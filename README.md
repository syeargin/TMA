# Team Hub (TMA)

Club team-management app for A5 Volleyball: schedules and availability, tournaments, ref jobs, meals, travel, team fund, roster and role-based access across multiple teams.

This repo moves the hub from its claude.ai prototype to AWS. The plan lives in [`docs/aws-migration-plan.html`](docs/aws-migration-plan.html), and the data model in [`docs/data-model.html`](docs/data-model.html) and [`db/key-design.md`](db/key-design.md).

## Stack

| Layer | Service |
|---|---|
| Infrastructure | AWS SAM (`template.yaml`), deployed from GitHub Actions through OIDC |
| Site | Angular 22 (standalone components, signals, zoneless) → private S3 bucket → CloudFront |
| Data | DynamoDB single table `TeamHub-<env>` (streams, PITR, TTL) |
| Sign-in | Cognito user pool, email and password, invite-only sign-up |
| API | HTTP API (Cognito JWT authorizer) + one Lambda that checks team roles on every call |
| Live updates | WebSocket API fed by DynamoDB Streams |

## Repository layout

```
template.yaml               app stack (one per environment)
samconfig.toml              dev / prod deploy settings
bootstrap/github-oidc.yaml  one-time: GitHub OIDC trust, deploy roles, artifact bucket
.github/workflows/ci.yml    pull requests: validate templates, build site
.github/workflows/deploy.yml main → dev; release → prod (with approval)
api/                        Lambda code (TypeScript, bundled by SAM with esbuild) and tests
scripts/invite.sh           add a team invite from the command line
web/                        Angular site (see "Site structure" below); the hub's screens arrive through Phase 4
db/                         DynamoDB key design and example items
docs/                       migration plan and data model
legacy/claude-hub.html      current claude.ai hub, source for Phase 4
```

## One-time setup

**1. Deploy the bootstrap stack** (from a machine signed in to account `774924543698` as an administrator):

```bash
aws cloudformation deploy \
  --stack-name tma-bootstrap \
  --template-file bootstrap/github-oidc.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1
```

If the account already has a GitHub OIDC provider, add `--parameter-overrides CreateOidcProvider=false`.

This creates:

