import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getDatabase, connectDatabaseEmulator, ref, update, get, onValue, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import { TEAMS, TEAM_BY_CODE, DEFAULT_LINES, DEFAULT_LOCK_AT, SEASON_LABEL, GAMES_PER_TEAM } from './teams.js';
import { teamPace, pickStatus, leaderboard, seasonProgress } from './scoring.js';
import { makeApi, UserError, normalizeCode } from './api.js';

// ---------- setup ----------
const $app = document.getElementById('app');
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const useEmulator = isLocal && new URLSearchParams(location.search).has('emulator');
const config = useEmulator
  ? { apiKey: 'demo', projectId: 'demo-swou', databaseURL: 'http://127.0.0.1:9000?ns=demo-swou-default-rtdb' }
  : firebaseConfig;

if (!config) {
  $app.innerHTML = `<section class="card"><h1>Almost there</h1>
    <p>This site isn't connected to a database yet. Paste your Firebase config into
    <code>js/firebase-config.js</code> (see the README).</p></section>`;
  throw new Error('No Firebase config');
}
const db = getDatabase(initializeApp(config));
if (useEmulator) connectDatabaseEmulator(db, '127.0.0.1', 9000);
const api = makeApi({ ref, update, get, onValue, serverTimestamp }, db);

// ---------- state ----------
const STALE_DAYS = 9;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const S = {
  db: { config: null, lines: null, players: null, picks: null, manualStandings: null },
  dbReady: false,
  dbError: null,
  file: null,               // standings.json
  me: store.get('swou:me'), // {id, name, code}
  adminCode: store.get('swou:admin'),
  pending: {},              // pid -> {team: 'O'|'U'|null} not yet saved
  saveState: '',            // '', 'saving', 'saved', or an error message
  shownCode: null,          // code to show once after join/claim/reset
  ui: store.get('swou:ui') || { conf: 'All', sort: 'line' },
};

const lines = () => ({ ...DEFAULT_LINES, ...(S.db.lines || {}) });
const lockAt = () => S.db.config?.lockAt ?? DEFAULT_LOCK_AT;
const isLocked = () => Date.now() >= lockAt();
const players = () => Object.entries(S.db.players || {}).map(([id, p]) => ({
  id, name: p.name, picks: { ...(S.db.picks?.[id] || {}), ...stripNulls(S.pending[id]) },
  pendingClears: S.pending[id] || {},
}));
function stripNulls(o) { return Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v)); }
function picksFor(pid) {
  const p = { ...(S.db.picks?.[pid] || {}) };
  for (const [t, v] of Object.entries(S.pending[pid] || {})) { if (v) p[t] = v; else delete p[t]; }
  return p;
}

/** Newer of the automatic feed and the admin's hand-entered standings. */
function standings() {
  const file = S.file ? { teams: S.file.teams, at: Date.parse(S.file.updatedAt), source: S.file.source } : null;
  const man = S.db.manualStandings?.teams ? { teams: S.db.manualStandings.teams, at: S.db.manualStandings.updatedAt, source: 'manual' } : null;
  const pick = !file ? man : !man ? file : (man.at > file.at ? man : file);
  return pick || { teams: {}, at: null, source: null };
}

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt1 = n => (Math.round(n * 10) / 10).toFixed(1);
const fmtDate = (ms, tz) => new Date(ms).toLocaleString(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short',
});
const STATUS = {
  won: { icon: '✓', label: 'locked in' },
  ahead: { icon: '▲', label: 'on pace' },
  even: { icon: '–', label: 'even' },
  behind: { icon: '▼', label: 'behind' },
  lost: { icon: '✕', label: 'out of reach' },
};
const ORDER = ['won', 'ahead', 'even', 'behind', 'lost'];
const SOURCE_NAMES = { espn: 'ESPN', nbaSchedule: 'NBA.com', manual: 'entered by admin', seed: 'not yet fetched' };

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { prompt('Copy this:', text); }
}

