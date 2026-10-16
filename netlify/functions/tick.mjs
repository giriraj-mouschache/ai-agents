// Runs every 15 minutes. If the agent is due and nothing has been attempted for the current slot, ask GitHub to run it.
// The workflow re-checks with the same rules (agent/gate.py), so a duplicate trigger never sends two emails.
import { cfg, dispatch, getFile, listRuns } from "../lib/github.mjs";
import { dueSlot, parseTs, DEFAULT_SETTINGS } from "../lib/shared.mjs";

export default async () => {
  if (!cfg().token) { console.log("tick: GITHUB_TOKEN not set, nothing to do"); return; }
  try {
    const sf = await getFile("settings.json");
    const settings = sf ? { ...DEFAULT_SETTINGS, ...JSON.parse(sf.text) } : DEFAULT_SETTINGS;
    if (settings.paused) { console.log("tick: paused"); return; }
    const idx = await getFile("site/index.json");
    const runs = idx ? JSON.parse(idx.text).runs || [] : [];
    const slot = dueSlot(Date.now(), settings, runs.length ? parseTs(runs[0].ran_at) : null);
    if (slot === null) { console.log("tick: not due"); return; }
    const recent = await listRuns(10);
    if (recent.some((r) => Date.parse(r.created_at) >= slot)) { console.log("tick: already attempted for this slot"); return; }
    await dispatch({ force: "false" });
    console.log("tick: dispatched run for slot", new Date(slot).toISOString());
  } catch (e) {
    console.error("tick failed:", e?.message);
  }
};

export const config = { schedule: "*/15 * * * *" };
