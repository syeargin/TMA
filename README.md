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

If the account already has a GitHub OIDC provider, add `--parameter-overrides CreateOidcProvider=false`. The template is built by `bootstrap/build.py`: edit that, then run `python3 bootstrap/build.py > bootstrap/github-oidc.yaml`. CI fails if the two differ, or if any dev resource names prod (or the reverse) (`bootstrap/check.py`).

Each environment gets its own three IAM pieces, so a dev deploy can't change prod:

| Resource | dev | prod |
|---|---|---|
| GitHub deploy role, trusted only from that GitHub environment of `syeargin/TMA` (matched by name and by GitHub's numeric owner/repo IDs) | `tma-github-deploy-dev` | `tma-github-deploy-prod` |
| CloudFormation execution role. Table, site bucket, functions, roles, logs, alarms and budget are limited to that environment's names. Cognito, API Gateway and CloudFront have random ids, so anything tagged for the other environment is refused instead. | `tma-cfn-exec-dev` | `tma-cfn-exec-prod` |
| Permissions boundary every role the app stack creates must carry: that environment's table and stream, its own logs, tracing and WebSocket replies, nothing else | `tma-dev-boundary` | `tma-prod-boundary` |

Shared by both: the GitHub OIDC provider and the SAM artifact bucket `tma-sam-artifacts-774924543698-us-east-1`. Each deploy role reads and writes only its own `tma-<env>/` folder in it.

**2. Create GitHub environments** in *Settings → Environments*:

- `dev`: under **Deployment branches and tags**, choose **Selected branches and tags** and add the branch `main`.
- `prod`: add yourself as a required reviewer. Under **Deployment branches and tags**, choose **Selected branches and tags** and add the tag pattern `v*`.

GitHub enforces these rules before it gives a run the token AWS trusts, so a workflow edited on another branch still can't deploy. `deploy.yml` checks the same rules in its first step.

**3. Protect `main`** in *Settings → Branches*: require a pull request, and require the CI checks to pass.

**4. Optional budget alert.** Add `AlertEmail=you@example.com` to `parameter_overrides` in `samconfig.toml` to create a monthly AWS budget alert (default $20).

## Deploying

| Trigger | Result |
|---|---|
| Pull request | CI validates both templates and builds the site |
| Merge to `main` | Deploys **dev** and prints the CloudFront URL in the run summary |
| Publish a GitHub release | Deploys **prod** after you approve it |
| *Actions → Deploy → Run workflow* | Deploys the environment you choose |


### Switching existing stacks to their own roles (R1)

The stacks used to deploy through one shared execution role, `tma-cfn-exec`, with PowerUserAccess. To move them over:

1. Redeploy the bootstrap stack with the command above. It adds the new roles and boundaries and keeps `tma-cfn-exec` for now.
2. Set the GitHub environment rules in step 2 above.
3. Merge to `main`. The dev deploy uses `tma-cfn-exec-dev`, and the boundary is added to dev's Lambda roles. If CloudFormation reports `AccessDenied`, the message names the missing action. Add it to `bootstrap/build.py`, rebuild, and redeploy the bootstrap stack.
   If the rollback itself stalls (`UPDATE_ROLLBACK_FAILED`), finish it with the old role: `aws cloudformation continue-update-rollback --stack-name tma-dev --role-arn arn:aws:iam::774924543698:role/tma-cfn-exec`.
4. Publish a release so prod deploys once through `tma-cfn-exec-prod`.
5. Remove the shared role: redeploy the bootstrap stack with `--parameter-overrides KeepSharedExecRole=false`.

### Moving prod to its own AWS account

This is the stronger form of R1. Nothing in dev can then reach prod, including its Cognito users, APIs and CloudFront.

1. Create the account under AWS Organizations and sign in to it as an administrator.
2. Deploy the bootstrap stack there with `--parameter-overrides Environments=prod`.
3. On the GitHub `prod` environment, add the variable `AWS_ACCOUNT_ID` set to the new account's id. `deploy.yml` reads it for the role and artifact bucket; without it, the environment deploys to `774924543698`.
4. Publish a release. It creates a new, empty `tma-prod` stack in the new account. Copy the data across before families use it (a DynamoDB export to S3, then an import), and expect people to sign in again, because Cognito users can't move between accounts.
5. In the old account, delete the old `tma-prod` stack. Its user pool is retained, so delete that by hand once you no longer need it. Then redeploy the bootstrap stack with `Environments=dev`.

## Sign-in (Phase 1)

Sign-up is invite-only:

1. An invite is stored as `INVITE#<email>` / `TEAM#<teamId>` with the person's roles and family.
2. On sign-up, a pre-sign-up check refuses emails that have no invite.
3. After the person enters the emailed code, a post-confirmation step turns each invite into a `MEMBER#<sub>` record on that team and deletes the invite.

Emails in the `ClubAdminEmails` parameter (`samconfig.toml`) can sign up without an invite and become admins of the default club (`ClubId`, `a5`). Emails in `PlatformAdminEmails` are site owners (an empty list makes no one a site owner). Club admin invites (`INVITE#<email>` / `CLUB#<c>`) also let someone sign up.

- **The lists apply once per person (R17).** They're applied when someone signs up, or on their next visit for accounts made earlier, and the time is recorded as `listGrantsAt` on their profile. After that the list is never checked again for them, so removing someone's club-admin or site-owner record takes their rights away for good, even while their email is still listed. To give the rights back, invite them as a club admin from the site, or delete `listGrantsAt` on their profile so the lists apply again on their next visit.
- **Only verified emails count (R5).** The API never trusts an email from a token. It uses the email saved on the profile at sign-up (Cognito had just verified it), and for accounts with no profile asks Cognito (`AdminGetUser`) and uses the email only if `email_verified` is true. An account without one gets a profile with no email: no invites are accepted and no lists apply. Locally there's no user pool, so tests and the preview server set `EMAIL_CHECK=off` to use the token's email; in AWS it's ignored.
- **Email changes aren't offered.** The site has no way to change your email, the pool won't let a change take effect until the new address is confirmed with a code (`AttributesRequireVerificationBeforeUpdate`), and the API keeps using the address from sign-up regardless. To move someone to a new address, invite the new address and remove the old account.

Team admins invite people from the team page on the site. You can also add invites from CloudShell:

```bash
scripts/invite.sh dev parent@example.com a5-13tom parent parent:p12:1 p12
scripts/invite.sh dev coach@example.com  a5-13tom coach,admin coach:0
```

**Email sending.** Sign-up and password-reset codes come from `noreply@teemhub.net` through Amazon SES (R10), set by `SesFromEmail` in `samconfig.toml`; sent as `EmailSenderName` ("Teem Hub"; dev adds " (dev)"). Without it, Cognito's built-in sender is used, which is limited to about 50 emails a day. See "Domain and email" below.

### Domain and email (R10)

`teemhub.net` is registered at GoDaddy; its DNS is served by Route 53. `bootstrap/domain.yaml` (stack `tma-domain`, deployed by hand once, used by both environments) holds:
- the Route 53 zone;
- the SES identity for the whole domain, with DKIM, a `mail.teemhub.net` bounce domain, SPF and DMARC records;
- one certificate for `teemhub.net` and `*.teemhub.net`.

Each app stack adds its own addresses (`SiteDomain`, `ApiDomain`, `WsDomain` in `samconfig.toml`), and its execution role may change only those DNS names (checked by `bootstrap/check.py`):

| | Site | API | Live updates |
|---|---|---|---|
| dev | `dev.teemhub.net` | `api-dev.teemhub.net` | `ws-dev.teemhub.net` |
| prod | `teemhub.net` | `api.teemhub.net` | `ws.teemhub.net` |

The CloudFront address keeps working too (stack output `CloudFrontUrl`). With the domain set, the CSP names the API and live-updates addresses exactly instead of API Gateway's regional wildcard.

**Setting it up (once, in this order):**
1. **Deploy the domain stack:** CloudFormation → Create stack → upload `bootstrap/domain.yaml`, name it `tma-domain`, leave `CreateCertificate=false`. Copy the `NameServers` output.
2. **Point GoDaddy at Route 53:** GoDaddy → teemhub.net → DNS → Nameservers → Change → "I'll use my own nameservers" → paste the four. Remove any domain forwarding first, and turn off DNSSEC there if it's on. Wait until `dig NS teemhub.net +short` shows the Route 53 servers: usually an hour or two, at most 48.
3. **Add the certificate:** update the `tma-domain` stack with `CreateCertificate=true`. It finishes once AWS has checked the certificate through DNS, usually within minutes. In SES → Identities, `teemhub.net` should show "Verified" for the domain and DKIM.
4. **Get SES out of the sandbox:** SES → Account dashboard → Request production access. Mail type: Transactional. Website: https://teemhub.net. Use case: "Sign-up verification codes and password-reset codes for an invite-only youth sports team site. We only email people who are invited by their team and sign up themselves. Bounces and complaints use SES's account-level suppression list." Approval usually takes about a day. Until then, SES only delivers to verified addresses, so sign-up emails would fail.
5. **Update the bootstrap stack** (`bootstrap/github-oidc.yaml`): the execution roles may now manage their own DNS records, API custom domains and Cognito's email role.
6. **Merge and deploy:** dev first (it moves to `dev.teemhub.net`), then tag a release for prod (`teemhub.net`). Before step 6, deploys would fail, because `samconfig.toml` already names the domain stack.

### Team email (Messaging M1)

Teem Hub sends its own email through SES, from the same `noreply@` address as sign-in codes (`SesFromEmail`). Today that's invites and account notices; the weekly email, reminders and texts follow (see the build plan, Messaging).

- **Catalog:** `api/src/shared/messages.ts` lists every message, sent or planned. Templates are in `api/src/lib/mail/templates.ts` and share one frame (`frame.ts`).
- **Sending:** a route queues a delivery record (`DELIV#<id>`, deleted after 90 days) and starts `MailSenderFunction` without waiting. Each record is sent once, even if the sender is retried. Without `SesFromEmail` emails are recorded as "skipped".
- **Events:** SES sends delivered, bounced, complaint and reject events through the domain stack's configuration set (`tma-domain-mail`) to EventBridge. Each app stack's rule picks up the events tagged with its environment (`MailEventsFunction`). The invite shows "Delivered", "Bounced" and so on. A bounced or complained-about address isn't emailed again.
- **Invites:** the Members page emails invites when they're made (a checkbox can hold it back), has "Email invite" or "Email again" per invite, and "Email them now" for invites a spreadsheet import saved. Emailing an expired invite gives it two more weeks. The link is `/signup#email=…`: the address is in the fragment, so it never reaches a server log.
- **Account notices:** "Your account was deleted" and "Two-step sign-in was reset", always sent.
- **Site owners** see every template under "Emails Teem Hub sends" on Your teams, with a preview and "Send me a test".
- **Locally:** `MAIL_TRANSPORT=memory` collects mail instead of sending it (tests and the preview, which lists it at `/outbox`).

**Scheduled emails (Messaging M2):** the weekly at-a-glance and the staff digest.
- **Communications page** (Team info → Communications, for team admins and coordinators): each message on or off, the day and time, who gets it, rules that keep it relevant, the team's time zone, a pause date, a preview of this week's email from the team's records, "Send me a test", and an Upcoming tab with the next two weeks of sends (skip one without turning the message off). **Everything starts off**: a team turns each message on.
- **Planner** (`PlannerFunction`, every 15 minutes, `lib/comms/planner.ts`): finds sends that are due in each team's time zone and queues one email per person. A run marker makes each send happen once; a send more than 3 hours late is skipped.
- **Content** (`lib/comms/content.ts`) comes from the team's own records and the same permission table as the site: a family sees its own answers, sign-ups and dues; a staff member sees only the sections their roles allow (a food coordinator gets meals, finance gets dues). The schedule is a port of the site's, checked against it by `test/comms/comms.test.ts`.
- **Opting out:** each person chooses per team on their Account page. Every optional email has a "Stop the weekly email" link (`/unsubscribe#t=…`, which waits for a click) and one-click unsubscribe headers for mail apps (`POST /public/unsubscribe`, no sign-in; the token is signed with a key kept in the table).

**Reminders and event emails (Messaging M2b),** also on the Communications page and off until a team turns them on:
- **Tournament packet**, N days before each tournament (default 7): the game-day sheet, what to bring, the team hotel, and each family's own jobs (meals they signed up for, ball cart or volleyballs) and missing travel plans.
- **Availability reminder**, N days before each practice or event (default 2), only to families who haven't answered. One email per family per day, with **one-tap In / Maybe / Out** links to `/answer#t=…` (`POST /public/answer`, no sign-in): the token names one parent, one player, one date and one answer, and expires the day after; the page shows what it will record and waits for a tap. It's skipped when the weekly email went out in the two days before.
- **Dues reminder**, N days before the team's dues date, to families who still owe, and optionally the day after. Needs the team fund on.
- **Payment recorded**, when finance confirms a family's payment or enters a new one for a family, and **Reimbursement approved**, to whoever asked. Each payment emails once.
- **Announcement emails**: "Also email the team" when posting (people with the announce permission), at most two a week by default, each post once.

**Setting it up (once, before merging the PR that added it):**
1. **Update the domain stack** (`tma-domain`) with the new `bootstrap/domain.yaml`, keeping the parameters. It adds the configuration set and its EventBridge destination, and exports `tma-domain-MailConfigSet`.
2. **Update the bootstrap stack** (`bootstrap/github-oidc.yaml`): app roles may now send through SES and start their own functions.
3. **Merge:** dev deploys and starts sending. Send yourself a test from Your teams → Emails Teem Hub sends, then invite a test address and watch it change to "Delivered".

### Two-step sign-in (R2)

- Anyone can turn on an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy) under **Your teams › Two-step sign-in** (`/security`). The user pool's MFA is `OPTIONAL` with authenticator apps only: no text messages, no remembered devices. Once it's on, Cognito asks for a 6-digit code at every sign-in.
- **Club admins and site owners need it.** Until it's on, their club-admin and site-owner rights don't apply. Club pages, club import, creating teams, adding clubs, and archiving or deleting teams answer 403 `mfa_required`, and the site shows a "Turn on two-step sign-in" prompt. Their own team memberships keep working as usual. Families, coaches and coordinators may turn it on but don't have to.
- **How the API knows.** Access tokens on Cognito's Lite tier can't carry an MFA claim, so `api/src/lib/mfa.ts` asks Cognito (`AdminGetUser`) whether the person has an authenticator app on. Only "yes" is cached, for a minute per function instance. Turning it on signs the person out everywhere, so every session from then on was opened with a code.
- **Lost phone.** A site owner opens the club page and uses **Reset two-step** next to that admin. The admin signs in with just their password and sets it up again; their admin tools are locked until they do. Each reset is logged to CloudWatch. To reset a site owner, run from CloudShell:

  ```bash
  aws cognito-idp admin-set-user-mfa-preference --user-pool-id <UserPoolId> --username <email> \
    --software-token-mfa-settings Enabled=false,PreferredMfa=false
  ```

