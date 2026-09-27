# Team Hub — DynamoDB key design

One table, `TeamHub-<env>`, holds every entity. Items are typed by a `type` attribute and located by generic keys.

| Key | Attributes | Purpose |
|---|---|---|
| Table | `PK` (S), `SK` (S) | Primary layout: one partition per club, team and user |
| GSI1 | `GSI1PK`, `GSI1SK` | Inverted view: user → teams, team → family records, requests, payments |
| GSI2 | `GSI2PK`, `GSI2SK` | Date-ordered lists: calendar, ledger, announcements |

Both indexes project `ALL`. Billing is on-demand. Streams carry new and old images for realtime fan-out and audit.

## Partitions

| Partition | Who writes | Holds |
|---|---|---|
| `CLUB#<clubId>` | Site owner / club admins (via API) | Team directory, club admins |
| `TEAM#<teamId>` | Staff roles (via API) | Settings, handbook, roster, contacts, events, ref jobs, agendas, meals, ledger, announcements, tasks, memberships |
| `USER#<uid>` | That user only (IAM leading-key condition) | Family records, join requests, submitted payments |

Putting everything a person may write under their own `USER#` partition lets IAM enforce "write only your own record" with `dynamodb:LeadingKeys`, the same guarantee the hosted version gets from its `{self}` rule. Memberships (roles) live in the team partition, so a user can never grant themselves a role.

## Entities

| Entity | PK | SK | GSI1PK / GSI1SK | GSI2PK / GSI2SK |
|---|---|---|---|---|
| Team (directory) | `CLUB#<c>` | `TEAM#<t>` | | |
| Club admin | `CLUB#<c>` | `ADMIN#<uid>` | | |
| Settings | `TEAM#<t>` | `META#SETTINGS` | | |
| Handbook | `TEAM#<t>` | `META#HANDBOOK` | | |
| Player | `TEAM#<t>` | `PLAYER#<pid>` | | |
| Player contacts | `TEAM#<t>` | `PLAYER#<pid>#CONTACTS` | | |
| Event / tournament | `TEAM#<t>` | `EVENT#<eid>` | | `TEAM#<t>#CAL` / `<date>#<eid>` |
| Ref jobs | `TEAM#<t>` | `EVENT#<eid>#REFJOBS` | | |
| Agenda | `TEAM#<t>` | `EVENT#<eid>#AGENDA` | | |
| Meal slot | `TEAM#<t>` | `EVENT#<eid>#MEAL#<mid>` | | |
| Ledger entry | `TEAM#<t>` | `LEDGER#<lid>` | | `TEAM#<t>#LEDGER` / `<date>#<lid>` |
| Announcement | `TEAM#<t>` | `ANN#<aid>` | | `TEAM#<t>#ANN` / `<at>#<aid>` |
| Task | `TEAM#<t>` | `TASK#<kid>` | | |
| Membership (roles) | `TEAM#<t>` | `MEMBER#<uid>` | `USER#<uid>` / `TEAM#<t>` | |
| Family record | `USER#<uid>` | `FAMILY#<t>` | `TEAM#<t>` / `FAMILY#<uid>` | |
| Join request | `USER#<uid>` | `REQUEST#<t>` | `TEAM#<t>` / `REQUEST#<at>#<uid>` | |
| Payment | `USER#<uid>` | `PAYMENT#<t>#<payId>` | `TEAM#<t>` / `PAYMENT#<status>#<at>#<uid>` | |

## Access patterns

| # | Pattern | Operation |
|---|---|---|
| 1 | Teams in the club | Query `PK = CLUB#c`, `begins_with(SK, TEAM#)` |
| 2 | Is a user a club admin? | GetItem `CLUB#c` / `ADMIN#uid` |
| 3 | Load a team (settings, roster, events, meals, ledger, tasks, members) | Query `PK = TEAM#t` (paginate) |
| 4 | Roster only | Query `PK = TEAM#t`, `begins_with(SK, PLAYER#)` |
| 5 | Everything for one tournament (event, ref jobs, agenda, meals) | Query `PK = TEAM#t`, `begins_with(SK, EVENT#eid)` |
| 6 | Calendar for a date range | Query GSI2 `GSI2PK = TEAM#t#CAL`, `GSI2SK BETWEEN d1 AND d2~` |
| 7 | Ledger by date | Query GSI2 `GSI2PK = TEAM#t#LEDGER` |
| 8 | Announcements, newest first | Query GSI2 `GSI2PK = TEAM#t#ANN`, `ScanIndexForward=false` |
| 9 | A user's teams and roles | Query GSI1 `GSI1PK = USER#uid`, `begins_with(GSI1SK, TEAM#)` |
| 10 | A team's members | Query `PK = TEAM#t`, `begins_with(SK, MEMBER#)` |
| 11 | All family records for a team (availability, travel, sizes, claims) | Query GSI1 `GSI1PK = TEAM#t`, `begins_with(GSI1SK, FAMILY#)` |
| 12 | Pending join requests | Query GSI1 `GSI1PK = TEAM#t`, `begins_with(GSI1SK, REQUEST#)` |
| 13 | Payments waiting for finance | Query GSI1 `GSI1PK = TEAM#t`, `begins_with(GSI1SK, PAYMENT#pending#)` |
| 14 | Everything one person has submitted | Query `PK = USER#uid` |
| 15 | Mark availability / travel / sizes | UpdateItem `USER#uid` / `FAMILY#t` with `SET rsvp.#k = :v` (client, own partition) |
| 16 | Approve a member | TransactWriteItems: Put `MEMBER#uid` + Delete `REQUEST#t` |
| 17 | Confirm a payment | TransactWriteItems: Put `LEDGER#l-uid-payId` (`attribute_not_exists(PK)`) + Update payment `status`, `GSI1SK` → `PAYMENT#settled#…` |
| 18 | Claim a meal (first family wins) | UpdateItem meal `SET claimedBy = :pid` with `attribute_not_exists(claimedBy) OR claimedBy = :null` |

Patterns 16–18 use DynamoDB's conditional writes and transactions, which replace the hosted version's newest-wins and earliest-claim merge rules.

## Conventions

- Money is stored as integer cents (`amountCents`, `costCents`).
- Dates are `YYYY-MM-DD`; timestamps are ISO-8601 UTC. Both sort correctly as strings.
- `ttl` (epoch seconds) expires unanswered join requests; set it about 60 days out.
- Every item carries `type` for filtering and stream consumers.
