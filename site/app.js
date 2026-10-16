// Research digest dashboard. Reads data/index.json and data/digests/*.json written by the agent.
// Everything shown comes from web pages and an AI model, so it is untrusted: the DOM is built with
// textContent only (never innerHTML) and links are limited to http(s).

const TZ = 'Asia/Kolkata';
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const longFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const shortFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
const monthFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, month: 'short' });
const dayNumFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric' });
const noonOf = (key) => new Date(`${key}T12:00:00+05:30`);
const DAY_MS = 86_400_000;

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), strip: $('strip'), digest: $('digest'), runs: $('runs'),
  topics: $('topics'), links: $('links'), updated: $('updated'), cadenceTitle: $('cadence-title'),
};

const state = { index: null, runs: [], byId: new Map(), byDay: new Map(), selectedId: null, days: 30, intro: true };
const digestCache = new Map();

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'vars') for (const [name, val] of Object.entries(v)) el.style.setProperty(name, String(val));
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const safeHref = (raw) => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch { return null; }
};
const toneOf = (status) => (status === 'failed' ? 'bad' : status === 'partial' ? 'warn' : 'ok');
const stateWord = (run) => (run.status === 'failed' ? 'Failed' : run.status === 'partial' ? 'Errors' : run.emailed ? 'Emailed' : 'Quiet');
const kindWord = (kind) => (kind === 'schedule' ? 'scheduled' : kind === 'workflow_dispatch' ? 'manual' : 'local');
const fmt12 = (hhmm) => {
  const [hh, mm] = String(hhmm || '08:00').split(':').map(Number);
  return `${((hh + 11) % 12) + 1}:${String(mm || 0).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
};

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function prepare(index) {
  const runs = (Array.isArray(index.runs) ? index.runs : [])
    .filter((r) => r && typeof r.id === 'string' && !Number.isNaN(Date.parse(r.ran_at)) && typeof r.date === 'string')
    .sort((a, b) => Date.parse(b.ran_at) - Date.parse(a.ran_at));
  state.index = index;
  state.runs = runs;
  state.byId = new Map(runs.map((r) => [r.id, r]));
  state.byDay = new Map();
  for (const r of runs) {
    if (!state.byDay.has(r.date)) state.byDay.set(r.date, []);
    state.byDay.get(r.date).push(r);
  }
}

function repoOk(repo) { return typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo); }

/* Status sentence: answers "did it run today?" without opening anything. */
function renderStatus() {
  const now = new Date();
  const today = dayKey.format(now);
  const sched = state.index.schedule || {};
  const [sh, sm] = String(sched.time_ist || '08:00').split(':').map(Number);
  const [nh, nm] = clockFmt.format(now).split(':').map(Number);
  const nowMin = nh * 60 + nm;
  const dueMin = sh * 60 + (sm || 0);
  const due = fmt12(sched.time_ist);
  const todays = state.byDay.get(today);
  const repo = state.index.repo;
  const actions = repoOk(repo) ? { href: `https://github.com/${repo}/actions`, label: 'Open the Actions page' } : null;

  let tone = 'idle', text, link = null;
  if (todays) {
    const r = todays[0];
    const at = `${timeFmt.format(new Date(r.ran_at))} IST`;
    const n = r.items || 0;
    if (r.status === 'failed') { tone = 'bad'; text = `Today's run failed at ${at}. The email did not go out.`; link = actions; }
    else if (r.status === 'partial') { tone = 'warn'; text = `Ran today at ${at} with errors. ${plural(n, 'new item', 'new items')}.`; }
    else if (n === 0) { tone = 'ok'; text = `Ran today at ${at} and found nothing new.`; }
    else { tone = 'ok'; text = `Ran today at ${at}. ${plural(n, 'new item', 'new items')}${r.emailed ? ', emailed to you' : ', not emailed'}.`; }
  } else if (state.runs.length === 0) {
    if (nowMin < dueMin) text = `No runs yet. The first one is due today at ${due} IST.`;
    else { tone = nowMin < dueMin + 180 ? 'warn' : 'bad'; text = `No runs recorded yet. It was due at ${due} IST. GitHub can start a new schedule hours late.`; link = actions; }
  } else if (nowMin < dueMin) {
    text = `The next run is due today at ${due} IST. The last one was ${longFmt.format(new Date(state.runs[0].ran_at))}.`;
  } else if (nowMin < dueMin + 180) {
    tone = 'warn'; text = `Today's run is late. It was due at ${due} IST, and GitHub often starts scheduled runs late.`; link = actions;
  } else {
    tone = 'bad'; text = `No run recorded today. It was due at ${due} IST.`; link = actions;
  }

  const parts = [
    h('span', { class: 'dot', 'data-tone': tone, 'aria-hidden': 'true' }),
    h('span', { text }),
  ];
  if (link) parts.push(h('a', { href: link.href, target: '_blank', rel: 'noopener noreferrer', text: link.label }));
  els.status.replaceChildren(...parts);
}

