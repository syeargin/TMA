import { describe, expect, it } from "vitest";
import { BUSY_MIN, intervalAt, isDue, nextDue, QUIET_MIN, slotOf, soonDates } from "../../src/lib/feed/schedule.js";
import { bodyHash } from "../../src/lib/feed/sync.js";

const NY = "America/New_York";
// Tue Nov 3 2026, 10:00 AM in New York (EST, UTC-5).
const at = (iso: string) => new Date(iso);
const base = { teamId: "a13", zone: NY, soon: [] as string[] };

describe("when a team's feed syncs", () => {
  it("every 30 minutes with something today or tomorrow, every 2 hours otherwise", () => {
    expect(intervalAt({ ...base, at: at("2026-11-03T15:00:00Z"), soon: ["2026-11-04"] })).toBe(BUSY_MIN);
    expect(intervalAt({ ...base, at: at("2026-11-03T15:00:00Z"), soon: ["2026-11-03"] })).toBe(BUSY_MIN);
    expect(intervalAt({ ...base, at: at("2026-11-03T15:00:00Z"), soon: ["2026-11-06"] })).toBe(QUIET_MIN);
  });

  it("not between 11 PM and 5 AM where the team is", () => {
    expect(isDue({ ...base, at: at("2026-11-04T04:30:00Z") })).toBe(false); // 11:30 PM
    expect(isDue({ ...base, at: at("2026-11-04T09:50:00Z") })).toBe(false); // 4:50 AM
  });

  it("once per interval for each team, in its own slot, spread across the club", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `team-${i}`);
    const ticks = Array.from({ length: 12 }, (_, i) => new Date(Date.parse("2026-11-03T14:00:00Z") + i * 600000)); // 9 AM to 11 AM
    for (const teamId of ids) {
      const quiet = ticks.filter((t) => isDue({ teamId, zone: NY, soon: [], at: t, lastAttemptAt: new Date(t.getTime() - 120 * 60000).toISOString() }));
      expect(quiet).toHaveLength(1);
      const busy = ticks.filter((t) => isDue({ teamId, zone: NY, soon: ["2026-11-03"], at: t, lastAttemptAt: new Date(t.getTime() - 30 * 60000).toISOString() }));
      expect(busy).toHaveLength(4);
    }
    expect(new Set(ids.map(slotOf)).size).toBeGreaterThan(8);
  });

  it("waits after a sync now, and catches up after a missed slot or the night", () => {
    const t = at("2026-11-03T15:00:00Z");
    expect(isDue({ ...base, at: t, lastAttemptAt: "2026-11-03T14:30:00Z" })).toBe(false); // 30 minutes ago, 2-hour interval
    expect(isDue({ ...base, at: t, lastAttemptAt: "2026-11-03T04:00:00Z" })).toBe(true); // last night
    expect(isDue({ ...base, at: t })).toBe(true); // never synced
  });

  it("says when the next sync is", () => {
    const n = nextDue({ ...base, at: at("2026-11-04T03:55:00Z"), lastAttemptAt: "2026-11-04T03:00:00Z" })!; // 10:55 PM
    expect(n.toISOString()).toBe("2026-11-04T10:00:00.000Z"); // 5 AM, the first run after the night
  });

  it("knows which days have events, multi-day ones included", () => {
    expect(soonDates([{ date: "2026-11-01", endDate: "2026-11-04" }, { date: "2026-11-06", cancelled: true }, { date: "2026-12-30" }], "2026-11-03", 14))
      .toEqual(["2026-11-03", "2026-11-04"]);
  });

  it("tells a changed calendar from one only re-stamped", () => {
    const cal = (stamp: string, time: string) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTAMP:${stamp}\r\nSEQUENCE:${stamp.slice(0, 8)}\r\nDTSTART:2026110${time}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    expect(bodyHash(cal("20261103T150000Z", "3T180000"), 1, "2026-11-01")).toBe(bodyHash(cal("20261104T150000Z", "3T180000"), 1, "2026-11-01"));
    expect(bodyHash(cal("20261103T150000Z", "3T180000"), 1, "2026-11-01")).not.toBe(bodyHash(cal("20261103T150000Z", "3T190000"), 1, "2026-11-01"));
    expect(bodyHash(cal("x", "3T180000"), 1, "2026-11-01")).not.toBe(bodyHash(cal("x", "3T180000"), 2, "2026-11-01"));
  });
});
