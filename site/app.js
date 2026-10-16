// Research agent dashboard. All text is inserted with textContent; links are limited to http(s).
const KEY_STORE = "agent-access-key";
const TIME_ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Europe/London",
  "Europe/Paris", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FRESHNESS = [["d", "Past day"], ["w", "Past week"], ["m", "Past month"], ["y", "Past year"]];
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const S = {
  status: null, key: "", settings: null, saved: null, sha: null, nextRun: null, settingsNote: "",
  index: null, digests: new Map(), selected: null, view: "digests", busy: "", locked: false, forceDirty: false, check: null, ideas: null,
};

const $ = (sel) => document.querySelector(sel);
const main = $("#main");

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const store = {
  get() { try { return localStorage.getItem(KEY_STORE) || ""; } catch { return ""; } },
  set(v) { try { v ? localStorage.setItem(KEY_STORE, v) : localStorage.removeItem(KEY_STORE); } catch { /* storage blocked */ } },
};

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      headers: { ...(S.key ? { "x-admin-key": S.key } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== "login") lock();
    throw new ApiError(res.status, data.error || `Request failed (${res.status}).`);
  }
  return data;
}

// ---------- helpers ----------
const tz = () => S.settings?.schedule?.timezone || "Asia/Kolkata";
const fmt = (iso, opts) => { try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz(), hour12: true, ...opts }).format(new Date(iso)); } catch { return iso; } };
const fmtWhen = (iso) => fmt(iso, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmtDay = (iso) => fmt(iso, { weekday: "short", day: "numeric", month: "short" });
const safeHref = (u) => { try { const p = new URL(u); return p.protocol === "https:" || p.protocol === "http:" ? p.href : null; } catch { return null; } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const plain = (s) => JSON.stringify({ ...s, updated: undefined });
const dirty = () => Boolean(S.settings && S.saved && (S.forceDirty || plain(S.settings) !== plain(S.saved)));

function scheduleSentence(sc) {
  const d = sc.days.length === 7 ? "every day" : sc.days.join() === "0,1,2,3,4" ? "on weekdays" : `on ${sc.days.map((i) => DAYS[i]).join(", ")}`;
  const t = sc.times.length > 1 ? sc.times.slice(0, -1).join(", ") + " and " + sc.times.at(-1) : sc.times[0];
  return `${d[0].toUpperCase()}${d.slice(1)} at ${t} (${sc.timezone.replace("_", " ")})`;
}

let toastTimer;
function toast(text, tone = "ok", sticky = false) {
  const el = $("#toast");
  el.textContent = text; el.dataset.tone = tone; el.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 8000);
}

const RUN_STATE = (r) => r.status === "failed" ? ["Failed", "bad"] : r.status === "partial" ? ["Some errors", "warn"] : r.emailed ? ["Emailed", "ok"] : ["Nothing new", "ok"];

function explainError(code) {
  if (!code) return "";
  if (code === "NoLLMKey") return "No AI key was found. Add a Gemini, Groq or OpenRouter key in GitHub secrets.";
  if (/SMTPAuth/.test(code)) return "Gmail refused the login. Check the sender address and app password in GitHub secrets.";
  if (/SMTP|Socket|Timeout|Connection/i.test(code)) return `The email could not be sent (${code}). It will be retried next run.`;
  return `The run stopped with an error (${code}).`;
}

// ---------- header ----------
function renderHeader() {
  const status = $("#status");
  const setupNeeded = S.status && (!S.status.github_token || !S.status.admin_key);
  const ready = !setupNeeded && !S.locked && S.settings;
  $("#actions").hidden = !ready;
  $("#tabs").hidden = !ready;
  let text, tone = "ok";
  if (!S.status) { text = "Loading."; tone = "none"; }
  else if (setupNeeded) { text = "One-time setup needed (about 5 minutes) before you can manage the agent from here."; tone = "warn"; }
  else if (S.locked || !S.settings) { text = "Enter your access key to continue."; tone = "warn"; }
  else if (S.busy) { text = S.busy; tone = "busy"; }
  else {
    const last = S.index?.runs?.[0];
    const parts = [];
    if (S.settings.paused) { parts.push("Paused. Nothing will run until you resume."); tone = "warn"; }
    else if (S.nextRun) parts.push(`On. Next digest: ${fmtWhen(S.nextRun)}.`);
    else parts.push("On, but nothing is scheduled.");
    if (last) {
      const [word, t] = RUN_STATE(last);
      parts.push(last.status === "failed" ? `The last run (${fmtWhen(last.ran_at)}) failed.` : `Last run: ${fmtWhen(last.ran_at)}, ${word.toLowerCase()}${last.emailed ? ` (${last.items} item${last.items === 1 ? "" : "s"})` : ""}.`);
      if (t === "bad") tone = "bad"; else if (t === "warn" && tone === "ok") tone = "warn";
    } else parts.push("No runs yet.");
    text = parts.join(" ");
  }
  status.textContent = text; status.dataset.tone = tone;
  const pause = $("#btn-pause");
  pause.textContent = S.settings?.paused ? "Resume" : "Pause";
  pause.disabled = Boolean(S.busy);
  $("#btn-run").disabled = Boolean(S.busy);
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.view)));
  const n = S.ideas?.ideas?.length || 0, badge = $("#ideas-badge");
  badge.hidden = !n; badge.textContent = String(n);
}

