import test from "node:test";
import assert from "node:assert/strict";
import { installFakeGitHub } from "./fake-github.mjs";

const gh = installFakeGitHub();
const { default: api } = await import("../functions/api.mjs");
const { default: tick } = await import("../functions/tick.mjs");

const KEY = "correct-horse-battery";
const good = () => ({
  paused: false,
  schedule: { times: ["08:00"], days: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC" },
  email: { to: "me@example.com" },
  min_score: 6,
  topics: [{ name: "AI", goal: "g", queries: ["a"] }],
});
const call = (path, { method = "GET", key = KEY, body } = {}) =>
  api(new Request(`https://site.test/api/${path}`, {
    method, headers: { ...(key ? { "x-admin-key": key } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), { ip: "1.2.3.4" });

test("status is public and reports what is configured", async () => {
  const r = await (await call("status", { key: "" })).json();
  assert.deepEqual([r.github_token, r.admin_key, r.repo], [true, true, "owner/repo"]);
});

test("everything else needs the key", async () => {
  assert.equal((await call("settings", { key: "" })).status, 401);
  assert.equal((await call("settings", { key: "wrong-wrong-wrong" })).status, 401);
  assert.equal((await call("run", { method: "POST", key: "" })).status, 401);
});

test("a too-short ADMIN_KEY is refused outright", async () => {
  gh.vars.ADMIN_KEY = "short";
  assert.equal((await call("login", { method: "POST", key: "short" })).status, 401);
  assert.equal((await (await call("status", { key: "" })).json()).admin_key, false);
  gh.vars.ADMIN_KEY = KEY;
});

test("settings: defaults when missing, round-trip, validation, conflicts", async () => {
  let r = await (await call("settings")).json();
  assert.equal(r.missing, true);
  assert.ok(r.next_run);

  const bad = await call("settings", { method: "PUT", body: { settings: { ...good(), min_score: 0 }, sha: null } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Strictness/);

  const ok = await call("settings", { method: "PUT", body: { settings: good(), sha: null } });
  assert.equal(ok.status, 200);
  const saved = await ok.json();
  assert.equal(saved.settings.topics[0].name, "AI");
  assert.ok(gh.files.get("settings.json"));

  const stale = await call("settings", { method: "PUT", body: { settings: good(), sha: "old" } });
  assert.equal(stale.status, 409);
  const again = await call("settings", { method: "PUT", body: { settings: { ...good(), paused: true }, sha: saved.sha } });
  assert.equal((await again.json()).settings.paused, true);
  r = await (await call("settings")).json();
  assert.equal(r.settings.paused, true);
});

test("data proxy only serves known files", async () => {
  gh.put("site/index.json", JSON.stringify({ runs: [{ id: "x" }] }));
  gh.put("site/digests/20260101T000000Z.json", JSON.stringify({ id: "20260101T000000Z" }));
  assert.equal((await (await call("data?file=index")).json()).runs[0].id, "x");
  assert.equal((await call("data?file=digests/20260101T000000Z")).status, 200);
  assert.equal((await call("data?file=digests/../settings")).status, 400);
  assert.equal((await call("data?file=settings")).status, 400);
  assert.equal((await call("data?file=digests/nope")).status, 404);
});

test("run and test-email start the workflow with the right inputs", async () => {
  gh.dispatches.length = 0;
  assert.equal((await call("run", { method: "POST", body: {} })).status, 200);
  assert.deepEqual(gh.dispatches.at(-1), { force: "true", dry_run: "false" });
  assert.equal((await call("test-email", { method: "POST", body: { to: "nope" } })).status, 400);
  assert.equal((await call("test-email", { method: "POST", body: { to: "a@b.co" } })).status, 200);
  assert.deepEqual(gh.dispatches.at(-1), { test_email_to: "a@b.co" });
  const p = await (await call("progress")).json();
  assert.equal(p.runs[0].event, "workflow_dispatch");
});

test("check route starts the setup check and its result is served", async () => {
  gh.dispatches.length = 0;
  assert.equal((await call("check", { method: "POST" })).status, 200);
  assert.deepEqual(gh.dispatches.at(-1), { check: "true" });
  assert.deepEqual(await (await call("data?file=check")).json(), { checks: [] });
  gh.put("site/check.json", JSON.stringify({ checks: [{ id: "gmail", ok: true }] }));
  assert.equal((await (await call("data?file=check")).json()).checks[0].id, "gmail");
});

const subscription = async () => {
  const { createECDH, randomBytes } = await import("node:crypto");
  const ua = createECDH("prime256v1"); ua.generateKeys();
  return { endpoint: "https://fcm.googleapis.com/fcm/send/device1", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};

test("push: key, subscribe, test notification, prune dead devices", async () => {
  const key = (await (await call("push/key")).json()).public_key;
  assert.equal(Buffer.from(key, "base64url").length, 65);
  assert.equal((await call("push/subscribe", { method: "POST", body: { subscription: { endpoint: "https://evil.test/x", keys: {} } } })).status, 400);
  const sub = await subscription();
  assert.equal((await (await call("push/subscribe", { method: "POST", body: { subscription: sub } })).json()).devices, 1);
  gh.pushes.length = 0;
  const r = await (await call("push/test", { method: "POST" })).json();
  assert.equal(r.sent, 1);
  assert.match(gh.pushes[0].headers.Authorization, /^vapid t=.+, k=/);
  assert.equal(gh.pushes[0].headers["Content-Encoding"], "aes128gcm");
  gh.pushState.status = 410;
  const gone = await (await call("push/test", { method: "POST" })).json();
  assert.equal(gone.removed, 1);
  assert.deepEqual(JSON.parse(gh.files.get("subscriptions.json").text), []);
  gh.pushState.status = 201;
  assert.equal((await call("push/test", { method: "POST" })).status, 400);
});

test("push: queued alerts are delivered once per run, by the page or the timer", async () => {
  const sub = await subscription();
  await call("push/subscribe", { method: "POST", body: { subscription: sub } });
  gh.put("site/alerts.json", JSON.stringify({ batch: "run1", created: new Date().toISOString(), items: [
    { kind: "alert", tag: "a", title: "Big", body: "b", url: "https://x.com" }, { kind: "ideas", tag: "i", title: "Idea", body: "b", url: "/?tab=ideas" }] }));
  gh.files.delete("push-state.json");
  gh.pushes.length = 0;
  assert.equal((await (await call("push/flush", { method: "POST" })).json()).sent, 2);
  assert.equal((await (await call("push/flush", { method: "POST" })).json()).reason, "already sent");
  await tick();
  assert.equal(gh.pushes.length, 2);
  gh.put("site/alerts.json", JSON.stringify({ batch: "old", created: "2020-01-01T00:00:00Z", items: [{ title: "t", body: "b", url: "/" }] }));
  assert.equal((await (await call("push/flush", { method: "POST" })).json()).reason, "too old");
});

test("ideas: list, decline remembers, accept adds the topic to the plan", async () => {
  gh.put("settings.json", JSON.stringify(good()));
  gh.files.delete("site/idea-status.json");
  const idea = (n, id) => ({ id, name: n, goal: "g", queries: ["q1", "q2"], why: "w", confidence: 8, sources: [] });
  gh.put("site/ideas.json", JSON.stringify({ last_scout: "2026-10-16", radar: [{ area: "AI", note: "n" }], ideas: [idea("Edge AI", "aaaaaaaaaa"), idea("Agent payments", "bbbbbbbbbb")] }));
  let r = await (await call("ideas")).json();
  assert.equal(r.ideas.length, 2);
  assert.equal((await call("ideas/decide", { method: "POST", body: { id: "nope", decision: "accept" } })).status, 400);
  assert.equal((await call("ideas/decide", { method: "POST", body: { id: "cccccccccc", decision: "accept" } })).status, 404);
  assert.equal((await call("ideas/decide", { method: "POST", body: { id: "aaaaaaaaaa", decision: "decline" } })).status, 200);
  const acc = await (await call("ideas/decide", { method: "POST", body: { id: "bbbbbbbbbb", decision: "accept" } })).json();
  assert.deepEqual(acc.settings.topics.map((t) => t.name), ["AI", "Agent payments"]);
  assert.deepEqual(JSON.parse(gh.files.get("settings.json").text).topics[1].queries, ["q1", "q2"]);
  r = await (await call("ideas")).json();
  assert.equal(r.ideas.length, 0);
  assert.deepEqual(JSON.parse(gh.files.get("site/idea-status.json").text), { aaaaaaaaaa: "declined", bbbbbbbbbb: "accepted" });
});

test("a bad GitHub token is reported clearly, not leaked", async () => {
  const saved = gh.vars.GITHUB_TOKEN;
  gh.vars.GITHUB_TOKEN = "ghp_wrong";
  const res = await call("settings");
  assert.equal(res.status, 502);
  const body = JSON.stringify(await res.json());
  assert.match(body, /rejected the token/);
  assert.ok(!body.includes("ghp_"));
  gh.vars.GITHUB_TOKEN = saved;
});

test("tick: dispatches once when due, never when paused or already attempted", async () => {
  const hhmm = new Date(Date.now() - 10 * 60e3).toISOString().slice(11, 16);
  const sched = { ...good(), schedule: { times: [hhmm], days: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC" } };
  gh.put("settings.json", JSON.stringify(sched));
  gh.put("site/index.json", JSON.stringify({ runs: [] }));
  gh.dispatches.length = 0; gh.runs.length = 0;
  await tick();
  assert.equal(gh.dispatches.length, 1);
  assert.deepEqual(gh.dispatches[0], { force: "false" });
  await tick(); // the first dispatch is now an attempted run for this slot
  assert.equal(gh.dispatches.length, 1);

  gh.runs.length = 0;
  gh.put("settings.json", JSON.stringify({ ...sched, paused: true }));
  await tick();
  assert.equal(gh.dispatches.length, 1);

  gh.put("settings.json", JSON.stringify(sched));
  gh.put("site/index.json", JSON.stringify({ runs: [{ ran_at: new Date().toISOString() }] }));
  await tick();
  assert.equal(gh.dispatches.length, 1);
});
