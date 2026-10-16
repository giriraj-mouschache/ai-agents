import { createHash, timingSafeEqual } from "node:crypto";
import { cfg, dispatch, getFile, GitHubError, listRuns, putFile } from "../lib/github.mjs";
import { DEFAULT_SETTINGS, LIMITS, nextSlot, validateSettings } from "../lib/shared.mjs";
import { b64u, endpointOk, validSubscription, vapidKeys } from "../lib/push.mjs";
import { deliverPending, loadSubs, saveSubs, sendAll } from "../lib/notify.mjs";

const EMAIL_RE = /^[^@\s,;<>"']+@[^@\s,;<>"']+\.[^@\s,;<>"']+$/;
const DATA_FILE_RE = /^(index|check|digests\/[A-Za-z0-9_-]{1,40})$/;
const MIN_KEY_LENGTH = 12;
const IDEA_ID_RE = /^[a-f0-9]{10}$/;
const MAX_DEVICES = 10;

const adminSecret = () => Netlify.env.get("ADMIN_KEY") || "";
const subjectFor = (req) => `${new URL(req.url).origin}`;

async function readJsonFile(path, fallback) {
  const f = await getFile(path);
  try { return { data: f ? JSON.parse(f.text) : fallback, sha: f?.sha }; } catch { return { data: fallback, sha: f?.sha }; }
}

async function setIdeaStatus(id, status) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await readJsonFile("site/idea-status.json", {});
    data[id] = status;
    try { return await putFile("site/idea-status.json", JSON.stringify(data, null, 1) + "\n", sha, `ideas: ${status} ${id}`); }
    catch (e) { if (!(e instanceof GitHubError && e.status === 409) || attempt) throw e; }
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
const fail = (status, error) => json({ error }, status);

const digest = (s) => createHash("sha256").update(String(s)).digest();
const keyOk = (given) => {
  const real = Netlify.env.get("ADMIN_KEY") || "";
  return real.length >= MIN_KEY_LENGTH && timingSafeEqual(digest(given || ""), digest(real));
};

// Slows down password guessing within one warm function instance (the key is also long and random).
const misses = new Map();
function throttled(ip) {
  const m = misses.get(ip);
  return m && m.n >= 8 && Date.now() - m.t < 10 * 60e3;
}
function noteMiss(ip) {
  const m = misses.get(ip) || { n: 0, t: 0 };
  misses.set(ip, { n: m.n + 1, t: Date.now() });
}

const withNext = (o) => {
  const n = nextSlot(Date.now(), o.settings.schedule);
  return { ...o, next_run: n === null ? null : new Date(n).toISOString() };
};

