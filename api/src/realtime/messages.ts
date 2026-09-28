import type { APIGatewayProxyResultV2 } from "aws-lambda";
import { z } from "zod";
import { keys } from "../lib/keys.js";
import { loadAccess } from "../api/context.js";
import { HttpError } from "../api/http.js";
import { deleteItem, getItem, putItem } from "../api/util.js";
import { CONNECTION_TTL_SECONDS } from "./connect.js";
import { endpointFromEvent, send } from "./send.js";

type WsEvent = { body?: string | null; requestContext: { connectionId?: string; domainName?: string; stage?: string; routeKey?: string } };

const subscribeSchema = z.object({ action: z.literal("subscribe"), teamId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/) });

/**
 * Handles messages from the browser:
 *  - {"action":"subscribe","teamId":"…"}: after checking membership, start receiving that team's change notices
 *    (one team per connection; subscribing again switches teams)
 *  - {"action":"ping"}: keep-alive, answered with {"type":"pong"}
 *  - anything else: {"type":"error"}
 */
export async function handler(event: WsEvent): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId!;
  const endpoint = endpointFromEvent(event.requestContext);
  let msg: { action?: string } = {};
  try { msg = JSON.parse(event.body ?? "{}"); } catch { /* handled below */ }

  if (msg.action === "ping") {
    await send(endpoint, connectionId, { type: "pong", at: new Date().toISOString() });
    return { statusCode: 200 };
  }

  if (msg.action === "subscribe") {
    const parsed = subscribeSchema.safeParse(msg);
    if (!parsed.success) {
      await send(endpoint, connectionId, { type: "error", action: "subscribe", teamId: null, message: "Invalid team." });
      return { statusCode: 200 };
    }
    const { teamId } = parsed.data;
    const meta = await getItem(keys.conn(connectionId));
    if (!meta) {
      await send(endpoint, connectionId, { type: "error", action: "subscribe", code: "reconnect", message: "Connection expired. Reconnecting." });
      return { statusCode: 200 };
    }
    const sub = String(meta.sub);
    try {
      await loadAccess({ sub, username: "" }, teamId);
    } catch (e) {
      if (e instanceof HttpError) {
        await send(endpoint, connectionId, { type: "error", action: "subscribe", teamId, message: e.message });
        return { statusCode: 200 };
      }
      throw e;
    }
    const ttl = Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS;
    if (meta.teamId && meta.teamId !== teamId) await deleteItem(keys.teamConn(String(meta.teamId), connectionId));
    await putItem({ ...keys.teamConn(teamId, connectionId), type: "TeamConnection", sub, connectionId, ttl });
    await putItem({ ...meta, teamId, ttl });
    await send(endpoint, connectionId, { type: "subscribed", teamId });
    return { statusCode: 200 };
  }

  await send(endpoint, connectionId, { type: "error", message: "Unknown action." });
  return { statusCode: 200 };
}
