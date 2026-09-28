import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { Caller } from "./context.js";

export type Req = {
  method: string;
  path: string;
  params: Record<string, string>;
  body: string | null;
  caller: Caller;
  event: APIGatewayProxyEventV2WithJWTAuthorizer;
};
export type Handler = (req: Req) => Promise<APIGatewayProxyStructuredResultV2>;

type Route = { method: string; pattern: RegExp; names: string[]; handler: Handler };

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler) {
    const names: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return "([^/]+)"; }) + "/?$"
    );
    this.routes.push({ method, pattern, names, handler });
    return this;
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | "method" | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? "method" : null;
  }
}
