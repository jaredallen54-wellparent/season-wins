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

  async function fresh(lockAt = FUTURE) {
    await env.clearDatabase();
    const db = env.unauthenticatedContext().database();
    const api = makeApi(sdk, db);
    const adminCode = await api.claimAdmin();
    await api.setLockAt(adminCode, lockAt);
    return { db, api, adminCode };
  }
  const denied = p => assert.rejects(p, /permission/i);

  test('admin can be claimed once only', async () => {
    const { api } = await fresh();
    await assert.rejects(api.claimAdmin(), /admin already exists/);
  });

  test('join, then save picks with the code; wrong code denied', async () => {
    const { db, api } = await fresh();
    const { id, code } = await api.join('Jared');
    await api.savePicks(id, { BOS: 'O', SAC: 'U' }, { id, code });
    assert.deepEqual((await get(ref(db, `picks/${id}`))).val(), { BOS: 'O', SAC: 'U' });
    await api.savePicks(id, { BOS: null }, { id, code }); // clear a pick
    assert.deepEqual((await get(ref(db, `picks/${id}`))).val(), { SAC: 'U' });
    await denied(api.savePicks(id, { BOS: 'U' }, { id, code: 'WRONG-CODE-XXXX' }));
    assert.equal(await api.verify(id, code), true);
    assert.equal(await api.verify(id, 'nope'), false);
  });

  test('a stale proof cannot be replayed; writing picks alone is denied', async () => {
    const { db, api } = await fresh();
    const { id, code } = await api.join('Amy');
    await api.savePicks(id, { BOS: 'O' }, { id, code }); // leaves proofs/<id> in the db
    await denied(set(ref(db, `picks/${id}/BOS`), 'U'));
    await denied(update(ref(db), { [`picks/${id}/BOS`]: 'U', [`proofs/${id}/${await hashCode('guess')}`]: serverTimestamp() }));
    await denied(update(ref(db), { [`picks/${id}/BOS`]: 'U', [`proofs/${id}/${await hashCode(code)}`]: 12345 }));
  });

  test("one player can't write another's picks with their own code", async () => {
    const { api } = await fresh();
    const a = await api.join('Amy');
    const b = await api.join('Bob');
    await denied(api.savePicks(b.id, { BOS: 'O' }, a));
  });

  test('secrets and proofs are unreadable', async () => {
    const { db, api } = await fresh();
    const { id } = await api.join('Amy');
    await denied(get(ref(db, `secrets/${id}`)));
    await denied(get(ref(db, 'secrets/admin')));
    await denied(get(ref(db, `proofs/${id}`)));
    await denied(get(ref(db, '/')));
  });

  test('names are unique case-insensitively and validated', async () => {
    const { api } = await fresh();
    await api.join('Jared');
    await assert.rejects(api.join('JARED'), /taken/);
    await assert.rejects(api.join('x'), /2–24/);
    await assert.rejects(api.join('<script>'), /letters/);
  });

  test('raw duplicate-name write is denied even bypassing the app', async () => {
    const { db, api } = await fresh();
    const a = await api.join('Jared');
    await denied(update(ref(db), {
      'players/pabcdefghij12': { name: 'jared', joinedAt: 1 },
      'names/jared': 'pabcdefghij12',
      'secrets/pabcdefghij12': await hashCode('x'),
    }));
    await denied(set(ref(db, `secrets/${a.id}`), await hashCode('hijack'))); // can't overwrite a secret
  });

  test('picks lock server-side; admin can still edit', async () => {
    const { api, adminCode, db } = await fresh();
    const { id, code } = await api.join('Amy');
    await api.setLockAt(adminCode, PAST);
    await denied(api.savePicks(id, { BOS: 'O' }, { id, code }));
    await assert.rejects(api.join('Late Larry'), /locked/);
    await api.savePicks(id, { BOS: 'U' }, { id: 'admin', code: adminCode });
    assert.equal((await get(ref(db, `picks/${id}/BOS`))).val(), 'U');
  });

  test('only admin can change lines, lock, standings; values validated', async () => {
    const { api, adminCode, db } = await fresh();
    const { id, code } = await api.join('Amy');
    await api.setLines(adminCode, { BOS: 50.5, SAC: 21.5 });
    await denied(api.setLines(adminCode, { BOS: 50 }));           // must end in .5
    await denied(api.setLines(adminCode, { XYZ: 40.5 }));         // unknown team
    await denied(update(ref(db), { 'lines/BOS': 70.5, [`proofs/${id}/${await hashCode(code)}`]: serverTimestamp() }));
    await denied(set(ref(db, 'config/lockAt'), FUTURE + 1));
    await api.setManualStandings(adminCode, { BOS: { w: 3, l: 1 } });
    await denied(api.setManualStandings(adminCode, { BOS: { w: 3.5, l: 1 } }));
    await denied(set(ref(db, 'manualStandings/teams/BOS/w'), 80));
    await denied(api.setLines('WRONG', { BOS: 51.5 }));
  });

  test('locks: up to 3, distinct, only on picked teams, frozen at the lock', async () => {
    const { db, api, adminCode } = await fresh();
    const me = await api.join('Amy');
    await api.savePicks(me.id, { BOS: 'O', SAC: 'U', OKC: 'O', NYK: 'U' }, me, ['BOS', 'SAC', 'OKC']);
    assert.deepEqual((await get(ref(db, `locks/${me.id}`))).val(), { a: 'BOS', b: 'SAC', c: 'OKC' });
    await assert.rejects(api.savePicks(me.id, {}, me, ['BOS', 'SAC', 'OKC', 'NYK']), /only lock 3/);
    await denied(api.savePicks(me.id, {}, me, ['BOS', 'BOS']));          // duplicate
    await denied(api.savePicks(me.id, {}, me, ['BOS', 'MIA']));          // MIA not picked
    await api.savePicks(me.id, { MIA: 'O' }, me, ['BOS', 'MIA']);        // pick + lock in one save
    await api.savePicks(me.id, { MIA: null }, me, ['BOS']);              // clearing a pick drops its lock
    assert.deepEqual((await get(ref(db, `locks/${me.id}`))).val(), { a: 'BOS' });
    const other = await api.join('Bob');
    await denied(api.savePicks(me.id, {}, other, ['BOS', 'SAC']));       // someone else's code
    await denied(set(ref(db, `locks/${me.id}/b`), 'SAC'));               // no proof
    await api.setLockAt(adminCode, PAST);
    await denied(api.savePicks(me.id, {}, me, ['BOS', 'SAC']));          // locked
    await api.savePicks(me.id, {}, { id: 'admin', code: adminCode }, ['BOS', 'SAC', 'OKC']); // admin can fix
    await api.deletePlayer(adminCode, me.id, 'Amy');
    assert.equal((await get(ref(db, `locks/${me.id}`))).val(), null);
  });

  test('pick values validated', async () => {
    const { api } = await fresh();
    const { id, code } = await api.join('Amy');
    await denied(api.savePicks(id, { BOS: 'X' }, { id, code }));
    await denied(api.savePicks(id, { NOPE: 'O' }, { id, code }));
  });

  test('admin can reset a code, rename, delete', async () => {
    const { api, adminCode, db } = await fresh();
    const { id, code } = await api.join('Amy');
    const newCode = await api.resetPlayerCode(adminCode, id);
    assert.equal(await api.verify(id, code), false);
    assert.equal(await api.verify(id, newCode), true);
    await api.renamePlayer(adminCode, id, 'Amy', 'Amelia');
    assert.equal(await api.findPlayerId('amelia'), id);
    assert.equal(await api.findPlayerId('amy'), null);
    await api.deletePlayer(adminCode, id, 'Amelia');
    assert.equal((await get(ref(db, `players/${id}`))).val(), null);
  });

  test('default lock (no config) uses the hard-coded first tip-off', async () => {
    await env.clearDatabase();
    const api = makeApi(sdk, env.unauthenticatedContext().database());
    const { id, code } = await api.join('Early'); // today is before Oct 20 2026
    await api.savePicks(id, { OKC: 'O' }, { id, code });
  });
}