/* The 30-day strip */
function renderStrip() {
  const days = state.days;
  const today = dayKey.format(new Date());
  const todayMs = noonOf(today).getTime();
  const keys = Array.from({ length: days }, (_, i) => dayKey.format(new Date(todayMs - (days - 1 - i) * DAY_MS)));
  const maxItems = Math.max(1, ...keys.map((k) => Math.max(0, ...(state.byDay.get(k) || []).map((r) => r.items || 0))));
  const selected = state.byId.get(state.selectedId);
  const withRun = keys.filter((k) => state.byDay.has(k));
  const focusKey = selected && withRun.includes(selected.date) ? selected.date : withRun[withRun.length - 1];

  els.cadenceTitle.textContent = `Last ${days} days`;
  els.strip.style.setProperty('--days', String(days));
  els.strip.classList.toggle('intro', state.intro);

  const items = keys.map((key, i) => {
    const runs = state.byDay.get(key) || [];
    const noon = noonOf(key);
    const dayNum = dayNumFmt.format(noon);
    const sub = key === today ? 'today' : (i === 0 || dayNum === '1') ? monthFmt.format(noon) : null;
    const label = h('span', { class: 'lbl', 'aria-hidden': 'true' }, dayNum, sub ? h('span', { class: 'sub', text: sub }) : null);
    const li = h('li', { 'data-today': key === today || null, 'data-selected': selected && selected.date === key || null });
    if (runs.length === 0) {
      li.append(
        h('div', { class: 'gap' }, h('span', { class: 'tick' })),
        h('span', { class: 'sr', text: `${shortFmt.format(noon)}: no run` }),
        label,
      );
      return li;
    }
    const run = runs[0];
    const name = `${shortFmt.format(noon)}: ${plural(run.items || 0, 'new item', 'new items')}, ${stateWord(run).toLowerCase()}${runs.length > 1 ? `, ${runs.length} runs` : ''}`;
    const frac = Math.max(0.1, (run.items || 0) / maxItems);
    li.append(
      h('button', {
        type: 'button', class: 'col', title: name, 'aria-label': name,
        'aria-current': selected && selected.date === key ? 'true' : null,
        tabindex: key === focusKey ? '0' : '-1', 'data-day': key,
        onclick: () => showRun(run.id),
      }, h('span', { class: 'bar', 'data-tone': toneOf(run.status), vars: { '--h': `${(frac * 100).toFixed(1)}%`, '--i': i } })),
      label,
    );
    return li;
  });
  els.strip.replaceChildren(...items);
  state.intro = false;
}

function onStripKey(e) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const buttons = [...els.strip.querySelectorAll('button.col')];
  const at = buttons.indexOf(document.activeElement);
  if (at === -1) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
    : Math.min(buttons.length - 1, Math.max(0, at + (e.key === 'ArrowRight' ? 1 : -1)));
  buttons.forEach((b, i) => b.setAttribute('tabindex', i === next ? '0' : '-1'));
  buttons[next].focus();
}

