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
| API *(Phase 2)* | HTTP API + Lambda with server-side role checks |
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
web/                        site: sign-in screens now; the hub moves here in Phase 4
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

Until the Invites screen ships in Phase 2, add invites from CloudShell:

```bash
scripts/invite.sh dev parent@example.com a5-13tom parent parent:p12:1 p12
scripts/invite.sh dev coach@example.com  a5-13tom coach,admin coach:0
```

**Email sending.** By default Cognito sends verification and reset codes from `no-reply@verificationemail.com`, which is limited to a small number of emails per day. That's fine for testing. For real use, verify a sender in Amazon SES, request SES production access, and set `SesFromEmail=<address>` in `samconfig.toml`.

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
