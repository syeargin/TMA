import type { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";

// Browsers can't set headers on a WebSocket, so the page passes its Cognito access token as ?token=.
let verifier: { verify: (t: string) => Promise<{ sub: string }> } | undefined;
const getVerifier = () =>
  (verifier ??= CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID!,
    clientId: process.env.USER_POOL_CLIENT_ID!,
    tokenUse: "access"
  }) as unknown as { verify: (t: string) => Promise<{ sub: string }> });

/** For tests. */
export const setVerifier = (v: typeof verifier) => { verifier = v; };

export async function handler(event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  const token = event.queryStringParameters?.token;
  if (!token) throw new Error("Unauthorized");
  let sub: string;
  try {
    sub = (await getVerifier().verify(token)).sub;
  } catch {
    throw new Error("Unauthorized"); // API Gateway turns this into a 401
  }
  return {
    principalId: sub,
    policyDocument: { Version: "2012-10-17", Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: event.methodArn }] },
    context: { sub }
  };
}
