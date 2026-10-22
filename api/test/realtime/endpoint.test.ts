import { afterEach, describe, expect, it } from "vitest";
import { endpointFromEvent } from "../../src/realtime/send.js";

const saved = process.env.WS_ENDPOINT;
afterEach(() => { if (saved === undefined) delete process.env.WS_ENDPOINT; else process.env.WS_ENDPOINT = saved; });

describe("where WebSocket replies go", () => {
  it("uses the API's own address when it's set (template.yaml WS_ENDPOINT)", () => {
    process.env.WS_ENDPOINT = "https://abc123.execute-api.us-east-1.amazonaws.com/live";
    expect(endpointFromEvent({ domainName: "ws-dev.teemhub.net", stage: "live" })).toBe("https://abc123.execute-api.us-east-1.amazonaws.com/live");
  });

  it("without it: the stage after API Gateway's domain, none after a custom domain", () => {
    delete process.env.WS_ENDPOINT;
    expect(endpointFromEvent({ domainName: "abc123.execute-api.us-east-1.amazonaws.com", stage: "live" })).toBe("https://abc123.execute-api.us-east-1.amazonaws.com/live");
    expect(endpointFromEvent({ domainName: "ws-dev.teemhub.net", stage: "live" })).toBe("https://ws-dev.teemhub.net");
  });
});