// ---------- views ----------
function render() {
  renderHeader();
  main.replaceChildren();
  if (!S.status) return;
  if (!S.status.github_token || !S.status.admin_key) return main.append(setupView());
  if (S.locked || !S.settings) return main.append(unlockView());
  main.append(S.view === "settings" ? settingsView() : S.view === "health" ? healthView() : S.view === "ideas" ? ideasView() : digestsView());
}

function setupView() {
  const st = S.status;
  const tick = (ok) => (ok ? h("span", { class: "done-mark", text: "Done. " }) : null);
  return h("section", { class: "card" },
    h("h2", { text: "Set up in 3 steps" }),
    h("p", { class: "hint", text: "The page needs permission to change settings and start runs. That permission is a key only you can create, so these steps are yours. After this you never need GitHub again." }),
    h("ol", { class: "steps" },
      h("li", {}, h("h3", {}, tick(st.github_token), "Create a GitHub key"),
        h("p", {}, "Open ", h("a", { href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener noreferrer", text: "GitHub: new fine-grained token" }), ". Then:"),
        h("ul", {},
          h("li", {}, "Name it anything, and set the expiry to the longest allowed."),
          h("li", {}, "Under Repository access choose Only select repositories, then pick ", h("code", { text: st.repo }), "."),
          h("li", {}, "Under Repository permissions set ", h("b", { text: "Contents" }), " and ", h("b", { text: "Actions" }), " to Read and write."),
          h("li", {}, "Press Generate token and copy it. GitHub shows it only once."))),
      h("li", {}, h("h3", {}, tick(st.admin_key && st.github_token), "Add two values in Netlify"),
        h("p", {}, "Open ", h("a", { href: "https://app.netlify.com/projects/research-digest-ai-agents/configuration/env", target: "_blank", rel: "noopener noreferrer", text: "Netlify: environment variables" }), " and add:"),
        h("ul", {},
          h("li", {}, h("code", { text: "GITHUB_TOKEN" }), " : paste the key from step 1."),
          h("li", {}, h("code", { text: "ADMIN_KEY" }), " : make up a long password (12 or more characters). You will type it on this page to unlock it."),
          h("li", {}, "Leave the scopes on their defaults, and make sure Functions is included.")),
        st.admin_key_too_short ? h("p", { class: "done-mark", style: "color:var(--bad)", text: "Your ADMIN_KEY is shorter than 12 characters. Make it longer." }) : null),
      h("li", {}, h("h3", { text: "Redeploy, then check" }),
        h("p", { text: "In Netlify open Deploys, then Trigger deploy, then Deploy project without cache. Values only take effect after a deploy. When it finishes, press the button below." }),
        h("p", {}, h("button", { type: "button", class: "btn primary", onclick: async (e) => { e.target.disabled = true; await boot(); } }, "Check again")))));
}

function unlockView() {
  const input = h("input", { type: "password", id: "key", autocomplete: "current-password", required: true, "aria-describedby": "key-help" });
  const err = h("p", { role: "alert", style: "color:var(--bad);min-height:1.5em;margin:8px 0 0" });
  const form = h("form", { class: "card", onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    S.key = input.value.trim();
    try { await api("login", { method: "POST" }); store.set(S.key); S.locked = false; await loadAll(); render(); }
    catch (ex) { S.key = ""; S.locked = true; err.textContent = ex.message; }
  } },
    h("h2", { text: "Unlock" }),
    h("p", { class: "hint", id: "key-help", text: "Type the access key you chose as ADMIN_KEY in Netlify. This device will remember it until you lock it." }),
    h("div", { class: "body" }, h("label", { for: "key", text: "Access key" }), input, err,
      h("p", {}, h("button", { type: "submit", class: "btn primary", text: "Unlock" }))));
  queueMicrotask(() => input.focus());
  return form;
}

function healthBanner() {
  const last = S.index?.runs?.[0];
  if (S.settings.paused) return banner("warn", "The agent is paused", "Nothing will run or be emailed until you press Resume.");
  const aiDown = last?.status === "partial" && last.errors > 0 && last.items > 0 && !last.llm;
  if (last?.status === "failed") return banner("bad", "The last run failed", "Open the Health tab and press Check my setup. It will tell you which key or setting needs fixing.", true);
  if (aiDown) return banner("warn", "The last run could not use the AI", "Results were sent unranked. Open the Health tab and press Check my setup to find the broken key.", true);
  const overdue = last && S.nextRun && Date.now() - Date.parse(last.ran_at) > 2.5 * 86400e3;
  if (overdue) return banner("warn", "No run for a few days", "Press Run now. If it does not start, open the Health tab.", true);
  return null;
}
function banner(tone, title, text, linkHealth) {
  return h("div", { class: "notice", "data-tone": tone, role: "status" }, h("h3", { text: title }), h("p", { text }),
    linkHealth ? h("p", {}, h("button", { type: "button", class: "btn", onclick: () => { S.view = "health"; render(); } }, "Open Health")) : null);
}

function digestsView() {
  const runs = S.index?.runs || [];
  if (!runs.length) {
    return h("div", {}, healthBanner(), h("div", { class: "empty" }, h("h2", { text: "No results yet" }),
      h("p", { text: S.nextRun && !S.settings.paused ? `The first run is scheduled for ${fmtWhen(S.nextRun)}. You can also press Run now.` : "Press Run now to get the first digest." })));
  }
  const body = h("div", { id: "digest", tabindex: "-1" });
  const list = h("ol", { class: "runs" });
  const rail = h("aside", { class: "rail", "aria-label": "Earlier results" }, h("h2", { text: "All runs" }), list);
  const select = (id, focus) => {
    S.selected = id;
    history.replaceState(null, "", `#run=${id}`);
    list.querySelectorAll(".run").forEach((b) => b.setAttribute("aria-current", String(b.dataset.id === id)));
    showDigest(body, runs.find((r) => r.id === id), focus);
  };
  for (const r of runs) {
    const [word, tone] = RUN_STATE(r);
    list.append(h("li", {}, h("button", { type: "button", class: "run", "data-id": r.id, "aria-current": "false", onclick: () => select(r.id, true) },
      h("b", { text: fmtDay(r.ran_at) }), h("span", { class: "state", "data-tone": tone, text: word }),
      h("small", { text: `${fmt(r.ran_at, { hour: "numeric", minute: "2-digit" })} · ${r.items} item${r.items === 1 ? "" : "s"}` }))));
  }
  const wanted = runs.find((r) => r.id === S.selected) || runs[0];
  queueMicrotask(() => select(wanted.id, false));
  const b = healthBanner();
  const layout = h("div", { class: "runs-layout" }, body, rail);
  return b ? h("div", {}, b, layout) : layout;
}

async function showDigest(el, run, focus) {
  el.replaceChildren(h("p", { class: "hint", text: "Loading." }));
  let d;
  try {
    if (!RUN_ID_RE.test(run.id)) throw new Error("bad id");
    d = S.digests.get(run.id);
    if (!d) { d = await api(`data?file=${encodeURIComponent(`digests/${run.id}`)}`); S.digests.set(run.id, d); }
  } catch (e) {
    return el.replaceChildren(h("div", { class: "notice", "data-tone": "warn" }, h("h3", { text: "This result could not be loaded" }), h("p", { text: e.message || "Try again in a moment." })));
  }
  if (S.selected !== run.id) return;
  const [word] = RUN_STATE(run);
  const kids = [h("div", { class: "digest-head" },
    h("h2", { text: fmtWhen(d.ran_at) }),
    h("p", { text: `${word}. ${(() => { const n = d.sections.reduce((a, x) => a + x.items.length, 0); return `${n} item${n === 1 ? "" : "s"} found.`; })()}${d.llm ? ` Summarised by ${d.llm}.` : ""}` }))];
  if (d.error || d.status === "failed") {
    kids.push(h("div", { class: "notice", "data-tone": "bad" }, h("h3", { text: "This run did not finish properly" }), h("p", { text: explainError(d.error) || "Something went wrong. Try Run now again." })));
  }
  if (d.tldr?.length) kids.push(h("section", { class: "tldr" }, h("h3", { text: "In short" }), h("ul", {}, d.tldr.map((t) => h("li", { text: t })))));
  for (const sec of d.sections) {
    kids.push(h("section", { class: "topic" }, h("h3", { text: sec.name }), sec.items.map((i) => {
      const href = safeHref(i.url);
      return h("article", { class: "item" },
        h("h4", {}, href ? h("a", { href, target: "_blank", rel: "noopener noreferrer", text: i.title }) : i.title),
        h("div", { class: "meta" }, h("span", { text: i.domain }), h("span", { class: "score", text: typeof i.score === "number" && i.score >= 0 ? `Relevance ${i.score}/10` : "Not scored" })),
        i.summary ? h("p", { class: "summary", text: i.summary }) : null,
        i.why ? h("p", { class: "why", text: i.why }) : null);
    })));
  }
  if (!d.sections.length && !d.error && d.status !== "failed") kids.push(h("p", { class: "hint", text: "Nothing new matched your topics this time." }));
  if (d.errors?.length) kids.push(h("div", { class: "notice", "data-tone": "warn" }, h("h3", { text: "Small problems during this run" }), h("ul", {}, d.errors.map((x) => h("li", { text: x })))));
  el.replaceChildren(...kids);
  if (focus) el.focus();
}

// ---------- health ----------
function healthView() {
  const c = S.check;
  const mark = (ok) => (ok === true ? ["✓", "Working", "ok"] : ok === false ? ["✕", "Problem", "bad"] : ["–", "Not set", "none"]);
  const list = c?.checks?.length
    ? h("ul", { class: "checks" }, c.checks.map((x) => { const [sym, word, tone] = mark(x.ok);
        return h("li", { class: "check", "data-tone": tone }, h("span", { class: "sym", "aria-hidden": "true", text: sym }),
          h("div", {}, h("b", {}, x.label, h("span", { class: "sr", text: `: ${word}` })), h("p", { text: x.detail }))); }))
    : h("p", { class: "hint", text: "No check has been run yet. Press the button to test everything in about a minute." });
  return h("section", { class: "card" }, h("h2", { text: "Is everything working?" }),
    h("p", { class: "hint", text: "This tests your Gmail login, each AI key and web search. It sends no email and costs nothing." }),
    h("div", { class: "body" }, h("p", {}, h("button", { type: "button", class: "btn primary", id: "btn-check", disabled: Boolean(S.busy), onclick: runCheck }, "Check my setup")),
      c?.ran_at ? h("p", { class: "help", text: `Last checked ${fmtWhen(c.ran_at)}.` }) : null, list,
      h("p", { class: "help", text: "Keys are changed in GitHub: Settings, Secrets and variables, Actions. Never paste a key into this page or into chat." })));
}

async function loadCheck() { try { S.check = await api("data?file=check"); } catch { /* shown as not run yet */ } }

async function runCheck() {
  const since = Date.now();
  try { await api("check", { method: "POST" }); } catch (e) { return toast(e.message, "bad", true); }
  track("Checking your setup.", since, "Check finished. Results are below.", { view: "health", after: loadCheck });
}

// ---------- settings ----------

// ---------- ideas (trend radar) ----------
async function loadIdeas() { try { S.ideas = await api("ideas"); } catch (e) { if (e.status !== 401) S.ideas = S.ideas || { ideas: [], radar: [], last_scout: null }; } }

function ideasView() {
  const d = S.ideas || { ideas: [], radar: [] };
  const root = h("div", {});
  const on = S.settings?.radar?.enabled !== false;
  root.append(h("section", { class: "card" }, h("h2", { text: "Topic ideas for you" }),
    h("p", { class: "hint", text: on ? "Once a day the agent scans what is rising in your areas and suggests topics worth tracking. Add one to your plan, or skip it and it will not be suggested again." : "The trend radar is off. Turn it on in Settings, under Trend radar." }),
    h("div", { class: "body" }, d.ideas.length ? d.ideas.map((i) => ideaCard(i)) : h("p", { class: "help", text: d.last_scout ? `No new ideas right now. The radar last looked on ${d.last_scout}. New ideas appear after its next daily scan.` : "No ideas yet. The first scan happens with the next scheduled run." }))));
  if (d.radar?.length) root.append(h("section", { class: "card" }, h("h2", { text: "What the radar noticed" }), h("div", { class: "body" },
    h("ul", { class: "radar" }, d.radar.map((r) => h("li", {}, h("strong", { text: `${r.area}: ` }), r.note))))));
  return root;
}

function ideaCard(i) {
  const srcs = (i.sources || []).map((u) => safeHref(u?.url || u)).filter(Boolean).slice(0, 3);
  const act = async (decision, btns) => {
    btns.forEach((b) => { b.disabled = true; });
    try {
      const r = await api("ideas/decide", { method: "POST", body: { id: i.id, decision } });
      S.ideas.ideas = S.ideas.ideas.filter((x) => x.id !== i.id);
      if (decision === "accept" && r.settings) {
        const mine = dirty() ? S.settings : null; // keep unsaved edits made in Settings
        S.saved = clone(r.settings); S.sha = r.sha || S.sha; S.nextRun = r.next_run ?? S.nextRun;
        S.settings = mine ? { ...mine, topics: [...mine.topics, r.settings.topics[r.settings.topics.length - 1]] } : clone(r.settings);
      }
      toast(decision === "accept" ? `Added "${i.name}" to your plan. It will be in your next digest.` : `Got it. "${i.name}" will not be suggested again.`);
    } catch (e) { toast(e.message, "bad", true); btns.forEach((b) => { b.disabled = false; }); return; }
    render();
  };
  const add = h("button", { type: "button", class: "btn primary" }, "Add to my plan");
  const no = h("button", { type: "button", class: "btn" }, "Not interested");
  add.onclick = () => act("accept", [add, no]); no.onclick = () => act("decline", [add, no]);
  return h("article", { class: "idea" }, h("h3", { text: i.name }),
    h("div", { class: "tags" }, i.area ? h("span", { class: "pill", text: i.area }) : null, h("span", { text: `Confidence ${i.confidence}/10` })),
    h("p", { class: "summary", text: i.why }),
    i.goal ? h("p", { class: "why", text: `It would look for: ${i.goal}` }) : null,
    srcs.length ? h("ul", { class: "src" }, srcs.map((u) => h("li", {}, h("a", { href: u, target: "_blank", rel: "noopener noreferrer", text: new URL(u).hostname })))) : null,
    h("div", { class: "acts" }, add, no));
}

// ---------- notifications (installable app + push) ----------
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const b64uToBytes = (b) => Uint8Array.from(atob(b.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
async function currentSub() { try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch { return null; } }

async function enablePush() {
  if (!pushSupported()) throw new Error("This browser cannot show notifications. On iPhone, add the app to your Home Screen first.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked. Allow them in your browser's site settings, then try again.");
  const reg = await navigator.serviceWorker.ready;
  const { public_key } = await api("push/key");
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(public_key) });
  await api("push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
}
async function disablePush() {
  const sub = await currentSub();
  if (sub) { try { await api("push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }); } catch { /* removed on next failed send */ } await sub.unsubscribe().catch(() => {}); }
}

function notifyCard(touch) {
  const n = S.settings.notify, box = h("div", { class: "body" });
  const draw = async () => {
    const sub = pushSupported() ? await currentSub() : null;
    const on = Boolean(sub) && Notification.permission === "granted";
    const status = h("p", { class: "summary-line", id: "push-status", text: !pushSupported() ? "This browser cannot show notifications. On iPhone or iPad, add this page to your Home Screen first." : on ? "Notifications are on for this device." : Notification.permission === "denied" ? "Notifications are blocked for this site. Allow them in your browser's site settings." : "Notifications are off on this device." });
    const msg = h("p", { class: "help", id: "push-msg", role: "status" });
    const btn = h("button", { type: "button", class: on ? "btn" : "btn primary", id: "btn-push", disabled: !pushSupported(), onclick: async () => {
      btn.disabled = true;
      try { if (on) await disablePush(); else await enablePush(); } catch (e) { toast(e.message, "bad", true); }
      draw();
    } }, on ? "Turn off on this device" : "Turn on for this device");
    const test = on ? h("button", { type: "button", class: "btn", id: "btn-push-test", onclick: async () => {
      test.disabled = true; msg.textContent = "Sending.";
      try {
        const r = await api("push/test", { method: "POST" });
        msg.textContent = r.sent ? "Sent. It should appear in a few seconds." : r.removed ? "This device was no longer valid and was removed. Turn notifications on again." : `The push service refused it (code ${(r.failed || [])[0] || "unknown"}). Turn notifications off and on again.`;
      } catch (e) { msg.textContent = e.message; }
      test.disabled = false;
    } }, "Send a test notification") : null;
    const tog = (key, label, help) => h("label", { class: "check-row", style: "margin-top:12px" }, h("input", { type: "checkbox", checked: n[key], onchange: (e) => { n[key] = e.target.checked; touch(); } }), h("span", {}, label, h("span", { class: "help", text: help })));
    const ms = h("input", { type: "range", min: 1, max: 10, step: 1, value: n.min_score, id: "nms", "aria-label": "Minimum score for an alert", oninput: (e) => { n.min_score = Number(e.target.value); out.textContent = String(n.min_score); touch(); } });
    const out = h("output", { for: "nms", text: String(n.min_score) });
    box.replaceChildren(status, h("div", { class: "row" }, btn, test), msg,
      tog("alerts", "Big finds", "A short alert when a result scores at or above the number below, or matches one of your rules."),
      h("div", { class: "field" }, h("label", { for: "nms", text: "Alert only at this score or higher" }), h("div", { class: "range" }, ms, out)),
      tog("ideas", "New topic ideas", "A ping when the trend radar has something new for you."),
      tog("digest", "Digest ready", "A ping each time a digest is sent. Off by default, the email already covers this."),
      h("p", { class: "help", text: "Notification choices are saved with the Save changes button. Turning a device on or off applies at once." }));
  };
  draw();
  return h("section", { class: "card", id: "notify-card" }, h("h2", { text: "Notifications" }),
    h("p", { class: "hint", text: "Install this page as an app (Chrome: the install icon in the address bar, or Menu, Install) and get only the alerts you choose." }), box);
}

// ---------- rules ----------
function rulesCard(touch) {
  const s = S.settings, box = h("div", { class: "body" });
  const topicNames = s.topics.map((t) => t.name).filter(Boolean);
  const draw = () => {
    box.replaceChildren(...[...s.rules.map((r, i) => h("div", { class: "rule-card" },
      h("div", { class: "field", style: "margin:0" }, h("label", { for: `rn${i}`, text: "Rule name" }), h("input", { type: "text", id: `rn${i}`, value: r.name || "", maxlength: 60, placeholder: `Rule ${i + 1}`, oninput: (e) => { r.name = e.target.value; touch(); } })),
      h("div", { class: "rule-line" }, h("span", { text: "When a result in" }),
        h("select", { "aria-label": "Which topic", onchange: (e) => { r.topic = e.target.value; touch(); } }, h("option", { value: "", text: "any topic", selected: !r.topic }), ...[...new Set([...(r.topic ? [r.topic] : []), ...topicNames])].map((t) => h("option", { value: t, text: t, selected: t === r.topic }))),
        h("span", { text: "mentions" })),
      h("div", { class: "rule-line" }, h("input", { type: "text", "aria-label": "Words to look for, separated by commas", placeholder: "words, separated by commas", value: (r.match || []).join(", "), oninput: (e) => { r.match = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); touch(); } })),
      h("div", { class: "rule-line" }, h("span", { text: "then" }),
        h("select", { "aria-label": "What to do", onchange: (e) => { r.action = e.target.value; touch(); } }, [["notify", "alert me right away"], ["boost", "rank it higher"], ["mute", "hide it"]].map(([v, l]) => h("option", { value: v, text: l, selected: v === (r.action || "notify") }))),
        h("button", { type: "button", class: "btn danger-quiet", "aria-label": `Delete rule ${r.name || i + 1}`, onclick: () => { s.rules.splice(i, 1); draw(); touch(); } }, "Delete"))),
    ), s.rules.length ? null : h("p", { class: "help", text: "No rules yet. Example: when a result in any topic mentions \"funding, raises\" then alert me right away." }),
    s.rules.length < 10 ? h("button", { type: "button", class: "btn", id: "btn-add-rule", onclick: () => { s.rules.push({ name: "", topic: "", match: [], action: "notify" }); draw(); touch(); } }, "+ Add a rule") : null].filter(Boolean));
  };
  draw();
  return h("section", { class: "card", id: "rules-card" }, h("h2", { text: "Your rules" }), h("p", { class: "hint", text: "Teach the agent what matters to you. Rules run on every result before it is emailed: alert you, rank it higher, or hide it." }), box);
}

function radarCard(touch) {
  const r = S.settings.radar;
  const on = h("input", { type: "checkbox", id: "radar-on", checked: r.enabled, onchange: (e) => { r.enabled = e.target.checked; areas.disabled = !e.target.checked; touch(); } });
  const areas = h("textarea", { id: "radar-areas", disabled: !r.enabled, "aria-label": "Areas to watch, one per line", oninput: (e) => { r.areas = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean); touch(); } }, (r.areas || []).join("\n"));
  return h("section", { class: "card", id: "radar-card" }, h("h2", { text: "Trend radar" }), h("p", { class: "hint", text: "Once a day the agent looks at what is rising in the areas below and suggests new topics. You decide what joins your plan." }),
    h("div", { class: "body" }, h("label", { class: "check-row", for: "radar-on" }, on, h("span", {}, "Suggest new topics daily")),
      h("div", { class: "field", style: "margin-top:12px" }, h("label", { for: "radar-areas" }, "Areas to watch", h("span", { class: "help", text: "One per line, up to 5. Broad is fine, like \"Healthcare technology\"." })), areas)));
}

function settingsView() {
  const s = S.settings;
  s.rules ||= []; s.notify ||= { digest: false, alerts: true, ideas: true, min_score: 9 }; s.radar ||= { enabled: true, areas: [] };
  const root = h("div", {});
  const touch = () => { updateSavebar(); };
  const rerender = (focusSel) => { const y = scrollY; main.replaceChildren(settingsView()); scrollTo(0, y); if (focusSel) document.querySelector(focusSel)?.focus(); renderHeader(); };

  // When
  const dayChips = h("div", { class: "chips", role: "group", "aria-label": "Days of the week" }, DAYS.map((d, i) =>
    h("label", { class: "chip" }, h("input", { type: "checkbox", checked: s.schedule.days.includes(i), onchange: (e) => {
      const set = new Set(s.schedule.days); e.target.checked ? set.add(i) : set.delete(i); s.schedule.days = [...set].sort(); sum(); touch();
    } }), h("span", { text: d }))));
  const timesBox = h("div", { class: "times" });
  const drawTimes = () => {
    timesBox.replaceChildren(...s.schedule.times.map((t, i) => h("div", { class: "time-row" },
      h("input", { type: "time", value: t, "aria-label": `Time ${i + 1}`, required: true, onchange: (e) => { if (e.target.value) { s.schedule.times[i] = e.target.value; sum(); touch(); } } }),
      s.schedule.times.length > 1 ? h("button", { type: "button", class: "btn danger-quiet", "aria-label": `Remove time ${i + 1}`, onclick: () => { s.schedule.times.splice(i, 1); drawTimes(); sum(); touch(); } }, "Remove") : null)),
      s.schedule.times.length < 6 ? h("button", { type: "button", class: "btn quiet", onclick: () => { s.schedule.times.push("18:00"); drawTimes(); sum(); touch(); } }, "+ Add another time") : null);
  };
  drawTimes();
  const zones = [...new Set([s.schedule.timezone, ...TIME_ZONES])];
  const tzSel = h("select", { id: "tz", onchange: (e) => { s.schedule.timezone = e.target.value; sum(); touch(); } }, zones.map((z) => h("option", { value: z, selected: z === s.schedule.timezone, text: z.replace("_", " ") })));
  const summary = h("p", { class: "summary-line" });
  const sum = () => { summary.textContent = s.schedule.days.length && s.schedule.times.length ? `The agent will run: ${scheduleSentence(s.schedule)}` : "Pick at least one day and one time."; };
  sum();

  // Topics
  const topicsBox = h("div", {});
  const drawTopics = () => {
    topicsBox.replaceChildren(...s.topics.map((t, i) => h("fieldset", { class: "topic-card", style: "border:1px solid var(--rule);margin:0 0 14px;min-width:0" },
      h("legend", { class: "label", text: `Topic ${i + 1}` }),
      h("div", { class: "topic-head" },
        h("div", {}, h("label", { for: `tn${i}`, text: "Name" }), h("input", { type: "text", id: `tn${i}`, value: t.name, maxlength: 80, oninput: (e) => { t.name = e.target.value; touch(); } })),
        s.topics.length > 1 ? h("button", { type: "button", class: "btn danger-quiet", "aria-label": `Delete topic ${t.name || i + 1}`, onclick: () => { if (confirm(`Delete the topic "${t.name}"?`)) { s.topics.splice(i, 1); drawTopics(); touch(); } } }, "Delete") : null),
      h("div", { class: "field" }, h("label", { for: `tg${i}` }, "What counts as a good result?", h("span", { class: "help", text: "Describe it in plain words. The AI uses this to decide what to keep and what to skip." })),
        h("textarea", { id: `tg${i}`, maxlength: 600, oninput: (e) => { t.goal = e.target.value; touch(); } }, t.goal)),
      h("div", { class: "field" }, h("label", { for: `tq${i}` }, "What should it search for?", h("span", { class: "help", text: "One search phrase per line, just like typing into Google. Up to 8." })),
        h("textarea", { id: `tq${i}`, oninput: (e) => { t.queries = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean); touch(); } }, t.queries.join("\n"))),
      h("div", { class: "field" }, h("label", { for: `tf${i}`, text: "How recent?" }),
        h("select", { id: `tf${i}`, onchange: (e) => { t.timelimit = e.target.value; touch(); } }, FRESHNESS.map(([v, l]) => h("option", { value: v, selected: (t.timelimit || "w") === v, text: l })))))),
      s.topics.length < 10 ? h("button", { type: "button", class: "btn", onclick: () => { s.topics.push({ name: "", goal: "", queries: [], timelimit: "w" }); drawTopics(); touch(); document.getElementById(`tn${s.topics.length - 1}`)?.focus(); } }, "+ Add a topic") : null);
  };
  drawTopics();

  // Email + strictness
  const to = h("input", { type: "text", inputmode: "email", id: "to", value: s.email.to, placeholder: "Use the address set in GitHub", autocomplete: "email", oninput: (e) => { s.email.to = e.target.value.trim(); touch(); } });
  const empty = h("input", { type: "checkbox", id: "empty", checked: s.email.send_when_empty, onchange: (e) => { s.email.send_when_empty = e.target.checked; touch(); } });
  const wk = h("input", { type: "checkbox", id: "wk", checked: s.weekly.enabled, onchange: (e) => { s.weekly.enabled = e.target.checked; wkDay.disabled = !e.target.checked; touch(); } });
  const wkDay = h("select", { id: "wkday", "aria-label": "Day for the weekly roundup", disabled: !s.weekly.enabled, onchange: (e) => { s.weekly.day = Number(e.target.value); touch(); } }, DAYS.map((d, i) => h("option", { value: i, selected: i === s.weekly.day, text: d })));
  const out = h("output", { for: "ms", text: String(s.min_score) });
  const label = h("p", { class: "help", style: "margin-top:8px" });
  const setLabel = () => { label.textContent = s.min_score <= 4 ? "Loose: you get more results, some less relevant." : s.min_score <= 7 ? "Balanced: a good mix. Most people keep it here." : "Strict: only the very best matches, you may get fewer emails."; };
  setLabel();
  const ms = h("input", { type: "range", id: "ms", min: 1, max: 10, step: 1, value: s.min_score, oninput: (e) => { s.min_score = Number(e.target.value); out.textContent = String(s.min_score); setLabel(); touch(); } });

  root.append(
    h("section", { class: "card" }, h("h2", { text: "When should it run?" }), h("p", { class: "hint", text: "It checks every 15 minutes, so a run starts at most about 15 minutes after the time you pick." }),
      h("div", { class: "body" },
        h("div", { class: "field" }, h("span", { class: "label", text: "Days" }), dayChips),
        h("div", { class: "field" }, h("span", { class: "label", text: "Times" }), timesBox),
        h("div", { class: "field" }, h("label", { for: "tz", text: "Time zone" }), tzSel), summary)),
    h("section", { class: "card" }, h("h2", { text: "What should it research?" }), h("p", { class: "hint", text: "Each topic becomes its own section in your email." }), h("div", { class: "body" }, topicsBox)),
    h("section", { class: "card" }, h("h2", { text: "Where should the email go?" }), h("p", { class: "hint", text: "Digests are sent from the Gmail account you set up in GitHub." }),
      h("div", { class: "body" }, h("div", { class: "field" }, h("label", { for: "to" }, "Send to", h("span", { class: "help", text: "Up to 5 addresses, separated by commas." })), to),
        h("div", { class: "field" }, h("label", { class: "check-row", for: "empty" }, empty, h("span", {}, "Email me even when nothing new is found", h("span", { class: "help", text: "Off by default, so you only get an email when there is something to read." })))),
        h("div", { class: "field" }, h("label", { class: "check-row", for: "wk" }, wk, h("span", {}, "Also send a weekly roundup", h("span", { class: "help", text: "The best items from the past 7 days, sent after that day's digest." }))), h("div", { style: "margin-top:8px" }, wkDay)),
        h("p", {}, h("button", { type: "button", class: "btn", id: "btn-test", onclick: () => sendTest(to.value.trim()) }, "Send a test email")))),
    h("section", { class: "card" }, h("h2", { text: "How picky should it be?" }), h("p", { class: "hint", text: "The AI gives every result a relevance score from 1 to 10. Only results at or above this number are emailed." }),
      h("div", { class: "body" }, h("label", { for: "ms", text: "Minimum relevance" }), h("div", { class: "range" }, ms, out), label)),
    rulesCard(touch), notifyCard(touch), radarCard(touch),
    h("section", { class: "card" }, h("h2", { text: "This device" }), h("p", { class: "hint", text: "Locking forgets your access key here. Nothing else changes." }),
      h("div", { class: "body" }, h("button", { type: "button", class: "btn", onclick: () => { store.set(""); S.key = ""; S.settings = null; S.locked = true; render(); } }, "Lock this device"))));

  const bar = h("div", { class: "savebar" }, h("span", { class: "msg", id: "savemsg", role: "status" }),
    h("button", { type: "button", class: "btn", id: "btn-discard", onclick: () => { S.settings = clone(S.saved); S.forceDirty = false; rerender(); } }, "Discard changes"),
    h("button", { type: "button", class: "btn primary", id: "btn-save", onclick: save }, "Save changes"));
  root.append(bar);
  queueMicrotask(updateSavebar);
  return root;
}

function updateSavebar() {
  const d = dirty();
  const msg = $("#savemsg"); if (!msg) return;
  if (d) msg.setAttribute("data-dirty", ""); else msg.removeAttribute("data-dirty");
  msg.textContent = d ? "You have unsaved changes." : S.settingsNote || "All changes saved.";
  $("#btn-save").disabled = !d || Boolean(S.busy);
  $("#btn-discard").disabled = !d;
}

async function save() {
  const btn = $("#btn-save"); btn.disabled = true; btn.textContent = "Saving";
  try {
    const r = await api("settings", { method: "PUT", body: { settings: S.settings, sha: S.sha } });
    S.settings = r.settings; S.saved = clone(r.settings); S.sha = r.sha; S.nextRun = r.next_run; S.forceDirty = false;
    S.settingsNote = "Saved just now. The agent uses this from its next run.";
    toast("Saved. The agent will use these settings from its next run.");
  } catch (e) { toast(e.message, "bad", true); }
  btn.textContent = "Save changes";
  renderHeader(); updateSavebar();
}

// ---------- actions ----------
async function togglePause() {
  if (dirty() && !confirm("You have unsaved changes. Pausing or resuming only saves the on/off switch, and unsaved edits are kept on screen. Continue?")) return;
  const next = { ...clone(S.saved), paused: !S.saved.paused };
  try {
    const r = await api("settings", { method: "PUT", body: { settings: next, sha: S.sha } });
    S.saved = clone(r.settings); S.sha = r.sha; S.nextRun = r.next_run;
    S.settings.paused = r.settings.paused;
    toast(r.settings.paused ? "Paused. Nothing will run until you resume." : "Resumed.");
  } catch (e) { toast(e.message, "bad", true); }
  render();
}

async function track(label, since, doneText, { view = "digests", after } = {}) {
  S.busy = label; render();
  const deadline = Date.now() + 15 * 60e3;
  let seen = false;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 7000));
      const { runs } = await api("progress");
      const run = runs.filter((r) => r.event === "workflow_dispatch" && Date.parse(r.created_at) >= since - 20000).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      if (!run) { if (!seen && Date.now() - since > 3 * 60e3) { toast("GitHub has not started the run yet. Check again in a minute.", "bad", true); break; } continue; }
      seen = true;
      if (run.status === "completed") {
        S.busy = "";
        await loadIndex(); await loadIdeas();
        api("push/flush", { method: "POST" }).catch(() => {});
        if (run.conclusion === "success") toast(doneText);
        else toast("The run did not finish properly. Open the newest result for details.", "bad", true);
        if (after) await after();
        S.selected = null; S.view = view;
        return render();
      }
      S.busy = run.status === "queued" ? `${label} Waiting for GitHub to start.` : `${label} Working on it.`; renderHeader();
    }
  } catch (e) { toast(e.message, "bad", true); }
  S.busy = ""; render();
}

