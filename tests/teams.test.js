import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS, DEFAULT_LINES, DEFAULT_LOCK_AT, teamCode } from '../js/teams.js';

test('30 teams, 15 per conference, every line ends in .5', () => {
  assert.equal(TEAMS.length, 30);
  assert.equal(TEAMS.filter(t => t.conf === 'East').length, 15);
  for (const t of TEAMS) assert.equal(DEFAULT_LINES[t.code] % 1, 0.5, t.code);
});

test('lock is 2:55 PM ET Oct 20 2026', () => {
  assert.equal(DEFAULT_LOCK_AT, 1792522500000);
  assert.equal(new Date(DEFAULT_LOCK_AT).toISOString(), '2026-10-20T18:55:00.000Z');
});

test('feed spellings map to codes', () => {
  const cases = {
    'LA Clippers': 'LAC', 'Los Angeles Clippers': 'LAC', 'L.A. Clippers': 'LAC',
    'Los Angeles Lakers': 'LAL', 'LA Lakers': 'LAL',
    GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', PHO: 'PHX', BRK: 'BKN',
    'Philadelphia 76ers': 'PHI', 'Portland Trail Blazers': 'POR',
  };
  for (const [name, code] of Object.entries(cases)) assert.equal(teamCode(name), code, name);
  for (const t of TEAMS) { assert.equal(teamCode(t.name), t.code); assert.equal(teamCode(t.code), t.code); }
});

test('unknown or ambiguous names fail loudly', () => {
  assert.throws(() => teamCode('Los Angeles'), /Unmapped/);
  assert.throws(() => teamCode('Seattle SuperSonics'), /Unmapped/);
  assert.throws(() => teamCode(undefined), /Unmapped/);
});