// ---------- views ----------
function masthead() {
  const st = standings();
  const prog = seasonProgress(st.teams);
  const pct = Math.round(prog.pct * 1000) / 10;
  const stale = isLocked() && st.at && (Date.now() - st.at) > STALE_DAYS * 864e5;
  const updated = st.at ? `${fmtDate(st.at)} · ${esc(SOURCE_NAMES[st.source] || st.source)}` : 'not yet';
  return `<header class="mast">
    <p class="kicker">NBA ${SEASON_LABEL}</p>
    <h1>Season Wins Over/Under</h1>
    <div class="progress" role="img" aria-label="Season ${pct}% complete, ${prog.games} of 1,230 games">
      <div class="progress-fill" style="width:${prog.pct * 100}%"></div>
    </div>
    <p class="progress-label"><strong>${pct}%</strong> · ${prog.games.toLocaleString()} of 1,230 games</p>
    <p class="updated ${stale ? 'stale' : ''}">${stale ? '⚠ Standings are more than 9 days old. ' : ''}Standings updated ${updated}</p>
  </header>`;
}

function cta() {
  const locked = isLocked();
  const lockLine = locked
    ? `<p class="lockline">🔒 Picks locked ${fmtDate(lockAt(), 'America/New_York')}</p>`
    : `<p class="lockline">Picks lock <strong>${fmtDate(lockAt(), 'America/New_York')}</strong>${countdown()}</p>`;
  if (S.me && S.db.players?.[S.me.id]) {
    const n = Object.keys(picksFor(S.me.id)).length;
    return `<section class="cta">${lockLine}
      <a class="btn primary" href="#/picks">${locked ? 'View my picks' : 'Edit my picks'} · ${n} of 30</a>
      <span class="who">Playing as <strong>${esc(S.db.players[S.me.id].name)}</strong></span></section>`;
  }
  if (locked) return `<section class="cta">${lockLine}</section>`;
  return `<section class="cta">${lockLine}
    <a class="btn primary" href="#/join">Join the game</a>
    <a class="btn ghost" href="#/signin">I already joined</a></section>`;
}
function countdown() {
  const ms = lockAt() - Date.now();
  if (ms <= 0 || ms > 14 * 864e5) return '';
  const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60;
  return ` · in ${d ? d + 'd ' : ''}${h}h ${m}m`;
}

function legend() {
  return `<ul class="legend" aria-label="Legend">${ORDER.map(s =>
    `<li><span class="sw s-${s}" aria-hidden="true"></span>${STATUS[s].icon} ${STATUS[s].label}</li>`).join('')}</ul>`;
}

function leaderboardView() {
  const ps = players();
  if (!ps.length) return `<section class="card"><h2>Leaderboard</h2><p class="muted">No one has joined yet. Be first!</p></section>`;
  const st = standings();
  const rows = leaderboard(lines(), st.teams, ps);
  const locked = isLocked();
  const items = rows.map(r => {
    const segs = ORDER.filter(s => r.counts[s]).map(s =>
      `<span class="seg s-${s}" style="flex:${r.counts[s]}" title="${STATUS[s].label}: ${r.counts[s]}"></span>`).join('');
    const gap = r.counts.unpicked ? `<span class="seg s-none" style="flex:${r.counts.unpicked}" title="not picked: ${r.counts.unpicked}"></span>` : '';
    const counts = ORDER.map(s => `<span class="c c-${s}" title="${STATUS[s].label}"><b aria-hidden="true">${STATUS[s].icon}</b> ${r.counts[s]}<span class="sr"> ${STATUS[s].label}</span></span>`).join('')
      + (r.counts.unpicked ? `<span class="c">${r.counts.unpicked} unpicked</span>` : '');
    const mine = S.me?.id === r.id ? ' mine' : '';
    const detail = locked ? playerDetail(r, st) : `<p class="muted small">Picks are hidden until the lock. ${30 - r.counts.unpicked} of 30 picked.</p>`;
    return `<li class="lb-row${mine}">
      <details><summary>
        <span class="rank">${r.rank}</span>
        <span class="lb-main">
          <span class="lb-name">${esc(r.name)}</span>
          <span class="lb-score"><strong>${r.onTrack}</strong> of 30 picks on track</span>
          <span class="stack" role="img" aria-label="${ORDER.map(s => `${r.counts[s]} ${STATUS[s].label}`).join(', ')}">${segs}${gap}</span>
          <span class="counts">${counts}</span>
        </span>
      </summary>${detail}</details></li>`;
  }).join('');
  return `<section class="card"><h2>Leaderboard</h2>${legend()}<ol class="lb">${items}</ol>
    <p class="muted small">On track = locked in + on pace. Tap a name to see their picks.</p></section>`;
}

