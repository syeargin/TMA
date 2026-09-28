import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const clients = new Map<string, ApiGatewayManagementApiClient>();

export function wsClient(endpoint: string) {
  let c = clients.get(endpoint);
  if (!c) { c = new ApiGatewayManagementApiClient({ endpoint }); clients.set(endpoint, c); }
  return c;
}

/** Endpoint for replying to a connection from inside a WebSocket route handler. */
export const endpointFromEvent = (ctx: { domainName?: string; stage?: string }) => `https://${ctx.domainName}/${ctx.stage}`;

/** Sends one JSON message. Returns false if the connection is gone (closed tab, lost network). */
export async function send(endpoint: string, connectionId: string, message: unknown): Promise<boolean> {
  try {
    await wsClient(endpoint).send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(message)) }));
    return true;
  } catch (e) {
    if (e instanceof GoneException || (e as { name?: string }).name === "GoneException" || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 410) return false;
    throw e;
  }
}