| Resource | Name |
|---|---|
| GitHub OIDC provider | `token.actions.githubusercontent.com` |
| Deploy role for dev | `tma-github-deploy-dev` (trusted only from the `dev` environment of `syeargin/TMA`, matched by name and by GitHub's numeric owner/repo IDs) |
| Deploy role for prod | `tma-github-deploy-prod` (trusted only from the `prod` environment) |
| CloudFormation execution role | `tma-cfn-exec` (may create IAM roles only if they're named `tma-*`) |
| SAM artifact bucket | `tma-sam-artifacts-774924543698-us-east-1` |

**2. Create GitHub environments** in *Settings → Environments*:

- `dev`: no rules needed.
- `prod`: add yourself as a required reviewer and limit deployments to protected branches and tags.

**3. Protect `main`** in *Settings → Branches*: require a pull request, and require the CI checks to pass.

**4. Optional budget alert.** Add `AlertEmail=you@example.com` to `parameter_overrides` in `samconfig.toml` to create a monthly AWS budget alert (default $20).

## Deploying

| Trigger | Result |
|---|---|
| Pull request | CI validates both templates and builds the site |
| Merge to `main` | Deploys **dev** and prints the CloudFront URL in the run summary |
| Publish a GitHub release | Deploys **prod** after you approve it |
| *Actions → Deploy → Run workflow* | Deploys the environment you choose |

## Sign-in (Phase 1)

Sign-up is invite-only:

1. An invite is stored as `INVITE#<email>` / `TEAM#<teamId>` with the person's roles and family.
2. On sign-up, a pre-sign-up check refuses emails that have no invite.
3. After the person enters the emailed code, a post-confirmation step turns each invite into a `MEMBER#<sub>` record on that team and deletes the invite.

Emails in the `ClubAdminEmails` parameter (`samconfig.toml`) can sign up without an invite and become admins of the default club (`ClubId`, `a5`). Emails in `PlatformAdminEmails` are site owners; when that's empty, the `ClubAdminEmails` people are. Club admin invites (`INVITE#<email>` / `CLUB#<c>`) also let someone sign up.

Team admins invite people from the team page on the site. You can also add invites from CloudShell:

```bash
scripts/invite.sh dev parent@example.com a5-13tom parent parent:p12:1 p12
scripts/invite.sh dev coach@example.com  a5-13tom coach,admin coach:0
```

**Email sending.** By default Cognito sends verification and reset codes from `no-reply@verificationemail.com`, which is limited to a small number of emails per day. That's fine for testing. For real use, verify a sender in Amazon SES, request SES production access, and set `SesFromEmail=<address>` in `samconfig.toml`.

## API (Phase 2)

Every call needs a Cognito access token (`Authorization: Bearer …`). The API loads the caller's membership for the team and checks it against [`api/src/shared/permissions.ts`](api/src/shared/permissions.ts), the same role table the site uses. Club admins have team-admin rights on every team.

| Route | Who |
|---|---|
| `GET /me` | Anyone signed in (also accepts invites waiting for their email) |
| `PUT /me` (first and last name, copied to every team) | Anyone signed in |
| `GET /teams` · `POST /teams` (`clubId`; team ids are unique across clubs) | Club admins: teams in the clubs they run · admins of that club |
| `GET /clubs` · `POST /clubs` | Club admins (their clubs; site owners see all) · site owners |
| `GET·PUT /clubs/{c}` (name, short name, colors, Team Info links and notes) | That club's admins, site owners |
| `POST /clubs/{c}/admins` · `DELETE …/admins/{sub}` · `DELETE …/invites/{email}` | That club's admins (a club keeps at least one) |
| `GET /teams/{t}` | Members (contacts, ledger, payments and member emails trimmed by role) |
| `PUT /teams/{t}/settings` | Coordinator, team admin (practices, cancellations and the meal budget are kept if left out) |
| `PUT /teams/{t}/practices` · `PUT·DELETE …/practices/cancelled/{pr-id-date}` | Coach, coordinator, team admin |
| `PUT /teams/{t}/refgroups` (players' A/B ref groups only) | Coach, coordinator, team admin |
| `PUT /teams/{t}/handbook` | Coach, coordinator, team admin |
| `PUT·DELETE /teams/{t}/players/{pid}` | Coordinator, team admin |
| `PUT·DELETE /teams/{t}/events/{eid}` | Coach, coordinator, team admin |
| `POST /teams/{t}/events/combine` | Coach, coordinator, team admin — turns one-off events into one repeating event; answers carry over |
| `PUT /teams/{t}/events/{eid}/refjobs` | Coach, coordinator, team admin |
| `PUT /teams/{t}/events/{eid}/agenda` | Coach, coordinator, food, team admin |
| `PUT·DELETE /teams/{t}/events/{eid}/meals/{mid}` | Food, coordinator, team admin |
| `POST·DELETE …/meals/{mid}/claim` | That player's parents; food/coordinator for anyone |
| `PUT /teams/{t}/family/{pid}` | That player's parents; staff for availability; coordinator for travel and sizes |
| `POST /teams/{t}/payments` · `DELETE …/{payId}` | Parents (own family) and anyone for reimbursements · the sender or finance |
| `POST /teams/{t}/payments/{payId}/confirm·decline` | Finance, coordinator, team admin |
| `PUT·DELETE /teams/{t}/ledger/{lid}` | Finance, coordinator, team admin |
| `PUT·DELETE /teams/{t}/announcements/{aid}` | Coach, coordinator, team admin |
| `PUT·DELETE /teams/{t}/tasks/{kid}` | Coordinator, team admin |
| `GET·POST /teams/{t}/invites` · `DELETE …/{email}` | Team admin |
| `GET /teams/{t}/members` · `PUT·DELETE …/{sub}` | Members · team admin (the last team admin can't be removed) |

Money is stored in whole cents (`amountCents`, `costCents`).

**Tests.** `api/test/api` runs every route as each role against a local DynamoDB. CI uses the DynamoDB Local container. Locally:

```bash
docker run -p 8000:8000 amazon/dynamodb-local     # or: pip install "moto[server]" && moto_server -p 8000
cd api && npm test
```

## Live updates (Phase 3)

Changes one person makes appear for everyone else on the team page within a second or two, with no reload.

```
browser ──wss://…/live?token=<access token>──► API Gateway WebSocket ──► authorizer (Cognito access token)
   ▲  {"action":"subscribe","teamId":"a5-13tom"}                          ├─ $connect / $disconnect
   │                                                                       └─ subscribe / ping  (membership checked)
   │ {"type":"changed","collections":["members"]}
   └──────────── FanoutFunction ◄── DynamoDB stream (TEAM# and INVITE# keys only)
```

- The socket only says *what kind* of thing changed. The page then re-reads through the REST API, so a notice never carries data the viewer isn't allowed to see.
- The page pings every 5 minutes, reconnects with backoff (1 s up to 30 s), and refetches after any reconnect to catch changes it missed.
- A change is held back while someone is typing or has ticked a box. The status pill then shows **New changes · Show**. Open "Change" panels stay open through a refresh.
- If someone is removed from a team while viewing it, the next notice sends them back to their team list.
- Deploys check that a WebSocket handshake without a valid token is refused (401/403).
- Alarms: `tma-<env>-fanout-lag` fires when updates are more than a minute behind; `tma-<env>-fanout-errors` fires on repeated fan-out failures.

Try it on dev: open the team page in two browsers (or one normal window and one private window) signed in as two admins. Change a member's roles in one and watch the other update. Turn Wi-Fi off and on in one window: the pill shows *Reconnecting…*, then *Live*, and the page catches up.

## Site structure (Angular)

```
web/src/main.ts                   reads /config.json (written by the deploy), then starts the app
web/src/app/app.ts                shell: header, Live pill, env badge
web/src/app/app.routes.ts         /, /teams/:id (Home), …/schedule, …/tournaments[/:eid[/gameday|ref|meals|travel|agenda]], …/fund, …/roster[/uniforms],
                                  …/info[/tasks], …/members, sign-in screens
                                  (team sections load on demand)
web/src/app/core/                 services shared by every screen
  auth.service.ts                   Cognito sign-in through Amplify
  api.service.ts                    typed REST calls; interceptor adds the access token (API calls only)
  live-client.ts / live.service.ts  WebSocket live updates (framework-free client + Angular wrapper)
  guards.ts, flash.service.ts       signed-in/out routing, one-time messages between screens
web/src/app/layout/               app shell pieces: narrow card (sign-in, your teams), team shell (tabs)
web/src/app/core/team-store.ts    the open team's data for every tab; live refreshes, held while editing
web/src/app/core/schedule.ts      events + weekly practices → schedule rows; availability counts
web/src/app/core/tournament.ts    ref-job rotation, meal days
web/src/app/core/calendar.ts      add-to-calendar: Google/Android, Outlook.com, Outlook 365, .ics (Apple, Outlook desktop)
web/src/app/core/money.ts         fund balance, dues per family, meal budget model
web/src/app/features/             one folder per area: auth, home, team (home, members), schedule, tournaments, fund, roster, info
web/src/app/shared/               small UI pieces and the role checkbox helpers
```

The site imports the API's role table directly (`@shared/permissions` → `api/src/shared/permissions.ts`), so the buttons a person sees always match what the API allows.

## Repeating events and month view

- A team event or deadline can repeat weekly, every 2 weeks or every 3 weeks on chosen weekdays until an end date. Tournament days are skipped unless the coach turns that off. The event is stored once with `repeat {every, days, until, skipTournaments}`, plus `cancelled[]` (struck through on the schedule) and `skip[]` (left off).
- Each date of a series is answered separately. The answer key is `<eid>-<date>`, the same idea as `pr-<id>-<date>` for practices.
- When a coach has entered the same event one date at a time (same name, time and place, on a steady weekly or every-other-week rhythm), the schedule offers **Combine into series**. `POST /events/combine` keeps the first event, makes it repeat, moves everyone's answers to the new keys and removes the rest.
- Rows in a series (weekly practices too) show a ↻ pill. Add to calendar offers the single date or the whole series: Apple and Google get a repeating entry (RRULE, with skipped or cancelled dates as exceptions); Outlook gets the series as an .ics file, since Outlook web links can't carry a repeat.
- The schedule has List and Month views. Month view uses a Sunday-first grid that always shows six weeks at a fixed size (dots only on phones); tap a day to list its items. The choice is remembered on that device.

## Clubs

- The site runs any number of clubs. Each team belongs to one club (`TEAM#<t>/META#CLUB`). Teams made before clubs existed have no such record and belong to the default club (`ClubId`), so existing data needs no migration. The default club's record (A5's name and Team Info links) is written the first time it's needed.
- **Site owners** (`PlatformAdminEmails`, or `ClubAdminEmails` when that's empty) add clubs from **Your teams → Add a club**, naming the first club admin by email. They can open any club and team.
- **Club admins** open their club from **Your teams**. There they set the club name, short name and colors, the notes and links every team sees on Team Info, create teams, and add or remove other club admins. They act as team admin on every team in their club, and nowhere else.
- **Colors:** a club picks a main color and an accent. The site derives the full set of light- and dark-mode colors from those two, darkening (or lightening in dark mode) only as far as needed to keep text readable (WCAG AA). The club page previews the colors on the whole page while choosing. Families see their club's colors on their team's pages; people in several clubs see the standard colors on **Your teams**.

## Setting up clubs and teams from a spreadsheet

Club admins and site owners can set up a whole club or one team from a workbook. The templates are in `web/public/templates/`, and the site serves them at `/templates/…`. They're built by `docs/templates/build-templates.py`.

- **Club setup** (`Club-Setup-Template.xlsx`), uploaded on the club page. Its tabs:
  - **Club**, **Club links** and **Club admins**: the club's settings.
  - **Teams**: every team, with its Team ID, name, program, age group, season and dues. A team can copy its setup from another team.
  - **Staff** and **Rosters**: one row per person or player, by Team ID.
  - **Practice patterns** and **Shared schedule**: each row applies to a team, a list of teams, or a group like `13U National`, `All Regional` or `All`.
  - **Defaults**: the starting handbook and lists for teams the import creates.
- **Team setup** (`Team-Setup-Template.xlsx`) covers one team: Team, Staff, Roster, Practices, Schedule and Lists. Where to upload it:
  - On the team's **Members** page, for that team.
  - On the club page with a Team ID, which creates the team or updates it.

How it works:
- The browser reads the .xlsx (`read-excel-file`, loaded only on that page) and sends plain rows to the API. Dates go as `YYYY-MM-DD` and times as `6:30 PM`.
  - The API endpoints are `POST /clubs/{c}/import` and `POST /teams/{t}/import`.
  - The parser is `api/src/lib/import/parse.ts`; the code that writes to the database is `api/src/lib/import/apply.ts`.
- The API checks everything and returns a **preview**: what each team gets, and every problem by tab and row. Nothing is saved while there are errors.
- The upload is saved in parts so a large club stays within the API's time limit: the club first, then one team per request. The page shows progress as it goes.
- **Uploading again updates instead of duplicating.** Records are matched like this:
  - teams on Team ID
  - players on jersey, then name
  - events on type, date and title
  - practices on name, so cancelled dates stay attached
  - people on email
- Blank cells keep what's saved, and nothing is removed. Players, events and people not in the workbook stay, and so does everything families entered.
- Staff and parents are added as invites with the right roles, and parents are linked to their player. People get access when they sign in or create an account with that email; no email is sent.
- Archived teams can't be imported into. A Team ID another club uses is an error.

Tests: `api/test/import/`. The sample workbooks there are made by `make-samples.py`, then read the way the browser reads them by `to-json.mjs`.

## Importing a team from the claude.ai hub

1. Export the hub's database for the team as JSON files (`teams/<t>.json` and `teams/<t>/<collection>/<doc>.json`).
2. Convert it. This replays every record through the API against a local DynamoDB (DynamoDB Local or moto on port 8000), so the items get exactly the keys and checks the API uses, then writes them to one file:
   ```bash
   cd api && DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npx vite-node scripts/hub-import/convert.ts -- <exportDir> a5-13tom-items.json a5-13tom a5
   ```
   It prints what it converted and anything it couldn't carry over (for example the hub's "Who does what" names, which come from member accounts here).
3. Load it from CloudShell. Without `--yes` it only shows what would change:
   ```bash
   python3 scripts/load-team.py dev a5-13tom-items.json
   python3 scripts/load-team.py dev a5-13tom-items.json --yes
   ```
   The team ends up matching the file. Its memberships are kept; its other records that aren't in the file (test events, families, payments) are removed. Nothing outside the team is touched.

The items file holds families' names, phone numbers and emails. Don't commit it.

### A test team with made-up people

`api/scripts/test-team/generate.ts` builds a test team shaped like a real one (by default `a5-13test` in A5; pass a team id, club id and name to put it elsewhere, such as `test-13` in the Test Club): it takes the real team's schedule, practices, handbook and checklists from a hub export and invents every person (players, parents, phones, `@example.com` emails, allergies, sizes, travel, staff). Real names in shared text are replaced, and the run fails if any real player, parent or staff name, phone or email is left. It also fills in data for every feature: availability answers, travel plans, uniform sizes, ref jobs, claimed meals, a cancelled practice, a repeating event with a cancelled date, one-off events that form a pattern (for "Combine into series"), a team fund ledger and three pending payments.

```bash
# Test 13 in the Test Club (club id "test"; add the club in the app first)
cd api && DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npx vite-node scripts/test-team/generate.ts -- <exportDir> test-13-items.json test-13 test "Test 13"
python3 scripts/load-team.py dev test-13-items.json --yes   # from CloudShell
```

Dates for answers, the series and payments are set relative to the day you run it, so regenerate it when the test data gets stale.

### Archiving and removing a team

Site owners do both from the club page: open the club, then **Manage** next to the team.

- **Archive** (when a season is over): the team and its data stay, but nothing on it can change. That covers every write under `/teams/{t}/`, by anyone, including site owners. Families find it under **Archived teams** on their home page. **Restore** undoes it. API: `POST /teams/{t}/archive`, `POST /teams/{t}/restore`.
- **Delete**: removes the team and everything stored for it. You confirm by typing the team id (the API takes `DELETE /teams/{t}` with `{"confirm": "<t>"}`). It deletes the same records as the script below. Live connections are left to expire, so anyone with the team open is told they've lost access.

The script does the same delete from CloudShell, for when the app isn't available. Without `--yes` it only lists what it would delete:

```bash
python3 scripts/delete-team.py dev jvc13e
python3 scripts/delete-team.py dev jvc13e --yes
```

It deletes the team's whole partition (settings, handbook, roster and contacts, schedule with ref jobs, agendas and meals, families, payments, ledger, announcements, tasks, memberships), its entry in the club's team list, any invites still waiting for the team, and its live-update connections. It leaves alone other teams, the club, and people's accounts and profiles, since people can be on other teams. Point-in-time recovery keeps the deleted records for up to 35 days.

## Local development

Node 24 is required (Angular 22 needs 22.22.3+ or 24).

```bash
cd web && npm install && npm start        # site on http://localhost:4200
cd web && npm test                         # unit tests (Vitest): live client, API service, messages
cd api && npm install && npm test         # unit and integration tests for the Lambda code
npm install -g esbuild                     # needed once for sam build
sam validate --lint && sam build          # check and build the stack
```

To run the site locally against dev, copy the dev site's `/config.json` into `web/public/config.json` (don't commit it; the committed copy only says `{"env":"local"}`). The dev API accepts calls from `http://localhost:4200`.

To try the site with no AWS at all, build it (`cd web && npx ng build`), start DynamoDB Local or moto on port 8000, and run `cd api && npx vite-node scripts/preview-server.ts`. That serves the site and the real API code on http://127.0.0.1:4300, with a seeded site owner, a Test Club and three teams (one archived). It has no real sign-in: the browser needs a stored Cognito token whose `sub` is `u-owner` (site owner) or `u-mom` (a parent), and the server doesn't check the token's signature. Use it for screenshots and local checks only.

## Notes

- The table and site bucket use `DeletionPolicy: Retain`, so deleting a stack never deletes data.
- Deletion protection is on for the prod table.
- If `TeamHub-dev` already exists from the earlier CLI scripts, delete it first (it's empty) or import it into the stack. Otherwise the first deploy fails with "already exists".
- No custom domain yet. The site is served from its `*.cloudfront.net` address until one is added.
