# Season Wins Over/Under (NBA 2026–27)

A small web page for a friend group. Everyone picks **Over** or **Under** on all 30 NBA win totals before opening night. A live leaderboard scores everyone as the season goes. There are no accounts: each player gets a random **edit code** instead.

- **Site:** plain HTML/CSS/JS with no build step, at **https://season-wins.web.app** (Firebase Hosting, free). The old GitHub Pages address forwards there and carries over each device's saved sign-in.
- **Shared data:** **Firebase Realtime Database**, free "Spark" plan. Security comes from `database.rules.json`, which the database enforces itself.
- **Standings:** a GitHub Action fetches the W–L records (ESPN first, NBA.com as backup) and commits `standings.json`. The admin can also enter standings by hand.
- **Picks lock:** Tue **Oct 20, 2026 at 2:55 PM ET**, five minutes before the first tip-off (Celtics at Pistons, 3:00 PM ET on NBC). The database enforces the lock, so changing the page code can't get around it. The admin can still edit afterwards.

---

## One-time setup (about 15 minutes)

### 1. Firebase (the shared database)
1. Go to <https://console.firebase.google.com> and sign in with a Google account.
2. **Create a project.** Any name works, e.g. `season-wins`. Google Analytics is optional; turn it off.
3. In the left menu: **Build → Realtime Database → Create Database**. Choose a US location and **Start in locked mode**.
4. Open the **Rules** tab. Delete what's there, paste the whole contents of [`database.rules.json`](database.rules.json), and press **Publish**.
5. Click the gear icon, then **Project settings**. Under **Your apps**, click the `</>` (Web) icon and register an app with any nickname. Don't set up Hosting. Firebase then shows a `firebaseConfig = { … }` block.
6. Put that block into [`js/firebase-config.js`](js/firebase-config.js), replacing `null`. Make sure it includes the `databaseURL` line. The config is meant to be public; the rules are what protect the game.

### 2. GitHub (hosting and the weekly standings job)
1. Create a **public** repository, e.g. `season-wins`. Free GitHub Pages needs a public repo.
2. Push this folder to it (or ask Claude to).
3. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Go to **Settings → Actions → General → Workflow permissions** and choose **Read and write permissions**. This lets the bot commit `standings.json`.
5. Go to the **Actions** tab, open **Standings + deploy**, and click **Run workflow**. Tick **dry run** the first time: it checks that the standings feeds work without saving anything. Then run it again without dry run.
6. Your link is `https://<your-github-name>.github.io/<repo-name>/`.

### 3. Become the admin (do this before sharing the link)
1. Open `<your link>#/admin`, expand **First-time setup**, and press **Claim admin**. Only the first person to press it becomes admin, ever.
2. **Save the admin code** it shows. If you lose it, see "Admin code lost" below.
3. In the admin page, check every line against FanDuel and fix any that differ. The seed lines come from **Fanatics (Oct 15)**, not FanDuel. Lines must end in .5.

### 4. Share the link in the group chat 🎉

---

### 5. Address: season-wins.web.app
The GitHub Action publishes to Firebase Hosting when the repo has a `FIREBASE_SERVICE_ACCOUNT` secret (a Google Cloud service-account key with the **Firebase Hosting Admin** and **API Keys Viewer** roles). Once that works, GitHub Pages serves only a forwarding page (`redirect/`). Without the secret, GitHub Pages keeps serving the full site.

## Day-to-day

| Task | How |
|---|---|
| Change how often standings update | Edit the `cron:` lines at the top of [`.github/workflows/site.yml`](.github/workflows/site.yml) (times are UTC). It runs at 6:17 AM ET with backups at 8:47 AM, 12:17 PM and 5:17 PM ET, because GitHub sometimes starts scheduled runs hours late or skips them. A run only saves when records changed. Standings also refresh whenever a change is published. |
| Update standings right now | **Actions → Standings + deploy → Run workflow** |
| The feed broke | GitHub emails you when the job fails. Meanwhile go to **Admin → Standings by hand**. The newer of your manual entry and the automatic feed always wins. |
| Someone lost their edit code | **Admin → Players → Reset code**, then send them the new code |
| Fix a name / remove a player | **Admin → Players → Rename / Delete** |
| Edit someone's picks after the lock | **Admin → Players → Edit picks** |
| Opening night moves | **Admin → Lock time** |

