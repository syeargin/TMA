import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBStreamEvent } from "aws-lambda";
import { freshTable } from "../api/harness.js";

process.env.WS_ENDPOINT = "https://ws.example.com/live";
// Own table: vitest runs test files in parallel, and the API tests drop and recreate TeamHub-test.
process.env.TABLE_NAME = "TeamHub-test-realtime";

const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { getItem } = await import("../../src/api/util.js");
const { describeChange } = await import("../../src/realtime/changes.js");
const connect = (await import("../../src/realtime/connect.js")).handler;
const disconnect = (await import("../../src/realtime/disconnect.js")).handler;
const messages = (await import("../../src/realtime/messages.js")).handler;
const fanout = (await import("../../src/realtime/fanout.js"));
const auth = await import("../../src/realtime/authorizer.js");

const ws = mockClient(ApiGatewayManagementApiClient);
const sentTo = (id: string) => ws.commandCalls(PostToConnectionCommand)
  .filter((c) => c.args[0].input.ConnectionId === id)
  .map((c) => JSON.parse(Buffer.from(c.args[0].input.Data as Uint8Array).toString()));

const ctx = (connectionId: string, extra: Record<string, unknown> = {}) =>
  ({ requestContext: { connectionId, domainName: "ws.example.com", stage: "live", ...extra } });

async function member(teamId: string, sub: string) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...keys.member(teamId, sub), status: "active", roles: ["parent"], type: "Membership" } }));
}

const streamEvent = (keysList: [string, string][]): DynamoDBStreamEvent => ({
  Records: keysList.map(([PK, SK]) => ({ eventName: "MODIFY", dynamodb: { Keys: { PK: { S: PK }, SK: { S: SK } } } }))
} as DynamoDBStreamEvent);

beforeAll(async () => {
  await freshTable();
  await member("ta", "u1");
  await member("tb", "u1");
  await member("ta", "u2");
});
beforeEach(() => { ws.reset(); ws.on(PostToConnectionCommand).resolves({}); });

describe("change mapping", () => {
  it.each([
    ["TEAM#ta", "META#SETTINGS", "settings"], ["TEAM#ta", "META#HANDBOOK", "handbook"],
    ["TEAM#ta", "PLAYER#p1", "players"], ["TEAM#ta", "PLAYER#p1#CONTACTS", "players"],
    ["TEAM#ta", "EVENT#e1", "events"], ["TEAM#ta", "EVENT#e1#REFJOBS", "refjobs"],
    ["TEAM#ta", "EVENT#e1#AGENDA", "agenda"], ["TEAM#ta", "EVENT#e1#MEAL#m1", "meals"],
    ["TEAM#ta", "FAMILY#p1", "family"], ["TEAM#ta", "PAYMENT#x", "payments"], ["TEAM#ta", "LEDGER#l", "ledger"],
    ["TEAM#ta", "ANN#a", "announcements"], ["TEAM#ta", "TASK#k", "tasks"], ["TEAM#ta", "MEMBER#u", "members"],
    ["INVITE#x@example.com", "TEAM#ta", "invites"]
  ])("%s / %s → %s", (pk, sk, col) => {
    expect(describeChange(pk, sk)).toEqual({ teamId: "ta", collection: col });
  });
  it("ignores connections, profiles and club records", () => {
    expect(describeChange("TEAMCONN#ta", "CONN#c1")).toBeNull();
    expect(describeChange("CONN#c1", "META")).toBeNull();
    expect(describeChange("USER#u1", "PROFILE")).toBeNull();
    expect(describeChange("CLUB#a5", "TEAM#ta")).toBeNull();
  });
});

