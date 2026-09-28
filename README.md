# Team Hub (TMA)

Club team-management app for A5 Volleyball: schedules and availability, tournaments, ref jobs, meals, travel, team fund, roster and role-based access across multiple teams.

This repo moves the hub from its claude.ai prototype to AWS. The plan lives in [`docs/aws-migration-plan.html`](docs/aws-migration-plan.html), and the data model in [`docs/data-model.html`](docs/data-model.html) and [`db/key-design.md`](db/key-design.md).

## Stack

| Layer | Service |
|---|---|
| Infrastructure | AWS SAM (`template.yaml`), deployed from GitHub Actions through OIDC |
| Site | Vite build → private S3 bucket → CloudFront |
| Data | DynamoDB single table `TeamHub-<env>` (streams, PITR, TTL) |
| Sign-in | Cognito user pool, email and password, invite-only sign-up |
| API | HTTP API (Cognito JWT authorizer) + one Lambda that checks team roles on every call |
| Live updates *(Phase 3)* | WebSocket API fed by DynamoDB Streams |

## Repository layout

```
template.yaml               app stack (one per environment)
samconfig.toml              dev / prod deploy settings
bootstrap/github-oidc.yaml  one-time: GitHub OIDC trust, deploy roles, artifact bucket
.github/workflows/ci.yml    pull requests: validate templates, build site
.github/workflows/deploy.yml main → dev; release → prod (with approval)
api/                        Lambda code (TypeScript, bundled by SAM with esbuild) and tests
scripts/invite.sh           add a team invite from the command line
web/                        site: sign-in and a team admin panel now; the hub moves here in Phase 4
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
| `GET /teams` · `POST /teams` | Anyone · club admins |
| `GET /teams/{t}` | Members (contacts, ledger, payments and member emails trimmed by role) |
| `PUT /teams/{t}/settings` | Coordinator, team admin |
| `PUT /teams/{t}/handbook` | Coach, coordinator, team admin |
| `PUT·DELETE /teams/{t}/players/{pid}` | Coordinator, team admin |
| `PUT·DELETE /teams/{t}/events/{eid}` | Coach, coordinator, team admin |
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

## Local development

```bash
cd web && npm install && npm run dev      # site on http://localhost:5173
cd api && npm install && npm test         # unit tests for the Lambda code
npm install -g esbuild                     # needed once for sam build
sam validate --lint && sam build          # check and build the stack
```

## Notes

- The table and site bucket use `DeletionPolicy: Retain`, so deleting a stack never deletes data.
- Deletion protection is on for the prod table.
- If `TeamHub-dev` already exists from the earlier CLI scripts, delete it first (it's empty) or import it into the stack. Otherwise the first deploy fails with "already exists".
- No custom domain yet. The site is served from its `*.cloudfront.net` address until one is added.