async function readSettings() {
  const f = await getFile("settings.json");
  if (!f) return withNext({ settings: DEFAULT_SETTINGS, sha: null, missing: true });
  const v = (() => { try { return validateSettings(JSON.parse(f.text)); } catch { return { error: "unreadable" }; } })();
  return withNext(v.settings ? { settings: v.settings, sha: f.sha } : { settings: DEFAULT_SETTINGS, sha: f.sha, broken: true });
}

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  const c = cfg();

  if (route === "status" && req.method === "GET") {
    const key = Netlify.env.get("ADMIN_KEY") || "";
    return json({
      github_token: Boolean(c.token),
      admin_key: key.length >= MIN_KEY_LENGTH,
      admin_key_too_short: key.length > 0 && key.length < MIN_KEY_LENGTH,
      repo: c.repo,
    });
  }

  const ip = context.ip || "unknown";
  if (throttled(ip)) return fail(429, "Too many wrong keys. Wait a few minutes.");
  if (!keyOk(req.headers.get("x-admin-key"))) {
    if (req.headers.get("x-admin-key")) { noteMiss(ip); await new Promise((r) => setTimeout(r, 500)); }
    return fail(401, "Enter your access key to continue.");
  }
  misses.delete(ip);

  try {
    if (route === "login" && req.method === "POST") return json({ ok: true });

    if (route === "settings" && req.method === "GET") return json(await readSettings());

    if (route === "settings" && req.method === "PUT") {
      const body = await req.json().catch(() => null);
      const v = validateSettings(body?.settings);
      if (v.error) return fail(400, v.error);
      const sha = await putFile("settings.json", JSON.stringify(v.settings, null, 1) + "\n", body.sha || undefined, "settings: update from dashboard");
      return json(withNext({ settings: v.settings, sha }));
    }

    if (route === "data" && req.method === "GET") {
      const file = url.searchParams.get("file") || "";
      if (!DATA_FILE_RE.test(file)) return fail(400, "Unknown file.");
      const f = await getFile(`site/${file}.json`);
      if (!f) return file === "index" ? json({ runs: [] }) : file === "check" ? json({ checks: [] }) : fail(404, "That digest no longer exists.");
      return new Response(f.text, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }

    if (route === "run" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      await dispatch({ force: "true", dry_run: body?.dry_run === true ? "true" : "false" });
      return json({ started: true });
    }

    if (route === "check" && req.method === "POST") {
      await dispatch({ check: "true" });
      return json({ started: true });
    }

    if (route === "test-email" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const to = String(body?.to || "").trim();
      if (!EMAIL_RE.test(to)) return fail(400, "Enter a valid email address.");
      await dispatch({ test_email_to: to });
      return json({ started: true });
    }

    if (route === "ideas" && req.method === "GET") {
      const ideas = (await readJsonFile("site/ideas.json", {})).data;
      const status = (await readJsonFile("site/idea-status.json", {})).data;
      const pending = (ideas.ideas || []).filter((i) => !status[i.id]);
      return json({ ideas: pending, radar: ideas.radar || [], last_scout: ideas.last_scout || null, accepted: Object.values(status).filter((v) => v === "accepted").length });
    }

    if (route === "ideas/decide" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!IDEA_ID_RE.test(body?.id || "") || !["accept", "decline"].includes(body?.decision)) return fail(400, "Unknown idea or choice.");
      const ideas = (await readJsonFile("site/ideas.json", {})).data;
      const idea = (ideas.ideas || []).find((i) => i.id === body.id);
      if (!idea) return fail(404, "That idea is no longer available. Reload the page.");
      if (body.decision === "decline") { await setIdeaStatus(idea.id, "declined"); return json({ ok: true }); }
      const cur = await readSettings();
      const next = structuredClone(cur.settings);
      if (next.topics.length >= LIMITS.topics) return fail(400, `Your plan already has ${LIMITS.topics} topics. Remove one in Settings first.`);
      if (next.topics.some((t) => t.name.toLowerCase() === idea.name.toLowerCase())) { await setIdeaStatus(idea.id, "accepted"); return json({ ok: true, already: true }); }
      next.topics.push({ name: idea.name, goal: idea.goal, queries: idea.queries, timelimit: "w" });
      const v = validateSettings(next);
      if (v.error) return fail(400, v.error);
      const sha = await putFile("settings.json", JSON.stringify(v.settings, null, 1) + "\n", cur.sha || undefined, `settings: add topic "${idea.name}" from trend idea`);
      await setIdeaStatus(idea.id, "accepted");
      return json({ ok: true, ...withNext({ settings: v.settings, sha }) });
    }

    if (route === "push/key" && req.method === "GET") return json({ public_key: b64u(vapidKeys(adminSecret()).pub) });

    if (route === "push/subscribe" && req.method === "POST") {
      const sub = (await req.json().catch(() => ({})))?.subscription;
      if (!validSubscription(sub)) return fail(400, "That device could not be registered.");
      const { subs, sha } = await loadSubs();
      const entry = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, created: new Date().toISOString() };
      const rest = subs.filter((x) => x.endpoint !== entry.endpoint);
      await saveSubs([entry, ...rest].slice(0, MAX_DEVICES), sha);
      return json({ ok: true, devices: Math.min(rest.length + 1, MAX_DEVICES) });
    }

    if (route === "push/unsubscribe" && req.method === "POST") {
      const endpoint = (await req.json().catch(() => ({})))?.endpoint;
      if (!endpointOk(endpoint)) return fail(400, "Unknown device.");
      const { subs, sha } = await loadSubs();
      if (subs.some((x) => x.endpoint === endpoint)) await saveSubs(subs.filter((x) => x.endpoint !== endpoint), sha);
      return json({ ok: true });
    }

    if (route === "push/test" && req.method === "POST") {
      const { subs, sha } = await loadSubs();
      if (!subs.length) return fail(400, "No device is registered yet. Turn notifications on first.");
      const r = await sendAll(subs, sha, [{ title: "Test notification", body: "Notifications are working on this device.", url: "/", tag: "test", kind: "test" }], adminSecret(), subjectFor(req));
      return json(r);
    }

    if (route === "push/flush" && req.method === "POST") return json(await deliverPending({ secret: adminSecret(), subject: subjectFor(req) }));

    if (route === "progress" && req.method === "GET") return json({ runs: await listRuns(5) });

    return fail(404, "Not found.");
  } catch (e) {
    if (e instanceof GitHubError) return fail(e.status === 401 || e.status === 403 ? 502 : e.status, e.message);
    console.error("api error", e?.message);
    return fail(500, "Something went wrong on the server.");
  }
};

export const config = { path: "/api/*" };