function playerDetail(r, st) {
  const L = lines();
  const groups = ORDER.map(s => {
    const teams = Object.entries(r.statuses).filter(([, v]) => v === s).map(([c]) => c);
    if (!teams.length) return '';
    return `<p class="pd"><span class="c c-${s}"><b>${STATUS[s].icon}</b> ${STATUS[s].label}</span> ${teams.map(c =>
      `<span class="chip">${c} ${players().find(p => p.id === r.id).picks[c]} ${L[c]}</span>`).join(' ')}</p>`;
  }).join('');
  return `<div class="detail">${groups || '<p class="muted small">No picks.</p>'}</div>`;
}

function teamsView() {
  const st = standings();
  const L = lines();
  const locked = isLocked();
  const ps = players();
  let teams = TEAMS.filter(t => S.ui.conf === 'All' || t.conf === S.ui.conf).map(t => {
    const s = st.teams[t.code] || { w: 0, l: 0 };
    return { ...t, pace: teamPace(L[t.code], s.w, s.l) };
  });
  const sorters = {
    line: (a, b) => b.pace.line - a.pace.line,
    delta: (a, b) => b.pace.delta - a.pace.delta,
    name: (a, b) => a.name.localeCompare(b.name),
  };
  teams.sort(sorters[S.ui.sort] || sorters.line);
  const filters = `<div class="filters" role="group" aria-label="Filter teams">
    ${['All', 'East', 'West'].map(c => `<button class="pill" data-conf="${c}" aria-pressed="${S.ui.conf === c}">${c}</button>`).join('')}
    <label class="sort">Sort <select data-sort>
      ${[['line', 'Line'], ['delta', 'Vs pace'], ['name', 'Name']].map(([v, n]) => `<option value="${v}" ${S.ui.sort === v ? 'selected' : ''}>${n}</option>`).join('')}
    </select></label></div>`;
  const rows = teams.map(t => {
    const p = t.pace, max = p.line * 1.25;
    const pctW = Math.min(100, (p.wins / max) * 100);
    const pctLine = 80;
    const pctPace = Math.min(100, ((p.gp / GAMES_PER_TEAM) * p.line / max) * 100);
    let note;
    if (p.overClinched) note = `<span class="c c-won">✓ Over clinched</span>`;
    else if (p.underClinched) note = `<span class="c c-lost">✕ Under clinched</span>`;
    else if (p.gp === 0) note = `<span class="muted">No games yet</span>`;
    else if (Math.abs(p.delta) < 1e-9) note = `– exactly on pace`;
    else note = `${p.delta > 0 ? '▲' : '▼'} ${fmt1(Math.abs(p.delta))} wins ${p.delta > 0 ? 'ahead of' : 'behind'} pace`;
    const proj = p.projected == null ? '' : ` · on pace for ${fmt1(p.projected)}`;
    let who = '';
    if (locked && ps.length) {
      const side = side => ps.filter(x => x.picks[t.code] === side).map(x =>
        `<span class="nm${S.me?.id === x.id ? ' me' : ''}">${esc(x.name)}</span>`).join(', ') || '<span class="muted">nobody</span>';
      who = `<p class="who-picked"><span class="tag">O</span> ${side('O')} <span class="tag">U</span> ${side('U')}</p>`;
    }
    const tip = `${t.name}: ${p.wins}–${p.losses}. Line ${p.line}. Pace target now ${fmt1(p.expected)} wins.`;
    return `<li class="team">
      <div class="team-head"><span class="team-name">${esc(t.name)}</span>
        <span class="team-meta">${t.conf} · <strong>${p.wins}–${p.losses}</strong> · ${p.gp} GP</span></div>
      <div class="pace" role="img" aria-label="${esc(tip)}" title="${esc(tip)}">
        <div class="pace-fill" style="width:${pctW}%"></div>
        <div class="pace-line" style="left:${pctLine}%"><span>${p.line}</span></div>
        ${p.gp ? `<div class="pace-marker" style="left:${pctPace}%"></div>` : ''}
      </div>
      <p class="team-note">${note}${proj}</p>${who}</li>`;
  }).join('');
  return `<section class="card"><h2>Team pace</h2>
    <p class="muted small">Bar = wins so far (scale 0–125% of the line). Dashed tick = the line.
    <span class="key-marker" aria-hidden="true"></span> Orange marker = where a team finishing exactly on its line would be now.</p>
    ${filters}<ul class="teams">${rows}</ul></section>`;
}

