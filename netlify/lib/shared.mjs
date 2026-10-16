// Schedule maths and settings validation. Mirrors agent/schedule.py and agent/settings.py;
// both sides are checked against tests/schedule_cases.json.

export const CATCHUP_HOURS = 6;
export const LIMITS = { topics: 10, queries: 8, times: 6, recipients: 5 };
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL_RE = /^[^@\s,;<>"']+@[^@\s,;<>"']+\.[^@\s,;<>"']+$/;

export const DEFAULT_SETTINGS = {
  version: 1,
  paused: false,
  schedule: { times: ["08:00"], days: [0, 1, 2, 3, 4, 5, 6], timezone: "Asia/Kolkata" },
  email: { to: "", send_when_empty: false },
  weekly: { enabled: false, day: 6 },
  min_score: 6,
  topics: [],
};

export function tzValid(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return typeof tz === "string" && tz.length < 60; } catch { return false; }
}

function parts(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}

function offsetMs(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

export function zonedToUtcMs(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ms = guess - offsetMs(guess, tz);
  ms = guess - offsetMs(ms, tz);
  return ms;
}

/** Latest scheduled time at or before nowMs within the catch-up window (ms since epoch), or null. */
export function latestSlot(nowMs, schedule, catchupHours = CATCHUP_HOURS) {
  const p = parts(nowMs, schedule.timezone);
  let best = null;
  for (let back = 0; back < 3; back++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day - back));
    const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
    if (!schedule.days.includes(weekday)) continue;
    for (const t of schedule.times) {
      const slot = zonedToUtcMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), +t.slice(0, 2), +t.slice(3), schedule.timezone);
      if (slot <= nowMs && nowMs - slot <= catchupHours * 3600e3 && (best === null || slot > best)) best = slot;
    }
  }
  return best;
}

/** First scheduled time strictly after nowMs (ms since epoch), or null if the schedule is empty. */
export function nextSlot(nowMs, schedule) {
  const p = parts(nowMs, schedule.timezone);
  let best = null;
  for (let ahead = 0; ahead < 9; ahead++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + ahead));
    const weekday = (day.getUTCDay() + 6) % 7;
    if (!schedule.days.includes(weekday)) continue;
    for (const t of schedule.times) {
      const slot = zonedToUtcMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), +t.slice(0, 2), +t.slice(3), schedule.timezone);
      if (slot > nowMs && (best === null || slot < best)) best = slot;
    }
  }
  return best;
}

export function dueSlot(nowMs, settings, lastRunMs) {
  if (settings.paused) return null;
  const slot = latestSlot(nowMs, settings.schedule);
  if (slot === null) return null;
  if (lastRunMs !== null && lastRunMs !== undefined && lastRunMs >= slot) return null;
  return slot;
}

export function parseTs(v) {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Strict validation for the API. Returns { settings } or { error } with a message a person can act on. */
export function validateSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Settings are missing." };
  const out = structuredClone(DEFAULT_SETTINGS);
  out.paused = raw.paused === true;

  const s = raw.schedule || {};
  const times = [...new Set((Array.isArray(s.times) ? s.times : []).filter((t) => typeof t === "string"))].sort();
  if (!times.length) return { error: "Pick at least one time of day." };
  if (times.length > LIMITS.times) return { error: `Use at most ${LIMITS.times} times per day.` };
  if (!times.every((t) => TIME_RE.test(t))) return { error: "A time of day is not valid." };
  const days = [...new Set(Array.isArray(s.days) ? s.days : [])].sort();
  if (!days.length) return { error: "Pick at least one day of the week." };
  if (!days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return { error: "A day of the week is not valid." };
  if (!tzValid(s.timezone)) return { error: "That time zone is not recognised." };
  out.schedule = { times, days, timezone: s.timezone };

  const parts = clean(raw.email?.to, 400).split(/[,;\s]+/).filter(Boolean);
  if (parts.some((p) => !EMAIL_RE.test(p))) return { error: "One of the email addresses does not look right." };
  const seenMail = new Set();
  const to = parts.filter((p) => !seenMail.has(p.toLowerCase()) && seenMail.add(p.toLowerCase()));
  if (to.length > LIMITS.recipients) return { error: `Use at most ${LIMITS.recipients} email addresses.` };
  out.email = { to: to.join(", "), send_when_empty: raw.email?.send_when_empty === true };

  const wd = raw.weekly?.day ?? 6;
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) return { error: "The weekly roundup day is not valid." };
  out.weekly = { enabled: raw.weekly?.enabled === true, day: wd };

  const ms = raw.min_score;
  if (!Number.isInteger(ms) || ms < 1 || ms > 10) return { error: "Strictness must be between 1 and 10." };
  out.min_score = ms;

  const topics = Array.isArray(raw.topics) ? raw.topics : [];
  if (!topics.length) return { error: "Add at least one topic." };
  if (topics.length > LIMITS.topics) return { error: `Use at most ${LIMITS.topics} topics.` };
  const names = new Set();
  for (const [i, t] of topics.entries()) {
    const name = clean(t?.name, 80);
    const queries = (Array.isArray(t?.queries) ? t.queries : []).map((q) => clean(q, 200)).filter(Boolean);
    if (!name) return { error: `Topic ${i + 1} needs a name.` };
    if (names.has(name.toLowerCase())) return { error: `Two topics are called "${name}".` };
    names.add(name.toLowerCase());
    if (!queries.length) return { error: `"${name}" needs at least one search phrase.` };
    if (queries.length > LIMITS.queries) return { error: `"${name}" has more than ${LIMITS.queries} search phrases.` };
    const topic = { name, queries, goal: clean(t?.goal, 600) || name };
    if (["d", "w", "m", "y"].includes(t?.timelimit)) topic.timelimit = t.timelimit;
    out.topics.push(topic);
  }
  out.updated = new Date().toISOString();
  return { settings: out };
}