- **Locally**, there's no user pool: tests and the preview server set `MFA_CHECK=off`, so everyone counts as having it on. Start the preview with `MFA_CHECK=on` to see the prompts. In AWS, `USER_POOL_ID` is always set, and then `MFA_CHECK` is ignored.
- **Deploying it** needs the bootstrap stack updated first: the function permissions boundary now allows `AdminGetUser` and `AdminSetUserMFAPreference`.

### Security headers and CSP (R6)

- **Sign-ins last 7 days.** The one-hour access and ID tokens refresh until the 7-day refresh token runs out (`RefreshTokenValidity` on `UserPoolClient`), then people sign in again. Signing out revokes the refresh token, and turning on two-step sign-in signs out everywhere.
- **Headers.** CloudFront serves our own response headers policy (`SiteHeaders` in `template.yaml`): HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (no camera, microphone, location or payment) and `Cross-Origin-Opener-Policy`, plus an enforced Content-Security-Policy:
  - scripts only from the site (`script-src 'self'`: no inline scripts, no `eval`);
  - network requests only to the site, Cognito and API Gateway in the region (by its regional domain, because naming our own API would be a circular reference in the template);
  - fonts and stylesheets only from the site (the fonts are served from the site, from the `@fontsource` packages, not Google); inline styles are allowed, since Angular sets them throughout;
  - images from the site and `data:` (the two-step QR code); nothing may frame the site, no plugins.
