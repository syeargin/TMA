#!/usr/bin/env python3
"""Removes a real team's data, and the real people who came with it, from DEV only (risk R12).

Once a team's real data lives in prod, dev should hold only made-up data. Run in CloudShell, which
already has python3, boto3 and the account's credentials:

    python3 scripts/scrub-dev.py --list                           # every dev team id, and how many real addresses each has
    python3 scripts/scrub-dev.py a5-13tom                         # shows what would go, changes nothing
    python3 scripts/scrub-dev.py a5-13tom --yes                   # does it
    python3 scripts/scrub-dev.py a5-13tom --clone test-13:a5-13test:a5:"A5 13 Test" --yes
                                                                  # ...and puts a made-up A5 team in its place

It only ever touches TeamHub-dev and the tma-dev user pool, and refuses anything else.

What goes, for each real team named:
  * The whole team partition (TEAM#<t>): roster, contacts, families, availability, travel, sizes,
    meals, fund, attendance, memberships, settings, calendar feed and communications settings.
  * Its club team-list entry, waiting invites, live connections, calendar feed log (FEEDLOG#),
    email counters and address list (MAILSTATS#), last-opened days (SEEN#) and send records (RUN#).
  * Every email delivery record for the team, and every other delivery record sent to one of its
    real people (DELIV#: these hold addresses and names; they'd expire after 90 days anyway).
  * The real people: anyone who was a member of the team, unless they are a site owner or club
    admin, use a made-up address (example.com, example.org, test.*), or are named with --keep.
    For each: their sign-in account in the dev user pool, profile, calendar links (and their link
    pointers), questions and feedback they sent (with screenshots), and invites waiting for them.
    Someone still on another dev team is listed and left alone; add --people-anyway to remove them too.

What stays: other teams, clubs, site owners and club admins, and site usage counts (totals, no people).
Point-in-time backups keep deleted records for up to 35 days; CloudWatch logs (no names, only ids)
expire after 30.

--clone FROM:TO:CLUB:NAME copies a made-up team already in dev (FROM, like test-13) to a new team id
in a club, without its memberships, so the club still has a team to test with. The copy keeps the
made-up families, schedule and fund. Its records are rewritten for the new id; nothing is shared.

Set AWS_ENDPOINT_URL to try it against DynamoDB Local or moto first (add --no-cognito there).
"""
import hashlib
import json
import os
import sys
from collections import Counter

import boto3
from boto3.dynamodb.conditions import Attr, Key

ENV = "dev"
TABLE = f"TeamHub-{ENV}"
STACK = f"tma-{ENV}"
DEFAULT_CLUB = "a5"
TEST_DOMAINS = ("example.com", "example.org", "example.net")


def query_all(table, **kw):
    out, start = [], None
    while True:
        if start:
            kw["ExclusiveStartKey"] = start
        page = table.query(**kw)
        out += page["Items"]
        start = page.get("LastEvaluatedKey")
        if not start:
            return out


def scan_all(table, **kw):
    out, start = [], None
    while True:
        if start:
            kw["ExclusiveStartKey"] = start
        page = table.scan(**kw)
        out += page["Items"]
        start = page.get("LastEvaluatedKey")
        if not start:
            return out


def made_up(email: str) -> bool:
    domain = email.rsplit("@", 1)[-1].lower()
    return domain in TEST_DOMAINS or domain.startswith("test.") or domain.endswith(".test") or domain.endswith(".invalid")


def plain(v):
    """Numbers come back from DynamoDB as Decimal; keep them numbers in the copy."""
    from decimal import Decimal
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    raise TypeError(type(v))


def source_club(records) -> str:
    link = next((r for r in records if r["SK"] == "META#CLUB"), None)
    return link["clubId"] if link else DEFAULT_CLUB


def key(item):
    return {"PK": item["PK"], "SK": item["SK"]}


def arg_value(name: str):
    for i, a in enumerate(sys.argv):
        if a == name and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return None


def user_pool_id() -> str:
    pool = arg_value("--pool")
    if pool:
        return pool
    outputs = boto3.client("cloudformation").describe_stacks(StackName=STACK)["Stacks"][0].get("Outputs", [])
    found = next((o["OutputValue"] for o in outputs if o["OutputKey"] == "UserPoolId"), "")
    if not found:
        raise SystemExit(f"Couldn't find the user pool in {STACK}'s outputs; pass --pool <id>.")
    return found


