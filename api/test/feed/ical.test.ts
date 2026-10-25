import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandRule, FeedError, parseFeed, parseLine, unescapeText, unfold, zoneFromTzid } from "../../src/lib/feed/ical.js";
import { applyRules, detectPreset, sameRules, findCourt, splitVenue, startingRules, suggestFilters, type FeedEvent } from "../../src/shared/feed-rules.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const window = { windowStart: "2025-09-01", windowEnd: "2027-12-31" };
const sprocket = () => parseFeed(fixture("sprocket-style.ics"), { teamZone: "America/New_York", ...window });
const google = (teamZone = "America/Chicago") => parseFeed(fixture("google-style.ics"), { teamZone, ...window });

describe("reading the standard", () => {
  it("joins folded lines and reads escaped text", () => {
    expect(unfold("SUMMARY:Long\r\n  title\r\nX:1")).toEqual(["SUMMARY:Long title", "X:1"]);
    expect(unescapeText("A5 Sportsplex \\n11000 Hwy\\, Roswell\\; GA \\\\ x")).toBe("A5 Sportsplex \n11000 Hwy, Roswell; GA \\ x");
    expect(parseLine('ATTENDEE;CN="Smith: Jo";ROLE=REQ:mailto:jo@example.com')).toEqual({ name: "ATTENDEE", params: { CN: "Smith: Jo", ROLE: "REQ" }, value: "mailto:jo@example.com" });
  });

  it("knows IANA, Windows and prefixed zone names", () => {
    expect(zoneFromTzid("America/New_York")).toBe("America/New_York");
    expect(zoneFromTzid("Eastern Standard Time")).toBe("America/New_York");
    expect(zoneFromTzid("/mozilla.org/20050126_1/America/Chicago")).toBe("America/Chicago");
    expect(zoneFromTzid("Mars/Olympus")).toBeNull();
  });

  it("refuses things that aren't calendars", () => {
    expect(() => parseFeed("<html>Sign in</html>", { teamZone: "UTC", ...window })).toThrow(FeedError);
  });
});

describe("a Sprocket-style feed (one event per date, court in the description)", () => {
  it("reads every event in the team's zone, with venue lines and exclusive all-day ends", () => {
    const f = sprocket();
    expect(f.events).toHaveLength(22);
    expect(f.name).toBe("My Calendar");
    const first = f.events.find((e) => e.title === "14-1 Gold - Practice")!;
    expect(first).toMatchObject({ uid: "SprocketSports-1001", date: "2026-09-05", time: "07:30", endTime: "10:00", allDay: false, cancelled: false });
    expect(first.location).toBe("Northside Fieldhouse \n200 Example Parkway, Springfield, GA 30000");
    expect(first.description).toContain("Court: Court 1");
    const showcase = f.events.find((e) => e.title.endsWith("Winter Showcase"))!;
    expect(showcase).toMatchObject({ date: "2026-12-12", endDate: "2026-12-13", allDay: true });
    expect(f.from).toBe("2026-09-05");
    expect(f.to).toBe("2027-03-07");
  });

  it("is detected as Sprocket, suggests the team's title start, and the preset sorts it", () => {
    const f = sprocket();
    expect(detectPreset({ prodid: f.prodid, host: "calendar.example.com", uids: f.events.map((e) => e.uid) })).toBe("sprocket");
    const s = suggestFilters(f.events);
    expect(s[0]).toEqual({ filter: { mode: "prefix", text: "14-1 Gold -" }, count: 17 });
    const rules = startingRules("sprocket", f.events);
    const res = applyRules(f.events, rules);
    expect(res.matched).toHaveLength(17);
    expect(res.leftOut.map((e) => e.title)).toEqual(Array(5).fill("General Skills Clinic"));
    expect(res.counts).toEqual({ practice: 14, tournament: 2, event: 1 });
    const mc = res.matched.find((m) => m.feedTitle.includes("Master Coaching"))!;
    expect(mc).toMatchObject({ title: "Master Coaching - Practice", kind: "practice", court: "Court 5", venue: "Northside Fieldhouse", address: "200 Example Parkway, Springfield, GA 30000", time: "17:30", endTime: "21:30" });
    expect(res.matched.find((m) => m.feedTitle.endsWith("Media Day"))).toMatchObject({ title: "Media Day", kind: "event", court: "" });
    expect(res.courts).toBe(14);
  });

  it("shows times in the team's zone when it's somewhere else", () => {
    const f = parseFeed(fixture("sprocket-style.ics"), { teamZone: "America/Chicago", ...window });
    expect(f.events[0]).toMatchObject({ date: "2026-09-05", time: "06:30", endTime: "09:00" });
  });
});

