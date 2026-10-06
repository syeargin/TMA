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
| `CLUBS` | Site owners (via API) | One row per club, for the site owner's club list |
| `CLUB#<clubId>` | Site owner / club admins (via API) | Club name, colors and links; team directory; club admins |
| `PLATFORM` | Bootstrap from `PlatformAdminEmails` | Site owners |
| `TEAM#<teamId>` | The API, by role | Settings, handbook, roster, contacts, events, ref jobs, agendas, meals, family records, payments, ledger, announcements, tasks, memberships |
| `USER#<uid>` | The API, for that user | Profile |
| `CONN#<connectionId>` | WebSocket functions | One open live-update socket: who it is and which team it follows |
| `TEAMCONN#<teamId>` | WebSocket functions | The sockets following a team, read by the stream fan-out |

All writes go through the API, which checks the caller's membership (`TEAM#<t>` / `MEMBER#<sub>`) before touching the table. That lets family records and payments live in the team partition, keyed by player and payment id, so a single query loads a whole team. (An earlier draft kept them in `USER#` partitions so IAM leading-key conditions could guard direct browser writes; with the API in front, that's no longer needed.)

## Entities

| Entity | PK | SK | GSI1PK / GSI1SK | GSI2PK / GSI2SK |
|---|---|---|---|---|
| Club list entry | `CLUBS` | `CLUB#<c>` | | |
| Club (name, short name, colors, links, notes) | `CLUB#<c>` | `META` | | |
| Team (directory; `archived` makes the team read-only) | `CLUB#<c>` | `TEAM#<t>` | | |
| Club admin | `CLUB#<c>` | `ADMIN#<uid>` | `USER#<uid>` / `CLUB#<c>` | |
| Club admin invite | `INVITE#<email>` | `CLUB#<c>` | `CLUB#<c>` / `INVITE#<email>` | |
| Site owner | `PLATFORM` | `ADMIN#<uid>` | | |
| Team's club | `TEAM#<t>` | `META#CLUB` (`clubId`) | | |
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
| Family record | `TEAM#<t>` | `FAMILY#<pid>` | | |
| Invite | `INVITE#<email>` | `TEAM#<t>` | `TEAM#<t>` / `INVITE#<email>` | |
| User profile (email, first and last name) | `USER#<uid>` | `PROFILE` | | |
| Payment (family-submitted) | `TEAM#<t>` | `PAYMENT#<payId>` | | |
| Live connection | `CONN#<connId>` | `META` (`sub`, `teamId`, `ttl`) | | |
| Team subscriber | `TEAMCONN#<t>` | `CONN#<connId>` (`sub`, `ttl`) | | |

### Live updates (Phase 3)

Connection items sit outside `TEAM#` partitions on purpose. The stream fan-out only looks at `TEAM#` and `INVITE#` keys (a Lambda event filter), so connecting and disconnecting never cause a notice. Both items carry a 3-hour `ttl`. API Gateway ends sockets after 2 hours, so any item a missed `$disconnect` leaves behind expires on its own. The fan-out also deletes a connection when a send to it returns 410 Gone.

The fan-out maps each changed key to a collection name (`PLAYER#p1#CONTACTS` → `players`, `EVENT#e1#MEAL#m1` → `meals`, `INVITE#…/TEAM#t` → `invites`, and so on). It sends each team one `{type:"changed", teamId, collections}` notice per stream batch. Notices carry no team data, and browsers re-read through the API, so permissions are checked in one place.

## Access patterns

| # | Pattern | Operation |
|---|---|---|
| 1 | Teams in a club | Query `PK = CLUB#c`, `begins_with(SK, TEAM#)` |
| 2 | Is a user an admin of this team's club? | GetItem `TEAM#t` / `META#CLUB` (cached per Lambda; missing = the default club), then BatchGet `CLUB#c` / `ADMIN#uid` and `PLATFORM` / `ADMIN#uid` |
| 2a | Clubs a user runs | Query GSI1 `GSI1PK = USER#uid`, `begins_with(GSI1SK, CLUB#)` |
| 2b | Every club (site owner) | Query `PK = CLUBS` |
| 3 | Load a team (settings, roster, events, meals, ledger, tasks, members) | Query `PK = TEAM#t` (paginate) |
| 4 | Roster only | Query `PK = TEAM#t`, `begins_with(SK, PLAYER#)` |
| 5 | Everything for one tournament (event, ref jobs, agenda, meals) | Query `PK = TEAM#t`, `begins_with(SK, EVENT#eid)` |
| 6 | Calendar for a date range | Query GSI2 `GSI2PK = TEAM#t#CAL`, `GSI2SK BETWEEN d1 AND d2~` |
| 7 | Ledger by date | Query GSI2 `GSI2PK = TEAM#t#LEDGER` |
| 8 | Announcements, newest first | Query GSI2 `GSI2PK = TEAM#t#ANN`, `ScanIndexForward=false` |
| 9 | A user's teams and roles | Query GSI1 `GSI1PK = USER#uid`, `begins_with(GSI1SK, TEAM#)` |
| 10 | A team's members | Query `PK = TEAM#t`, `begins_with(SK, MEMBER#)` |
| 11 | All family records for a team (availability, travel, sizes) | Query `PK = TEAM#t`, `begins_with(SK, FAMILY#)` (part of pattern 3) |
| 12 | Accept invites on sign-up or sign-in | Query `PK = INVITE#email`; TransactWriteItems: Put `MEMBER#sub` + Delete invite |
| 13 | Payments waiting for finance | Query `PK = TEAM#t`, `begins_with(SK, PAYMENT#)`, filter `status = pending` |
| 14 | A person's profile | GetItem `USER#sub` / `PROFILE` |
| 15 | Mark availability / travel / sizes | UpdateItem `TEAM#t` / `FAMILY#pid` with `SET rsvp.#k = :v` (API checks parent-of-player or staff role) |
| 16 | Change a member's roles | Put `TEAM#t` / `MEMBER#sub` (API refuses to remove the last team admin) |
| 17 | Confirm a payment | TransactWriteItems: Update payment `status = confirmed` (`status = pending`) + Put `LEDGER#l-<payId>` (`attribute_not_exists(PK)`) |
| 18 | Claim a meal (first family wins) | UpdateItem meal `SET claimedBy = :pid` with `attribute_not_exists(claimedBy) OR claimedBy = :null` |
| 19 | Is this email invited? (sign-up check) | Query `PK = INVITE#email`, `begins_with(SK, TEAM#)`, limit 1 |
| 20 | A team's pending invites | Query GSI1 `GSI1PK = TEAM#t`, `begins_with(GSI1SK, INVITE#)` |

Patterns 16–18 use DynamoDB's conditional writes and transactions, which replace the hosted version's newest-wins and earliest-claim merge rules.

## Conventions

- Money is stored as integer cents (`amountCents`, `costCents`).
- Dates are `YYYY-MM-DD`; timestamps are ISO-8601 UTC. Both sort correctly as strings.
- `ttl` (epoch seconds) expires unanswered join requests; set it about 60 days out.
- Every item carries `type` for filtering and stream consumers.

Names: `firstName`/`lastName` live on the profile and are copied onto each `MEMBER#` item (so a team loads names in its one query). `PUT /me` updates both; an invite's name is used until the person sets their own; team admins can correct a name on their team.