function renderRuns() {
  if (state.runs.length === 0) {
    els.runs.replaceChildren(h('li', {}, h('p', { class: 'updated', text: 'Runs will be listed here.' })));
    return;
  }
  els.runs.replaceChildren(...state.runs.map((r) => {
    const d = new Date(r.ran_at);
    return h('li', {}, h('button', {
      type: 'button', class: 'run', 'aria-current': r.id === state.selectedId ? 'true' : null, onclick: () => showRun(r.id),
    },
    h('b', { text: `${shortFmt.format(d)}, ${timeFmt.format(d)}` }),
    h('small', { text: `${plural(r.items || 0, 'new item', 'new items')}, ${kindWord(r.kind)}` }),
    h('span', { class: 'state', 'data-tone': toneOf(r.status), text: stateWord(r) })));
  }));
}

function renderTopics() {
  const topics = Array.isArray(state.index.topics) ? state.index.topics : [];
  els.topics.replaceChildren(...topics.map((t) => h('div', { class: 'topic-def' },
    h('h3', { text: String(t.name || '') }),
    t.goal ? h('p', { text: String(t.goal) }) : null,
    Array.isArray(t.queries) && t.queries.length
      ? h('details', {}, h('summary', { text: `Search phrases (${t.queries.length})` }), h('ul', {}, t.queries.map((q) => h('li', { text: String(q) }))))
      : null)));

  const repo = state.index.repo;
  const links = repoOk(repo) ? [
    [`https://github.com/${repo}/actions/workflows/research-agent.yml`, 'Run it now on GitHub'],
    [`https://github.com/${repo}/edit/main/config.yaml`, 'Edit topics on GitHub'],
  ] : [];
  els.links.replaceChildren(...links.map(([href, text]) => h('li', {}, h('a', { href, target: '_blank', rel: 'noopener noreferrer', text }))));

  if (state.index.updated && !Number.isNaN(Date.parse(state.index.updated))) {
    const d = new Date(state.index.updated);
    els.updated.textContent = `Data from ${shortFmt.format(d)}, ${timeFmt.format(d)} IST. Topic edits show here after the next run.`;
  }
}

async function getDigest(run) {
  if (digestCache.has(run.id)) return digestCache.get(run.id);
  if (!/^digests\/[A-Za-z0-9_-]+\.json$/.test(String(run.file))) throw new Error('bad file name');
  const data = await loadJson(`data/${run.file}`);
  digestCache.set(run.id, data);
  return data;
}

function itemNode(item) {
  const href = safeHref(item.url);
  const title = String(item.title || item.url || 'Untitled');
  const score = Number(item.score);
  return h('article', { class: 'item' },
    h('h4', {}, href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: title }) : title),
    h('div', { class: 'meta' },
      h('span', { class: 'domain', text: String(item.domain || '') }),
      item.score != null && Number.isFinite(score)
        ? h('span', { class: 'score', role: 'img', 'aria-label': `Score ${score} out of 10` },
          h('span', { class: 'track' }, h('span', { class: 'fill', vars: { '--s': Math.min(1, Math.max(0, score / 10)) } })),
          h('span', { 'aria-hidden': 'true', text: `${score}/10` }))
        : h('span', { text: 'Unranked' })),
    item.summary ? h('p', { class: 'summary', text: String(item.summary) }) : null,
    item.why ? h('p', { class: 'why' }, h('strong', { text: 'Why it matters: ' }), String(item.why)) : null);
}