function boardView() {
  const err = S.dbError ? `<p class="banner err">Can't reach the database: ${esc(S.dbError)}</p>` : '';
  return masthead() + err + cta() + leaderboardView() + teamsView();
}

// --- join / sign in ---
function joinView() {
  if (S.shownCode) return codeShownView();
  if (isLocked()) return `<section class="card"><h1>Picks are locked</h1><p>The season has started, so new players can't join. Ask the admin if you need to be added.</p><a class="btn" href="#/">Back to board</a></section>`;
  return `<section class="card"><h1>Join the game</h1>
    <form id="join-form" class="form">
      <label for="name">Your name (what your friends will see)</label>
      <input id="name" name="name" autocomplete="nickname" minlength="2" maxlength="24" required autofocus>
      <p class="muted small">2–24 characters. Must be unique.</p>
      <button class="btn primary" type="submit">Join</button>
      <p class="form-err" role="alert"></p>
    </form>
    <p class="muted small">Already joined on another device? <a href="#/signin">Sign in with your edit code</a>.</p></section>`;
}
function codeShownView() {
  const { code, title, next } = S.shownCode;
  return `<section class="card"><h1>${esc(title)}</h1>
    <p>Your edit code:</p>
    <p class="code">${esc(code)}</p>
    <button class="btn" data-copy="${esc(code)}">Copy code</button>
    <p class="warn">Save this somewhere (a note, or message it to yourself). You need it to edit your picks from another device. It won't be shown again.</p>
    <a class="btn primary" href="${next}" data-done-code>I saved it, continue</a></section>`;
}
function signinView() {
  return `<section class="card"><h1>Sign in</h1>
    <form id="signin-form" class="form">
      <label for="sname">Name</label><input id="sname" name="name" required>
      <label for="scode">Edit code</label><input id="scode" name="code" required autocomplete="off" autocapitalize="characters" spellcheck="false">
      <button class="btn primary" type="submit">Sign in</button>
      <p class="form-err" role="alert"></p>
    </form>
    <p class="muted small">Lost your code? Ask the admin to reset it.</p></section>`;
}

