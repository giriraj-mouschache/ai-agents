import { createHash, timingSafeEqual } from "node:crypto";
import { cfg, dispatch, getFile, GitHubError, listRuns, putFile } from "../lib/github.mjs";
import { DEFAULT_SETTINGS, nextSlot, validateSettings } from "../lib/shared.mjs";

const EMAIL_RE = /^[^@\s,;<>"']+@[^@\s,;<>"']+\.[^@\s,;<>"']+$/;
const DATA_FILE_RE = /^(index|check|digests\/[A-Za-z0-9_-]{1,40})$/;
const MIN_KEY_LENGTH = 12;

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

    if (route === "progress" && req.method === "GET") return json({ runs: await listRuns(5) });

    return fail(404, "Not found.");
  } catch (e) {
    if (e instanceof GitHubError) return fail(e.status === 401 || e.status === 403 ? 502 : e.status, e.message);
    console.error("api error", e?.message);
    return fail(500, "Something went wrong on the server.");
  }
};

export const config = { path: "/api/*" };
