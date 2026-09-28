import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { ZodError, type ZodTypeAny, type z } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") { super(message); }
}

export const forbidden = (msg = "You don't have access to do that.") => new HttpError(403, msg, "forbidden");
export const notFound = (msg = "Not found.") => new HttpError(404, msg, "not_found");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");
export const badRequest = (msg: string) => new HttpError(400, msg, "bad_request");

export function json(status: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: body === undefined ? "" : JSON.stringify(body)
  };
}

export function parseBody<S extends ZodTypeAny>(schema: S, raw: string | null | undefined): z.infer<S> {
  let data: unknown = {};
  if (raw) {
    try { data = JSON.parse(raw); } catch { throw badRequest("The request body isn't valid JSON."); }
  }
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) {
      const first = e.issues[0];
      throw badRequest(`${first.path.join(".") || "body"}: ${first.message}`);
    }
    throw e;
  }
}

/** Maps DynamoDB condition failures to 409s; everything else is rethrown. */
export function mapDbError(e: unknown, msg: string): never {
  const name = (e as { name?: string })?.name;
  if (name === "ConditionalCheckFailedException") throw conflict(msg);
  if (name === "TransactionCanceledException") {
    const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
    if (!reasons.length || reasons.some((r) => r.Code === "ConditionalCheckFailed")) throw conflict(msg);
  }
  throw e;
}
