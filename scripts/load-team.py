#!/usr/bin/env python3
"""Loads one team's items (from api/scripts/hub-import/convert.ts) into a Team Hub table.

Run where the AWS CLI is signed in to the account, e.g. CloudShell (python3 and boto3 are already there):

    python3 scripts/load-team.py dev a5-13tom-items.json          # shows what would change, writes nothing
    python3 scripts/load-team.py dev a5-13tom-items.json --yes    # does it

What it does to TeamHub-<env>:
  * Writes every item in the file (the team's settings, handbook, roster, contacts, schedule, meals,
    agendas, announcements, tasks, its club link and its entry in the club's team list).
  * Removes the team's other records that aren't in the file (test events, test families, payments…),
    so the team matches the file. Memberships (who can sign in, with what roles) are always kept.
  * Leaves everything outside this team alone: other teams, clubs, invites, people's profiles.

Set AWS_ENDPOINT_URL to try it against DynamoDB Local first.
"""
import json
import sys
from collections import Counter
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key


def kind(sk: str, pk: str = "") -> str:
    if pk.startswith("CLUB#"):
        return "club team list"
    parts = sk.split("#")
    if parts[0] == "EVENT" and len(parts) > 2:
        return f"EVENT#…#{parts[2]}"
    if parts[0] == "PLAYER" and len(parts) > 2:
        return "PLAYER#…#CONTACTS"
    return parts[0] if parts[0] != "META" else sk


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        return 1
    env, path = args
    go = "--yes" in sys.argv
    with open(path) as f:
        data = json.load(f, parse_float=Decimal)
    team, items = data["teamId"], data["items"]
    team_pk = f"TEAM#{team}"
    bad = [i for i in items if i["PK"] != team_pk and not (i["PK"].startswith("CLUB#") and i["SK"] == f"TEAM#{team}")]
    if bad:
        print(f"error: the file has records for something other than team {team}: {bad[0]['PK']} / {bad[0]['SK']}")
        return 1

    table = boto3.resource("dynamodb").Table(f"TeamHub-{env}")
    table.load()  # fails early if the table or credentials are wrong

    existing, start = [], None
    while True:
        kw = {"KeyConditionExpression": Key("PK").eq(team_pk), "ProjectionExpression": "PK, SK"}
        if start:
            kw["ExclusiveStartKey"] = start
        page = table.query(**kw)
        existing += page["Items"]
        start = page.get("LastEvaluatedKey")
        if not start:
            break

    incoming = {(i["PK"], i["SK"]) for i in items}
    keep = [e for e in existing if e["SK"].startswith("MEMBER#")]
    remove = [e for e in existing if not e["SK"].startswith("MEMBER#") and (e["PK"], e["SK"]) not in incoming]
    replaced = sum(1 for e in existing if (e["PK"], e["SK"]) in incoming)

    print(f"Table TeamHub-{env}, team {team}")
    print(f"  now in the table: {len(existing)} records ({len(keep)} memberships, kept)")
    print(f"  write {len(items)} records ({replaced} replace existing ones): " + ", ".join(f"{k} {n}" for k, n in sorted(Counter(kind(i['SK'], i['PK']) for i in items).items())))
    print(f"  remove {len(remove)} records not in the file" + (": " + ", ".join(f"{k} {n}" for k, n in sorted(Counter(kind(e['SK']) for e in remove).items())) if remove else ""))
    if not go:
        print("\nNothing written. Run again with --yes to do it.")
        return 0

    with table.batch_writer() as batch:
        for e in remove:
            batch.delete_item(Key={"PK": e["PK"], "SK": e["SK"]})
        for i in items:
            batch.put_item(Item=i)
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