- **Reports.** Browsers report anything the CSP blocks to `CspReportFunction` (a public Lambda URL), which logs a trimmed summary: paths only, no query strings. In CloudWatch Logs Insights on its log group: `fields @timestamp, directive, blocked, page, browser | filter msg = "csp violation"`.
- **Keeping it working.** `scripts/check-csp.mjs` runs in CI and in the deploy after the site build. It fails if the built site has an inline script or event handler, loads anything from another site, or if the policy loosens `script-src`. The deploy then checks the live headers. The local preview serves the same policy (set `PREVIEW_CSP=off` to drop it), so a blocked script shows up as a console error and a `csp violation` line in the preview's output.
- **Adding a third-party service** (an analytics script, a map, an embed) means adding its domain to the policy in `template.yaml` on purpose.
- **Deploying it** needs the bootstrap stack updated first: the execution roles may now create and update CloudFront response headers policies.

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

### Who sees what (R3)

`GET /teams/{t}` sends each member only what their roles allow (`bundle()` in `routes/teams.ts`; permissions in `shared/permissions.ts`):

| Data | Who sees it |
|---|---|
| Parents' phone numbers and emails | Staff (admin, coach, coordinator, food, finance), the player's own family, and families who chose to share. A family turns sharing on with the checkbox on the Roster page (`shareContacts` on `FAMILY#pid`, off by default; only that player's parents can change it). |
| Food allergies | Admins, coaches, coordinators, food, and the player's own parents |
| Travel plans, uniform sizes | The family itself, plus admins and coordinators. Others get `{ entered: true }` (travel keeps the travel mode), so "plans in" counts still work. |
| Every fund entry, every family's dues | Finance, coordinators, admins. Everyone else gets the team totals (`fundSummary`, worked out on the server) and their own family's entries. |
| Availability, schedule, meals, announcements | Every member, as before |

### Privacy, your own data and retention (R4, R31)

- **Privacy notice** at `/privacy` (`web/src/app/features/privacy/privacy.ts`), readable without signing in and linked from sign-in, sign-up, Your teams and the account page. Its version is `PRIVACY_VERSION` in `api/src/shared/privacy.ts`. Sign-up has an "I've read the privacy notice" box. Everyone else sees `/consent` once per version, and acceptance is saved on the profile (`privacyVersion`, `privacyAt`; `PUT /me/privacy`). **Change the version whenever the notice changes in a way people should see.** Requests and corrections go to the team coordinator, as the notice says.
- **Your account** (`/account`):
  - **Download my data** (`GET /me/export`): a JSON file with your profile, teams and roles, your player's record and contacts, your family's answers, travel and sizes, your fund entries and payments, and pending invites. Nothing about other families.
  - **Delete my account** (`DELETE /me`, body `{ "confirm": "DELETE" }`): removes the Cognito sign-in, profile, team memberships, club-admin records, pending invites, and your own phone and email on your player's roster entry. The player's record and the team's fund entries stay; the coordinator removes those if asked. It's refused for the last admin of a team or club, and for site owners.
- **Retention** (`api/src/lib/retention.ts`, run daily at 08:15 UTC by `PurgeFunction`):
  - Archiving sets `purgeAt` 90 days out; the team is deleted then unless restored.
  - **Delete team** now archives the team at once and deletes it 7 days later; restore within the 7 days to cancel.
  - Teams archived before this change count 90 days from their archive date.
  - The club page shows each archived team's deletion date.
  - `scripts/delete-team.py` still deletes at once from CloudShell when needed.
- **Deploying it** needs the bootstrap stack updated first: the function boundary allows `AdminDeleteUser`, and each execution role may manage its environment's EventBridge schedule.

### Optional team features

Each team can turn off what it doesn't use, from **Team Info → Team settings → Features** (admins and coordinators; `PUT /teams/{t}/features`, body `{ "features": { "fund": false } }`). Everything is on until a team turns it off, so existing teams are unchanged. The list is in `api/src/shared/features.ts`, shared with the site.

| Feature | Turning it off hides |
|---|---|
| `fund` Team fund | The Fund tab, the fund and dues cards and reminders on the team home, dues in settings, and the Finance role in the role picker |
| `meals` Tournament meals | Meals on tournaments, meal reminders, the meal budget in settings, and the Food role |
| `travel` Travel and lodging | Travel and Agenda on travel tournaments, travel reminders and "plans in" counts. Events can still be marked Travel or Local. |
| `refjobs` Ref jobs | Ref jobs on tournaments and the reminder to assign them |
| `uniforms` Uniform order | The Uniform order view on the roster and uniform items in settings |
| `tasks` Coordinator tasks | Team Info → Coordinator tasks and its reminder |
| `handbook` Team handbook | The kickoff-meeting sections and players' jobs in Team Info |

- **Hidden, not deleted.** Switched-off features are left out of `GET /teams/{t}` for everyone, and their routes answer 409 `feature_off`. The data stays saved and comes back when the feature is turned on. Each person's data download (`GET /me/export`) still includes it.
- **Roles stay.** People who already have the Finance or Food role keep it; the picker just stops offering it to others while the feature is off.
- Saved on the settings record as `features: { fund: false, ... }` (only switched-off features). `loadAccess` reads it in the same batch as the membership, so checking costs no extra request.

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

**Landing page.** `/` is the public landing page for everyone: families, staff and clubs considering Team Hub (`features/landing/`, built from the "Home page (desktop)" design). It has its own navigation and footer, so the app header is hidden there. Signed-in visitors see **Your teams** where others see **Sign in**. **Your teams is at `/teams`.** "Request an invite" and "Contact" use the GitHub environment variable `CONTACT_EMAIL`, which the deploy writes into `config.json` as `contactEmail`. They're hidden until it's set.

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

### Practices

- **Practice** is an event type (**Add practice** on the Schedule page). Besides the name, times, place and details, a practice has a **court** and a **practice uniform color**. The colors come from a list each team keeps under Team Info › Team settings (`settings.practiceColors`). Practices repeat like team events: weekly, every 2 or every 3 weeks, from a start date to an end date, skipping tournament days.
- Each row of a series has **Edit ▾** with three choices:
  - **This date only** saves just the changes as `overrides[<date>]` on the series, such as a new time, court, uniform or note. Blank fields follow the series, and the answer key stays `<eid>-<date>`. The row shows "Changed this date", and **Match the series again** removes the change.
  - **This and following dates** (`POST /events/{eid}/split`) ends the series the day before that date and starts a new one with the changes. Later cancelled dates, single-date changes and families' answers move to the new series.
  - **Whole series** changes every date except ones changed on their own. If a change drops dates families have already answered, the form says how many before saving.
- **The old Practice times sheet is retired.** The first time someone who can edit the schedule opens a team that still has weekly practice times, `POST /teams/{t}/practices/convert` turns each one into a weekly practice series with id `pr-<practice id>`. Answers were already keyed `pr-<id>-<date>`, so they carry over untouched, and cancelled dates move onto the series. It runs once; the settings update is conditional, so two coaches can't convert twice.
- Spreadsheet import does the same. Practices rows (with optional **Repeats**, **Court** and **Uniform color**) become practice series, matched to saved ones by name. A team still on practice times is converted first. The Schedule tab also takes **Practice** rows for one-off practices, and the Lists and Defaults tabs take **Practice uniform colors**. Colors used on practices are added to the team's list.

### Addresses and map links

- Practices, team events and tournaments have an optional street **Address** (`address`, up to 300 characters). Travel tournaments also have a **Hotel address** (`hotelAddress`) on the team hotel card. A single date of a series can have its own address under **This date only**; a date that changes only its location drops the series address, so the map doesn't point at the old place.
- Every place shown on the site (Schedule, Home, the tournament header, the game-day sheet and the team hotel) is a map link (`shared/map-link.ts`, `core/maps.ts`). The address is the link; a ▾ menu next to it offers **Open in Apple Maps** and **Open in Google Maps**. The main link opens Apple Maps on iPhone, iPad and Mac, and Google Maps everywhere else.
- Without an address, the link searches for the venue and city (or just the location), so older events still get a map.
- Add to calendar puts the place, court and address in the calendar entry's location.
- Spreadsheet import reads an **Address** column on Practices, Schedule and Shared schedule rows, and **Hotel address** for tournaments.

## Clubs

- The site runs any number of clubs. Each team belongs to one club (`TEAM#<t>/META#CLUB`). Teams made before clubs existed have no such record and belong to the default club (`ClubId`), so existing data needs no migration. The default club's record (A5's name and Team Info links) is written the first time it's needed.
- **Site owners** (`PlatformAdminEmails`, applied once per person) add clubs from **Your teams → Add a club**, naming the first club admin by email. They can open any club and team.
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
- Staff and parents are added as invites with the right roles, and parents are linked to their player. People get access when they sign in or create an account with that email. The import saves the invites without emailing them; email them from the Members page ("Email them now") when you're ready.
- Archived teams can't be imported into. A Team ID another club uses is an error.

