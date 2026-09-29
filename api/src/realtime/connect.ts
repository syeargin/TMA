import type { APIGatewayProxyResultV2 } from "aws-lambda";
import { keys } from "../lib/keys.js";
import { putItem } from "../api/util.js";

export const CONNECTION_TTL_SECONDS = 3 * 60 * 60; // API Gateway closes sockets after 2 hours

type WsEvent = { requestContext: { connectionId?: string; authorizer?: Record<string, unknown> } };

/** $connect: the authorizer has checked the token; remember which person owns this connection. */
export async function handler(event: WsEvent): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId!;
  const sub = String(event.requestContext.authorizer?.sub ?? event.requestContext.authorizer?.principalId ?? "");
  if (!sub) return { statusCode: 401 };
  await putItem({
    ...keys.conn(connectionId), type: "Connection", sub, connectedAt: new Date().toISOString(),
    ttl: Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS
  });
  return { statusCode: 200 };
}