describe("connect, subscribe, disconnect", () => {
  it("connect requires the authorizer's sub and stores the connection with a TTL", async () => {
    expect((await connect(ctx("c0") as any) as any).statusCode).toBe(401);
    expect((await connect(ctx("c1", { authorizer: { sub: "u1" } }) as any) as any).statusCode).toBe(200);
    const meta = await getItem(keys.conn("c1"));
    expect(meta).toMatchObject({ sub: "u1", type: "Connection" });
    expect(Number(meta!.ttl)).toBeGreaterThan(Date.now() / 1000 + 2 * 3600);
  });

  it("subscribes members, refuses non-members, and switches teams cleanly", async () => {
    await messages({ ...ctx("c1"), body: JSON.stringify({ action: "subscribe", teamId: "ta" }) } as any);
    expect(sentTo("c1").at(-1)).toMatchObject({ type: "subscribed", teamId: "ta" });
    expect(await getItem(keys.teamConn("ta", "c1"))).toMatchObject({ sub: "u1" });

    await messages({ ...ctx("c1"), body: JSON.stringify({ action: "subscribe", teamId: "tb" }) } as any);
    expect(await getItem(keys.teamConn("ta", "c1"))).toBeUndefined();
    expect(await getItem(keys.teamConn("tb", "c1"))).toBeDefined();

    await connect(ctx("c2", { authorizer: { sub: "u2" } }) as any);
    await messages({ ...ctx("c2"), body: JSON.stringify({ action: "subscribe", teamId: "tb" }) } as any);
    expect(sentTo("c2").at(-1)).toMatchObject({ type: "error" });
    expect(await getItem(keys.teamConn("tb", "c2"))).toBeUndefined();
  });

  it("answers pings and rejects unknown or malformed messages", async () => {
    await messages({ ...ctx("c1"), body: JSON.stringify({ action: "ping" }) } as any);
    expect(sentTo("c1").at(-1)).toMatchObject({ type: "pong" });
    await messages({ ...ctx("c1"), body: "not json" } as any);
    expect(sentTo("c1").at(-1)).toMatchObject({ type: "error" });
    await messages({ ...ctx("c1"), body: JSON.stringify({ action: "subscribe", teamId: "../x" }) } as any);
    expect(sentTo("c1").at(-1)).toMatchObject({ type: "error" });
  });

  it("disconnect removes the connection and its subscription", async () => {
    await disconnect(ctx("c1") as any);
    expect(await getItem(keys.conn("c1"))).toBeUndefined();
    expect(await getItem(keys.teamConn("tb", "c1"))).toBeUndefined();
  });
});

describe("fan-out", () => {
  it("sends one notice per team listing what changed, only to that team's subscribers", async () => {
    for (const [id, sub, team] of [["f1", "u1", "ta"], ["f2", "u2", "ta"], ["f3", "u1", "tb"]]) {
      await connect(ctx(id, { authorizer: { sub } }) as any);
      await messages({ ...ctx(id), body: JSON.stringify({ action: "subscribe", teamId: team }) } as any);
    }
    ws.reset(); ws.on(PostToConnectionCommand).resolves({});
    const r = await fanout.handler(streamEvent([
      ["TEAM#ta", "EVENT#e1"], ["TEAM#ta", "EVENT#e1#MEAL#m1"], ["TEAM#ta", "EVENT#e2"],
      ["TEAMCONN#ta", "CONN#f1"], ["USER#u1", "PROFILE"]
    ]));
    expect(r).toMatchObject({ teams: 1, sent: 2, gone: 0 });
    expect(sentTo("f1")).toEqual([expect.objectContaining({ type: "changed", teamId: "ta", collections: ["events", "meals"] })]);
    expect(sentTo("f2")).toHaveLength(1);
    expect(sentTo("f3")).toHaveLength(0);
  });

  it("removes connections that have gone away and keeps the rest", async () => {
    ws.reset();
    ws.on(PostToConnectionCommand, { ConnectionId: "f1" }).rejects(new GoneException({ message: "gone", $metadata: {} }));
    ws.on(PostToConnectionCommand, { ConnectionId: "f2" }).resolves({});
    const r = await fanout.handler(streamEvent([["TEAM#ta", "MEMBER#u9"]]));
    expect(r).toMatchObject({ sent: 1, gone: 1 });
    expect(await getItem(keys.teamConn("ta", "f1"))).toBeUndefined();
    expect(await getItem(keys.conn("f1"))).toBeUndefined();
    expect(await getItem(keys.teamConn("ta", "f2"))).toBeDefined();
  });

  it("notifies admins about invite changes on the invited team", async () => {
    const groups = fanout.groupChanges(streamEvent([["INVITE#new@example.com", "TEAM#tb"]]));
    expect([...groups.get("tb")!]).toEqual(["invites"]);
  });
});

describe("authorizer", () => {
  const ev = (token?: string) => ({ methodArn: "arn:aws:execute-api:us-east-1:1:abc/live/$connect", queryStringParameters: token ? { token } : {} }) as any;
  it("allows a valid token and passes the sub on", async () => {
    auth.setVerifier({ verify: async (t: string) => { if (t !== "good") throw new Error("bad"); return { sub: "u1" }; } });
    const res = await auth.handler(ev("good"));
    expect(res.principalId).toBe("u1");
    expect(res.context).toEqual({ sub: "u1" });
    expect(res.policyDocument.Statement[0]).toMatchObject({ Effect: "Allow" });
  });
  it("rejects missing or invalid tokens", async () => {
    await expect(auth.handler(ev())).rejects.toThrow("Unauthorized");
    await expect(auth.handler(ev("bad"))).rejects.toThrow("Unauthorized");
  });
});
