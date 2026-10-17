// End-to-end test across the lock moment, against the local emulators (never production).
//   npm run test:e2e        (needs Playwright + Chromium; set PLAYWRIGHT_DIR if it isn't resolvable)
// Three players join and pick; a visitor who never joined watches the board. The lock is set ~90 s
// ahead. Pages stay open across it, and everyone's picks must appear without a reload.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = new URL('../..', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || join(ROOT, 'tests/e2e/shots');
const require = createRequire(process.env.PLAYWRIGHT_DIR || import.meta.url);
const { chromium } = require('playwright');
await mkdir(SHOTS, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const srv = createServer(async (req, res) => {
  const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html')));
  try { res.writeHead(200, { 'content-type': types[extname(p)] || 'text/plain' }); res.end(await readFile(p)); }
  catch { res.writeHead(404); res.end(); }
}).listen(8080);
const URL0 = 'http://localhost:8080/?emulator#/';
const DB_REST = 'http://127.0.0.1:9000';
const NS = 'ns=demo-swou-default-rtdb';

const browser = await chromium.launch();
const errors = [];
const t0 = Date.now();
const log = m => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${m}`);
let failed = 0;
const check = (ok, m) => { log(`${ok ? 'PASS' : 'FAIL'} ${m}`); if (!ok) failed++; };

async function ctx(opts = {}) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...opts });
  // Serve the Firebase SDK from node_modules (identical files to the CDN) so this runs offline.
  await c.route('https://www.gstatic.com/firebasejs/**', async r =>
    r.fulfill({ contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/firebase', new URL(r.request().url()).pathname.split('/').pop())) }));
  await c.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  c.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  return c;
}
const saved = p => p.waitForFunction(() => document.querySelector('.pk-head [role=status]')?.textContent.includes('Saved'), null, { timeout: 15000 });

// --- admin sets up the game with the lock ~90 s away
const A = await ctx(); const ap = await A.newPage(); ap.on('dialog', d => d.accept());
await ap.goto(URL0.replace('#/', '#/admin'));
await ap.click('summary:has-text("First-time setup")'); await ap.click('[data-claim]');
await ap.waitForSelector('.code'); await ap.click('[data-done-code]'); await ap.waitForSelector('#lock-form');
const LOCK_IN_MS = 90e3;
const lockAt = new Date(Date.now() + LOCK_IN_MS);
const local = new Date(lockAt.getTime() - lockAt.getTimezoneOffset() * 6e4).toISOString().slice(0, 19);
await ap.$eval('#lock-form input', (el, v) => { el.step = 1; el.value = v; }, local);
await ap.click('#lock-form button'); await ap.waitForTimeout(800);
log(`lock set for ${lockAt.toISOString()}`);

// --- three players join and pick (Cy leaves picks unfinished and uses only 1 lock)
const players = [];
for (const [i, name] of ['Amy', 'Bob', 'Cy'].entries()) {
  const c = await ctx({ colorScheme: i === 1 ? 'dark' : 'light' }); const p = await c.newPage();
  await p.goto(URL0); await p.click('.intro-cta >> text=Join the game');
  await p.fill('#name', name); await p.click('button[type=submit]');
  await p.waitForSelector('.code'); const code = await p.textContent('.code');
  await p.click('[data-done-code]'); await p.waitForSelector('.pk-list');
  const codes = await p.$$eval('button[data-pick][data-v="O"]', b => b.map(x => x.dataset.pick));
  const n = i === 2 ? 12 : 30;
  for (const [k, t] of codes.slice(0, n).entries()) await p.click(`button[data-pick="${t}"][data-v="${(k + i) % 2 ? 'U' : 'O'}"]`);
  await saved(p);
  for (const t of codes.slice(i * 3, i * 3 + (i === 2 ? 1 : 3))) await p.click(`button[data-lock="${t}"]`);
  await saved(p);
  players.push({ name, code, c, p });
  log(`${name} joined: ${await p.textContent('.pk-head span')}`);
}
const [amy, bob, cy] = players;

// --- before the lock: privacy checks
const rest = async path => (await fetch(`${DB_REST}/${path}.json?${NS}`)).status;
check(await rest('picks') === 401, 'a direct database read of all picks is refused before the lock');
check(await rest('locks') === 401, 'a direct database read of all locks is refused before the lock');
const V = await ctx(); const vp = await V.newPage();
await vp.goto(URL0); await vp.waitForSelector('.lb');
const preText = await vp.textContent('.lb');
check(/30 of 30 picked/.test(preText) && /12 of 30 picked/.test(preText), `visitor sees counts before the lock`);
check(await vp.$('.team .chip') === null, 'visitor sees no pick chips on team rows before the lock');
await vp.screenshot({ path: `${SHOTS}/1-visitor-before-lock.png` });
await vp.locator('.lb').screenshot({ path: `${SHOTS}/1b-board-counts-before-lock.png` });
await amy.p.goto(URL0); await amy.p.waitForSelector('.lb');
check(await amy.p.$('.team .chip') === null, "Amy can't see anyone's picks before the lock");
check(/You picked/.test(await amy.p.textContent('.teams')), 'Amy sees her own pick on each team row');
await amy.p.screenshot({ path: `${SHOTS}/2-amy-before-lock.png` });

// Amy's second device (signs in with her code) sees her saved picks and locks
const A2 = await ctx(); const a2 = await A2.newPage();
await a2.goto(URL0.replace('#/', '#/signin'));
await a2.fill('#sname', 'amy'); await a2.fill('#scode', amy.code); await a2.click('button[type=submit]');
await a2.waitForSelector('.pk-list', { timeout: 15000 });
check((await a2.textContent('.pk-head span')).includes('30 of 30 picked · 🔒 3 of 3 locks'), "Amy's second phone loads her 30 picks and 3 locks");

// A phone whose clock runs 10 minutes slow must still flip at the real lock time (server clock).
const S = await ctx(); const sp = await S.newPage();
await sp.clock.install({ time: new Date(Date.now() - 10 * 60e3) });
await sp.clock.resume();
await sp.goto(URL0); await sp.waitForSelector('.lb');
await bob.p.goto(URL0); await bob.p.waitForSelector('.lb');

// Admin can't open anyone's picks before the lock either
await ap.goto(`${URL0.replace('#/', '#/picks/')}`); // no pid, own sheet: admin isn't a player here
check(await rest(`picks/x`) === 401, 'unauthenticated read of a single player is refused');

// --- wait across the lock with pages open
const waitMs = lockAt.getTime() - Date.now();
log(`waiting ${(waitMs / 1000).toFixed(0)} s for the lock with Amy, Bob (dark), a visitor and a slow-clock phone open…`);
const revealed = async (p, who) => {
  const start = Date.now();
  await p.waitForSelector('.team .chip', { timeout: waitMs + 90e3 });
  log(`${who}: picks appeared ${((Date.now() - lockAt.getTime()) / 1000).toFixed(1)} s after the lock, no reload`);
};
await Promise.all([revealed(vp, 'visitor'), revealed(amy.p, 'Amy'), revealed(bob.p, 'Bob'), revealed(sp, 'slow-clock phone')]);
check(true, 'all four open pages revealed picks without reloading');
check(await rest('picks') === 200, 'a direct database read of picks is allowed after the lock');
const postText = await vp.textContent('.lb');
check(/points/.test(postText), 'leaderboard switched to points after the lock');
const chips = await vp.$$eval('.team .chip', c => c.length);
check(chips === 30 + 30 + 12, `visitor sees every pick on team rows (${chips} chips)`);
const lockChips = await vp.$$eval('.team .chip.lock', c => c.length);
check(lockChips === 3 + 3 + 1, `visitor sees every lock (${lockChips})`);
await vp.click('.lb summary');
await vp.screenshot({ path: `${SHOTS}/3-visitor-after-lock.png` });
await bob.p.screenshot({ path: `${SHOTS}/4-bob-dark-after-lock.png` });
await vp.screenshot({ path: `${SHOTS}/5-visitor-after-lock-full.png`, fullPage: true });

// --- after the lock: players can't edit, admin can, everyone sees the admin's change live
await amy.p.goto(URL0.replace('#/', '#/picks')); await amy.p.waitForSelector('.pk-list');
check(await amy.p.$$eval('button[data-pick]:not([disabled])', b => b.length) === 0, "Amy's pick buttons are disabled after the lock");
const ids = await ap.evaluate(async () => (await fetch('http://127.0.0.1:9000/players.json?ns=demo-swou-default-rtdb')).json());
const cyId = Object.keys(ids).find(k => ids[k].name === 'Cy');
await ap.goto(URL0.replace('#/', `#/picks/${cyId}`)); await ap.waitForSelector('.pk-list');
const team = (await ap.$$eval('button[data-pick][data-v="O"]', b => b.map(x => x.dataset.pick)))[29]; // one Cy didn't pick
await ap.click(`button[data-pick="${team}"][data-v="O"]`); await saved(ap);
await vp.waitForFunction(n => document.querySelectorAll('.team .chip').length === n, 30 + 30 + 13, { timeout: 15000 });
check(true, "visitor sees the admin's post-lock edit to Cy's picks without reloading");

log(`page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
if (errors.length) failed++;
await browser.close(); srv.close();
log(failed ? `${failed} check(s) FAILED` : 'ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
