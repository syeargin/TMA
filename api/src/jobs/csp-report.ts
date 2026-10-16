import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

/**
 * Content-Security-Policy violation reports (R6), sent by browsers to this function's public URL
 * (template.yaml CspReportFunction). Each report becomes one trimmed log line in CloudWatch:
 *   fields @timestamp, directive, blocked, page | filter msg = "csp violation"
 * The policy uses report-uri ({"csp-report": {...}}, sent by every major browser). The newer Reporting
 * API format ([{type: "csp-violation", body: {...}}]) is read too, in case report-to is added later.
 */
const MAX_BODY = 16_000;
const MAX_REPORTS = 10;

type Summary = { directive: string; blocked: string; page: string; source: string; line: number | null; disposition: string; sample: string };

/** Paths only: query strings and fragments can carry ids or codes. */
function trimUrl(v: unknown): string {
  const s = String(v ?? "").slice(0, 500);
  if (!/^https?:|^wss?:/.test(s)) return s.slice(0, 100); // "inline", "eval", "data", ...
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname}`.slice(0, 300);
  } catch {
    return "(unreadable)";
  }
}

function summarize(r: Record<string, unknown>): Summary {
  return {
    directive: String(r["effective-directive"] ?? r.effectiveDirective ?? r["violated-directive"] ?? "").slice(0, 60),
    blocked: trimUrl(r["blocked-uri"] ?? r.blockedURL),
    page: trimUrl(r["document-uri"] ?? r.documentURL),
    source: trimUrl(r["source-file"] ?? r.sourceFile),
    line: Number(r["line-number"] ?? r.lineNumber) || null,
    disposition: String(r.disposition ?? "").slice(0, 20),
    sample: String(r["script-sample"] ?? r.sample ?? "").slice(0, 80)
  };
}

export function parseReports(raw: string): Summary[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  const out: Summary[] = [];
  if (Array.isArray(data)) {
    for (const item of data.slice(0, MAX_REPORTS)) {
      const it = item as { type?: string; body?: Record<string, unknown> };
      if (it?.type === "csp-violation" && it.body && typeof it.body === "object") out.push(summarize(it.body));
    }
  } else if (data && typeof data === "object" && (data as Record<string, unknown>)["csp-report"]) {
    const r = (data as Record<string, unknown>)["csp-report"];
    if (r && typeof r === "object") out.push(summarize(r as Record<string, unknown>));
  }
  return out;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  if (event.requestContext?.http?.method !== "POST") return { statusCode: 405 };
  let raw = event.body ?? "";
  if (raw.length > MAX_BODY * 2) return { statusCode: 413 };
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  if (raw.length > MAX_BODY) return { statusCode: 413 };
  const browser = String(event.headers?.["user-agent"] ?? "").slice(0, 160);
  for (const r of parseReports(raw)) console.log(JSON.stringify({ msg: "csp violation", ...r, browser }));
  return { statusCode: 204 };
};
