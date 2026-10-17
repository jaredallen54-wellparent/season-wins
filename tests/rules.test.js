// Security-rules tests against the Firebase Realtime Database emulator.
// Run with: npm run test:rules   (starts the emulator automatically)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { ref, update, get, set, onValue, serverTimestamp } from 'firebase/database';
import { makeApi, hashCode } from '../js/api.js';

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  test('rules tests skipped (run `npm run test:rules` to start the emulator)', { skip: true }, () => {});
} else {
  const sdk = { ref, update, get, onValue, serverTimestamp };
  let env;
  const FUTURE = Date.now() + 86400e3, PAST = Date.now() - 1000;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: 'demo-swou',
      database: { rules: readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8') },
    });
  });
  after(() => env.cleanup());

  // A visitor with no sign-in, and phones signed in anonymously (each its own uid).
  const anon = () => env.unauthenticatedContext().database();
  const phone = uid => env.authenticatedContext(uid).database();
  const apiFor = db => makeApi(sdk, db);
  // Read with rules switched off, to check what was stored.
  const peek = async path => { let v; await env.withSecurityRulesDisabled(async c => { v = (await get(ref(c.database(), path))).val(); }); return v; };
  const denied = p => assert.rejects(p, /permission/i);

  async function fresh(lockAt = FUTURE) {
    await env.clearDatabase();
    const db = anon();
    const api = apiFor(db);
    const adminCode = await api.claimAdmin();
    await api.setLockAt(adminCode, lockAt);
    return { db, api, adminCode };
  }
  const lock = (api, adminCode) => api.setLockAt(adminCode, PAST);

  // ---------- accounts and codes ----------
  test('admin can be claimed once only', async () => {
    const { api } = await fresh();
    await assert.rejects(api.claimAdmin(), /admin already exists/);
  });

  test('join, then save picks with the code; wrong code denied; tap again clears', async () => {
    const { api } = await fresh();
    const { id, code } = await api.join('Jared');
    await api.savePicks(id, { BOS: 'O', SAC: 'U' }, { id, code });
    assert.deepEqual(await peek(`picks/${id}`), { BOS: 'O', SAC: 'U' });
    await api.savePicks(id, { BOS: null }, { id, code });
    assert.deepEqual(await peek(`picks/${id}`), { SAC: 'U' });
    await denied(api.savePicks(id, { BOS: 'U' }, { id, code: 'WRONG-CODE-XXXX' }));
    assert.equal(await api.verify(id, code), true);
    assert.equal(await api.verify(id, 'nope'), false);
  });

  test('a stale proof cannot be replayed; writing picks without a fresh proof is denied', async () => {
    const { db, api } = await fresh();
    const { id, code } = await api.join('Amy');
    await api.savePicks(id, { BOS: 'O' }, { id, code });
    await denied(set(ref(db, `picks/${id}/BOS`), 'U'));
    await denied(update(ref(db), { [`picks/${id}/BOS`]: 'U', [`proofs/${id}/${await hashCode('guess')}`]: serverTimestamp() }));
    await denied(update(ref(db), { [`picks/${id}/BOS`]: 'U', [`proofs/${id}/${await hashCode(code)}`]: 12345 }));
  });

  test("a proof made for one player can't write another player's picks, locks or summary", async () => {
    const { api } = await fresh();
    const a = await api.join('Amy');
    const b = await api.join('Bob');
    await denied(api.savePicks(b.id, { BOS: 'O' }, a));
    await api.savePicks(b.id, { BOS: 'O' }, b);
    await denied(api.savePicks(b.id, {}, a, ['BOS']));
    await denied(api.savePicks(b.id, {}, a, undefined, { picked: 30, locks: 3 }));
  });

  test('secrets, proofs and devices are never readable, before or after the lock', async () => {
    const { api, adminCode } = await fresh();
    const { id, code } = await api.join('Amy');
    await apiFor(phone('amy-phone')).registerDevice(id, code, 'amy-phone');
    for (const db of [anon(), phone('amy-phone')]) {
      await denied(get(ref(db, `secrets/${id}`)));
      await denied(get(ref(db, 'secrets/admin')));
      await denied(get(ref(db, `proofs/${id}`)));
      await denied(get(ref(db, `devices/${id}`)));
      await denied(get(ref(db, '/')));
    }
    await lock(api, adminCode);
    await denied(get(ref(anon(), 'secrets')));
    await denied(get(ref(anon(), 'devices')));
  });

  test('names are unique case-insensitively and validated', async () => {
    const { api } = await fresh();
    await api.join('Jared');
    await assert.rejects(api.join('JARED'), /taken/);
    await assert.rejects(api.join('x'), /2–24/);
    await assert.rejects(api.join('<script>'), /letters/);
  });

  test('two people grabbing the same name at once: the database lets only one through', async () => {
    const { db, api } = await fresh();
    const a = await api.join('Jared');
    await denied(update(ref(db), {
      'players/pabcdefghij12': { name: 'jared', joinedAt: 1 },
      'names/jared': 'pabcdefghij12',
      'secrets/pabcdefghij12': await hashCode('x'),
    }));
    await denied(set(ref(db, `secrets/${a.id}`), await hashCode('hijack')));
  });

  // ---------- the lock ----------
  test('picks freeze at the lock for players; the admin can still edit; no joining after', async () => {
    const { api, adminCode } = await fresh();
    const { id, code } = await api.join('Amy');
    await lock(api, adminCode);
    await denied(api.savePicks(id, { BOS: 'O' }, { id, code }));
    await denied(api.savePicks(id, {}, { id, code }, undefined, { picked: 1, locks: 0 }));
    await assert.rejects(api.join('Late Larry'), /locked/);
    await api.savePicks(id, { BOS: 'U' }, { id: 'admin', code: adminCode });
    assert.equal(await peek(`picks/${id}/BOS`), 'U');
  });

  test('only admin can change lines, lock time, standings; values validated', async () => {
    const { api, adminCode, db } = await fresh();
    const { id, code } = await api.join('Amy');
    await api.setLines(adminCode, { BOS: 50.5, SAC: 21.5 });
    await denied(api.setLines(adminCode, { BOS: 50 }));
    await denied(api.setLines(adminCode, { XYZ: 40.5 }));
    await denied(update(ref(db), { 'lines/BOS': 70.5, [`proofs/${id}/${await hashCode(code)}`]: serverTimestamp() }));
    await denied(set(ref(db, 'config/lockAt'), FUTURE + 1));
    await denied(api.setLockAt(adminCode, 'tomorrow'));
    await denied(api.setLockAt(adminCode, 5));
    await api.setManualStandings(adminCode, { BOS: { w: 3, l: 1 } });
    await denied(api.setManualStandings(adminCode, { BOS: { w: 3.5, l: 1 } }));
    await denied(set(ref(db, 'manualStandings/teams/BOS/w'), 80));
    await denied(api.setLines('WRONG', { BOS: 51.5 }));
  });

  test('pick values validated', async () => {
    const { api } = await fresh();
    const { id, code } = await api.join('Amy');
    await denied(api.savePicks(id, { BOS: 'X' }, { id, code }));
    await denied(api.savePicks(id, { NOPE: 'O' }, { id, code }));
  });

  test('admin can reset a code (old phones lose access), rename, delete (everything cleaned up)', async () => {
    const { api, adminCode } = await fresh();
    const { id, code } = await api.join('Amy');
    await api.savePicks(id, { BOS: 'O' }, { id, code }, ['BOS'], { picked: 1, locks: 1 });
    await apiFor(phone('amy-phone')).registerDevice(id, code, 'amy-phone');
    const newCode = await api.resetPlayerCode(adminCode, id);
    assert.equal(await api.verify(id, code), false);
    assert.equal(await api.verify(id, newCode), true);
    assert.equal(await peek(`devices/${id}`), null);
    await denied(get(ref(phone('amy-phone'), `picks/${id}`)));
    await api.renamePlayer(adminCode, id, 'Amy', 'Amelia');
    assert.equal(await api.findPlayerId('amelia'), id);
    assert.equal(await api.findPlayerId('amy'), null);
    await api.deletePlayer(adminCode, id, 'Amelia');
    for (const p of ['players', 'picks', 'locks', 'summary', 'devices', 'secrets', 'proofs']) assert.equal(await peek(`${p}/${id}`), null, p);
  });

  test('default lock (no lock time set) uses the hard-coded first tip-off', async () => {
    await env.clearDatabase();
    const api = apiFor(anon());
    const { id, code } = await api.join('Early'); // today is before Oct 20 2026
    await api.savePicks(id, { OKC: 'O' }, { id, code });
  });

  // ---------- locks ----------
  test('locks: up to 3, distinct, real teams, only on picked teams, frozen at the lock', async () => {
    const { api, adminCode } = await fresh();
    const me = await api.join('Amy');
    await api.savePicks(me.id, { BOS: 'O', SAC: 'U', OKC: 'O', NYK: 'U' }, me, ['BOS', 'SAC', 'OKC']);
    assert.deepEqual(await peek(`locks/${me.id}`), { a: 'BOS', b: 'SAC', c: 'OKC' });
    await assert.rejects(api.savePicks(me.id, {}, me, ['BOS', 'SAC', 'OKC', 'NYK']), /only lock 3/);
    await denied(update(ref(anon()), { [`locks/${me.id}/d`]: 'NYK', [`proofs/${me.id}/${await hashCode(me.code)}`]: serverTimestamp() })); // no 4th slot
    await denied(api.savePicks(me.id, {}, me, ['BOS', 'BOS']));   // duplicate
    await denied(api.savePicks(me.id, {}, me, ['BOS', 'MIA']));   // MIA not picked
    await denied(api.savePicks(me.id, {}, me, ['BOS', 'XYZ']));   // not a team
    await api.savePicks(me.id, { MIA: 'O' }, me, ['BOS', 'MIA']); // pick + lock in one save
    await denied(api.savePicks(me.id, { MIA: null }, me));        // can't drop a locked pick and keep the lock
    await api.savePicks(me.id, { MIA: null }, me, ['BOS']);       // dropping both together is fine
    assert.deepEqual(await peek(`locks/${me.id}`), { a: 'BOS' });
    await denied(set(ref(anon(), `locks/${me.id}/b`), 'SAC'));    // no proof
    await lock(api, adminCode);
    await denied(api.savePicks(me.id, {}, me, ['BOS', 'SAC']));
    await api.savePicks(me.id, {}, { id: 'admin', code: adminCode }, ['BOS', 'SAC', 'OKC']);
  });

  // ---------- hidden until the lock ----------
  test('before the lock: nobody can read other players’ picks or locks, admin included', async () => {
    const { api } = await fresh();
    const amy = await api.join('Amy');
    const bob = await api.join('Bob');
    await api.savePicks(amy.id, { BOS: 'O' }, amy, ['BOS'], { picked: 1, locks: 1 });
    await apiFor(phone('bob-phone')).registerDevice(bob.id, bob.code, 'bob-phone');
    for (const db of [anon(), phone('bob-phone'), phone('random')]) {
      await denied(get(ref(db, 'picks')));
      await denied(get(ref(db, 'locks')));
      await denied(get(ref(db, `picks/${amy.id}`)));
      await denied(get(ref(db, `locks/${amy.id}`)));
    }
  });

  test('before the lock: a player can read their own picks and locks from a registered phone (two phones OK)', async () => {
    const { api } = await fresh();
    const amy = await api.join('Amy');
    await api.savePicks(amy.id, { BOS: 'O', SAC: 'U' }, amy, ['SAC'], { picked: 2, locks: 1 });
    await denied(get(ref(phone('amy-phone'), `picks/${amy.id}`))); // not registered yet
    for (const uid of ['amy-phone', 'amy-laptop']) {
      const db = phone(uid);
      await apiFor(db).registerDevice(amy.id, amy.code, uid);
      assert.deepEqual((await get(ref(db, `picks/${amy.id}`))).val(), { BOS: 'O', SAC: 'U' });
      assert.deepEqual((await get(ref(db, `locks/${amy.id}`))).val(), { a: 'SAC' });
    }
  });

  test('registering a phone needs the right code, and only registers the phone doing it', async () => {
    const { api } = await fresh();
    const amy = await api.join('Amy');
    const bob = await api.join('Bob');
    await denied(apiFor(phone('x')).registerDevice(amy.id, 'WRONG', 'x'));
    await denied(apiFor(phone('x')).registerDevice(amy.id, bob.code, 'x'));      // Bob's code
    await denied(apiFor(phone('x')).registerDevice(amy.id, amy.code, 'other'));  // someone else's uid
    await denied(apiFor(anon()).registerDevice(amy.id, amy.code, 'x'));         // not signed in
    await denied(set(ref(phone('x'), `devices/${amy.id}/x`), true));           // no proof
  });

  test('after the lock: everyone, including visitors who never joined, reads all picks and locks', async () => {
    const { api, adminCode } = await fresh();
    const amy = await api.join('Amy');
    const bob = await api.join('Bob');
    await api.savePicks(amy.id, { BOS: 'O', SAC: 'U' }, amy, ['BOS'], { picked: 2, locks: 1 });
    await api.savePicks(bob.id, { BOS: 'U' }, bob, undefined, { picked: 1, locks: 0 });
    await lock(api, adminCode);
    const picks = (await get(ref(anon(), 'picks'))).val();
    assert.deepEqual(picks[amy.id], { BOS: 'O', SAC: 'U' });
    assert.deepEqual(picks[bob.id], { BOS: 'U' });
    assert.deepEqual((await get(ref(anon(), 'locks'))).val(), { [amy.id]: { a: 'BOS' } });
    await api.savePicks(bob.id, { SAC: 'O' }, { id: 'admin', code: adminCode });  // admin edit after the lock
    assert.equal((await get(ref(anon(), `picks/${bob.id}/SAC`))).val(), 'O');
  });

  test('moving the lock time later hides picks again (rules follow config/lockAt)', async () => {
    const { api, adminCode } = await fresh(PAST);
    await assert.rejects(api.join('Too late'), /locked/);
    await api.setLockAt(adminCode, FUTURE);
    const amy = await api.join('Amy');
    await api.savePicks(amy.id, { BOS: 'O' }, amy);
    await denied(get(ref(anon(), 'picks')));
  });

  // ---------- public counts ----------
  test('summary counts: public, player-written before the lock, validated, frozen after', async () => {
    const { api, adminCode } = await fresh();
    const amy = await api.join('Amy');
    await api.savePicks(amy.id, { BOS: 'O' }, amy, ['BOS'], { picked: 1, locks: 1 });
    assert.deepEqual((await get(ref(anon(), `summary/${amy.id}`))).val(), { picked: 1, locks: 1 });
    await denied(api.savePicks(amy.id, {}, amy, undefined, { picked: 31, locks: 1 }));
    await denied(api.savePicks(amy.id, {}, amy, undefined, { picked: 2, locks: 4 }));
    await denied(api.savePicks(amy.id, {}, amy, undefined, { picked: 1.5, locks: 1 }));
    await denied(set(ref(anon(), `summary/${amy.id}`), { picked: 30, locks: 3 })); // no proof
    await lock(api, adminCode);
    await denied(api.savePicks(amy.id, {}, amy, undefined, { picked: 30, locks: 3 }));
  });
}
