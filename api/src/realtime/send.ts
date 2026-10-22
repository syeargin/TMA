import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const clients = new Map<string, ApiGatewayManagementApiClient>();

export function wsClient(endpoint: string) {
  let c = clients.get(endpoint);
  if (!c) { c = new ApiGatewayManagementApiClient({ endpoint }); clients.set(endpoint, c); }
  return c;
}

/**
 * Endpoint for replying to a connection from inside a WebSocket route handler. WS_ENDPOINT (the API's
 * own execute-api address and stage, set in template.yaml) always works. Without it, the address the
 * browser used: API Gateway's own domain plus the stage, or a custom domain (ws-dev.teemhub.net), which
 * maps straight to the stage, so no stage in the path.
 */
export function endpointFromEvent(ctx: { domainName?: string; stage?: string }): string {
  if (process.env.WS_ENDPOINT) return process.env.WS_ENDPOINT;
  const host = String(ctx.domainName ?? "");
  return host.endsWith(".amazonaws.com") ? `https://${host}/${ctx.stage}` : `https://${host}`;
}

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
