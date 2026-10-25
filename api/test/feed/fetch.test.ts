import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { blockedAddress, maskFeedUrl, normalizeFeedUrl, readLimited, safeLookup } from "../../src/lib/feed/fetch.js";

describe("calendar links", () => {
  it("accepts https and webcal, and refuses everything else", () => {
    expect(normalizeFeedUrl("webcal://cal.example.com/team.ics").toString()).toBe("https://cal.example.com/team.ics");
    expect(normalizeFeedUrl(" https://cal.example.com/a.ics#x ").toString()).toBe("https://cal.example.com/a.ics");
    for (const bad of ["http://cal.example.com/a.ics", "ftp://x.example.com/a", "https://user:pw@cal.example.com/a.ics", "https://cal.example.com:8443/a.ics", "https://localhost/a.ics", "not a link", "file:///etc/passwd"]) {
      expect(() => normalizeFeedUrl(bad), bad).toThrow();
    }
  });

  it("blocks private, local, metadata and reserved addresses", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1"]) {
      expect(blockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "20.119.0.1", "2606:4700::1111"]) expect(blockedAddress(ip), ip).toBe(false);
  });

  it("refuses names that resolve inside private networks", async () => {
    const err = await new Promise<Error | null>((resolve) => safeLookup("localhost", {}, (e) => resolve(e)));
    expect(err?.message).toMatch(/private address/);
  });

  it("stops reading past the size limit", async () => {
    await expect(readLimited(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), 1000)).rejects.toThrow(/larger than 2 MB/);
    expect((await readLimited(Readable.from([Buffer.from("BEGIN:VCALENDAR")]), 1000)).toString()).toBe("BEGIN:VCALENDAR");
  });

  it("masks the secret part of a link", () => {
    expect(maskFeedUrl("https://ss-func-prod.azurewebsites.net/api/calendar/feed/0123456789abcdef0123456789abcdef.ics")).toBe("ss-func-prod.azurewebsites.net/…/feed/0123…abcdef.ics");
    expect(maskFeedUrl("webcal://calendar.google.com/calendar/ical/abc%40group/private-xyz/basic.ics")).toBe("calendar.google.com/…/ba….ics");
    expect(maskFeedUrl("https://cal.example.com/team.ics?token=secret")).toBe("cal.example.com/…/team.ics?…");
  });
});
