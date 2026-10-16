import { afterEach, describe, expect, it, vi } from "vitest";
import { handler, parseReports } from "../src/jobs/csp-report.js";

const ev = (body: string, method = "POST", isBase64Encoded = false) =>
  ({ requestContext: { http: { method } }, headers: { "user-agent": "Test/1.0" }, body, isBase64Encoded }) as any;

afterEach(() => vi.restoreAllMocks());

describe("CSP reports (R6)", () => {
  it("reads both report formats and keeps only paths", () => {
    const old = parseReports(JSON.stringify({ "csp-report": {
      "document-uri": "https://hub.test/teams/t1?code=secret#x", "effective-directive": "script-src-elem",
      "blocked-uri": "https://evil.test/x.js?token=abc", "source-file": "https://hub.test/main.js", "line-number": 12, disposition: "enforce"
    } }));
    expect(old).toEqual([{ directive: "script-src-elem", blocked: "https://evil.test/x.js", page: "https://hub.test/teams/t1", source: "https://hub.test/main.js", line: 12, disposition: "enforce", sample: "" }]);

    const api = parseReports(JSON.stringify([
      { type: "csp-violation", body: { documentURL: "https://hub.test/", effectiveDirective: "connect-src", blockedURL: "wss://elsewhere.test/socket", disposition: "enforce" } },
      { type: "deprecation", body: { id: "x" } }
    ]));
    expect(api).toHaveLength(1);
    expect(api[0]).toMatchObject({ directive: "connect-src", blocked: "wss://elsewhere.test/socket", page: "https://hub.test/" });
    expect(parseReports(JSON.stringify({ "csp-report": { "blocked-uri": "inline" } }))[0].blocked).toBe("inline");
  });

  it("ignores junk, caps how much it reads, and answers 204", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(parseReports("not json")).toEqual([]);
    expect(parseReports(JSON.stringify(Array(50).fill({ type: "csp-violation", body: {} })))).toHaveLength(10);
    expect((await handler(ev("{}", "GET"))).statusCode).toBe(405);
    expect((await handler(ev("x".repeat(40_000)))).statusCode).toBe(413);
    const body = Buffer.from(JSON.stringify({ "csp-report": { "blocked-uri": "eval", "effective-directive": "script-src" } })).toString("base64");
    expect((await handler(ev(body, "POST", true))).statusCode).toBe(204);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ msg: "csp violation", blocked: "eval", browser: "Test/1.0" });
  });
});
