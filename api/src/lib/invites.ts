import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "./db.js";
import { keys, normEmail } from "./keys.js";

type Invite = { PK: string; SK: string; teamId?: string; person?: string; pid?: string; roles?: string[]; invitedBy?: string };
type TxItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

export async function pendingInvites(email: string): Promise<Invite[]> {
  const out: Invite[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :team)",
      ExpressionAttributeValues: { ":pk": keys.invitePrefix(email), ":team": "TEAM#" },
      ExclusiveStartKey: startKey
    }));
    out.push(...((res.Items ?? []) as Invite[]));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return out;
}

/** Transaction actions that turn each invite into an active membership and delete the invite. */
export function inviteToMembershipItems(invites: Invite[], sub: string, email: string, now: string): TxItem[] {
  const items: TxItem[] = [];
  for (const inv of invites) {
    const teamId = inv.teamId ?? inv.SK.slice("TEAM#".length);
    items.push({
      Put: {
        TableName: TABLE,
        Item: {
          ...keys.member(teamId, sub), ...keys.memberGsi(teamId, sub),
          type: "Membership", status: "active", sub, email: normEmail(email),
          person: inv.person ?? "", pid: inv.pid ?? "", roles: inv.roles?.length ? inv.roles : ["parent"],
          invitedBy: inv.invitedBy ?? "", at: now
        }
      }
    });
    items.push({ Delete: { TableName: TABLE, Key: { PK: inv.PK, SK: inv.SK } } });
  }
  return items;
}

export async function writeInChunks(items: TxItem[]) {
  // DynamoDB transactions hold up to 100 actions.
  for (let i = 0; i < items.length; i += 100) {
    await ddb.send(new TransactWriteCommand({ TransactItems: items.slice(i, i + 100) }));
  }
}

/** Accepts any invites waiting for this email (used after sign-in for people who already have an account). */
export async function acceptPendingInvites(sub: string, email: string): Promise<number> {
  if (!email) return 0;
  const invites = await pendingInvites(email);
  if (!invites.length) return 0;
  await writeInChunks(inviteToMembershipItems(invites, sub, email, new Date().toISOString()));
  return invites.length;
}
