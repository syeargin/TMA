import type { APIGatewayProxyResultV2 } from "aws-lambda";
import { keys } from "../lib/keys.js";
import { deleteMany, getItem } from "../api/util.js";

type WsEvent = { requestContext: { connectionId?: string } };

/** $disconnect: forget the connection and its team subscription. */
export async function handler(event: WsEvent): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId!;
  await forgetConnection(connectionId);
  return { statusCode: 200 };
}

export async function forgetConnection(connectionId: string, teamId?: string) {
  const meta = await getItem(keys.conn(connectionId));
  const team = teamId ?? (meta?.teamId as string | undefined);
  await deleteMany([keys.conn(connectionId), ...(team ? [keys.teamConn(team, connectionId)] : [])]);
}