function renderDigest(run, data) {
  const d = new Date(run.ran_at);
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const problems = [...(Array.isArray(data.errors) ? data.errors : []), ...(data.error ? [`Sending the email failed (${data.error}).`] : [])];
  const fact = (k, v) => h('div', {}, h('dt', { text: k }), h('dd', { text: v }));

  const nodes = [
    h('div', { class: 'digest-head' },
      h('h2', { text: longFmt.format(d) }),
      h('dl', { class: 'facts' },
        fact('Ran at', `${timeFmt.format(d)} IST`),
        fact('Trigger', kindWord(run.kind)),
        fact('New items', String(run.items || 0)),
        fact('Model', run.llm || 'none answered'),
        fact('Email', run.emailed ? 'sent' : 'not sent'))),
  ];

  if (problems.length) {
    nodes.push(h('div', { class: 'notice', 'data-tone': run.status === 'failed' ? 'bad' : 'warn' },
      h('h3', { text: 'This run had problems' }),
      h('ul', {}, problems.map((p) => h('li', { text: String(p) })))));
  }
  if (Array.isArray(data.tldr) && data.tldr.length) {
    nodes.push(h('div', { class: 'tldr' }, h('h3', { text: 'In short' }), h('ul', {}, data.tldr.map((t) => h('li', { text: String(t) })))));
  }
  for (const s of sections) {
    nodes.push(h('section', { class: 'topic' }, h('h3', { text: String(s.name || '') }), (s.items || []).map(itemNode)));
  }
  if (!sections.length && !problems.length) {
    nodes.push(h('div', { class: 'notice' },
      h('h3', { text: 'Nothing new this run' }),
      h('p', { text: 'Everything the agent read had already been sent, or scored below your minimum.' })));
  }
  els.digest.replaceChildren(...nodes);
}

function renderEmpty() {
  const repo = state.index.repo;
  els.digest.replaceChildren(h('div', { class: 'notice' },
    h('h3', { text: 'No digests yet' }),
    h('p', { text: 'The first digest appears here after the next run.' }),
    repoOk(repo)
      ? h('p', {}, h('a', { href: `https://github.com/${repo}/actions/workflows/research-agent.yml`, target: '_blank', rel: 'noopener noreferrer', text: 'Run it now on GitHub' }), ' by choosing Run workflow.')
      : null));
}

async function showRun(id) {
  const run = state.byId.get(id);
  if (!run) return;
  state.selectedId = id;
  renderStrip();
  renderRuns();
  try { history.replaceState(null, '', `#run=${encodeURIComponent(id)}`); } catch { /* ignore */ }
  els.digest.setAttribute('aria-busy', 'true');
  try {
    const data = await getDigest(run);
    if (state.selectedId === id) renderDigest(run, data);
  } catch {
    if (state.selectedId === id) {
      els.digest.replaceChildren(h('div', { class: 'notice', 'data-tone': 'warn' },
        h('h3', { text: "Couldn't load this run" }),
        h('p', { text: 'The digest file is missing or still being published. Try again in a minute.' })));
    }
  } finally {
    els.digest.removeAttribute('aria-busy');
  }
}

function showLoadError() {
  els.status.replaceChildren(h('span', { class: 'dot', 'data-tone': 'bad', 'aria-hidden': 'true' }), h('span', { text: "Couldn't load the run data." }));
  els.digest.replaceChildren(h('div', { class: 'notice', 'data-tone': 'bad' },
    h('h3', { text: 'The data file did not load' }),
    h('p', {}, 'If you opened this page as a file, serve the folder instead: run ', h('code', { text: 'python3 -m http.server' }), ' inside the site folder and open localhost:8000.'),
    h('p', { text: 'On the hosted site, check that data/index.json exists in the latest deploy.' })));
}

function pickDays() { return window.matchMedia('(min-width: 640px)').matches ? 30 : 14; }

async function init() {
  let index;
  try { index = await loadJson('data/index.json'); } catch { showLoadError(); return; }
  prepare(index);
  state.days = pickDays();
  const hash = new URLSearchParams(location.hash.slice(1)).get('run');
  const first = (hash && state.byId.has(hash)) ? hash : state.runs[0]?.id;
  state.selectedId = first || null;

  renderStatus();
  renderStrip();
  renderRuns();
  renderTopics();
  if (first) await showRun(first); else renderEmpty();

  els.strip.addEventListener('keydown', onStripKey);
  window.matchMedia('(min-width: 640px)').addEventListener('change', () => { state.days = pickDays(); renderStrip(); });
  // Keep the "did it run today" sentence honest if the tab stays open.
  setInterval(renderStatus, 60_000);
}

init();
