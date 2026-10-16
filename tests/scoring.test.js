import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamPace, pickStatus, pickPoints, leaderboard, seasonProgress } from '../js/scoring.js';

const close = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('30–20 on 47.5: ahead of pace, lean O', () => {
  const p = teamPace(47.5, 30, 20);
  assert.equal(p.gp, 50);
  close(p.expected, 28.96);
  close(p.delta, 1.04);
  assert.equal(p.lean, 'O');
  assert.equal(p.overClinched, false);
  assert.equal(p.underClinched, false);
  close(p.projected, 49.2);
  assert.equal(pickStatus(p, 'O'), 'ahead');
  assert.equal(pickStatus(p, 'U'), 'behind');
});

test('48–20 on 47.5: over clinched', () => {
  const p = teamPace(47.5, 48, 20);
  assert.equal(p.overClinched, true);
  assert.equal(pickStatus(p, 'O'), 'won');
  assert.equal(pickStatus(p, 'U'), 'lost');
});

test('47–35 on 47.5: season over, under clinched', () => {
  const p = teamPace(47.5, 47, 35);
  assert.equal(p.gp, 82);
  assert.equal(p.underClinched, true);
  assert.equal(pickStatus(p, 'O'), 'lost');
  assert.equal(pickStatus(p, 'U'), 'won');
});

test('10–50 on 47.5: under clinched early', () => {
  const p = teamPace(47.5, 10, 50);
  assert.equal(p.underClinched, true);
  assert.equal(pickStatus(p, 'O'), 'lost');
  assert.equal(pickStatus(p, 'U'), 'won');
});

test('2–40 on 30.5: lean U', () => {
  const p = teamPace(30.5, 2, 40);
  assert.equal(p.gp, 42);
  close(p.expected, 15.62);
  close(p.delta, -13.62);
  assert.equal(p.lean, 'U');
});

test('0–0: everything even, projected null', () => {
  const p = teamPace(47.5, 0, 0);
  assert.equal(p.projected, null);
  assert.equal(pickStatus(p, 'O'), 'even');
  assert.equal(pickStatus(p, 'U'), 'even');
});

test('leaderboard: sort, dense ranks, ties share rank', () => {
  const lines = { AAA: 47.5, BBB: 47.5, CCC: 47.5 };
  const standings = { AAA: { w: 48, l: 20 }, BBB: { w: 30, l: 20 }, CCC: { w: 10, l: 50 } };
  const players = [
    { id: 'z', name: 'zed', picks: { AAA: 'O', BBB: 'U', CCC: 'U' } }, // won,behind,won → 2 on track, 2 won
    { id: 'a', name: 'Amy', picks: { AAA: 'O', BBB: 'U', CCC: 'U' } }, // same → tie
    { id: 'b', name: 'Bob', picks: { AAA: 'O', BBB: 'O', CCC: 'O' } }, // won,ahead,lost → 2 on track, 1 won
    { id: 'c', name: 'Cat', picks: { AAA: 'U' } },                     // lost, 2 unpicked
  ];
  const rows = leaderboard(lines, standings, players);
  assert.deepEqual(rows.map(r => r.name), ['Amy', 'zed', 'Bob', 'Cat']);
  assert.deepEqual(rows.map(r => r.rank), [1, 1, 2, 3]);
  assert.equal(rows[2].counts.ahead, 1);
  assert.equal(rows[3].counts.unpicked, 2);
});

test('pick points: normal +1/0, lock +2/-1, even 0', () => {
  assert.deepEqual(['won', 'ahead', 'even', 'behind', 'lost'].map(s => pickPoints(s, false)), [1, 1, 0, 0, 0]);
  assert.deepEqual(['won', 'ahead', 'even', 'behind', 'lost'].map(s => pickPoints(s, true)), [2, 2, 0, -1, -1]);
});

test('locks: +2 when right, -1 when wrong, counted at pace in season', () => {
  const lines = { A: 47.5, B: 47.5, C: 47.5, D: 47.5 };
  // A over clinched, B ahead of pace (lean O), C under clinched, D 0-0 even
  const standings = { A: { w: 48, l: 20 }, B: { w: 30, l: 20 }, C: { w: 10, l: 50 }, D: { w: 0, l: 0 } };
  const rows = leaderboard(lines, standings, [
    { id: '1', name: 'Locky', picks: { A: 'O', B: 'O', C: 'O', D: 'O' }, locks: ['A', 'B', 'C'] }, // +2 +2 -1 0 = 3
    { id: '2', name: 'Plain', picks: { A: 'O', B: 'O', C: 'O', D: 'O' } },                          // +1 +1 0 0 = 2
    { id: '3', name: 'Wrong', picks: { A: 'U', B: 'U', C: 'O', D: 'O' }, locks: ['A', 'B', 'C'] },   // -1 -1 -1 0 = -3
  ]);
  assert.deepEqual(rows.map(r => [r.name, r.points, r.clinchedPoints]), [['Locky', 3, 1], ['Plain', 2, 1], ['Wrong', -3, -2]]);
  assert.deepEqual(rows[0].locks, ['A', 'B', 'C']);
});

test('a lock on an unpicked team is ignored', () => {
  const rows = leaderboard({ A: 47.5 }, { A: { w: 48, l: 20 } }, [{ id: '1', name: 'X', picks: {}, locks: ['A'] }]);
  assert.equal(rows[0].points, 0);
  assert.deepEqual(rows[0].locks, []);
});

test('ties on points break by clinched points; equal on both share a rank', () => {
  const lines = { A: 47.5, B: 47.5 };
  const standings = { A: { w: 48, l: 20 }, B: { w: 30, l: 20 } };
  const rows = leaderboard(lines, standings, [
    { id: '1', name: 'Pace', picks: { B: 'O' }, locks: ['B'] },  // 2 pts, 0 clinched
    { id: '2', name: 'Done', picks: { A: 'O' }, locks: ['A'] },  // 2 pts, 2 clinched
    { id: '3', name: 'Also', picks: { A: 'O' }, locks: ['A'] },
  ]);
  assert.deepEqual(rows.map(r => `${r.name}:${r.rank}`), ['Also:1', 'Done:1', 'Pace:2']);
});

test('leaderboard tiebreak: fewer lost ranks higher but shares rank', () => {
  const lines = { A: 47.5, B: 47.5 };
  const standings = { A: { w: 48, l: 20 }, B: { w: 30, l: 20 } };
  const rows = leaderboard(lines, standings, [
    { id: '1', name: 'X', picks: { A: 'O', B: 'U' } }, // won, behind
    { id: '2', name: 'Y', picks: { A: 'O' } },          // won, unpicked
  ]);
  assert.deepEqual(rows.map(r => r.rank), [1, 1]);
});

test('season progress counts games played / 2', () => {
  const s = seasonProgress({ A: { w: 3, l: 2 }, B: { w: 2, l: 3 } });
  assert.equal(s.games, 5);
  assert.equal(s.total, 1230);
});