// --- pick sheet ---
function picksView(pid) {
  const asAdmin = pid && pid !== S.me?.id;
  pid = pid || S.me?.id;
  if (!pid || !S.db.players?.[pid]) {
    return `<section class="card"><h1>My picks</h1><p>You're not signed in on this device.</p>
      <a class="btn primary" href="#/join">Join the game</a> <a class="btn ghost" href="#/signin">Sign in with code</a></section>`;
  }
  if (asAdmin && !S.adminCode) return `<section class="card"><p>Admin sign-in needed.</p><a class="btn" href="#/admin">Admin</a></section>`;
  const locked = isLocked();
  const canEdit = asAdmin || !locked;
  const picks = picksFor(pid);
  const L = lines();
  const n = Object.keys(picks).length;
  const sorted = [...TEAMS].sort((a, b) => L[b.code] - L[a.code] || a.name.localeCompare(b.name));
  const save = S.saveState === 'saving' ? 'Saving…' : S.saveState === 'saved' ? 'Saved ✓' : S.saveState ? `⚠ ${esc(S.saveState)}` : '';
  const rows = sorted.map(t => {
    const v = picks[t.code];
    return `<li class="pick-row">
      <span class="pr-team"><span class="pr-name">${esc(t.name)}</span><span class="muted small">${t.conf}</span></span>
      <span class="pr-line">${L[t.code]}</span>
      <span class="pr-btns">
        <button class="ou o" data-pick="${t.code}" data-v="O" aria-pressed="${v === 'O'}" ${canEdit ? '' : 'disabled'} aria-label="${esc(t.name)} over ${L[t.code]}">Over</button>
        <button class="ou u" data-pick="${t.code}" data-v="U" aria-pressed="${v === 'U'}" ${canEdit ? '' : 'disabled'} aria-label="${esc(t.name)} under ${L[t.code]}">Under</button>
      </span></li>`;
  }).join('');
  return `<section class="card picks" data-pid="${pid}">
    <h1>${asAdmin ? `Editing ${esc(S.db.players[pid].name)} (admin)` : 'My picks'}</h1>
    ${locked && !asAdmin ? `<p class="banner">🔒 Picks are locked. Good luck!</p>` :
      `<p class="muted small">Tap Over or Under for each team. Tap again to clear. Saves automatically. Lock: ${fmtDate(lockAt(), 'America/New_York')}.</p>`}
    <div class="picks-bar"><strong>${n} of 30 picked</strong><span class="save" role="status">${save}</span></div>
    <ul class="pick-list">${rows}</ul>
    ${asAdmin ? '<a class="btn" href="#/admin">Back to admin</a>' : `<p class="muted small">Playing as ${esc(S.db.players[pid].name)} · <button class="link" data-signout>Sign out on this device</button></p>`}
  </section>`;
}

let saveTimer = null;
function queuePick(pid, team, v) {
  const current = picksFor(pid)[team];
  const next = current === v ? null : v;
  S.pending[pid] = { ...(S.pending[pid] || {}), [team]: next };
  S.saveState = 'saving';
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush(pid), 700);
}
async function flush(pid) {
  const changes = S.pending[pid];
  if (!changes || !Object.keys(changes).length) return;
  const asSelf = pid === S.me?.id && (!isLocked() || !S.adminCode);
  const auth = asSelf ? { id: S.me.id, code: S.me.code } : { id: 'admin', code: S.adminCode };
  try {
    await api.savePicks(pid, changes, auth);
    // Drop only what we sent (more taps may have arrived meanwhile).
    for (const [t, v] of Object.entries(changes)) if (S.pending[pid]?.[t] === v) delete S.pending[pid][t];
    S.saveState = 'saved';
  } catch (e) {
    S.saveState = /permission/i.test(e.message)
      ? (isLocked() && auth.id !== 'admin' ? 'Picks are locked' : "Couldn't save: your edit code may be wrong. Sign in again.")
      : "Couldn't save, try again";
    if (isLocked() && auth.id !== 'admin') S.pending[pid] = {};
  }
  render();
}

// --- how it works ---
function rulesView() {
  return `<section class="card prose"><h1>How it works</h1>
    <p>Each NBA team has a win-total line (always ending in .5, so no pushes). Pick <b>Over</b> or <b>Under</b> for all 30 teams before the first tip-off. Picks lock ${fmtDate(lockAt(), 'America/New_York')}.</p>
    <h2>Scoring during the season</h2>
    <ul>
      <li><b>✓ Locked in</b>: your side is clinched (team already passed the line, or can't reach it).</li>
      <li><b>▲ On pace</b>: the team is running ahead of the pace your pick needs.</li>
      <li><b>– Even</b>: exactly on pace (or no games yet).</li>
      <li><b>▼ Behind</b>: pace is going the other way, but it's not over.</li>
      <li><b>✕ Out of reach</b>: the other side is clinched.</li>
    </ul>
    <p>"Pace" compares wins so far to <i>line × games played ÷ 82</i>. Your score is <b>locked in + on pace</b>. After all 82 games every pick is either locked in or out of reach, and your final score is how many you got right.</p>
    <p>Ties: more locked-in picks ranks higher; players tied on both share a rank.</p>
    <h2>Your edit code</h2>
    <p>No accounts. When you join you get a random edit code. This device remembers it. Save it to edit from another device. Lost it? Ask the admin to reset it.</p>
  </section>`;
}

