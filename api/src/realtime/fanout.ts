import type { DynamoDBStreamEvent } from "aws-lambda";
import { keys } from "../lib/keys.js";
import { deleteMany, queryAll } from "../api/util.js";
import { describeChange } from "./changes.js";
import { send } from "./send.js";

const CONCURRENCY = 10;

/** Groups stream records into {teamId → collections changed}. */
export function groupChanges(event: DynamoDBStreamEvent) {
  const byTeam = new Map<string, Set<string>>();
  for (const rec of event.Records) {
    const k = rec.dynamodb?.Keys;
    const pk = k?.PK?.S, sk = k?.SK?.S;
    if (!pk || !sk) continue;
    const change = describeChange(pk, sk);
    if (!change) continue;
    if (!byTeam.has(change.teamId)) byTeam.set(change.teamId, new Set());
    byTeam.get(change.teamId)!.add(change.collection);
  }
  return byTeam;
}

/**
 * DynamoDB stream consumer. For each team with changes, sends every browser subscribed to that
 * team a notice like {"type":"changed","teamId":"a5-13tom","collections":["events","meals"]}.
 * The notice carries no data: browsers re-read through the API, which applies role checks.
 * Connections that have gone away are removed.
 */
export async function handler(event: DynamoDBStreamEvent) {
  const endpoint = process.env.WS_ENDPOINT!;
  const byTeam = groupChanges(event);
  let sent = 0, gone = 0;

  for (const [teamId, cols] of byTeam) {
    const conns = await queryAll({
      KeyConditionExpression: "PK = :p",
      ExpressionAttributeValues: { ":p": `TEAMCONN#${teamId}` },
      ProjectionExpression: "SK"
    });
    const ids = conns.map((c) => String(c.SK).slice("CONN#".length));
    const message = { type: "changed", teamId, collections: [...cols].sort(), at: new Date().toISOString() };
    const dead: string[] = [];

    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((id) => send(endpoint, id, message).catch((e) => {
        console.warn(JSON.stringify({ msg: "send failed", connectionId: id, error: String(e) }));
        return true; // transient: keep the connection
      })));
      results.forEach((ok, j) => { if (ok) sent++; else dead.push(batch[j]); });
    }
    if (dead.length) {
      gone += dead.length;
      await deleteMany(dead.flatMap((id) => [keys.teamConn(teamId, id), keys.conn(id)]));
    }
  }
  console.log(JSON.stringify({ msg: "fanout", records: event.Records.length, teams: byTeam.size, sent, gone }));
  return { teams: byTeam.size, sent, gone };
}
