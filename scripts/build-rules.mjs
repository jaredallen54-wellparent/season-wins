// Generates database.rules.json. Run: npm run rules
//
// How edit codes work without accounts:
//   /secrets/<id>  = SHA-256(edit code). Nobody can read it.
//   Every protected write also writes /proofs/<id>/<hash> = SERVER_TIMESTAMP in the
//   same multi-path update. Rules look up the proof at the path named by the stored
//   secret, so only someone who knows the hash can write it, and it must equal this
//   request's server time (`now`), so an old proof can't be replayed. /proofs is
//   unreadable too.
import { writeFileSync } from 'node:fs';
import { TEAMS, DEFAULT_LOCK_AT } from '../js/teams.js';

const up = d => 'newData' + '.parent()'.repeat(d); // new state of the database root from depth d
const proof = (d, id) =>
  `${up(d)}.child('proofs').child(${id}).child(root.child('secrets').child(${id}).val()).val() === now`;
const admin = d => proof(d, "'admin'");
const beforeLock =
  `((root.child('config/lockAt').exists() && now < root.child('config/lockAt').val()) || ` +
  `(!root.child('config/lockAt').exists() && now < ${DEFAULT_LOCK_AT}))`;
const afterLock = `!${beforeLock}`;
// Before the lock, a player's picks are readable only from a phone registered to that player
// (Firebase Anonymous Auth uid, registered with the player's edit-code proof). Nobody else, admin included.
const ownDevice = pid => `(auth != null && root.child('devices').child(${pid}).child(auth.uid).val() === true)`;
const playerWrite = d => `(${beforeLock} && root.child('players').child($pid).exists() && ${proof(d, '$pid')}) || ${admin(d)}`;
// Every lock slot that will exist after this write must name a team that will have a pick.
const locksHavePicks = (picksNode, locksNode) => ['a', 'b', 'c'].map(slot =>
  `(!${locksNode}.child('${slot}').exists() || ${picksNode}.child(${locksNode}.child('${slot}').val()).exists())`).join(' && ');
const teamRe = `/^(${TEAMS.map(t => t.code).join('|')})$/`;
// A lock slot names a real team that this player has picked, and differs from the other slots.
const lockSlot = (slot, others) =>
  `newData.isString() && newData.val().matches(${teamRe}) && ` +
  `${up(3)}.child('picks').child($pid).child(newData.val()).exists() && ` +
  others.map(o => `newData.parent().child('${o}').val() !== newData.val()`).join(' && ');
const NAME_RE = "/^[A-Za-z0-9]+([ '_.-][A-Za-z0-9]+)*$/";
const PID_RE = '/^p[a-z0-9]{10,24}$/';

const rules = {
  rules: {
    '.read': false,
    '.write': false,
    config: {
      '.read': true,
      '.write': admin(1),
      lockAt: { '.validate': 'newData.isNumber() && newData.val() > 1700000000000 && newData.val() < 1900000000000' },
      '$other': { '.validate': false },
    },
    lines: {
      '.read': true,
      '.write': admin(1),
      '$team': { '.validate': `$team.matches(${teamRe}) && newData.isNumber() && newData.val() > 0 && newData.val() < 82 && newData.val() % 1 === 0.5` },
    },
    manualStandings: {
      '.read': true,
      '.write': admin(1),
      updatedAt: { '.validate': 'newData.val() === now' },
      teams: {
        '$team': {
          '.validate': `$team.matches(${teamRe}) && newData.hasChildren(['w', 'l'])`,
          w: { '.validate': 'newData.isNumber() && newData.val() >= 0 && newData.val() <= 82 && newData.val() % 1 === 0' },
          l: { '.validate': 'newData.isNumber() && newData.val() >= 0 && newData.val() <= 82 && newData.val() % 1 === 0' },
          '$other': { '.validate': false },
        },
      },
      '$other': { '.validate': false },
    },
    players: {
      '.read': true,
      '$pid': {
        '.write': `(!data.exists() && newData.exists() && ${beforeLock}) || ${admin(2)}`,
        '.validate': `$pid.matches(${PID_RE}) && newData.hasChildren(['name', 'joinedAt']) && ${up(2)}.child('secrets').child($pid).exists()`,
        name: {
          '.validate': `newData.isString() && newData.val().length >= 2 && newData.val().length <= 24 && newData.val().matches(${NAME_RE}) && ` +
            `${up(3)}.child('names').child(newData.val().toLowerCase()).val() === $pid`,
        },
        joinedAt: { '.validate': 'newData.isNumber()' },
        '$other': { '.validate': false },
      },
    },
    names: {
      '.read': true,
      '$key': {
        '.write': `(!data.exists() && newData.exists() && ${beforeLock}) || ${admin(2)}`,
        '.validate': `newData.isString() && ${up(2)}.child('players').child(newData.val()).child('name').val().toLowerCase() === $key`,
      },
    },
    secrets: {
      '$pid': {
        '.write': `(!data.exists() && newData.exists() && ($pid === 'admin' || (!root.child('players').child($pid).exists() && ${up(2)}.child('players').child($pid).child('name').exists()))) || ${admin(2)}`,
        '.validate': 'newData.isString() && newData.val().matches(/^[0-9a-f]{64}$/)',
      },
    },
    proofs: {
      '$pid': {
        '.write': admin(2), // admin cleanup when deleting a player
        '$hash': {
          '.write': 'newData.exists()',
          '.validate': "$hash === root.child('secrets').child($pid).val() && newData.val() === now",
        },
      },
    },
    // Phones registered to a player (for reading their own picks before the lock). Never readable.
    devices: {
      '$pid': {
        '.write': admin(2), // admin clears these when resetting a code or deleting a player
        '$uid': {
          '.write': `auth != null && auth.uid === $uid && root.child('players').child($pid).exists() && ${proof(3, '$pid')}`,
          '.validate': 'newData.val() === true',
        },
      },
    },
    // Counts only, public, so the board can show "22 of 30 picked · 2 of 3 locks" before the lock.
    summary: {
      '.read': true,
      '$pid': {
        '.write': playerWrite(2),
        '.validate': "newData.hasChildren(['picked', 'locks'])",
        picked: { '.validate': 'newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 0 && newData.val() <= 30' },
        locks: { '.validate': 'newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 0 && newData.val() <= 3' },
        '$other': { '.validate': false },
      },
    },
    // Up to three locks per player, as fixed slots a/b/c (rules can't count children).
    // Hidden until the lock (except from the player's own registered phone), then public.
    locks: {
      '.read': afterLock,
      '$pid': {
        '.read': ownDevice('$pid'),
        '.write': playerWrite(2),
        a: { '.validate': `${lockSlot('a', ['b', 'c'])}` },
        b: { '.validate': `${lockSlot('b', ['a', 'c'])}` },
        c: { '.validate': `${lockSlot('c', ['a', 'b'])}` },
        '$other': { '.validate': false },
      },
    },
    picks: {
      '.read': afterLock,
      '$pid': {
        '.read': ownDevice('$pid'),
        '.write': playerWrite(2),
        // A locked team can't lose its pick unless the lock goes in the same save.
        '.validate': locksHavePicks('newData', `${up(2)}.child('locks').child($pid)`),
        '$team': { '.validate': `$team.matches(${teamRe}) && newData.isString() && (newData.val() === 'O' || newData.val() === 'U')` },
      },
    },
  },
};

writeFileSync(new URL('../database.rules.json', import.meta.url), JSON.stringify(rules, null, 2) + '\n');
console.log('Wrote database.rules.json');
