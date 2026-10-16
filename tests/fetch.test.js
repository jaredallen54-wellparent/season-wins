// Parser tests. The fixtures are hand-built in the shape these feeds use;
// the live feeds are exercised by the GitHub Action ("Run workflow" → dry run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS } from '../js/teams.js';
import { parseEspn, parseNbaSchedule } from '../scripts/fetch-standings.mjs';

const ESPN_NAMES = {
  GSW: ['Golden State Warriors', 'GS'], NYK: ['New York Knicks', 'NY'], NOP: ['New Orleans Pelicans', 'NO'],
  SAS: ['San Antonio Spurs', 'SA'], UTA: ['Utah Jazz', 'UTAH'], WAS: ['Washington Wizards', 'WSH'],
  LAC: ['LA Clippers', 'LAC'], LAL: ['Los Angeles Lakers', 'LAL'],
};
function espnFixture(season = 2027) {
  const entry = (t, i) => {
    const [displayName, abbreviation] = ESPN_NAMES[t.code] || [t.name, t.code];
    const w = [1, 2, 3][i % 3], l = 4 - w; // 15 per conference → league W equals L
    return { team: { displayName, abbreviation }, stats: [{ name: 'losses', value: l }, { name: 'wins', value: w }, { name: 'winPercent', value: 0.5 }] };
  };
  const conf = c => ({ name: `${c}ern Conference`, standings: { season, entries: TEAMS.filter(t => t.conf === c).map(entry) } });
  return { children: [conf('East'), conf('West')] };
}

test('ESPN shape parses, odd abbreviations map', () => {
  const s = parseEspn(espnFixture());
  assert.equal(Object.keys(s).length, 30);
  assert.ok(s.GSW && s.LAC && s.LAL && s.UTA && s.WAS);
});

test('ESPN wrong season is rejected (e.g. last year\'s final table in preseason)', () => {
  assert.throws(() => parseEspn(espnFixture(2026)), /expected 2027/);
});

test('ESPN unmapped team fails loudly', () => {
  const f = espnFixture();
  f.children[0].standings.entries[0].team = { displayName: 'Seattle SuperSonics', abbreviation: 'SEA' };
  assert.throws(() => parseEspn(f), /Unmapped/);
});

test('ESPN missing team fails loudly', () => {
  const f = espnFixture();
  f.children[1].standings.entries.pop();
  assert.throws(() => parseEspn(f), /Missing teams|≠/);
});

test('NBA schedule: counts only finished regular-season games', () => {
  const g = (id, status, home, hs, away, as) => ({
    gameId: id, gameStatus: status,
    homeTeam: { teamTricode: home, teamCity: '', teamName: '', score: hs },
    awayTeam: { teamTricode: away, teamCity: '', teamName: '', score: as },
  });
  const json = { leagueSchedule: { seasonYear: '2026-27', gameDates: [
    { games: [g('0012600001', 3, 'BOS', 100, 'DET', 90)] },   // preseason, ignored
    { games: [g('0022600001', 3, 'DET', 110, 'BOS', 101), g('0022600002', 3, 'NYK', 99, 'PHI', 105)] },
    { games: [g('0022600003', 1, 'SAS', 0, 'OKC', 0)] },      // not started
    { games: [g('0062600001', 3, 'LAL', 120, 'MIL', 100)] },  // Cup final, ignored
  ] } };
  const s = parseNbaSchedule(json);
  assert.deepEqual(s.DET, { w: 1, l: 0 });
  assert.deepEqual(s.BOS, { w: 0, l: 1 });
  assert.deepEqual(s.PHI, { w: 1, l: 0 });
  assert.deepEqual(s.LAL, { w: 0, l: 0 });
});

test('NBA schedule: wrong season rejected', () => {
  assert.throws(() => parseNbaSchedule({ leagueSchedule: { seasonYear: '2025-26', gameDates: [] } }), /expected 2026-27/);
});
