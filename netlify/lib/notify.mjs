// Delivers the push notifications the agent queued in site/alerts.json, once per run, to every subscribed device.
import { getFile, putFile, GitHubError } from "./github.mjs";
import { sendPush } from "./push.mjs";

const MAX_AGE_MS = 24 * 3600e3;
const parse = (f, fallback) => { try { return f ? JSON.parse(f.text) : fallback; } catch { return fallback; } };

export async function loadSubs() {
  const f = await getFile("subscriptions.json");
  return { subs: parse(f, []), sha: f?.sha };
}
export async function saveSubs(subs, sha) {
  return putFile("subscriptions.json", JSON.stringify(subs, null, 1) + "\n", sha, "push: update subscriptions");
}

export async function deliverPending({ secret, subject }) {
  if (!secret) return { sent: 0, reason: "no key" };
  const af = await getFile("site/alerts.json");
  const alerts = parse(af, null);
  if (!alerts?.batch || !Array.isArray(alerts.items) || !alerts.items.length) return { sent: 0, reason: "nothing queued" };
  if (Date.now() - Date.parse(alerts.created) > MAX_AGE_MS) return { sent: 0, reason: "too old" };

  const sf = await getFile("push-state.json");
  if (parse(sf, {}).last_batch === alerts.batch) return { sent: 0, reason: "already sent" };
  try {
    // Claim the batch first: if tick and the page race, only one of them gets to send.
    await putFile("push-state.json", JSON.stringify({ last_batch: alerts.batch, at: new Date().toISOString() }) + "\n", sf?.sha, "push: mark batch sent");
  } catch (e) {
    if (e instanceof GitHubError && e.status === 409) return { sent: 0, reason: "claimed elsewhere" };
    throw e;
  }
  const { subs, sha } = await loadSubs();
  if (!subs.length) return { sent: 0, reason: "no devices" };
  return { ...(await sendAll(subs, sha, alerts.items.slice(0, 5), secret, subject)), batch: alerts.batch };
}

export async function sendAll(subs, sha, messages, secret, subject) {
  let sent = 0;
  const failed = [];
  const dead = new Set();
  for (const sub of subs) {
    for (const m of messages) {
      const r = await sendPush(sub, { title: m.title, body: m.body, url: m.url, tag: m.tag, kind: m.kind }, { secret, subject });
      if (r.ok) sent++; else failed.push(r.status);
      if (r.gone) { dead.add(sub.endpoint); break; }
    }
  }
  if (dead.size) { try { await saveSubs(subs.filter((s) => !dead.has(s.endpoint)), sha); } catch { /* pruned next time */ } }
  return { sent, failed, removed: dead.size };
}
