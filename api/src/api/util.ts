import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../lib/db.js";
import { badRequest } from "./http.js";

export const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
export const checkId = (v: string, what = "id") => { if (!ID.test(v)) throw badRequest(`Invalid ${what}.`); return v; };
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const now = () => new Date().toISOString();

// Reusable field schemas
export const str = (max = 500) => z.string().trim().max(max);
export const optStr = (max = 500) => z.string().trim().max(max).optional();
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
export const cents = z.number().int().min(0).max(100_000_00);

const KEY_ATTRS = new Set(["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK"]);
/** Removes table keys before returning an item to the browser. */
export const clean = <T extends Record<string, unknown>>(item: T | undefined) => {
  if (!item) return item;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!KEY_ATTRS.has(k)) out[k] = v;
  return out;
};

export async function getItem(key: { PK: string; SK: string }) {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: key }));
  return res.Item as Record<string, unknown> | undefined;
}

export async function putItem(item: Record<string, unknown>, condition?: string) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: condition }));
}

export async function deleteItem(key: { PK: string; SK: string }) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: key }));
}

export async function queryAll(input: Omit<ConstructorParameters<typeof QueryCommand>[0], "TableName">) {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({ TableName: TABLE, ...input, ExclusiveStartKey: startKey }));
    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export async function deleteMany(keysToDelete: { PK: string; SK: string }[]) {
  for (let i = 0; i < keysToDelete.length; i += 25) {
    let batch = keysToDelete.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; batch.length && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: batch } }));
      batch = (res.UnprocessedItems?.[TABLE] ?? []) as typeof batch;
    }
  }
}
