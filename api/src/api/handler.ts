import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { HttpError, json } from "./http.js";
import { Router } from "./router.js";
import { meRoutes } from "./routes/me.js";
import { teamRoutes } from "./routes/teams.js";
import { contentRoutes } from "./routes/content.js";
import { familyRoutes } from "./routes/family.js";
import { moneyRoutes } from "./routes/money.js";
import { peopleRoutes } from "./routes/people.js";

export const router = new Router();
meRoutes(router);
teamRoutes(router);
contentRoutes(router);
familyRoutes(router);
moneyRoutes(router);
peopleRoutes(router);

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/^\/(dev|prod)(?=\/)/, "");
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const sub = String(claims.sub ?? "");
  const started = Date.now();
  let status = 500;
  try {
    if (!sub) throw new HttpError(401, "Sign in to continue.", "unauthorized");
    const m = router.match(method, path);
    if (m === null) throw new HttpError(404, "Not found.", "not_found");
    if (m === "method") throw new HttpError(405, "Method not allowed.", "method_not_allowed");
    const res = await m.handler({
      method, path, params: m.params,
      body: event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : event.body ?? null,
      caller: { sub, username: String(claims.username ?? claims["cognito:username"] ?? "") },
      event
    });
    status = res.statusCode ?? 200;
    return res;
  } catch (e) {
    if (e instanceof HttpError) {
      status = e.status;
      return json(e.status, { error: e.code, message: e.message });
    }
    console.error(JSON.stringify({ msg: "unhandled", method, path, error: String(e), stack: (e as Error)?.stack }));
    return json(500, { error: "server_error", message: "Something went wrong on our side. Try again." });
  } finally {
    console.log(JSON.stringify({ msg: "request", method, path, status, ms: Date.now() - started, sub }));
  }
}