describe("a Google-style feed (repeating events, UTC times, cancellations)", () => {
  it("expands weekly days up to UNTIL, skips EXDATEs and swaps in the changed date", () => {
    const practices = google().events.filter((e) => e.uid.startsWith("abc123@google.com"));
    expect(practices.map((e) => `${e.date} ${e.time}`)).toEqual([
      "2026-11-03 18:00", "2026-11-05 18:00", "2026-11-10 18:00", // Nov 12 is skipped
      "2026-11-17 18:00", "2026-11-19 19:00", "2026-11-24 18:00", "2026-11-26 18:00"
    ]);
    expect(practices.find((e) => e.date === "2026-11-19")).toMatchObject({ title: "Practice (late start)", uid: "abc123@google.com#20261119", repeating: true });
    expect(practices[0].categories).toEqual(["Practice", "Indoor"]);
  });

  it("reads UTC times and durations, Windows zones, missing ids and both kinds of cancellation", () => {
    const evs = google().events;
    expect(evs.find((e) => e.uid === "tourney1@google.com")).toMatchObject({ date: "2026-11-07", time: "09:00", endTime: "19:00" });
    expect(evs.find((e) => e.uid === "dinner@google.com")).toMatchObject({ title: "Team dinner", cancelled: true, allDay: true, endDate: "2026-11-21" });
    expect(evs.find((e) => e.uid === "scrim@google.com")).toMatchObject({ cancelled: true });
    const meeting = evs.find((e) => e.title === "Parent meeting")!;
    expect(meeting).toMatchObject({ date: "2026-11-24", time: "09:00", endTime: "10:00" }); // 10 AM Eastern is 9 AM Central
    expect(meeting.uid).toMatch(/^gen-[0-9a-f]{16}$/);
    expect(meeting.description).toBe("A long note that keeps going so the line is folded across more than one line, with commas; and semicolons.");
    expect(evs.filter((e) => e.uid.startsWith("film@")).map((e) => e.date)).toEqual(["2026-11-14", "2026-12-12", "2027-01-09"]);
  });

  it("gets generic rules and an \"everything\" filter when titles share no start", () => {
    const f = google();
    expect(detectPreset({ prodid: f.prodid, host: "calendar.google.com", uids: [] })).toBe("google");
    const rules = startingRules("google", f.events);
    expect(rules.filter).toEqual({ mode: "all" });
    const res = applyRules(f.events, rules);
    expect(res.matched.find((m) => m.uid === "tourney1@google.com")!.kind).toBe("tournament"); // 10 hours long
    expect(res.matched.find((m) => m.uid === "abc123@google.com#20261103")).toMatchObject({ kind: "practice", court: "Court 3", venue: "Riverside Rec Center, Gym B Court 3" });
  });
});

describe("rule pieces", () => {
  it("finds courts written several ways", () => {
    expect(findCourt("Court: Court 8\nArrive early", "Court")).toBe("Court 8");
    expect(findCourt("Gym B Court 3", "Court")).toBe("Court 3");
    expect(findCourt("Field #4", "field")).toBe("Field 4");
    expect(findCourt("Courtside seats", "Court")).toBe("");
  });

  it("compares rules whatever order their keys come back in", () => {
    const a = startingRules("sprocket", []);
    const shuffled = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse())));
    shuffled.court = { label: "Court", from: "description" };
    expect(sameRules(a, shuffled)).toBe(true);
    expect(sameRules(a, { ...a, fallback: "practice" })).toBe(false);
  });

  it("splits venue and address", () => {
    expect(splitVenue("A5 Sportsplex \n11000 Hwy, Roswell, GA", "firstLine")).toEqual({ venue: "A5 Sportsplex", address: "11000 Hwy, Roswell, GA" });
    expect(splitVenue("A5 Sportsplex \n11000 Hwy", "whole")).toEqual({ venue: "A5 Sportsplex, 11000 Hwy", address: "" });
  });

  it("expands monthly and daily rules and stops at the window", () => {
    expect(expandRule("2026-01-31", { freq: "MONTHLY", interval: 1, byday: [], bymonthday: [-1], bymonth: [], count: 3 }, "2027-01-01")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(expandRule("2026-05-01", { freq: "DAILY", interval: 2, byday: [], bymonthday: [], bymonth: [] }, "2026-05-07")).toEqual(["2026-05-01", "2026-05-03", "2026-05-05", "2026-05-07"]);
  });

  it("suggests bracketed tags and skips starts every event shares", () => {
    const ev = (title: string): FeedEvent => ({ uid: title, title, description: "", location: "", categories: [], date: "2026-01-01", endDate: "2026-01-01", allDay: true, cancelled: false });
    const s = suggestFilters([ev("[14U] Practice"), ev("[14U] Game"), ev("[14U] Meeting"), ev("[12U] Practice")]);
    expect(s).toEqual([{ filter: { mode: "prefix", text: "[14U]" }, count: 3 }]);
    expect(suggestFilters([ev("Club - A"), ev("Club - B"), ev("Club - C")])).toEqual([]);
  });
});
