// Database access. The Firebase SDK functions are injected so the same code runs
// in the browser (CDN SDK) and in Node tests (npm SDK against the emulator).

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export function randomString(n, alphabet = ALPHABET) {
  const out = [];
  const max = 256 - (256 % alphabet.length);
  while (out.length < n) {
    const buf = crypto.getRandomValues(new Uint8Array(n * 2));
    for (const b of buf) if (b < max && out.length < n) out.push(alphabet[b % alphabet.length]);
  }
  return out.join('');
}

/** 12 random characters (~59 bits), shown as XXXX-XXXX-XXXX. */
export const newEditCode = () => randomString(12).replace(/(.{4})(?=.)/g, '$1-');
export const newPlayerId = () => 'p' + randomString(16, 'abcdefghijklmnopqrstuvwxyz0123456789');
export const normalizeCode = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const hashCode = code => sha256Hex('swou:' + normalizeCode(code));

export const NAME_RE = /^[A-Za-z0-9]+([ '_.-][A-Za-z0-9]+)*$/;
export function cleanName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > 24) throw new UserError('Name must be 2–24 characters.');
  if (!NAME_RE.test(n)) throw new UserError("Use letters, numbers, spaces, and - ' _ . only.");
  return n;
}
export const nameKey = name => cleanName(name).toLowerCase();

export class UserError extends Error {}

export function makeApi(sdk, db) {
  const { ref, update, get, onValue, serverTimestamp } = sdk;

  const isDenied = e => /permission/i.test(String(e?.code || e?.message || ''));

  async function proved(id, code, paths) {
    const hash = await hashCode(code);
    return update(ref(db), { ...paths, [`proofs/${id}/${hash}`]: serverTimestamp() });
  }

  return {
    /** Live snapshot of everything public. cb({config, lines, players, picks, manualStandings}). */
    subscribe(cb, onError) {
      const state = {};
      const paths = ['config', 'lines', 'players', 'picks', 'manualStandings'];
      const unsubs = paths.map(p => onValue(ref(db, p), snap => { state[p] = snap.val(); cb({ ...state }); }, onError));
      return () => unsubs.forEach(u => u());
    },

    async findPlayerId(name) {
      const snap = await get(ref(db, `names/${nameKey(name)}`));
      return snap.val();
    },

    /** Returns {id, code}. */
    async join(name) {
      const clean = cleanName(name);
      const key = clean.toLowerCase();
      if ((await get(ref(db, `names/${key}`))).exists()) throw new UserError('That name is taken. Pick another (or sign in with your code).');
      const id = newPlayerId();
      const code = newEditCode();
      try {
        await update(ref(db), {
          [`players/${id}`]: { name: clean, joinedAt: serverTimestamp() },
          [`names/${key}`]: id,
          [`secrets/${id}`]: await hashCode(code),
        });
      } catch (e) {
        if (isDenied(e)) throw new UserError('Could not join: that name may have just been taken, or picks are locked.');
        throw e;
      }
      return { id, code };
    },

    /** True if the code is right for this player (or 'admin'). Writes only a proof. */
    async verify(id, code) {
      try { await proved(id, code, {}); return true; }
      catch (e) { if (isDenied(e)) return false; throw e; }
    },

    /** changes: {CODE: 'O'|'U'|null}. Works for the player before lock, or for admin any time. */
    async savePicks(pid, changes, auth /* {id, code} */) {
      const paths = {};
      for (const [team, v] of Object.entries(changes)) paths[`picks/${pid}/${team}`] = v ?? null;
      return proved(auth.id, auth.code, paths);
    },

    // ---- admin ----
    async claimAdmin() {
      const code = newEditCode();
      try { await update(ref(db), { 'secrets/admin': await hashCode(code) }); }
      catch (e) { if (isDenied(e)) throw new UserError('An admin already exists for this game.'); throw e; }
      return code;
    },
    adminWrite(code, paths) { return proved('admin', code, paths); },
    setLines(code, lines) { return proved('admin', code, { lines }); },
    setLockAt(code, ms) { return proved('admin', code, { 'config/lockAt': ms }); },
    setManualStandings(code, teams) {
      return proved('admin', code, { manualStandings: { updatedAt: serverTimestamp(), teams } });
    },
    clearManualStandings(code) { return proved('admin', code, { manualStandings: null }); },
    async resetPlayerCode(adminCode, pid) {
      const code = newEditCode();
      await proved('admin', adminCode, { [`secrets/${pid}`]: await hashCode(code) });
      return code;
    },
    renamePlayer(adminCode, pid, oldName, newName) {
      const clean = cleanName(newName);
      const paths = { [`players/${pid}/name`]: clean, [`names/${clean.toLowerCase()}`]: pid };
      if (oldName.toLowerCase() !== clean.toLowerCase()) paths[`names/${oldName.toLowerCase()}`] = null;
      return proved('admin', adminCode, paths);
    },
    deletePlayer(adminCode, pid, name) {
      return proved('admin', adminCode, {
        [`players/${pid}`]: null, [`names/${name.toLowerCase()}`]: null,
        [`picks/${pid}`]: null, [`secrets/${pid}`]: null, [`proofs/${pid}`]: null,
      });
    },
  };
}