Tests: `api/test/import/`. The sample workbooks there are made by `make-samples.py`, then read the way the browser reads them by `to-json.mjs`.

### Exporting to a spreadsheet

Team admins (on the team's **Members** page) and club admins and site owners (on the **club page**) can download the team or club as a filled-in copy of the upload template. They can edit it and upload it again, or keep it as a copy.
- **Server:** `GET /teams/{t}/export` (needs the `accounts` permission, which team admins have) and `GET /clubs/{c}/export` (club admins and site owners) return rows per tab, keyed by the template's column names (`api/src/lib/export/export.ts`). Each export is logged (`"msg":"export"`) with who, which team or club, and how many players.
- **It's the importer's mirror image:** `test/import/export.test.ts` imports a team and a club, exports them, uploads the export again and checks that **nothing changes**. Keep that test passing when either side changes.
- **Site:** `core/xlsx-fill.ts` writes the rows into the template from `/templates/` with the browser's own zip support (no spreadsheet library), keeping the Read me, notes, dropdowns and formatting.
  - Text is written as text cells, never formulas.
  - Dates are written as Excel dates in the date columns.
  - Row 2 (the example) is overwritten.
- **Not exported** (no place in the templates): availability, travel plans, meal claims, ref job assignments, uniform sizes and the fund ledger. Archived teams are left out of a club export.
- **Lists:** the team template's **Lists** tab now takes handbook sections (`Handbook section`, with a **Title**), and the club template has a **Team lists** tab for each team's own lists and handbook. Lists given there replace that list on the team.
- **Import rules this changed:**
  - A roster row without a parent, or a staff row without a name, is now a warning instead of an error, since teams built on the site can have both.
  - A team without a Program is a warning.
  - Coach cards keep saved coaches the workbook doesn't list (nothing is removed).

### Checking invite addresses (R30)

The import preview lists every address it would invite, with the person's name, roles and player, flagged ones first, so a typo can't quietly invite a stranger. Flags are warnings, so the admin can still apply:
- **Misspelt domains**, such as `gmial.com`, `yaho.com` and `gmail.con`, with a suggested fix (`lib/import/email-check.ts`).
- **Near-duplicates:** an address within two typos of another one in the file, on the team, or already invited to it.
- **One address listed as a parent of several players.**
- **A parent already invited to another team.** Staff often run several teams, so they aren't flagged for this.

Imported invites expire after **14 days**; invites sent from the Members page last 60. An invite past its date is never accepted, even before DynamoDB's TTL removes it (it can take a day or two): sign-up, sign-in and `GET /me` all check the date. The Members page marks it **Expired** with a **Send again** button.

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
