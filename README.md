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

Emails in the `ClubAdminEmails` parameter (`samconfig.toml`) can sign up without an invite and become club admins.

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
| `GET /teams` · `POST /teams` | Anyone · club admins |
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

## Notes

- The table and site bucket use `DeletionPolicy: Retain`, so deleting a stack never deletes data.
- Deletion protection is on for the prod table.
- If `TeamHub-dev` already exists from the earlier CLI scripts, delete it first (it's empty) or import it into the stack. Otherwise the first deploy fails with "already exists".
- No custom domain yet. The site is served from its `*.cloudfront.net` address until one is added.