async function runNow() {
  const extra = dirty() ? "\n\nYou have unsaved changes. This run uses the last saved settings." : "";
  if (!confirm(`Run the agent now? It takes a few minutes and emails you a digest.${extra}`)) return;
  const since = Date.now();
  try { await api("run", { method: "POST", body: {} }); } catch (e) { return toast(e.message, "bad", true); }
  track("Run started.", since, "Done. The newest results are shown, and the email is on its way.");
}

async function sendTest(to) {
  if (!to) return toast("Type an email address first, then press the button.", "bad");
  const since = Date.now();
  try { await api("test-email", { method: "POST", body: { to } }); } catch (e) { return toast(e.message, "bad", true); }
  track("Sending a test email.", since, `Test email sent to ${to}. Check the inbox (and spam) in a minute.`, { view: S.view });
}

// ---------- boot ----------
function lock() { S.locked = true; S.settings = null; store.set(""); S.key = ""; if (S.status) render(); }

async function loadIndex() {
  try { S.index = await api("data?file=index"); } catch (e) { if (e.status !== 401) toast(e.message, "bad", true); }
}

async function loadAll() {
  const r = await api("settings");
  S.settings = r.settings; S.saved = clone(r.settings); S.sha = r.sha; S.nextRun = r.next_run;
  S.settingsNote = r.missing ? "No saved settings yet. Press Save to create them." : r.broken ? "The saved settings file was unreadable, so defaults are shown." : "";
  S.forceDirty = Boolean(r.missing || r.broken); // nothing valid is saved yet, so offer Save straight away
  await loadIndex(); await loadIdeas();
  const m = /^#run=([\w-]+)$/.exec(location.hash);
  S.selected = m ? m[1] : null;
}

async function boot() {
  try { S.status = await api("status"); }
  catch (e) { S.status = { github_token: true, admin_key: true, repo: "" }; S.locked = true; toast(e.message, "bad", true); return render(); }
  if (S.status.github_token && S.status.admin_key) {
    S.key = store.get();
    if (S.key) { try { await loadAll(); S.locked = false; } catch { S.locked = true; } } else S.locked = true;
  }
  const tab = new URLSearchParams(location.search).get("tab");
  if (!S.locked && ["ideas", "settings", "health"].includes(tab)) S.view = tab;
  render();
}
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", async () => {
  S.view = b.dataset.tab; render();
  if (S.view === "health" && !S.check) { await loadCheck(); if (S.view === "health") render(); }
}));
$("#btn-pause").addEventListener("click", togglePause);
$("#btn-run").addEventListener("click", runNow);
boot();