The page warns "Standings are more than 9 days old" if the feed has stopped. The warning only appears after the lock.

GitHub pauses scheduled jobs in repos with no activity for 60 days. The weekly standings commits count as activity, so this shouldn't happen during the season.

### Admin code lost
In the Firebase console, open **Realtime Database → Data**, delete the `secrets → admin` entry, then claim admin again at `#/admin`.

---

## How the security works (no accounts)

- When you join, your browser creates a random 12-character code (about 59 bits, so it can't be guessed). Only its **SHA-256 hash** is stored, at `secrets/<player>`, and **nobody can read** `secrets/`.
- Every save also writes a proof to `proofs/<player>/<hash>` stamped with the server clock. The rules accept the change only if a proof exists at the path named by *that player's* stored hash, made *in this same request*. Old proofs can't be replayed. Proofs are unreadable.
- **Picks and locks are hidden until the lock, enforced by the database.** Before `config/lockAt`, `picks/` and `locks/` can't be read by anyone, the admin included, except a player reading **their own** picks from a phone registered to them. Each phone signs in with **Firebase Anonymous Authentication** (invisible, no account). When a player joins or signs in with their code, the app writes `devices/<player>/<phone id>` together with a code proof. After the lock, everyone can read all picks and locks, including visitors who never joined.
- Before the lock the board shows only counts from `summary/<player>` (`{picked, locks}`), saved with every pick change. The rules check the ranges but can't count picks, so a player could fake their own counts. That only affects the pre-lock progress display; after the lock the board uses the real picks.
- Pages left open across the lock: the app uses the server clock (`.info/serverTimeOffset`), sets a timer for `lockAt`, re-subscribes to everyone's picks, and retries every 15 s (then every minute) if the database refuses at first.
- The rules also enforce:
  - names unique regardless of capitalization (2–24 characters);
  - picks only `O`/`U` for real teams;
  - at most 3 distinct locks, each on a picked team, and a locked pick can't be cleared without removing its lock;
  - no joining or player changes after the lock;
  - lines, the lock time, hand-entered standings, renames, deletes and code resets are admin-only.
- Resetting a player's code also unregisters their phones.

## Scoring
Pure functions in [`js/scoring.js`](js/scoring.js), tested in [`tests/scoring.test.js`](tests/scoring.test.js).

- expected = line × GP / 82
- delta = W − expected
- projected = W / GP × 82
- **Over clinched** when W > line; **Under clinched** when W + remaining < line.
- Pick status: **✓ clinched** / **✕ out of reach** once decided; otherwise **▲ on pace** / **▼ behind** depending on the sign of delta; **– even** when delta = 0.
- **Locks:** every player marks exactly 3 picks as 🔒 locks (stored as slots `locks/<player>/a|b|c`; the rules allow only real, picked, distinct teams, and freeze them at the lock time like picks).
- **Points:** normal pick +1 if clinched or on pace, otherwise 0. Lock +2 if clinched or on pace, −1 if out of reach or behind, 0 if even.
- Sort by points, then points from clinched picks, then fewest out of reach, then name. Players tied on (points, clinched points) share a rank. After 82 games every pick is clinched or out of reach, so points become final.
- Season progress = (sum of GP) ÷ 2 out of 1,230 games.

## Developer notes
```
npm install            # only needed for the rules tests
npm test               # scoring, team-name mapping, feed parsers
npm run test:rules     # rebuilds database.rules.json, runs it in the Firebase emulator (needs Java)
npm run test:e2e       # browser test across the lock moment (auth + database emulators, Playwright)
npm run rules          # rebuild database.rules.json after editing scripts/build-rules.mjs
node scripts/fetch-standings.mjs --dry-run   # try the live feeds
```
Local preview against the emulator: run `npx firebase emulators:start --only database --project demo-swou`, serve the folder (e.g. `npx serve .`), and open `http://localhost:3000/?emulator`.

Team-name mapping lives in [`js/teams.js`](js/teams.js). It knows ESPN's `GS`, `NY`, `NO`, `SA`, `UTAH`, `WSH` and both "LA"/"Los Angeles" spellings. Any unknown name stops the standings job with an error rather than guessing.