// --- admin ---
function adminView() {
  if (S.shownCode) return codeShownView();
  if (!S.adminCode) {
    return `<section class="card"><h1>Admin</h1>
      <form id="admin-form" class="form">
        <label for="acode">Admin code</label>
        <input id="acode" name="code" required autocomplete="off" autocapitalize="characters" spellcheck="false">
        <button class="btn primary" type="submit">Sign in as admin</button>
        <p class="form-err" role="alert"></p>
      </form>
      <details class="setup"><summary>First-time setup</summary>
        <p class="small">The first person to press this becomes the admin for good. Do it once, right after the site goes live, before sharing the link.</p>
        <button class="btn" data-claim>Claim admin</button>
      </details></section>`;
  }
  const L = lines();
  const st = standings();
  const lock = new Date(lockAt());
  const localIso = new Date(lock.getTime() - lock.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  const ps = players().sort((a, b) => a.name.localeCompare(b.name));
  return `<section class="card"><h1>Admin</h1>
    <p class="small">Signed in as admin on this device. <button class="link" data-admin-signout>Sign out</button></p></section>

    <section class="card"><h2>Win total lines</h2>
      <p class="small warn">Seeded from Fanatics (Oct 15), not FanDuel. Check each against FanDuel and fix here before the lock. Every line must end in .5.</p>
      <form id="lines-form" class="grid-form">
        ${[...TEAMS].sort((a, b) => a.code.localeCompare(b.code)).map(t => `<label><span>${t.code}</span>
          <input name="${t.code}" type="number" inputmode="decimal" step="1" min="0.5" max="81.5" value="${L[t.code]}" required></label>`).join('')}
        <button class="btn primary" type="submit">Save lines</button><p class="form-err" role="alert"></p>
      </form></section>

    <section class="card"><h2>Lock time</h2>
      <p class="small">Currently ${fmtDate(lockAt(), 'America/New_York')} (${fmtDate(lockAt())} your time). First tip: Celtics at Pistons, Tue Oct 20, 3:00 PM ET. Enforced by the database.</p>
      <form id="lock-form" class="form inline"><input type="datetime-local" name="at" value="${localIso}" required>
        <button class="btn" type="submit">Save lock time</button><p class="form-err" role="alert"></p></form></section>

    <section class="card"><h2>Standings by hand</h2>
      <p class="small">Use only if the automatic weekly update breaks. Whichever is newer wins: your manual entry, or the next automatic update.
      Current source: ${esc(SOURCE_NAMES[st.source] || st.source || 'none')}${st.at ? ', ' + fmtDate(st.at) : ''}.</p>
      <form id="standings-form" class="grid-form standings">
        ${[...TEAMS].sort((a, b) => a.code.localeCompare(b.code)).map(t => {
          const s = st.teams[t.code] || { w: 0, l: 0 };
          return `<label><span>${t.code}</span><input name="${t.code}-w" type="number" min="0" max="82" value="${s.w}" aria-label="${t.code} wins">
            <input name="${t.code}-l" type="number" min="0" max="82" value="${s.l}" aria-label="${t.code} losses"></label>`;
        }).join('')}
        <button class="btn primary" type="submit">Save standings</button>
        ${S.db.manualStandings ? '<button class="btn ghost" type="button" data-clear-manual>Remove manual standings</button>' : ''}
        <p class="form-err" role="alert"></p>
      </form></section>

    <section class="card"><h2>Players (${ps.length})</h2>
      <ul class="admin-players">${ps.map(p => `<li data-pid="${p.id}" data-name="${esc(p.name)}">
        <strong>${esc(p.name)}</strong> <span class="muted small">${Object.keys(picksFor(p.id)).length}/30</span>
        <span class="admin-actions">
          <a class="btn sm" href="#/picks/${p.id}">Edit picks</a>
          <button class="btn sm" data-reset>Reset code</button>
          <button class="btn sm" data-rename>Rename</button>
          <button class="btn sm danger" data-delete>Delete</button>
        </span></li>`).join('') || '<li class="muted">No players yet.</li>'}</ul></section>`;
}

// ---------- router / render ----------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  return { page: page || 'board', arg };
}
function render({ live = false } = {}) {
  // Background updates (database, standings file, timers) must not wipe a form the user is typing in.
  const a = document.activeElement;
  if (live && a && $app.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
  if (!S.dbReady && !S.dbError) { $app.innerHTML = '<p class="loading">Loading…</p>'; return; }
  const { page, arg } = route();
  const view = { board: boardView, join: joinView, signin: signinView, picks: () => picksView(arg), rules: rulesView, admin: adminView }[page] || boardView;
  const y = window.scrollY;
  // Preserve open <details> across live re-renders.
  const open = [...$app.querySelectorAll('details[open]')].map(d => d.closest('[data-pid],li')?.querySelector('.lb-name')?.textContent).filter(Boolean);
  $app.innerHTML = view();
  $app.querySelectorAll('.lb-row').forEach(li => { if (open.includes(li.querySelector('.lb-name')?.textContent)) li.querySelector('details').open = true; });
  window.scrollTo(0, y);
}
addEventListener('hashchange', () => { S.saveState = ''; render(); window.scrollTo(0, 0); });

// ---------- events ----------
$app.addEventListener('click', async e => {
  const b = e.target.closest('button, a');
  if (!b) return;
  if (b.dataset.pick) {
    const pid = b.closest('[data-pid]').dataset.pid;
    queuePick(pid, b.dataset.pick, b.dataset.v);
  } else if (b.dataset.conf) {
    S.ui.conf = b.dataset.conf; store.set('swou:ui', S.ui); render();
  } else if ('copy' in b.dataset) {
    copy(b.dataset.copy);
  } else if ('doneCode' in b.dataset) {
    S.shownCode = null;
    if (location.hash === b.getAttribute('href')) render();
  } else if ('signout' in b.dataset) {
    if (confirm('Sign out on this device? You will need your edit code to sign back in.')) { S.me = null; store.set('swou:me', null); location.hash = '#/'; }
  } else if ('adminSignout' in b.dataset) {
    S.adminCode = null; store.set('swou:admin', null); render();
  } else if ('claim' in b.dataset) {
    try {
      const code = await api.claimAdmin();
      S.adminCode = code; store.set('swou:admin', code);
      // Save the seed lines into the database so they're visible and editable.
      await api.setLines(code, DEFAULT_LINES);
      S.shownCode = { code, title: "You're the admin", next: '#/admin' };
      render();
    } catch (err) { toast(err instanceof UserError ? err.message : 'Failed: ' + err.message); }
  } else if ('clearManual' in b.dataset) {
    await adminDo(() => api.clearManualStandings(S.adminCode), 'Manual standings removed');
  } else if (b.closest('.admin-players li')) {
    const li = b.closest('li'); const pid = li.dataset.pid; const name = li.dataset.name;
    if ('reset' in b.dataset) {
      if (!confirm(`Give ${name} a new edit code? Their old code stops working.`)) return;
      await adminDo(async () => {
        const code = await api.resetPlayerCode(S.adminCode, pid);
        S.shownCode = { code, title: `New code for ${name}`, next: '#/admin' };
      });
    } else if ('rename' in b.dataset) {
      const nn = prompt(`New name for ${name}:`, name);
      if (nn && nn !== name) await adminDo(() => api.renamePlayer(S.adminCode, pid, name, nn), 'Renamed');
    } else if ('delete' in b.dataset) {
      if (confirm(`Delete ${name} and all their picks? This can't be undone.`)) await adminDo(() => api.deletePlayer(S.adminCode, pid, name), 'Deleted');
    }
  }
});
$app.addEventListener('change', e => {
  if (e.target.matches('[data-sort]')) { S.ui.sort = e.target.value; store.set('swou:ui', S.ui); render(); }
});

async function adminDo(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (err) {
    const msg = err instanceof UserError ? err.message : /permission/i.test(err.message) ? 'Denied. Is your admin code right? Values valid?' : err.message;
    toast(msg); return false;
  }
  render(); return true;
}

$app.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const errEl = f.querySelector('.form-err');
  const fail = m => { if (errEl) errEl.textContent = m; };
  const btn = f.querySelector('[type=submit]');
  const data = Object.fromEntries(new FormData(f));
  btn.disabled = true;
  try {
    if (f.id === 'join-form') {
      const { id, code } = await api.join(data.name);
      S.me = { id, code, name: data.name.trim() }; store.set('swou:me', S.me);
      S.shownCode = { code, title: "You're in!", next: '#/picks' };
      document.activeElement.blur(); render();
    } else if (f.id === 'signin-form') {
      const id = await api.findPlayerId(data.name);
      if (!id) return fail('No player with that name.');
      const code = normalizeCode(data.code);
      if (!(await api.verify(id, code))) return fail("That code doesn't match. Check it, or ask the admin to reset it.");
      S.me = { id, code, name: data.name.trim() }; store.set('swou:me', S.me);
      document.activeElement.blur(); location.hash = '#/picks';
    } else if (f.id === 'admin-form') {
      const code = normalizeCode(data.code);
      if (!(await api.verify('admin', code))) return fail('Wrong admin code.');
      S.adminCode = code; store.set('swou:admin', code);
      document.activeElement.blur(); render();
    } else if (f.id === 'lines-form') {
      const out = {};
      for (const t of TEAMS) {
        const v = Number(data[t.code]);
        if (!(v > 0 && v < 82 && v % 1 === 0.5)) return fail(`${t.code}: line must end in .5 (got ${data[t.code]})`);
        out[t.code] = v;
      }
      document.activeElement.blur();
      if (await adminDo(() => api.setLines(S.adminCode, out), 'Lines saved')) fail('');
    } else if (f.id === 'lock-form') {
      const ms = new Date(data.at).getTime();
      if (!Number.isFinite(ms)) return fail('Invalid date');
      document.activeElement.blur();
      await adminDo(() => api.setLockAt(S.adminCode, ms), 'Lock time saved');
    } else if (f.id === 'standings-form') {
      const teams = {};
      for (const t of TEAMS) {
        const w = Number(data[`${t.code}-w`]), l = Number(data[`${t.code}-l`]);
        if (!Number.isInteger(w) || !Number.isInteger(l) || w < 0 || l < 0 || w + l > 82) return fail(`${t.code}: bad record ${w}-${l}`);
        teams[t.code] = { w, l };
      }
      const W = Object.values(teams).reduce((s, x) => s + x.w, 0), Lo = Object.values(teams).reduce((s, x) => s + x.l, 0);
      if (W !== Lo && !confirm(`League wins (${W}) and losses (${Lo}) don't match. Save anyway?`)) return;
      document.activeElement.blur();
      await adminDo(() => api.setManualStandings(S.adminCode, teams), 'Standings saved');
    }
  } catch (err) {
    fail(err instanceof UserError ? err.message : `Something went wrong: ${err.message}`);
  } finally { btn.disabled = false; }
});

// ---------- data ----------
api.subscribe(state => { S.db = { ...S.db, ...state }; S.dbReady = true; S.dbError = null; render({ live: true }); },
  err => { S.dbError = err.message; render({ live: true }); });
async function loadFile() {
  try {
    const r = await fetch(`standings.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) { S.file = await r.json(); render({ live: true }); }
  } catch { /* offline; keep last */ }
}
loadFile();
setInterval(loadFile, 30 * 60e3);
setInterval(() => { if (route().page === 'board') render({ live: true }); }, 60e3); // countdown + lock flip
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadFile(); });
