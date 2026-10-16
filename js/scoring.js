// Pure scoring functions. No DOM, no network. Tested in tests/scoring.test.js.
import { GAMES_PER_TEAM, LEAGUE_GAMES } from './teams.js';

const EPS = 1e-9;

/** Pace math for one team. */
export function teamPace(line, wins, losses) {
  const W = Number(wins) || 0;
  const L = Number(losses) || 0;
  const gp = W + L;
  const remaining = GAMES_PER_TEAM - gp;
  const expected = (line * gp) / GAMES_PER_TEAM;
  const delta = W - expected;
  const projected = gp === 0 ? null : (W / gp) * GAMES_PER_TEAM;
  const overClinched = W > line;
  const underClinched = W + remaining < line;
  let lean = null;
  if (!overClinched && !underClinched && Math.abs(delta) >= EPS) lean = delta > 0 ? 'O' : 'U';
  return { line, wins: W, losses: L, gp, remaining, expected, delta, projected, overClinched, underClinched, lean };
}

/** Status of pick 'O' | 'U' against a pace object: won | lost | even | ahead | behind. */
export function pickStatus(pace, pick) {
  if (pace.overClinched) return pick === 'O' ? 'won' : 'lost';
  if (pace.underClinched) return pick === 'U' ? 'won' : 'lost';
  if (Math.abs(pace.delta) < EPS) return 'even';
  const lean = pace.delta > 0 ? 'O' : 'U';
  return pick === lean ? 'ahead' : 'behind';
}

export const STATUSES = ['won', 'ahead', 'even', 'behind', 'lost'];

/**
 * lines: {CODE: number}; standings: {CODE: {w, l}}; players: [{id, name, picks: {CODE: 'O'|'U'}}]
 * Returns sorted rows with dense rank by (onTrack, won).
 */
export function leaderboard(lines, standings, players) {
  const paces = {};
  for (const code of Object.keys(lines)) {
    const s = standings?.[code] || {};
    paces[code] = teamPace(lines[code], s.w, s.l);
  }
  const rows = players.map(p => {
    const counts = { won: 0, ahead: 0, even: 0, behind: 0, lost: 0, unpicked: 0 };
    const statuses = {};
    for (const code of Object.keys(paces)) {
      const pick = p.picks?.[code];
      if (pick !== 'O' && pick !== 'U') { counts.unpicked++; continue; }
      const st = pickStatus(paces[code], pick);
      statuses[code] = st;
      counts[st]++;
    }
    return { id: p.id, name: p.name, counts, statuses, onTrack: counts.won + counts.ahead };
  });
  rows.sort((a, b) =>
    b.onTrack - a.onTrack ||
    b.counts.won - a.counts.won ||
    a.counts.lost - b.counts.lost ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  let rank = 0, prevKey = null;
  for (const r of rows) {
    const key = `${r.onTrack}|${r.counts.won}`;
    if (key !== prevKey) { rank++; prevKey = key; }
    r.rank = rank;
  }
  return rows;
}

/** League progress from games played. */
export function seasonProgress(standings) {
  let gpSum = 0;
  for (const s of Object.values(standings || {})) gpSum += (Number(s.w) || 0) + (Number(s.l) || 0);
  const games = gpSum / 2;
  return { games, total: LEAGUE_GAMES, pct: Math.min(1, games / LEAGUE_GAMES) };
}
