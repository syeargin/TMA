import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists, waitUntilTableNotExists } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

export const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://127.0.0.1:8000";
process.env.DYNAMODB_ENDPOINT = ENDPOINT;

const raw = new DynamoDBClient({ endpoint: ENDPOINT, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } });

/** Same keys and indexes as template.yaml. */
export async function freshTable() {
  const TableName = process.env.TABLE_NAME!;
  try {
    await raw.send(new DeleteTableCommand({ TableName }));
    await waitUntilTableNotExists({ client: raw, maxWaitTime: 30, minDelay: 1 }, { TableName });
  } catch { /* not there */ }
  const S = "S" as const;
  await raw.send(new CreateTableCommand({
    TableName, BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: ["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK"].map((AttributeName) => ({ AttributeName, AttributeType: S })),
    KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }],
    GlobalSecondaryIndexes: [1, 2].map((n) => ({
      IndexName: `GSI${n}`,
      KeySchema: [{ AttributeName: `GSI${n}PK`, KeyType: "HASH" as const }, { AttributeName: `GSI${n}SK`, KeyType: "RANGE" as const }],
      Projection: { ProjectionType: "ALL" as const }
    }))
  }));
  await waitUntilTableExists({ client: raw, maxWaitTime: 30 }, { TableName });
}

export function event(method: string, path: string, sub: string | null, body?: unknown, email = ""): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: "2.0", routeKey: "ANY /{proxy+}", rawPath: path, rawQueryString: "", headers: {},
    body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      authorizer: { jwt: { claims: sub ? { sub, username: sub, ...(email ? { email } : {}) } : {}, scopes: [] }, principalId: "", integrationLatency: 0 }
    }
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
