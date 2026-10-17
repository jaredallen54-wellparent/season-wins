import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getDatabase, connectDatabaseEmulator, ref, update, get, onValue, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
import { getAuth, connectAuthEmulator, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';
import { TEAMS, DEFAULT_LINES, DEFAULT_LOCK_AT, GAMES_PER_TEAM, LEAGUE_GAMES } from './teams.js';
import { teamPace, pickStatus, leaderboard, seasonProgress, LOCKS_PER_PLAYER } from './scoring.js';
import { makeApi, UserError, normalizeCode } from './api.js';

// ---------- setup ----------
const $app = document.getElementById('app');
const $mast = document.getElementById('mast');
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const useEmulator = isLocal && new URLSearchParams(location.search).has('emulator');
const config = useEmulator
  ? { apiKey: 'demo', projectId: 'demo-swou', databaseURL: 'http://127.0.0.1:9000?ns=demo-swou-default-rtdb' }
  : firebaseConfig;

if (!config) {
  $app.innerHTML = `<div class="card"><h3>Almost there</h3>
    <p class="note">This site isn't connected to a database yet. Paste your Firebase config into
    <code>js/firebase-config.js</code> (see the README).</p></div>`;
  throw new Error('No Firebase config');
}
const fbApp = initializeApp(config);
const db = getDatabase(fbApp);
const auth = getAuth(fbApp);
if (useEmulator) { connectDatabaseEmulator(db, '127.0.0.1', 9000); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); }
const api = makeApi({ ref, update, get, onValue, serverTimestamp }, db);

