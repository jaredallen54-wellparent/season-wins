# Updating standings from a single prompt

This explains what happens when the owner says **"update standings"** (or "please update standings", "run the update") in a Claude Code session, why it works the way it does, and exactly how to do it. It is written for a future session that has no memory of how this was set up.

**Short version:** push an empty commit to `main`. That starts the GitHub Actions workflow, which fetches fresh records, saves `standings.json`, and republishes the site. Wait for the run to finish, pull, and report the new records.

---

## 1. How standings flow into the app

```
ESPN standings JSON ──┐
                      ├─► scripts/fetch-standings.mjs ─► standings.json (committed to main)
NBA.com schedule JSON ┘                                        │
                                                               ▼
                                     GitHub Actions "deploy" job copies the site
                                                               │
                                                               ▼
                               Firebase Hosting: https://season-wins.web.app
                                                               │
                                                               ▼
                         Browser loads standings.json and scores every pick
```

- **Workflow:** `.github/workflows/site.yml`, named **"Standings + deploy"**. It has three jobs:
  1. `test` runs the unit tests (scoring, team-name mapping, feed parsers).
  2. `standings` runs `node scripts/fetch-standings.mjs`, then commits `standings.json` back to `main` as **standings-bot** with the message "Update standings". That commit only happens if the file changed.
  3. `deploy` checks out the latest `main`, which includes the new standings, and publishes `index.html`, `css/`, `js/` and `standings.json`. It goes to Firebase Hosting (season-wins.web.app). GitHub Pages serves a page that forwards to that address.
- **Fetch script:** `scripts/fetch-standings.mjs`.
  - Tries ESPN first (`site.api.espn.com/.../standings?season=2027`).
  - Falls back to the NBA.com full-season schedule, counting final scores of regular-season games (game IDs starting `002`).
  - Every result is validated before it's used:
    - all 30 teams are present, and every team name maps to a code (an unknown name fails loudly);
    - league wins equal league losses;
    - the feed is for the right season;
    - no games counted before opening night, which would mean last season's table.
  - Saves only when a record changed, or when the last save is more than 20 hours old.
- **The app:** `js/app.js` fetches `standings.json` on load and every 30 minutes. Pages left open pick up new standings within half an hour; a refresh shows them right away.
- **Hand-entered standings:** if an admin entered standings in **Admin → Standings by hand** (stored in Firebase at `manualStandings`), the app uses whichever is newer, that entry or `standings.json`.

## 2. Why the update is triggered this way

| Constraint | Consequence |
|---|---|
| GitHub's scheduled (cron) runs are best effort. Here they started 1–7 hours late, and some never ran. | The workflow has four daily schedules: 6:17 AM, 8:47 AM, 12:17 PM and 5:17 PM ET. Even so, last night's late games often aren't on the board first thing, so the owner asks for a manual update. |
| The Claude Code sandbox can't reach ESPN or NBA.com: the network policy blocks them. | Claude can't fetch standings itself. The fetch has to run on GitHub's servers. |
| The session's GitHub token can't start a workflow directly. `POST .../actions/workflows/site.yml/dispatches` returns **403 "Resource not accessible by integration"**, and `gh workflow run` fails because GraphQL is blocked. | The only trigger available is the workflow's **`push` to `main`**. On a push, the `standings` job runs and then `deploy` runs, which is exactly a manual update. |
| An empty commit changes no files. | `git commit --allow-empty` is a safe, zero-change way to cause that push. |

On a push, the fetch step has `continue-on-error: true`, so a feed outage never blocks publishing a code change. For a manual update, that means a green run does **not** prove standings were fetched. Always check `updatedAt` afterwards (step 4).

## 3. Prerequisites in a new session

- The repository **`jaredallen54-wellparent/season-wins`** must be in the session with **push** access. If it isn't, attach it with the `add_repo` tool (`access: "push"`) and clone it to `/home/user/season-wins`.
- `gh` works for **reading** runs: `gh run list -R jaredallen54-wellparent/season-wins`. Writes go through `git push`.
- No Firebase access is needed. Standings never touch the database unless an admin enters them by hand.

## 4. The procedure (copy and run)

