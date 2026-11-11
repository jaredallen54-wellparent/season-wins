# Season Wins Over/Under: notes for Claude

A friend-group NBA win-totals over/under game: static site at https://season-wins.web.app with a Firebase Realtime Database. The owner is not a developer. Keep replies plain, short and non-technical, and give times in ET.

## "Update standings"
When the owner asks to update or refresh standings, follow **[docs/updating-standings.md](docs/updating-standings.md)**.

1. Push an empty commit to `main`. That triggers the "Standings + deploy" GitHub Action, which fetches ESPN/NBA.com records, commits `standings.json` and republishes the site.
2. Wait for the run to finish.
3. Pull, then report the records.

Direct workflow dispatch isn't allowed from these sessions, and the sandbox can't reach ESPN or NBA.com, so the push is the trigger.

## Other ground rules
- Code changes go on a branch. Test them, show the owner, and merge to `main` only after they say "go"; a push to `main` publishes the live site.
- Before the lock, individual picks are private, and that privacy is enforced by `database.rules.json`. Never guess who leads the pool.
- Database rules are generated: edit `scripts/build-rules.mjs`, then run `npm run rules`. The owner publishes the result by pasting it into Firebase → Realtime Database → Rules. Hosting deploys never deploy rules.
- Tests:
  - `npm test` (unit tests)
  - `npm run test:rules` (database emulator; needs Java)
  - `npm run test:e2e` (browser test across the lock; set `PLAYWRIGHT_DIR` to the folder holding Playwright)
- Never print or log edit codes, the admin code, `secrets/`, or service-account keys.