def list_teams(table):
    """Every team in dev, with how many members use a real address, so the right id is easy to find."""
    rows = scan_all(table, FilterExpression=Attr("PK").begins_with("TEAM#") & (Attr("SK").eq("META#SETTINGS") | Attr("SK").begins_with("MEMBER#")),
                    ProjectionExpression="PK, SK, teamName, email")
    teams = {}
    for r in rows:
        t = teams.setdefault(r["PK"][5:], {"name": "", "members": 0, "real": 0})
        if r["SK"] == "META#SETTINGS":
            t["name"] = str(r.get("teamName", ""))
        else:
            t["members"] += 1
            email = str(r.get("email", ""))
            if email and not made_up(email):
                t["real"] += 1
    print(f"\nTeams in {TABLE}:")
    print(f"  {'team id':<24} {'members':>7} {'real addresses':>15}  name")
    for tid, t in sorted(teams.items()):
        print(f"  {tid:<24} {t['members']:>7} {t['real']:>15}  {t['name']}")
    return teams


def team_records(table, team):
    """Everything stored for one team, outside the people themselves."""
    records = query_all(table, KeyConditionExpression=Key("PK").eq(f"TEAM#{team}"))
    club_link = next((r for r in records if r["SK"] == "META#CLUB"), None)
    club = club_link["clubId"] if club_link else DEFAULT_CLUB
    dir_entry = table.get_item(Key={"PK": f"CLUB#{club}", "SK": f"TEAM#{team}"}).get("Item")
    invites = query_all(table, IndexName="GSI1",
                        KeyConditionExpression=Key("GSI1PK").eq(f"TEAM#{team}") & Key("GSI1SK").begins_with("INVITE#"))
    side = []
    for prefix in ("TEAMCONN#", "FEEDLOG#", "MAILSTATS#", "SEEN#", "RUN#"):
        side += query_all(table, KeyConditionExpression=Key("PK").eq(f"{prefix}{team}"), ProjectionExpression="PK, SK")
    return records, club, dir_entry, invites, side


