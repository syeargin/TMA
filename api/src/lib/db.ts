import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const TABLE = process.env.TABLE_NAME ?? "";

// DYNAMODB_ENDPOINT is only set in tests (DynamoDB Local); Lambda uses the regional endpoint.
const endpoint = process.env.DYNAMODB_ENDPOINT;

export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient(endpoint
    ? { endpoint, region: process.env.AWS_REGION ?? "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } }
    : {}),
  { marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false } }
);
