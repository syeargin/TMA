import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { HttpError, json } from "./http.js";
import { Router } from "./router.js";
import { accountRoutes } from "./routes/account.js";
import { meRoutes } from "./routes/me.js";
import { smsRoutes } from "./routes/sms.js";
import { adminRoutes } from "./routes/admin.js";
import { attendanceRoutes } from "./routes/attendance.js";
import { feedRoutes } from "./routes/feed.js";
import { teamRoutes } from "./routes/teams.js";
import { contentRoutes } from "./routes/content.js";
import { familyRoutes } from "./routes/family.js";
import { moneyRoutes } from "./routes/money.js";
import { peopleRoutes } from "./routes/people.js";
import { clubRoutes } from "./routes/clubs.js";
import { exportRoutes } from "./routes/exports.js";
import { importRoutes } from "./routes/imports.js";
import { mailRoutes } from "./routes/mail.js";
import { commsRoutes, publicRoutes } from "./routes/comms.js";
import { helpAdminRoutes, helpPublicRoutes } from "./routes/help.js";
import { assertClubWritable, assertTeamWritable } from "./context.js";
import { ID } from "./util.js";

export const router = new Router();
meRoutes(router);
accountRoutes(router);
smsRoutes(router);
adminRoutes(router);
attendanceRoutes(router);
feedRoutes(router);
teamRoutes(router);
contentRoutes(router);
familyRoutes(router);
moneyRoutes(router);
peopleRoutes(router);
clubRoutes(router);
importRoutes(router);
exportRoutes(router);
mailRoutes(router);
commsRoutes(router);
helpAdminRoutes(router);

/** Routes that need no sign-in (template.yaml gives them no authorizer). */
export const publicRouter = new Router();
publicRoutes(publicRouter);
helpPublicRoutes(publicRouter);

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/^\/(dev|prod)(?=\/)/, "");
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const sub = String(claims.sub ?? "");
  const started = Date.now();
  let status = 500;
  try {
    const pub = path.startsWith("/public/") ? publicRouter.match(method, path) : null;
    if (pub && pub !== "method") {
      const res = await pub.handler({ method, path, params: pub.params, body: event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : event.body ?? null, caller: { sub: "", username: "" }, event });
      status = res.statusCode ?? 200;
      return res;
    }
    if (!sub) throw new HttpError(401, "Sign in to continue.", "unauthorized");
    const m = router.match(method, path);
    if (m === null) throw new HttpError(404, "Not found.", "not_found");
    if (m === "method") throw new HttpError(405, "Method not allowed.", "method_not_allowed");
    // Nothing on an archived team changes, except archiving itself.
    const team = method !== "GET" ? /^\/teams\/[^/]+\/([^/]+)/.exec(path) : null;
    const caller = { sub, username: String(claims.username ?? claims["cognito:username"] ?? "") };
    if (team && team[1] !== "archive" && team[1] !== "restore" && ID.test(m.params.teamId ?? "")) await assertTeamWritable(m.params.teamId, caller);
    // An inactive club's settings, admins and invites don't change either, except by site owners (site admin dashboard).
    if (method !== "GET" && /^\/clubs\/[^/]+/.test(path) && ID.test(m.params.clubId ?? "")) await assertClubWritable(m.params.clubId, caller);
    const res = await m.handler({
      method, path, params: m.params,
      body: event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : event.body ?? null,
      caller,
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