```bash
cd /home/user/season-wins
git checkout -q main && git pull -q origin main

# 1. Note the current standings timestamp (to compare afterwards)
grep updatedAt standings.json

# 2. Trigger: empty commit + push to main.
#    End the message with the attribution lines the session's system reminder gives.
git commit -q --allow-empty -m "Refresh standings (manual)"
git push -q origin main

# 3. Wait for the run to finish (don't chain plain sleeps; use an until-loop)
sleep 20
until [ "$(gh run list -R jaredallen54-wellparent/season-wins -L 1 --json status -q '.[0].status')" = "completed" ]; do sleep 5; done
gh run list -R jaredallen54-wellparent/season-wins -L 1   # expect: completed  success  Refresh standings (manual)

# 4. Pull the bot's commit and read the result
git pull -q origin main
node -e '
const s=require("./standings.json"); let g=0; for (const r of Object.values(s.teams)) g+=r.w+r.l;
console.log("updated:", s.updatedAt, "| games:", g/2);
console.log(Object.entries(s.teams).sort((a,b)=>(b[1].w-b[1].l)-(a[1].w-a[1].l)||a[0].localeCompare(b[0])).map(([c,r])=>c+" "+r.w+"-"+r.l).join(", "))'
```

A run normally takes about 1 minute, and occasionally 3–4.

**How to read the result:**
- **`updatedAt` is just now and the game count went up:** new results are in and the site is republished.
- **`updatedAt` is unchanged:** there were no new games since the last save, or the feeds failed. To tell which, open the run's **standings** job and check whether the **Fetch standings** step reported `✓ espn: N games played` or an error. If an automatic run already saved last night's games, a manual update correctly finds nothing new.

## 5. How to report back to the owner

The owner is not a developer. Keep the reply short and plain:

1. One line: updated and live, the time in **ET**, and the number of games played. Tell them to refresh the board.
2. A compact table of records grouped by win–loss.
3. Two to four bullets on what changed since the last update: unbeaten or winless teams, big streaks, and teams far from their pool line. The lines are in `js/teams.js` (`DEFAULT_LINES`; the admin can edit them in the app).
4. If nothing changed, say the board was already current and why. For example: the games named are tonight's, not last night's. Check the date before calling games "last night's".

Never claim to know who leads the pool. Before the lock, the database rules hide individual picks, and Claude has no admin read access to them.

## 6. Troubleshooting

| Symptom | What to do |
|---|---|
| `git push` is rejected (non-fast-forward) | Someone (usually standings-bot) pushed first. Run `git pull --rebase origin main`, then push again. |
| Push fails with 403 or permission errors | The session lacks push access. Attach the repository with `add_repo` and `access: "push"`. |
| The run fails in `test` | A code change broke the unit tests. Fix it before anything else; standings and deploy don't run until tests pass. |
| `Fetch standings` errors (shown as success on a push) | Usually ESPN briefly failing or changing shape. NBA.com is the automatic fallback. If both fail, the error names the cause, for example `Unmapped team name: …`, which means adding an alias in `js/teams.js`. Meanwhile the owner can use **Admin → Standings by hand**. |
| `deploy` fails at "Deploy to Firebase Hosting" | The `FIREBASE_SERVICE_ACCOUNT` repo secret may be missing or expired, or the service account lost its **Firebase Hosting Admin** or **API Keys Viewer** role. The owner fixes this in Google Cloud and GitHub; never ask for the key in chat. |
| The board says "Standings are more than 9 days old" | Every automatic run has been failing. Check the Actions tab, then run this procedure. |

## 7. Changing the schedule

The `cron:` lines at the top of `.github/workflows/site.yml` are in UTC. They currently run at 6:17 AM, 8:47 AM, 12:17 PM and 5:17 PM ET. More runs are cheap, because a run only saves and republishes when records change. For on-the-minute reliability, an outside scheduler such as cron-job.org could call the workflow-dispatch API with a fine-grained GitHub token. The owner declined that, so manual "update standings" requests are the backup.

## 8. Safety notes

- Never print or log edit codes, the admin code, `secrets/`, or the Firebase service-account key.
- An empty commit can't damage anything. Don't change other files as part of an "update standings" request.
- Work on `main` directly for this task only. Code changes go on a branch and wait for the owner's "go" before merging.