def main() -> int:
    teams = [a for a in sys.argv[1:] if not a.startswith("--") and a not in (arg_value("--keep") or "", arg_value("--clone") or "", arg_value("--pool") or "")]
    go = "--yes" in sys.argv
    use_cognito = "--no-cognito" not in sys.argv
    anyway = "--people-anyway" in sys.argv
    keep = {e.strip().lower() for e in (arg_value("--keep") or "").split(",") if e.strip()}
    clone = arg_value("--clone")
    if "--list" in sys.argv:
        boto3.resource("dynamodb").Table(TABLE).load()
        list_teams(boto3.resource("dynamodb").Table(TABLE))
        return 0
    if not teams and not clone:
        print(__doc__)
        return 1
    if os.environ.get("TEAMHUB_TABLE", TABLE) != TABLE:
        raise SystemExit("This script only works on TeamHub-dev.")

    table = boto3.resource("dynamodb").Table(TABLE)
    table.load()
    if not go:
        print("DRY RUN: nothing will change. Add --yes to do it.")
    print(f"Table {TABLE}{' (local: ' + os.environ['AWS_ENDPOINT_URL'] + ')' if os.environ.get('AWS_ENDPOINT_URL') else ''}")

    # Who is protected: site owners and club admins (by sign-in id), and made-up or listed addresses.
    owners = {r["SK"].split("#", 1)[1] for r in query_all(table, KeyConditionExpression=Key("PK").eq("PLATFORM") & Key("SK").begins_with("ADMIN#"))}
    club_admins = {r["SK"].split("#", 1)[1] for r in scan_all(table, FilterExpression=Attr("PK").begins_with("CLUB#") & Attr("SK").begins_with("ADMIN#"), ProjectionExpression="PK, SK")}
    protected_subs = owners | club_admins

    to_delete = []          # table keys
    people = {}             # sub -> email
    invite_emails = set()   # emails with invites to these teams (people who never signed up)
    for team in teams:
        records, club, dir_entry, invites, side = team_records(table, team)
        if not records and not dir_entry and not invites:
            # Stop before changing anything: a wrong id shouldn't still copy a team or delete people.
            print(f"\nNo team {team!r} in {TABLE}, so nothing was changed. Use one of these ids:")
            list_teams(table)
            return 1
        settings = next((r for r in records if r["SK"] == "META#SETTINGS"), {})
        kinds = Counter(r["SK"].split("#")[0] for r in records)
        print(f"\n{team} ({settings.get('teamName', 'no name')}) in club {club}")
        print(f"  team records: {len(records)} (" + ", ".join(f"{k} {n}" for k, n in sorted(kinds.items())) + ")")
        print(f"  club team-list entry: {'yes' if dir_entry else 'none'} · waiting invites: {len(invites)} · side records: {len(side)}")
        for r in records:
            if r["SK"].startswith("MEMBER#"):
                people[r["SK"].split("#", 1)[1]] = str(r.get("email", "")).lower()
        for i in invites:
            invite_emails.add(i["PK"].split("#", 1)[1].lower())
        to_delete += [key(r) for r in records + invites] + side + ([key(dir_entry)] if dir_entry else [])

    # The real people, and what to do with each.
    gone_teams = {f"TEAM#{t}" for t in teams}
    remove, stay = {}, []
    for sub, email in sorted(people.items(), key=lambda p: p[1]):
        profile = table.get_item(Key={"PK": f"USER#{sub}", "SK": "PROFILE"}).get("Item") or {}
        email = email or str(profile.get("email", "")).lower()
        why = ("site owner" if sub in owners else "club admin" if sub in club_admins else
               "made-up address" if email and made_up(email) else "kept (--keep)" if email in keep else "")
        if why:
            stay.append(f"{email or sub}: {why}")
            continue
        others = [m["GSI1SK"] for m in query_all(table, IndexName="GSI1", KeyConditionExpression=Key("GSI1PK").eq(f"USER#{sub}") & Key("GSI1SK").begins_with("TEAM#"))
                  if m["PK"] not in gone_teams]
        if others and not anyway:
            stay.append(f"{email or sub}: still on {', '.join(o[5:] for o in others)} (use --people-anyway)")
            continue
        remove[sub] = email
    real_emails = {e for e in list(remove.values()) + list(invite_emails) if e and not made_up(e) and e not in keep}
    protected_emails = set()
    for sub in protected_subs:
        p = table.get_item(Key={"PK": f"USER#{sub}", "SK": "PROFILE"}).get("Item") or {}
        if p.get("email"):
            protected_emails.add(str(p["email"]).lower())
    real_emails -= protected_emails

    # Their own records: profile, calendar links and pointers, feedback, invites, and memberships elsewhere (with --people-anyway).
    for sub in remove:
        mine = query_all(table, KeyConditionExpression=Key("PK").eq(f"USER#{sub}"))
        to_delete += [key(r) for r in mine]
        to_delete += [{"PK": f"CALTOKEN#{hashlib.sha256(str(r['token']).encode()).hexdigest()}", "SK": "META"} for r in mine if str(r["SK"]).startswith("CAL#") and r.get("token")]
        fb = query_all(table, IndexName="GSI2", KeyConditionExpression=Key("GSI2PK").eq(f"USER#{sub}#FB"), ProjectionExpression="PK, SK")
        to_delete += [{"PK": f["PK"], "SK": s} for f in fb for s in ("META", "SHOT")]
        if anyway:
            to_delete += [key(m) for m in query_all(table, IndexName="GSI1", KeyConditionExpression=Key("GSI1PK").eq(f"USER#{sub}") & Key("GSI1SK").begins_with("TEAM#"))]
    for email in real_emails:
        to_delete += [key(i) for i in query_all(table, KeyConditionExpression=Key("PK").eq(f"INVITE#{email}"))]

    # Email records: the team's, and anything sent to its real people. Feedback sent while signed out from those addresses.
    team_set = set(teams)
    deliveries = scan_all(table, FilterExpression=Attr("PK").begins_with("DELIV#"), ProjectionExpression="PK, SK, teamId, #t", ExpressionAttributeNames={"#t": "to"})
    dels = [d for d in deliveries if d.get("teamId") in team_set or str(d.get("to", "")).lower() in real_emails]
    to_delete += [key(d) for d in dels]
    feedback = scan_all(table, FilterExpression=Attr("PK").begins_with("FB#") & Attr("SK").eq("META"), ProjectionExpression="PK, SK, email, teamId")
    fbs = [f for f in feedback if f.get("teamId") in team_set or str(f.get("email", "")).lower() in real_emails]
    to_delete += [{"PK": f["PK"], "SK": s} for f in fbs for s in ("META", "SHOT")]

    unique = list({(k["PK"], k["SK"]): k for k in to_delete}.values())
    print(f"\nReal people to remove ({len(remove)}): " + (", ".join(e or s for s, e in remove.items()) or "none"))
    print(f"  plus {len(real_emails - set(remove.values()))} invited address(es) that never signed up")
    for s in stay:
        print(f"  left alone: {s}")
    print(f"Email delivery records: {len(dels)} · feedback items: {len(fbs)}")
    print(f"Records to delete in all: {len(unique)}")
    if use_cognito and remove:
        print(f"Sign-in accounts to delete from the {STACK} user pool: {len(remove)}")

    # A made-up team in the club's place.
    copy = []
    if clone:
        parts = clone.split(":", 3)
        if len(parts) != 4:
            raise SystemExit('--clone needs FROM:TO:CLUB:NAME, like test-13:a5-13test:a5:"A5 13 Test"')
        src, dst, club, name = parts
        if dst in team_set:
            raise SystemExit("--clone can't reuse a team id that's being removed; pick a new one, like a5-13test.")
        source = query_all(table, KeyConditionExpression=Key("PK").eq(f"TEAM#{src}"))
        if not source:
            raise SystemExit(f"No team {src!r} in {TABLE} to copy.")
        if query_all(table, KeyConditionExpression=Key("PK").eq(f"TEAM#{dst}"), Limit=1):
            raise SystemExit(f"Team {dst!r} already exists in {TABLE}.")
        # Copying a team that still has real people in it would undo the point; check first.
        real = [str(r.get("email", "")) for r in source if r["SK"].startswith("MEMBER#") and r.get("email") and not made_up(str(r["email"])) and str(r["email"]).lower() not in protected_emails]
        if real:
            print(f"\nNothing was changed: {src} has {len(real)} member(s) with a real address ({', '.join(real)}).")
            print("Copy only a made-up team. Run without --clone to remove the real team now, and copy later.")
            return 1
        src_dir = table.get_item(Key={"PK": f"CLUB#{source_club(source)}", "SK": f"TEAM#{src}"}).get("Item") or {}
        for r in source:
            sk = r["SK"]
            if sk.startswith("MEMBER#") or sk.startswith("FEED#"):
                continue
            item = json.loads(json.dumps(r, default=plain).replace(f"TEAM#{src}#", f"TEAM#{dst}#").replace(f'"TEAM#{src}"', f'"TEAM#{dst}"'))
            item.pop("GSI1PK", None)
            item.pop("GSI1SK", None)
            item["PK"] = f"TEAM#{dst}"
            if sk == "META#CLUB":
                item["clubId"] = club
            if sk == "META#SETTINGS":
                item["teamName"] = name
            copy.append(item)
        if not any(i["SK"] == "META#CLUB" for i in copy):
            copy.append({"PK": f"TEAM#{dst}", "SK": "META#CLUB", "type": "TeamClub", "clubId": club})
        copy.append({"PK": f"CLUB#{club}", "SK": f"TEAM#{dst}", "type": "Team", "name": name, "season": str(src_dir.get("season", "")),
                     "age": str(src_dir.get("age", "")), "coaches": [], "archived": False, "createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(), "createdBy": "scrub-dev"})
        print(f"\nCopy {src} → {dst} ({name}) in club {club}: {len(copy)} records, no memberships")

    if not go:
        print("\nNothing changed. Run again with --yes to do all of the above.")
        return 0

    with table.batch_writer() as batch:
        for k in unique:
            batch.delete_item(Key=k)
    print(f"Deleted {len(unique)} records.")
    if use_cognito and remove:
        cognito = boto3.client("cognito-idp")
        pool = user_pool_id()
        for sub, email in remove.items():
            found = cognito.list_users(UserPoolId=pool, Filter=f'sub = "{sub}"', Limit=1)["Users"]
            if found:
                cognito.admin_delete_user(UserPoolId=pool, Username=found[0]["Username"])
        print(f"Deleted {len(remove)} sign-in accounts from {pool}.")
    if copy:
        from decimal import Decimal
        with table.batch_writer() as batch:
            for item in copy:
                batch.put_item(Item=json.loads(json.dumps(item), parse_float=Decimal))
        print(f"Wrote {len(copy)} records for the made-up team.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