// ---------- state ----------
const STALE_DAYS = 9;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// Arriving from the old github.io address: take over that device's saved sign-in, then tidy the URL.
(function importFromOldAddress() {
  const m = location.hash.match(/^#\/import\/(.+)$/);
  if (!m) return;
  let to = '#/';
  try {
    const { carry, to: dest } = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
    for (const [k, v] of Object.entries(carry || {})) {
      if (/^swou:(me|admin|ui)$/.test(k) && typeof v === 'string' && localStorage.getItem(k) == null) localStorage.setItem(k, v);
    }
    if (typeof dest === 'string' && /^#\/[\w/-]*$/.test(dest)) to = dest;
  } catch { /* bad link: ignore */ }
  history.replaceState(null, '', location.pathname + location.search + to);
})();
const S = {
  db: { config: null, lines: null, players: null, picks: null, manualStandings: null },
  dbReady: false,
  offset: 0,                // server clock minus this phone's clock (ms)
  uid: null,                // this phone's anonymous sign-in id
  authError: null,
  device: store.get('swou:device'), // "playerId:uid" once this phone is registered to the player
  picksMode: 'none',        // which picks we're listening to: 'none' | 'mine' (before the lock) | 'all' (after)
  picksLoaded: false,       // first answer received for the current mode
  picksError: null,
  dbError: null,
  file: null,               // standings.json
  me: store.get('swou:me'), // {id, name, code}
  adminCode: store.get('swou:admin'),
  pending: {},              // pid -> {team: 'O'|'U'|null} not yet saved
  pendingLocks: {},         // pid -> [team, ...] full lock list not yet saved
  saveState: '',            // '', 'saving', 'saved', or an error message
  shownCode: null,          // code to show once after join/claim/reset
  confirmDelete: null,
  ui: { conf: 'All', sort: 'line', ...(store.get('swou:ui') || {}) },
};

const lines = () => ({ ...DEFAULT_LINES, ...(S.db.lines || {}) });
const lockAt = () => S.db.config?.lockAt ?? DEFAULT_LOCK_AT;
// The database rules use the server's clock, so the page does too (phones' clocks can be off).
const serverNow = () => Date.now() + (S.offset || 0);
const isLocked = () => serverNow() >= lockAt();
function picksFor(pid) {
  const p = { ...(S.db.picks?.[pid] || {}) };
  for (const [t, v] of Object.entries(S.pending[pid] || {})) { if (v) p[t] = v; else delete p[t]; }
  return p;
}
/** The player's locks (up to 3), including unsaved changes, limited to teams they've picked. */
function locksFor(pid) {
  const saved = Object.values(S.db.locks?.[pid] || {});
  const picks = picksFor(pid);
  return (S.pendingLocks[pid] ?? saved).filter(c => picks[c]);
}
const players = () => Object.entries(S.db.players || {}).map(([id, p]) => ({ id, name: p.name, picks: picksFor(id), locks: locksFor(id) }));
const LOCK = '🔒';
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const meJoined = () => !!(S.me && S.db.players?.[S.me.id]);

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
const lockText = () => fmtDate(lockAt(), 'America/New_York');
const GLYPH = { won: '✓', ahead: '▲', even: '–', behind: '▼', lost: '✕' };
const WORD = { won: 'clinched', ahead: 'on pace', even: 'even', behind: 'behind pace', lost: 'out of reach' };
const SHORT = { won: 'clinched', ahead: 'on pace', even: 'even', behind: 'behind', lost: 'out' };
const ORDER = ['won', 'ahead', 'even', 'behind', 'lost'];
const SOURCE_NAMES = { espn: 'ESPN', nbaSchedule: 'NBA.com', manual: 'entered by admin', seed: 'season not started' };
const glyph = s => `<i class="glyph s-${s}" aria-hidden="true">${GLYPH[s]}</i>`;

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { prompt('Copy this:', text); }
}

// ---------- masthead ----------
function renderMast() {
  const st = standings();
  const prog = seasonProgress(st.teams);
  const pct = Math.round(prog.pct * 1000) / 10;
  const stale = isLocked() && st.at && (Date.now() - st.at) > STALE_DAYS * 864e5;
  const lockLine = isLocked() ? `Picks locked ${lockText()}` : `Picks lock ${lockText()}${countdown()}`;
  const upd = st.at && st.source !== 'seed' ? `Standings updated ${fmtDate(st.at)} (${esc(SOURCE_NAMES[st.source] || st.source)})` : '';
  $mast.innerHTML = `<div>
      <p class="eyebrow">NBA 2026–27 · 82 games</p>
      <h1>Season Wins Over/Under</h1>
      <p class="sub">${lockLine}</p>
      ${stale ? `<p class="sub stale">⚠ Standings are more than ${STALE_DAYS} days old. ${upd}</p>` : upd ? `<p class="sub">${upd}</p>` : ''}
    </div>
    <div class="progress">
      <div class="progress-top"><span>Season elapsed</span><span><b>${pct}%</b> · ${prog.games.toLocaleString()} of ${LEAGUE_GAMES.toLocaleString()} games</span></div>
      <div class="ptrack" role="img" aria-label="${pct} percent of the regular season played"><span style="width:${prog.pct * 100}%"></span></div>
    </div>`;
}
function countdown() {
  const ms = lockAt() - Date.now();
  if (ms <= 0 || ms > 14 * 864e5) return '';
  const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60;
  return ` · ${d ? d + 'd ' : ''}${h}h ${m}m to go`;
}

// ---------- board ----------
function introView() {
  const locked = isLocked();
  let cta;
  if (meJoined()) {
    const sm = S.db.summary?.[S.me.id] || { picked: 0, locks: 0 };
    const n = S.picksLoaded ? Object.keys(picksFor(S.me.id)).length : sm.picked;
    const k = S.picksLoaded ? locksFor(S.me.id).length : sm.locks;
    const todo = !locked && (n < 30 || k < LOCKS_PER_PLAYER) ? ` <b>Still to do:</b> ${[n < 30 ? `${30 - n} pick${30 - n === 1 ? '' : 's'}` : '', k < LOCKS_PER_PLAYER ? `${LOCKS_PER_PLAYER - k} lock${LOCKS_PER_PLAYER - k === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}.` : '';
    cta = `<a class="btn primary" href="#/picks">${locked ? 'View my picks' : 'Edit my picks'} · ${n}/30 · ${LOCK} ${k}/${LOCKS_PER_PLAYER}</a>
      <span>Playing as <b>${esc(S.db.players[S.me.id].name)}</b>.${todo}</span>`;
  } else if (!locked) {
    cta = `<a class="btn primary" href="#/join">Join the game</a><a class="btn ghost" href="#/signin">I already joined</a>
      <span>No account needed, just a name.</span>`;
  } else {
    cta = `<span>Picks are locked for the season. Follow along below.</span>`;
  }
  return `<section class="intro" aria-labelledby="intro-h">
    <div class="intro-head"><h2 id="intro-h">How it works</h2><a class="small" href="#/rules">Full rules</a></div>
    <ol class="steps">
      <li><div><b>Pick all 30, lock 3</b>Pick Over or Under on every team's win total (like 47.5). Then mark your 3 most confident picks as ${LOCK} locks.</div></li>
      <li><div><b>Picks lock at tip-off</b>${lockText()}. After that, nobody can change them.</div></li>
      <li><div><b>Score points</b>Each right pick is +1. A right lock is +2, but a wrong lock is −1. Through the season, picks count at their current pace. Most points at the end wins.</div></li>
    </ol>
    <div class="intro-cta">${cta}</div>
  </section>`;
}

function bannersView() {
  const st = standings();
  const games = seasonProgress(st.teams).games;
  let out = '';
  if (S.dbError) out += `<div class="banner"><b>Can't reach the database.</b> ${esc(S.dbError)}</div>`;
  if (games === 0) out += `<div class="banner"><b>The season hasn't tipped off.</b> Every team is 0–0, so every pick shows as even until games are played.${isLocked() ? '' : ' Everyone\'s picks stay hidden until the lock.'}</div>`;
  return out;
}

function keyView() {
  return `<ul class="key" aria-label="Pick status key">${ORDER.map(s => `<li>${glyph(s)}${WORD[s][0].toUpperCase() + WORD[s].slice(1)}</li>`).join('')}</ul>`;
}

function leaderboardView() {
  const ps = players();
  const head = `<div class="sec-head"><h2>Leaderboard</h2>
    <p class="hint">Points if every team finished at its current pace: +1 per pick on track, and ${LOCK} locks +2 on track or −1 off track. Clinched picks are final.</p></div>`;
  if (!ps.length) return head + `<ol class="lb"><li class="empty"><b>No players yet</b>Be the first: tap Join the game above.</li></ol>`;
  const locked = isLocked();
  if (!locked) return head + preLockBoard(ps);
  if (!S.picksLoaded) return head + `<ol class="lb"><li class="empty"><b>${S.picksError ? 'Revealing everyone\u2019s picks…' : 'Loading picks…'}</b>${S.picksError ? 'The picks just unlocked. This page will keep trying, no need to refresh.' : ''}</li></ol>`;
  const st = standings();
  const rows = leaderboard(lines(), st.teams, ps);
  const items = rows.map(r => {
    const c = r.counts;
    const segs = ORDER.map(s => c[s] ? `<span class="sg-${s}" style="flex:${c[s]}"></span>` : '').join('')
      + (c.unpicked ? `<span class="sg-none" style="flex:${c.unpicked}"></span>` : '');
    const counts = ORDER.map(s => `<span>${glyph(s)}<b>${c[s]}</b> ${SHORT[s]}</span>`).join('')
      + (c.unpicked ? `<span>${c.unpicked} unpicked</span>` : '');
    const you = S.me?.id === r.id ? ' <small>(you)</small>' : '';
    const pts = r.points === 1 || r.points === -1 ? 'point' : 'points';
    const row = `<div class="lb-row"><div class="rk" aria-label="Rank ${r.rank}">${r.rank}</div><div style="min-width:0">
        <div class="lb-top"><span class="lb-name">${esc(r.name)}${you}</span><span class="lb-score"><b>${r.points}</b>${pts} · ${r.onTrack} of 30 on track</span></div>
        <div class="stack" role="img" aria-label="${ORDER.map(s => `${c[s]} ${WORD[s]}`).join(', ')}${c.unpicked ? `, ${c.unpicked} unpicked` : ''}">${segs}</div>
        <div class="lb-counts">${counts}</div></div></div>`;
    return `<li><details data-pid="${r.id}"><summary>${row}</summary>${playerDetail(r)}</details></li>`;
  }).join('');
  return head + keyView() + `<ol class="lb">${items}</ol>`;
}

/** Before the lock: who has joined and how far along they are, from the public counts. No picks. */
function preLockBoard(ps) {
  const items = [...ps].sort(byName).map(p => {
    const sm = S.db.summary?.[p.id];
    const mine = S.me?.id === p.id;
    const n = mine && S.picksLoaded ? Object.keys(picksFor(p.id)).length : sm?.picked;
    const k = mine && S.picksLoaded ? locksFor(p.id).length : sm?.locks;
    const counts = n == null ? 'Picks hidden until the lock'
      : `${n} of 30 picked · <span class="${k < LOCKS_PER_PLAYER ? 'lk-need' : ''}">${LOCK} ${k} of ${LOCKS_PER_PLAYER} locks</span>${n === 30 && k === LOCKS_PER_PLAYER ? ' · ready ✓' : ''}`;
    return `<li><div class="lb-row"><div class="rk" aria-hidden="true">·</div><div style="min-width:0">
      <div class="lb-top"><span class="lb-name">${esc(p.name)}${mine ? ' <small>(you)</small>' : ''}</span></div>
      <div class="stack" role="img" aria-label="${n ?? 0} of 30 picked">${n ? `<span class="sg-ahead" style="flex:${n}"></span>` : ''}${30 - (n || 0) ? `<span class="sg-none" style="flex:${30 - (n || 0)}"></span>` : ''}</div>
      <div class="lb-counts"><span>${counts}</span></div></div></div></li>`;
  }).join('');
  return `<p class="note" style="margin:-4px 0 12px">Everyone's picks and locks are hidden until ${lockText()}, then shown here with live points.</p><ol class="lb">${items}</ol>`;
}

function playerDetail(r) {
  const L = lines();
  const pk = picksFor(r.id);
  const lk = new Set(r.locks);
  const locksLine = r.locks.length ? `<div class="grp"><span class="grp-l">${LOCK} Locks</span>${r.locks.map(c => {
    const s = r.statuses[c];
    return `<span class="chip lock s-${s}"><i aria-hidden="true">${GLYPH[s]}</i><span>${c} ${pk[c]} ${L[c]}</span><span class="sr-only"> lock, ${WORD[s]}</span></span>`;
  }).join('')}</div>` : '';
  const groups = ORDER.map(s => {
    const teams = Object.entries(r.statuses).filter(([, v]) => v === s).map(([c]) => c).sort();
    if (!teams.length) return '';
    return `<div class="grp"><span class="grp-l">${WORD[s]}</span>${teams.map(c =>
      `<span class="chip s-${s}${lk.has(c) ? ' lock' : ''}" title="${c} ${pk[c] === 'O' ? 'Over' : 'Under'} ${L[c]}${lk.has(c) ? ' (lock)' : ''}"><i aria-hidden="true">${GLYPH[s]}</i><span>${c} ${pk[c]} ${L[c]}</span></span>`).join('')}</div>`;
  }).join('');
  return `<div class="lb-detail">${locksLine}${groups || '<p class="none">No picks.</p>'}</div>`;
}

function teamsView() {
  const st = standings();
  const L = lines();
  const locked = isLocked();
  const ps = players().sort(byName);
  const rows = TEAMS.filter(t => S.ui.conf === 'All' || t.conf === S.ui.conf).map(t => {
    const s = st.teams[t.code] || { w: 0, l: 0 };
    const pace = { ...teamPace(L[t.code], s.w, s.l), code: t.code };
    const o = ps.filter(p => p.picks[t.code] === 'O'), u = ps.filter(p => p.picks[t.code] === 'U');
    return { t, pace, o, u };
  });
  const cmp = {
    line: (a, b) => b.pace.line - a.pace.line,
    ahead: (a, b) => b.pace.delta - a.pace.delta || b.pace.line - a.pace.line,
    behind: (a, b) => a.pace.delta - b.pace.delta || b.pace.line - a.pace.line,
    split: (a, b) => Math.min(b.o.length, b.u.length) - Math.min(a.o.length, a.u.length) || b.pace.line - a.pace.line,
    name: (a, b) => a.t.name.localeCompare(b.t.name),
  };
  const sortOpts = [['line', 'Highest line'], ['ahead', 'Most ahead of pace'], ['behind', 'Most behind pace'], ...(locked ? [['split', 'Most divided picks']] : []), ['name', 'Team A–Z']];
  if (!sortOpts.some(([v]) => v === S.ui.sort)) S.ui.sort = 'line';
  rows.sort(cmp[S.ui.sort]);
  const chip = (p, v, pace) => {
    const s = pickStatus(pace, v);
    const isLock = p.locks.includes(pace.code);
    return `<span class="chip s-${s}${S.me?.id === p.id ? ' me' : ''}${isLock ? ' lock' : ''}" title="${esc(p.name)}: ${v === 'O' ? 'Over' : 'Under'} ${pace.line}${isLock ? ' (lock)' : ''}, ${WORD[s]}"><i aria-hidden="true">${GLYPH[s]}</i><span>${esc(p.name)}</span><span class="sr-only">${isLock ? ' lock,' : ''} ${WORD[s]}</span></span>`;
  };
  const html = rows.map(({ t, pace: p, o, u }) => {
    const max = p.line * 1.25;
    const fill = Math.min(100, (p.wins / max) * 100);
    const mk = Math.min(100, ((p.gp / GAMES_PER_TEAM) * p.line / max) * 100);
    let d;
    if (p.gp === 0) d = '<small>No games played yet</small>';
    else if (p.delta > 0.049) d = `<span>${glyph('ahead')} <b>${fmt1(p.delta)}</b> wins ahead of pace</span>`;
    else if (p.delta < -0.049) d = `<span>${glyph('behind')} <b>${fmt1(-p.delta)}</b> wins behind pace</span>`;
    else d = `<span>${glyph('even')} Right on pace</span>`;
    if (p.projected != null) d += `<small>on pace for ${fmt1(p.projected)} wins</small>`;
    if (p.overClinched) d += '<span class="tag">Over clinched</span>';
    else if (p.underClinched) d += '<span class="tag">Under clinched</span>';
    const aria = `${t.name}: ${p.wins} wins, pace marker ${fmt1(p.expected)}, line ${p.line}`;
    let picksCol;
    if (!ps.length) picksCol = '';
    else if (!locked) {
      const mine = S.me && picksFor(S.me.id)[t.code];
      picksCol = `<p class="none">Everyone's picks are revealed at the lock.${mine ? ` You picked <b>${mine === 'O' ? 'Over' : 'Under'}</b>${locksFor(S.me.id).includes(t.code) ? ` ${LOCK}` : ''}.` : ''}</p>`;
    } else if (!S.picksLoaded) {
      picksCol = '<p class="none">Revealing picks…</p>';
    } else {
      picksCol = `<div class="grp"><span class="grp-l">Over</span>${o.map(x => chip(x, 'O', p)).join('') || '<span class="none">No one</span>'}</div>
        <div class="grp"><span class="grp-l">Under</span>${u.map(x => chip(x, 'U', p)).join('') || '<span class="none">No one</span>'}</div>`;
    }
    return `<article class="team">
      <div><h3>${esc(t.name)}</h3><div class="t-meta">${t.conf} · <b>${p.wins}–${p.losses}</b> · ${p.gp} GP</div></div>
      <div><div class="bar" role="img" aria-label="${esc(aria)}" title="${esc(aria)}"><span class="fill" style="width:${fill.toFixed(2)}%"></span><span class="ln" style="left:80%"></span>${p.gp ? `<span class="mk" style="left:${mk.toFixed(2)}%"></span>` : ''}</div>
        <div class="cap"><span>${p.wins} wins${p.gp ? ` · pace marker ${fmt1(p.expected)}` : ''}</span><span>Line ${p.line}</span></div>
        <div class="t-delta">${d}</div></div>
      <div>${picksCol}</div>
    </article>`;
  }).join('');
  return `<div class="sec-head"><h2>Team pace</h2>
      <div class="controls">
        <div class="seg-ctl" role="group" aria-label="Conference">${['All', 'East', 'West'].map(c => `<button type="button" data-conf="${c}" aria-pressed="${S.ui.conf === c}">${c}</button>`).join('')}</div>
        <label class="sel">Sort <select data-sort>${sortOpts.map(([v, n]) => `<option value="${v}" ${S.ui.sort === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div></div>
    <div class="legend" aria-label="Bar key">
      <span><i class="lg-fill"></i>Wins so far</span>
      <span><i class="lg-mk"></i>Where the team should be by now if it finishes right on its line</span>
      <span><i class="lg-ln"></i>The win total line</span>
    </div>
    <div class="teams">${html}</div>`;
}

function boardView() {
  return introView() + bannersView() + leaderboardView() + teamsView();
}

// ---------- join / sign in ----------
function joinView() {
  if (S.shownCode) return codeShownView();
  if (isLocked()) return `<div class="card"><h3>Picks are locked</h3><p class="note">The season has started, so new players can't join. Ask the admin if you need to be added.</p><a class="btn ghost" href="#/">Back to the board</a></div>`;
  return `<div class="sec-head"><h2>Join the game</h2></div>
    <div class="card"><form id="join-form" class="form">
      <label for="name">Your name in the game</label>
      <input type="text" id="name" name="name" autocomplete="nickname" minlength="2" maxlength="24" required autofocus>
      <p class="note">2–24 characters, and nobody else can have it. Your friends will see it.</p>
      <button class="btn primary" type="submit">Join</button>
      <p class="form-err" role="alert"></p>
    </form></div>
    <p class="note">Already joined on another phone? <a href="#/signin">Sign in with your edit code</a>.</p>`;
}
function codeShownView() {
  const { code, title, next } = S.shownCode;
  return `<div class="sec-head"><h2>${esc(title)}</h2></div>
    <div class="card"><p>Your edit code:</p>
    <p class="code">${esc(code)}</p>
    <button class="btn ghost" data-copy="${esc(code)}">Copy code</button>
    <p class="warnbox">Save this somewhere (a note, or message it to yourself). This device remembers it, but you'll need it to sign in on any other phone or computer.</p>
    <a class="btn primary" href="${next}" data-done-code>I saved it, continue</a></div>`;
}
function signinView() {
  return `<div class="sec-head"><h2>Sign in</h2></div>
    <div class="card"><form id="signin-form" class="form">
      <label for="sname">Name</label><input type="text" id="sname" name="name" required>
      <label for="scode">Edit code</label><input type="text" id="scode" name="code" required autocomplete="off" autocapitalize="characters" spellcheck="false">
      <button class="btn primary" type="submit">Sign in</button>
      <p class="form-err" role="alert"></p>
    </form></div>
    <p class="note">Lost your code? Ask the admin to reset it.</p>`;
}

// ---------- pick sheet ----------
function picksView(pid) {
  const asAdmin = !!pid && pid !== S.me?.id;
  pid = pid || S.me?.id;
  if (!pid || !S.db.players?.[pid]) {
    return `<div class="sec-head"><h2>My picks</h2></div>
      <div class="pk-list"><div class="empty"><b>${isLocked() ? 'Picks are locked' : "You're not signed in on this device"}</b>
      ${isLocked() ? 'Sign in to see your picks.' : 'Join the game to start picking, or sign in with your edit code.'}
      <div class="row-form" style="justify-content:center;margin-top:14px">${isLocked() ? '' : '<a class="btn primary" href="#/join">Join the game</a>'}<a class="btn ghost" href="#/signin">Sign in with code</a></div></div></div>`;
  }
  if (asAdmin && !S.adminCode) return `<div class="card"><p>Admin sign-in needed.</p><a class="btn" href="#/admin">Admin</a></div>`;
  const locked = isLocked();
  if (asAdmin && !locked) return `<div class="sec-head"><h2>Editing ${esc(S.db.players[pid].name)}</h2></div>
    <div class="card"><p>Picks are hidden from everyone until ${lockText()}, the admin included. You can fix a player's picks after the lock.</p><a class="btn ghost" href="#/admin">Back to admin</a></div>`;
  if (!S.picksLoaded) {
    const why = S.authError ? `This phone couldn't sign in to the game (${esc(S.authError)}). Ask the admin to switch on Anonymous sign-in.`
      : S.picksError && !locked ? esc(S.picksError) : 'Loading your picks…';
    return `<div class="sec-head"><h2>${asAdmin ? `Editing ${esc(S.db.players[pid].name)}` : 'My picks'}</h2></div>
      <div class="pk-list"><div class="empty"><b>${why}</b>${S.picksError && !locked ? '<div class="row-form" style="justify-content:center;margin-top:12px"><a class="btn ghost" href="#/signin">Sign in with code</a></div>' : ''}</div></div>`;
  }
  const canEdit = asAdmin || !locked;
  const picks = picksFor(pid);
  const L = lines();
  const n = Object.keys(picks).length;
  const myLocks = locksFor(pid);
  const k = myLocks.length;
  const sorted = [...TEAMS].sort((a, b) => L[b.code] - L[a.code] || a.name.localeCompare(b.name));
  const save = S.saveState === 'saving' ? 'Saving…' : S.saveState === 'saved' ? 'Saved ✓' : S.saveState ? `⚠ ${esc(S.saveState)}` : (locked && !asAdmin ? 'Picks are locked' : 'Picks are open');
  const rows = sorted.map(t => {
    const v = picks[t.code];
    const isLock = myLocks.includes(t.code);
    const lockOff = !canEdit || !v || (!isLock && k >= LOCKS_PER_PLAYER);
    return `<div class="pk${isLock ? ' is-lock' : ''}"><div class="pk-n"><b>${esc(t.name)}</b><small>${t.conf} · win total ${L[t.code]}${isLock ? ` · <span class="lk-note">${LOCK} lock</span>` : ''}</small></div>
      <div class="pk-ctl"><div class="tg" role="group" aria-label="${esc(t.name)} pick">
        <button type="button" data-pick="${t.code}" data-v="O" aria-pressed="${v === 'O'}" ${canEdit ? '' : 'disabled'}>Over</button>
        <button type="button" data-pick="${t.code}" data-v="U" aria-pressed="${v === 'U'}" ${canEdit ? '' : 'disabled'}>Under</button>
      </div><button type="button" class="lockbtn" data-lock="${t.code}" aria-pressed="${isLock}" aria-label="Make ${esc(t.name)} a lock" title="${!v ? 'Pick a side first' : isLock ? 'Remove lock' : k >= LOCKS_PER_PLAYER ? 'All 3 locks used' : 'Make this a lock'}" ${lockOff ? 'disabled' : ''}>${LOCK}</button></div></div>`;
  }).join('');
  return `<div class="sec-head"><h2>${asAdmin ? `Editing ${esc(S.db.players[pid].name)}` : 'My picks'}</h2>
      <p class="hint">${locked && !asAdmin ? 'Locked in for the season. Good luck!' : `Pick Over or Under for every team, then tap ${LOCK} on your ${LOCKS_PER_PLAYER} most confident picks (+2 if right, −1 if wrong). Tap a selection again to clear it. Saves automatically. Picks lock ${lockText()}.`}</p></div>
    <div data-pid="${pid}">
      <div class="pk-head"><span><b>${esc(S.db.players[pid].name)}</b> · ${n} of 30 picked · <span class="${k < LOCKS_PER_PLAYER && !locked ? 'lk-need' : ''}">${LOCK} ${k} of ${LOCKS_PER_PLAYER} locks</span></span><span role="status">${save}</span></div>
      <div class="pk-list">${rows}</div>
    </div>
    <p class="note" style="margin-top:14px">${asAdmin ? '<a href="#/admin">Back to admin</a>' : `Playing as ${esc(S.db.players[pid].name)} · <button class="link" data-show-code="me">Show my edit code</button> · <button class="link" data-signout>Sign out on this device</button>`}</p>`;
}

let saveTimer = null;
function scheduleSave(pid) {
  S.saveState = 'saving';
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush(pid), 700);
}
function queuePick(pid, team, v) {
  const next = picksFor(pid)[team] === v ? null : v;
  const locks = locksFor(pid);
  S.pending[pid] = { ...(S.pending[pid] || {}), [team]: next };
  if (!next && locks.includes(team)) S.pendingLocks[pid] = locks.filter(c => c !== team); // clearing a pick drops its lock
  scheduleSave(pid);
}
function toggleLock(pid, team) {
  const locks = locksFor(pid);
  if (locks.includes(team)) S.pendingLocks[pid] = locks.filter(c => c !== team);
  else if (!picksFor(pid)[team]) return toast('Pick Over or Under first.');
  else if (locks.length >= LOCKS_PER_PLAYER) return toast(`All ${LOCKS_PER_PLAYER} locks used. Remove one first.`);
  else S.pendingLocks[pid] = [...locks, team];
  scheduleSave(pid);
}
async function flush(pid) {
  const changes = { ...(S.pending[pid] || {}) };
  const locks = S.pendingLocks[pid];
  if (!Object.keys(changes).length && !locks) return;
  const asSelf = pid === S.me?.id && (!isLocked() || !S.adminCode);
  const auth = asSelf ? { id: S.me.id, code: S.me.code } : { id: 'admin', code: S.adminCode };
  try {
    const knowAll = S.picksLoaded && (S.picksMode === 'all' || (S.picksMode === 'mine' && pid === S.me?.id));
    await api.savePicks(pid, changes, auth, locks, knowAll ? summaryFor(pid) : undefined);
    // Drop only what we sent (more taps may have arrived meanwhile).
    for (const [t, v] of Object.entries(changes)) if (S.pending[pid]?.[t] === v) delete S.pending[pid][t];
    if (S.pendingLocks[pid] === locks) delete S.pendingLocks[pid];
    S.saveState = 'saved';
  } catch (e) {
    S.saveState = /permission/i.test(e.message)
      ? (isLocked() && auth.id !== 'admin' ? 'Picks are locked' : "Couldn't save: your edit code may be wrong. Sign in again.")
      : "Couldn't save, try again";
    if (isLocked() && auth.id !== 'admin') { S.pending[pid] = {}; delete S.pendingLocks[pid]; }
  }
  render();
}

// ---------- full rules ----------
function rulesView() {
  return `<div class="sec-head"><h2>How it works</h2></div>
  <div class="card prose">
    <p>Each NBA team has a win-total line. Lines always end in .5, so there are no ties. Pick <b>Over</b> or <b>Under</b> for all 30 teams before the first tip-off. Picks lock <b>${lockText()}</b>, and the database enforces it.</p>
    <h3>${LOCK} Locks</h3>
    <p>Mark exactly ${LOCKS_PER_PLAYER} of your picks as locks. A lock that hits is worth <b>+2</b>. A lock that misses costs you <b>−1</b>. Every other pick is <b>+1</b> if right and <b>0</b> if wrong. Locks freeze with your picks at tip-off.</p>
    <h3>Pick status during the season</h3>
    <ul class="key" style="flex-direction:column;align-items:flex-start;gap:8px;margin:8px 0">
      <li>${glyph('won')}<span><b>Clinched</b>: your side is clinched (the team already passed the line, or can't reach it).</span></li>
      <li>${glyph('ahead')}<span><b>On pace</b>: the team is running at the pace your pick needs.</span></li>
      <li>${glyph('even')}<span><b>Even</b>: exactly on pace, or no games yet.</span></li>
      <li>${glyph('behind')}<span><b>Behind pace</b>: the pace favours the other side, but it's not over.</span></li>
      <li>${glyph('lost')}<span><b>Out of reach</b>: the other side is clinched.</span></li>
    </ul>
    <p>"Pace" compares wins so far with <i>line × games played ÷ 82</i>, which is where a team finishing exactly on its line would be right now. Your live score counts every pick as if teams finish at their current pace: on track picks score (+1, or +2 for a lock), off-track locks cost −1. After all 82 games every pick is clinched or out of reach, so the live score becomes the final score.</p>
    <p>Ties: more points from already-clinched picks ranks higher. Players tied on both share a rank.</p>
    <h3>Your edit code</h3>
    <p>There are no accounts. When you join, you get a random edit code, and this device remembers it. Save it to edit your picks from another device. Lost it? Ask the admin to reset it.</p>
  </div>`;
}

// ---------- admin ----------
function adminView() {
  if (S.shownCode) return codeShownView();
  if (!S.adminCode) {
    return `<div class="sec-head"><h2>Admin</h2></div>
      <div class="card"><form id="admin-form" class="form">
        <label for="acode">Admin code</label>
        <input type="text" id="acode" name="code" required autocomplete="off" autocapitalize="characters" spellcheck="false">
        <button class="btn primary" type="submit">Sign in as admin</button>
        <p class="form-err" role="alert"></p>
      </form></div>
      <details class="card"><summary><b>First-time setup</b></summary>
        <p class="note">The first person to press this becomes the admin for good. It's already been done for this game.</p>
        <button class="btn ghost" data-claim style="margin-top:10px">Claim admin</button>
      </details>`;
  }
  const L = lines();
  const st = standings();
  const lock = new Date(lockAt());
  const localIso = new Date(lock.getTime() - lock.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  const ps = players().sort(byName);
  const teamsAZ = [...TEAMS].sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="sec-head"><h2>Admin</h2><p class="hint">Signed in as admin on this device. <button class="link" data-show-code="admin">Show my admin code</button> · <button class="link" data-admin-signout>Sign out</button></p></div>

    <div class="card"><h3>Win total lines</h3>
      <p class="warnbox">Seeded from Fanatics (Oct 15), not FanDuel. Check each against FanDuel and fix it here before the lock. Every line must end in .5.</p>
      <form id="lines-form">
        <div class="adm-grid">${teamsAZ.map(t => `<label><span>${esc(t.name)}</span><input name="${t.code}" type="number" inputmode="decimal" step="1" min="0.5" max="81.5" value="${L[t.code]}" required aria-label="${esc(t.name)} line"></label>`).join('')}</div>
        <button class="btn" type="submit">Save lines</button><p class="form-err" role="alert"></p>
      </form></div>

    <div class="card"><h3>Lock time</h3>
      <p class="note">Currently ${lockText()} (${fmtDate(lockAt())} your time). First tip: Celtics at Pistons, Tue Oct 20, 3:00 PM ET. The database enforces this.</p>
      <form id="lock-form" class="row-form" style="margin-top:10px"><input type="datetime-local" name="at" value="${localIso}" required aria-label="Lock time">
        <button class="btn ghost" type="submit">Save lock time</button></form><p class="form-err" role="alert"></p></div>

    <div class="card"><h3>Players (${ps.length})</h3>
      <ul class="plist">${ps.map(p => `<li data-pid="${p.id}" data-name="${esc(p.name)}">
        <span><b>${esc(p.name)}</b> · ${isLocked() && S.picksLoaded ? `${Object.keys(p.picks).length} of 30 picked · ${LOCK} ${p.locks.length} of ${LOCKS_PER_PLAYER}` : S.db.summary?.[p.id] ? `${S.db.summary[p.id].picked} of 30 picked · ${LOCK} ${S.db.summary[p.id].locks} of ${LOCKS_PER_PLAYER}` : 'picks hidden'}</span>
        <span class="acts">
          ${isLocked() ? `<a class="btn sm ghost" href="#/picks/${p.id}">Edit picks</a>` : ''}
          <button class="btn sm ghost" data-reset>Reset code</button>
          <button class="btn sm ghost" data-rename>Rename</button>
          <button class="btn sm ${S.confirmDelete === p.id ? 'warn' : 'ghost'}" data-delete>${S.confirmDelete === p.id ? 'Confirm delete' : 'Delete'}</button>
        </span></li>`).join('') || '<li><span class="none">No players yet.</span></li>'}</ul></div>

    <div class="card"><h3>Standings by hand</h3>
      <p class="note">Use this only if the automatic weekly update breaks. Whichever is newer wins: your entry, or the next automatic update.
      Current source: ${esc(SOURCE_NAMES[st.source] || st.source || 'none')}${st.at ? ', ' + fmtDate(st.at) : ''}.</p>
      <form id="standings-form">
        <div class="adm-grid">${teamsAZ.map(t => {
          const s = st.teams[t.code] || { w: 0, l: 0 };
          return `<label><span>${esc(t.name)}</span><span class="wl"><input name="${t.code}-w" type="number" min="0" max="82" value="${s.w}" aria-label="${esc(t.name)} wins"><input name="${t.code}-l" type="number" min="0" max="82" value="${s.l}" aria-label="${esc(t.name)} losses"></span></label>`;
        }).join('')}</div>
        <div class="row-form"><button class="btn ghost" type="submit">Save standings by hand</button>
        ${S.db.manualStandings ? '<button class="btn ghost" type="button" data-clear-manual>Remove hand-entered standings</button>' : ''}</div>
        <p class="form-err" role="alert"></p>
      </form></div>`;
}

// ---------- router / render ----------
function route() {
  const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { page: page || 'board', arg };
}
const TAB_OF = { board: 'board', picks: 'picks', join: 'picks', signin: 'picks', rules: 'rules', admin: 'admin' };
function render({ live = false } = {}) {
  // Background updates (database, standings file, timers) must not wipe a form the user is typing in.
  const a = document.activeElement;
  if (live && a && $app.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) { renderMast(); return; }
  renderMast();
  const { page, arg } = route();
  document.querySelectorAll('.tab').forEach(t => t.toggleAttribute('aria-current', t.dataset.tab === (TAB_OF[page] || 'board')));
  document.querySelectorAll('.tab[aria-current]').forEach(t => t.setAttribute('aria-current', 'page'));
  if (!S.dbReady && !S.dbError) { $app.innerHTML = '<p class="loading">Loading…</p>'; return; }
  const view = S.shownCode ? codeShownView : { board: boardView, join: joinView, signin: signinView, picks: () => picksView(arg), rules: rulesView, admin: adminView }[page] || boardView;
  const y = window.scrollY;
  const open = [...$app.querySelectorAll('details[open][data-pid]')].map(d => d.dataset.pid);
  $app.innerHTML = view();
  open.forEach(id => { const d = $app.querySelector(`details[data-pid="${id}"]`); if (d) d.open = true; });
  window.scrollTo(0, y);
}
addEventListener('hashchange', () => { S.saveState = ''; S.confirmDelete = null; S.shownCode = null; render(); window.scrollTo(0, 0); });

// ---------- events ----------
$app.addEventListener('click', async e => {
  const b = e.target.closest('button, a');
  if (!b) return;
  if (b.dataset.lock) {
    toggleLock(b.closest('[data-pid]').dataset.pid, b.dataset.lock);
  } else if (b.dataset.pick) {
    const pid = b.closest('[data-pid]').dataset.pid;
    queuePick(pid, b.dataset.pick, b.dataset.v);
  } else if (b.dataset.conf) {
    S.ui.conf = b.dataset.conf; store.set('swou:ui', S.ui); render();
  } else if (b.dataset.showCode) {
    const raw = b.dataset.showCode === 'admin' ? S.adminCode : S.me?.code;
    const code = normalizeCode(raw).replace(/(.{4})(?=.)/g, '$1-');
    S.shownCode = { code, title: b.dataset.showCode === 'admin' ? 'Your admin code' : 'Your edit code', next: location.hash || '#/' };
    render(); window.scrollTo(0, 0);
  } else if ('copy' in b.dataset) {
    copy(b.dataset.copy);
  } else if ('doneCode' in b.dataset) {
    S.shownCode = null;
    if (location.hash === b.getAttribute('href')) render();
  } else if ('signout' in b.dataset) {
    if (confirm('Sign out on this device? You will need your edit code to sign back in.')) { S.me = null; store.set('swou:me', null); S.device = null; store.set('swou:device', null); syncPicks(); location.hash = '#/'; }
  } else if ('adminSignout' in b.dataset) {
    S.adminCode = null; store.set('swou:admin', null); render();
  } else if ('claim' in b.dataset) {
    try {
      const code = await api.claimAdmin();
      S.adminCode = code; store.set('swou:admin', code);
      if (!S.db.lines) await api.setLines(code, DEFAULT_LINES); // seed lines once; never overwrite edits
      S.shownCode = { code, title: "You're the admin", next: '#/admin' };
      render();
    } catch (err) { toast(err instanceof UserError ? err.message : 'Failed: ' + err.message); }
  } else if ('clearManual' in b.dataset) {
    await adminDo(() => api.clearManualStandings(S.adminCode), 'Hand-entered standings removed');
  } else if (b.closest('.plist li[data-pid]')) {
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
      if (S.confirmDelete !== pid) { S.confirmDelete = pid; render(); return; }
      S.confirmDelete = null;
      await adminDo(() => api.deletePlayer(S.adminCode, pid, name), `${name} deleted`);
    }
  }
});
$app.addEventListener('change', e => {
  if (e.target.matches('[data-sort]')) { S.ui.sort = e.target.value; store.set('swou:ui', S.ui); e.target.blur(); render(); }
});

async function adminDo(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (err) {
    toast(err instanceof UserError ? err.message : /permission/i.test(err.message) ? 'Denied. Is your admin code right? Are the values valid?' : err.message);
    return false;
  }
  render(); return true;
}

$app.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const errEl = f.querySelector('.form-err') || f.parentElement.querySelector('.form-err');
  const fail = m => { if (errEl) errEl.textContent = m; };
  const btn = f.querySelector('[type=submit]');
  const data = Object.fromEntries(new FormData(f));
  btn.disabled = true;
  try {
    if (f.id === 'join-form') {
      const { id, code } = await api.join(data.name);
      S.me = { id, code, name: data.name.trim() }; store.set('swou:me', S.me);
      registerThisPhone();
      S.shownCode = { code, title: "You're in!", next: '#/picks' };
      document.activeElement.blur(); render();
    } else if (f.id === 'signin-form') {
      const id = await api.findPlayerId(data.name);
      if (!id) return fail('No player with that name.');
      const code = normalizeCode(data.code);
      if (!(await api.verify(id, code))) return fail("That code doesn't match. Check it, or ask the admin to reset it.");
      S.me = { id, code, name: data.name.trim() }; store.set('swou:me', S.me);
      S.device = null; registerThisPhone();
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
        if (!(v > 0 && v < 82 && v % 1 === 0.5)) return fail(`${t.name}: the line must end in .5 (got ${data[t.code]})`);
        out[t.code] = v;
      }
      document.activeElement.blur();
      await adminDo(() => api.setLines(S.adminCode, out), 'Lines saved');
    } else if (f.id === 'lock-form') {
      const ms = new Date(data.at).getTime();
      if (!Number.isFinite(ms)) return fail('Invalid date');
      document.activeElement.blur();
      await adminDo(() => api.setLockAt(S.adminCode, ms), 'Lock time saved');
    } else if (f.id === 'standings-form') {
      const teams = {};
      for (const t of TEAMS) {
        const w = Number(data[`${t.code}-w`]), l = Number(data[`${t.code}-l`]);
        if (!Number.isInteger(w) || !Number.isInteger(l) || w < 0 || l < 0 || w + l > 82) return fail(`${t.name}: bad record ${w}–${l}`);
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
api.subscribe(state => { S.db = { ...S.db, ...state }; S.dbReady = true; S.dbError = null; syncPicks(); armLockTimer(); render({ live: true }); },
  err => { S.dbError = err.message; render({ live: true }); });
onValue(ref(db, '.info/serverTimeOffset'), snap => { S.offset = snap.val() || 0; armLockTimer(); syncPicks(); });

// Picks and locks are hidden by the database until the lock. Before it, this phone listens only to
// its own player's picks (allowed once the phone is registered with the edit code). After it, it listens
// to everyone's. Firebase cancels a listener the rules refuse, so we re-listen at the lock time and retry.
let pickUnsubs = [], retryTimer = null, retries = 0;
function stopPicks() { pickUnsubs.forEach(u => u()); pickUnsubs = []; clearTimeout(retryTimer); }
function wantedMode() {
  if (isLocked()) return 'all';
  if (S.me && S.uid && S.device === `${S.me.id}:${S.uid}`) return 'mine';
  return 'none';
}
function syncPicks(force = false) {
  const mode = wantedMode();
  if (!force && mode === S.picksMode && !S.picksError) return;
  stopPicks();
  const switching = mode !== S.picksMode;
  S.picksMode = mode; S.picksError = null; if (switching) S.picksLoaded = false;
  if (mode === 'none') { S.db.picks = {}; S.db.locks = {}; S.picksLoaded = false; return; }
  const base = mode === 'all' ? '' : `/${S.me.id}`;
  const got = { picks: false, locks: false };
  const onData = key => val => {
    S.db[key] = mode === 'all' ? (val || {}) : { [S.me.id]: val || {} };
    got[key] = true;
    if (got.picks && got.locks) { S.picksLoaded = true; retries = 0; if (mode === 'mine') backfillSummary(); }
    render({ live: true });
  };
  const onErr = err => {
    S.picksError = err?.message || 'denied';
    stopPicks();
    // After the lock the server may not agree yet (clock skew): try again soon, then less often.
    // Before the lock a refusal means this phone isn't registered (e.g. code was reset): re-register.
    if (mode === 'mine') { S.device = null; store.set('swou:device', null); registerThisPhone(); }
    const wait = retries++ < 40 ? 15e3 : 60e3;
    retryTimer = setTimeout(() => syncPicks(true), wait);
    render({ live: true });
  };
  pickUnsubs = ['picks', 'locks'].map(key => api.watch(key + base, onData(key), onErr));
}
let lockTimer = null;
function armLockTimer() {
  clearTimeout(lockTimer);
  const ms = lockAt() - serverNow();
  if (ms <= 0) return;
  // Wake a moment after the lock (capped so long waits re-check; browsers clamp huge timeouts).
  lockTimer = setTimeout(() => { syncPicks(); armLockTimer(); render({ live: true }); }, Math.min(ms + 1500, 6 * 3600e3));
}

// Anonymous sign-in gives this phone an id the database rules can recognise. No account, no password.
onAuthStateChanged(auth, user => { S.uid = user?.uid || null; registerThisPhone(); syncPicks(); render({ live: true }); });
signInAnonymously(auth).catch(err => { S.authError = err?.code || err?.message || 'sign-in failed'; render({ live: true }); });
let registering = null;
async function registerThisPhone() {
  if (!S.me || !S.uid || S.device === `${S.me.id}:${S.uid}` || registering) return;
  const me = S.me, uid = S.uid;
  registering = api.registerDevice(me.id, me.code, uid)
    .then(() => { S.device = `${me.id}:${uid}`; store.set('swou:device', S.device); })
    .catch(() => { S.picksError = "This phone couldn't be linked to your player. Sign in again with your edit code."; })
    .finally(() => { registering = null; syncPicks(true); render({ live: true }); });
}
/** Keep the public counts right, e.g. for players who picked before counts existed. Before the lock only. */
function backfillSummary() {
  if (!S.me || isLocked() || Object.keys(S.pending[S.me.id] || {}).length || S.pendingLocks[S.me.id]) return;
  const want = summaryFor(S.me.id);
  const have = S.db.summary?.[S.me.id];
  if (have && have.picked === want.picked && have.locks === want.locks) return;
  api.savePicks(S.me.id, {}, { id: S.me.id, code: S.me.code }, undefined, want).catch(() => {});
}
const summaryFor = pid => ({ picked: Object.keys(picksFor(pid)).length, locks: locksFor(pid).length });

async function loadFile() {
  try {
    const r = await fetch(`standings.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) { S.file = await r.json(); render({ live: true }); }
  } catch { /* offline; keep last */ }
}
render();
loadFile();
setInterval(loadFile, 30 * 60e3);
setInterval(() => { syncPicks(); render({ live: true }); }, 60e3); // countdown, lock flip, waking from sleep
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadFile(); syncPicks(); armLockTimer(); } });
