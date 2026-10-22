// Fetch NBA regular-season W–L for all 30 teams and write standings.json.
// Runs in GitHub Actions (server-side, so no browser CORS issues).
//   node scripts/fetch-standings.mjs            → fetch + write standings.json
//   node scripts/fetch-standings.mjs --dry-run  → fetch + print, don't write
//
// Sources, in order (first that passes validation wins):
//   1. ESPN public standings JSON (no key)
//   2. NBA.com CDN full-season schedule; W–L computed from final scores of regular-season games
// Any unmapped team name, missing team, or wrong season fails the run loudly.
import { writeFileSync, readFileSync } from 'node:fs';
import { TEAMS, teamCode, DEFAULT_LOCK_AT } from '../js/teams.js';

export const SEASON_END_YEAR = 2027;        // 2026–27
export const SEASON_LABEL = '2026-27';

export const SOURCES = {
  espn: `https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=${SEASON_END_YEAR}&seasontype=2`,
  nbaSchedule: 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json',
};

function codeFrom(...names) {
  const codes = new Set();
  for (const n of names) {
    if (n == null || n === '') continue;
    try { codes.add(teamCode(n)); } catch { /* try the next spelling */ }
  }
  if (codes.size === 0) throw new Error(`Unmapped team name: ${JSON.stringify(names)}`);
  if (codes.size > 1) throw new Error(`Conflicting team names: ${JSON.stringify(names)} → ${[...codes]}`);
  return [...codes][0];
}

export function validate(teams, now = Date.now()) {
  const codes = Object.keys(teams).sort();
  const want = TEAMS.map(t => t.code).sort();
  const missing = want.filter(c => !codes.includes(c));
  if (missing.length) throw new Error(`Missing teams: ${missing.join(', ')}`);
  for (const [c, { w, l }] of Object.entries(teams)) {
    if (!Number.isInteger(w) || !Number.isInteger(l) || w < 0 || l < 0 || w + l > 82) throw new Error(`Bad record for ${c}: ${w}-${l}`);
  }
  const wins = Object.values(teams).reduce((s, t) => s + t.w, 0);
  const losses = Object.values(teams).reduce((s, t) => s + t.l, 0);
  if (wins !== losses) throw new Error(`League wins (${wins}) ≠ losses (${losses}); feed looks inconsistent`);
  // Opening night is after the default lock; any games before then means last season's table.
  if (now < DEFAULT_LOCK_AT && wins > 0) throw new Error(`${wins} games already played before opening night: feed is probably last season`);
  return teams;
}

/** ESPN: find every {team, stats[]} entry anywhere in the response. */
export function parseEspn(json, now = Date.now()) {
  const seasons = new Set();
  const teams = {};
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.standings && typeof node.standings.season === 'number') seasons.add(node.standings.season);
    if (node.team && Array.isArray(node.stats)) {
      const t = node.team;
      const code = codeFrom(t.displayName, t.abbreviation, t.shortDisplayName, t.location && t.name ? `${t.location} ${t.name}` : null);
      const stat = name => {
        const s = node.stats.find(x => x.name === name || x.type === name);
        if (!s) throw new Error(`ESPN: no "${name}" stat for ${code}`);
        return Math.round(Number(s.value));
      };
      if (teams[code]) throw new Error(`ESPN: duplicate entry for ${code}`);
      teams[code] = { w: stat('wins'), l: stat('losses') };
      return;
    }
    Object.values(node).forEach(walk);
  })(json);
  if (seasons.size && !seasons.has(SEASON_END_YEAR)) throw new Error(`ESPN returned season ${[...seasons]}, expected ${SEASON_END_YEAR}`);
  return validate(teams, now);
}

/** NBA.com schedule: count wins/losses from finished regular-season games (gameId 002…). */
export function parseNbaSchedule(json, now = Date.now()) {
  const ls = json?.leagueSchedule;
  if (!ls) throw new Error('NBA: no leagueSchedule');
  if (ls.seasonYear !== SEASON_LABEL) throw new Error(`NBA schedule is for ${ls.seasonYear}, expected ${SEASON_LABEL}`);
  const teams = Object.fromEntries(TEAMS.map(t => [t.code, { w: 0, l: 0 }]));
  for (const day of ls.gameDates || []) {
    for (const g of day.games || []) {
      // 002 = regular season (NBA Cup group/knockout games count; the Cup final, 006, does not).
      if (!String(g.gameId).startsWith('002') || g.gameStatus !== 3) continue;
      const h = g.homeTeam, a = g.awayTeam;
      const hc = codeFrom(h.teamTricode, `${h.teamCity} ${h.teamName}`);
      const ac = codeFrom(a.teamTricode, `${a.teamCity} ${a.teamName}`);
      if (h.score === a.score) throw new Error(`NBA: tied final ${g.gameId}`);
      const [win, lose] = h.score > a.score ? [hc, ac] : [ac, hc];
      teams[win].w++; teams[lose].l++;
    }
  }
  return validate(teams, now);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (season-wins-over-under)', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

export async function fetchStandings() {
  const errors = [];
  const results = {};
  for (const [name, parse] of [['espn', parseEspn], ['nbaSchedule', parseNbaSchedule]]) {
    try { results[name] = parse(await getJson(SOURCES[name])); }
    catch (e) { errors.push(`${name}: ${e.message}`); console.error(`✗ ${name}: ${e.message}`); }
  }
  if (results.espn && results.nbaSchedule) {
    const diffs = TEAMS.map(t => t.code).filter(c =>
      results.espn[c].w !== results.nbaSchedule[c].w || results.espn[c].l !== results.nbaSchedule[c].l);
    if (diffs.length) console.warn(`⚠ Sources disagree on: ${diffs.map(c => `${c} espn ${results.espn[c].w}-${results.espn[c].l} / nba ${results.nbaSchedule[c].w}-${results.nbaSchedule[c].l}`).join('; ')}`);
  }
  const source = results.espn ? 'espn' : results.nbaSchedule ? 'nbaSchedule' : null;
  if (!source) throw new Error(`All standings sources failed:\n  ${errors.join('\n  ')}`);
  return { source, season: SEASON_LABEL, updatedAt: new Date().toISOString(), teams: results[source] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await fetchStandings();
  const games = Object.values(out.teams).reduce((s, t) => s + t.w + t.l, 0) / 2;
  console.log(`✓ ${out.source}: ${games} games played`);
  console.table(out.teams);
  if (!process.argv.includes('--dry-run')) {
    const path = new URL('../standings.json', import.meta.url);
    let prev = null;
    try { prev = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    // Several runs a day (GitHub's scheduler is unreliable): save only when records changed,
    // or when the last save is more than 20 hours old (keeps the "updated" time fresh on off days).
    const same = prev && JSON.stringify(prev.teams) === JSON.stringify(out.teams);
    const ageH = prev ? (Date.now() - Date.parse(prev.updatedAt)) / 36e5 : Infinity;
    if (same && ageH < 20) console.log(`No W–L changes; last saved ${ageH.toFixed(1)} h ago, leaving standings.json as is.`);
    else {
      writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
      console.log(same ? 'No W–L changes (timestamp refreshed).' : 'standings.json updated.');
    }
  }
}
