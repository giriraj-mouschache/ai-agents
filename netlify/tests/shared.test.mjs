import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dueSlot, nextSlot, parseTs, validateSettings } from "../lib/shared.mjs";

const cases = JSON.parse(readFileSync(new URL("../../tests/schedule_cases.json", import.meta.url), "utf8"));

for (const c of cases) {
  test(`schedule: ${c.name}`, () => {
    const got = dueSlot(parseTs(c.now), c.settings, parseTs(c.last_run));
    const iso = got === null ? null : new Date(got).toISOString().replace(".000Z", "Z");
    assert.equal(iso, c.expected_slot);
  });
}

const good = () => ({
  paused: false,
  schedule: { times: ["08:00"], days: [0, 1], timezone: "Asia/Kolkata" },
  email: { to: "me@example.com" },
  min_score: 6,
  topics: [{ name: "AI", goal: "g", queries: ["a", " b "], timelimit: "w" }],
});

test("validate accepts good settings and trims", () => {
  const r = validateSettings(good());
  assert.ok(r.settings);
  assert.deepEqual(r.settings.topics[0].queries, ["a", "b"]);
});

test("validate rejects bad input with readable messages", () => {
  const bad = (mut) => { const s = good(); mut(s); return validateSettings(s).error; };
  assert.match(bad((s) => (s.schedule.times = [])), /time of day/);
  assert.match(bad((s) => (s.schedule.times = ["25:61"])), /not valid/);
  assert.match(bad((s) => (s.schedule.days = [])), /day/);
  assert.match(bad((s) => (s.schedule.timezone = "Mars/Base")), /time zone/);
  assert.match(bad((s) => (s.email.to = "nope")), /email/);
  assert.match(bad((s) => (s.min_score = 0)), /Strictness/);
  assert.match(bad((s) => (s.topics = [])), /at least one topic/);
  assert.match(bad((s) => (s.topics[0].queries = [" "])), /search phrase/);
  assert.match(bad((s) => s.topics.push({ name: "ai", queries: ["x"] })), /Two topics/);
  assert.ok(validateSettings(null).error);
});

test("nextSlot finds the next allowed day and time", () => {
  const sched = { times: ["08:00", "18:00"], days: [0, 1, 2, 3, 4], timezone: "Asia/Kolkata" };
  const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
  assert.equal(iso(nextSlot(Date.parse("2026-10-16T02:45:00Z"), sched)), "2026-10-16T12:30:00Z"); // Fri 08:15 IST -> 18:00 IST
  assert.equal(iso(nextSlot(Date.parse("2026-10-16T13:00:00Z"), sched)), "2026-10-19T02:30:00Z"); // Fri evening -> Monday 08:00 IST
});

test("validate handles several recipients, weekly roundup and empty-day option", () => {
  const s = { paused: false, schedule: { times: ["08:00"], days: [0], timezone: "UTC" }, min_score: 6,
    email: { to: "a@x.co, B@x.co;a@X.co", send_when_empty: true }, weekly: { enabled: true, day: 2 },
    topics: [{ name: "T", queries: ["q"] }] };
  const r = validateSettings(s);
  assert.equal(r.settings.email.to, "a@x.co, B@x.co");
  assert.equal(r.settings.email.send_when_empty, true);
  assert.deepEqual(r.settings.weekly, { enabled: true, day: 2 });
  assert.match(validateSettings({ ...s, email: { to: "a@x.co, nope" } }).error, /email/);
  assert.match(validateSettings({ ...s, email: { to: "1@x.co 2@x.co 3@x.co 4@x.co 5@x.co 6@x.co" } }).error, /at most 5/);
  assert.match(validateSettings({ ...s, weekly: { enabled: true, day: 9 } }).error, /weekly/);
});
