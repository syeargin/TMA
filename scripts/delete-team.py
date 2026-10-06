#!/usr/bin/env python3
"""Removes one team and everything stored for it from a Team Hub table.

Run where the AWS CLI is signed in to the account, e.g. CloudShell:

    python3 scripts/delete-team.py dev jvc13e          # shows what would be removed, deletes nothing
    python3 scripts/delete-team.py dev jvc13e --yes    # deletes it

What it removes from TeamHub-<env>:
  * Every record in the team's partition (TEAM#<t>): settings, handbook, its club link, players and
    contacts, events, ref jobs, agendas, meals, family records, payments, ledger, announcements, tasks
    and memberships (so the team disappears from everyone's Your teams list).
  * The team's entry in its club's team list (CLUB#<club>/TEAM#<t>).
  * Invites still waiting for someone to sign up for this team (INVITE#<email>/TEAM#<t>).
  * Live-update connection records for the team (TEAMCONN#<t>); these expire on their own anyway.

What it leaves alone: other teams, the club itself, and people's sign-in accounts and profiles, since
people can be on other teams. Point-in-time backups keep the deleted records for up to 35 days, and
logs for 30 days.
"""
import sys
from collections import Counter

import boto3
from boto3.dynamodb.conditions import Key

DEFAULT_CLUB = "a5"


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


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        return 1
    env, team = args
    go = "--yes" in sys.argv
    table = boto3.resource("dynamodb").Table(f"TeamHub-{env}")
    table.load()

    records = query_all(table, KeyConditionExpression=Key("PK").eq(f"TEAM#{team}"))
    club_link = next((r for r in records if r["SK"] == "META#CLUB"), None)
    club = club_link["clubId"] if club_link else DEFAULT_CLUB
    settings = next((r for r in records if r["SK"] == "META#SETTINGS"), {})
    dir_entry = table.get_item(Key={"PK": f"CLUB#{club}", "SK": f"TEAM#{team}"}).get("Item")
    invites = query_all(table, IndexName="GSI1",
                        KeyConditionExpression=Key("GSI1PK").eq(f"TEAM#{team}") & Key("GSI1SK").begins_with("INVITE#"),
                        ProjectionExpression="PK, SK")
    conns = query_all(table, KeyConditionExpression=Key("PK").eq(f"TEAMCONN#{team}"), ProjectionExpression="PK, SK")

    if not records and not dir_entry and not invites:
        print(f"No team {team!r} in TeamHub-{env}. Check the team id (the part before the dot on the club page).")
        return 1

    kinds = Counter(r["SK"].split("#")[0] for r in records)
    print(f"Table TeamHub-{env}, team {team} ({settings.get('teamName', 'no name')}) in club {club}")
    print(f"  team records: {len(records)} (" + ", ".join(f"{k} {n}" for k, n in sorted(kinds.items())) + ")")
    print(f"  club team-list entry: {'yes' if dir_entry else 'none'}")
    print(f"  waiting invites: {len(invites)}")
    print(f"  live connections: {len(conns)}")
    members = [r for r in records if r["SK"].startswith("MEMBER#")]
    if members:
        print(f"  {len(members)} people lose access to this team; their accounts stay.")
    if not go:
        print("\nNothing deleted. Run again with --yes to delete all of the above.")
        return 0

    keys = [{"PK": r["PK"], "SK": r["SK"]} for r in records + invites + conns]
    if dir_entry:
        keys.append({"PK": dir_entry["PK"], "SK": dir_entry["SK"]})
    with table.batch_writer() as batch:
        for k in keys:
            batch.delete_item(Key=k)
    print(f"Deleted {len(keys)} records.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
