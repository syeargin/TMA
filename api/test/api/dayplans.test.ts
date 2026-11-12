import { beforeAll, describe, expect, it } from "vitest";
process.env.TABLE_NAME = "TeamHub-test-dayplans";
process.env.MAIL_TRANSPORT = "memory";
process.env.MFA_CHECK = "off";
const { event, freshTable } = await import("./harness.js");
const { handler } = await import("../../src/api/handler.js");
const { ddb, TABLE } = await import("../../src/lib/db.js");
const { keys } = await import("../../src/lib/keys.js");
const { PutCommand, GetCommand } = await import("@aws-sdk/lib-dynamodb");
const { DEFAULT_PLAYBOOK, familyTaskFrom, defaultDayType, planDates, planKey } = await import("../../src/shared/dayplans.js");

async function call(method: string, path: string, sub: string, body?: unknown) {
  const r = await handler(event(method, path, sub, body));
  return { status: r.statusCode ?? 0, body: r.body ? JSON.parse(r.body) : undefined };
}
const put = (Item: Record<string, unknown>) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const T = "t13", FOOD = "u-food", COACH = "u-coach", CARTER = "u-carter", LEE = "u-lee";
const member = (sub: string, roles: string[], pid = "") => put({ ...keys.member(T, sub), ...keys.memberGsi(T, sub), type: "Membership", status: "active", sub, roles, pid });
const meals = async () => (await call("GET", `/teams/${T}`, FOOD)).body.meals as Record<string, any>[];

beforeAll(async () => {
  await freshTable();
  await put({ ...keys.settings(T), teamName: "A5 13 Tom" });
  await member(FOOD, ["food"]);
  await member(COACH, ["coach"]);
  await member(CARTER, ["parent"], "p1");
  await member(LEE, ["parent"], "p2");
  await put({ ...keys.event(T, "sq"), type: "Event", kind: "tournament", title: "Sunshine Qualifier", date: "2027-01-29", endDate: "2027-01-31", travel: true });
  await put({ ...keys.event(T, "hc"), type: "Event", kind: "tournament", title: "Holiday Classic", date: "2026-12-12", travel: false });
}, 60_000);

describe("day plan rules", () => {
  it("knows each kind of day and when families get the order to-do", () => {
    const d = ["2027-01-29", "2027-01-30", "2027-01-31"];
    // Travel: the arrival day is the day before the listed start; the schedule's dates don't change.
    expect(planDates(true, "2027-01-29", "2027-01-31")).toEqual(["2027-01-28", ...d]);
    expect(planDates(true, "2027-01-29", "2027-01-31", true)).toEqual(d);
    expect(planDates(false, "2026-12-12")).toEqual(["2026-12-12"]);
    expect(["2027-01-28", ...d].map((x) => defaultDayType(true, d, x))).toEqual(["arrival", "play", "play", "last"]);
    expect(defaultDayType(false, d, d[0])).toBe("play");
    expect(planKey(true, "play")).toBeNull();
    expect(planKey(true, "arrival")).toBe("travel-arrival");
    expect(planKey(true, "last", "am")).toBe("travel-last-am");
    expect(planKey(false, "play", "pm")).toBe("local-pm");
    const by = Date.parse("2027-01-29T18:00:00Z");
    // Posted early: waits until 48 hours before the deadline. Posted late: right away.
    expect(familyTaskFrom(by - 5 * 86400_000, by, 48)).toBe(by - 48 * 3600_000);
    expect(familyTaskFrom(by - 3600_000, by, 48)).toBe(by - 3600_000);
    expect(familyTaskFrom(null, by, 48)).toBeNull();
  });
});

describe("tournament day plans", () => {
  it("fills in a PM play day's delivered dinner from the playbook, with the order deadline the day before", async () => {
    const r = await call("PUT", `/teams/${T}/events/sq/dayplan/2027-01-30`, COACH, { type: "play", wave: "pm" });
    expect(r.status).toBe(200);
    expect(r.body.days["2027-01-30"]).toEqual({ type: "play", wave: "pm", agenda: DEFAULT_PLAYBOOK.plans["travel-pm"].agenda });
    const dinner = (await meals()).filter((m) => m.eid === "sq" && m.day === "2027-01-30");
    expect(dinner).toHaveLength(1);
    expect(dinner[0]).toMatchObject({ meal: "Dinner", style: "delivered", fromPlan: true, familyOrders: true, vendor: "ezCater", orderBy: "2027-01-29T18:00", claimedBy: null });
  });

  it("lets the family with the job post the group order link; other families can't", async () => {
    const m = (await meals()).find((x) => x.eid === "sq" && x.meal === "Dinner")!;
    expect((await call("POST", `/teams/${T}/events/sq/meals/${m.mid}/claim`, CARTER, { pid: "p1" })).status).toBe(200);
    expect((await call("PUT", `/teams/${T}/events/sq/meals/${m.mid}/order-link`, LEE, { vendor: "DoorDash", orderLink: "https://drd.sh/x" })).status).toBe(403);
    expect((await call("PUT", `/teams/${T}/events/sq/meals/${m.mid}/order-link`, CARTER, { vendor: "DoorDash", orderLink: "http://drd.sh/x" })).status).toBe(400);
    const ok = await call("PUT", `/teams/${T}/events/sq/meals/${m.mid}/order-link`, CARTER, { vendor: "DoorDash", orderLink: "https://drd.sh/group/8kQ2" });
    expect(ok.body).toMatchObject({ vendor: "DoorDash", orderLink: "https://drd.sh/group/8kQ2" });
    expect(ok.body.linkAt).toBeTruthy();
  });

  it("records each family's part of the order, and keeps it when the meal is edited", async () => {
    const m = (await meals()).find((x) => x.eid === "sq" && x.meal === "Dinner")!;
    expect((await call("POST", `/teams/${T}/events/sq/meals/${m.mid}/my-order`, LEE, { pid: "p1", state: "added" })).status).toBe(403);
    expect((await call("POST", `/teams/${T}/events/sq/meals/${m.mid}/my-order`, LEE, { pid: "p2", state: "added" })).status).toBe(200);
    expect((await call("POST", `/teams/${T}/events/sq/meals/${m.mid}/my-order`, CARTER, { pid: "p1", state: "skip" })).status).toBe(200);
    expect((await call("POST", `/teams/${T}/events/sq/meals/${m.mid}/my-order`, CARTER, { pid: "p1", state: null })).status).toBe(200);
    const { eid: _e, mid: _m, orders: _o, linkAt: _l, ...rest } = m;
    expect((await call("PUT", `/teams/${T}/events/sq/meals/${m.mid}`, FOOD, { ...rest, time: "5:30 PM", orderLink: "https://drd.sh/group/8kQ2", headcount: 14 })).status).toBe(200);
    const after = (await meals()).find((x) => x.mid === m.mid)!;
    expect(after.orders).toEqual({ p2: expect.objectContaining({ state: "added" }) });
    expect(after).toMatchObject({ time: "5:30 PM", headcount: 14, claimedBy: "p1", linkAt: expect.any(String) });
  });

  it("swaps the plan when the wave changes: keeps a job a family has, flags it, and adds the new one", async () => {
    await call("PUT", `/teams/${T}/events/sq/dayplan/2027-01-30`, COACH, { type: "play", wave: "am" });
    const day = (await meals()).filter((m) => m.eid === "sq" && m.day === "2027-01-30");
    expect(day.map((m) => [m.meal, m.style, !!m.stale]).sort()).toEqual([["Dinner", "delivered", true], ["Lunch", "delivered", false]]);
    // Back to PM: the dinner is current again; the new lunch nobody took is removed.
    await call("PUT", `/teams/${T}/events/sq/dayplan/2027-01-30`, COACH, { type: "play", wave: "pm" });
    const again = (await meals()).filter((m) => m.eid === "sq" && m.day === "2027-01-30");
    expect(again.map((m) => [m.meal, !!m.stale])).toEqual([["Dinner", false]]);
  });

  it("follows the team's own playbook, and never touches meals added by hand", async () => {
    await call("PUT", `/teams/${T}/events/hc/meals/hand1`, FOOD, { meal: "Team snack", day: "2026-12-12", costCents: 0 });
    const pb = structuredClone(DEFAULT_PLAYBOOK);
    pb.plans["local-pm"].meals = [{ meal: "Dinner", style: "restaurant" }];
    const { updatedAt: _u, updatedBy: _b, ...body } = pb as typeof pb & { updatedAt?: string; updatedBy?: string };
    expect((await call("PUT", `/teams/${T}/dayplans`, COACH, body)).status).toBe(403);
    expect((await call("PUT", `/teams/${T}/dayplans`, FOOD, body)).status).toBe(200);
    await call("PUT", `/teams/${T}/events/hc/dayplan/2026-12-12`, FOOD, { type: "play", wave: "pm" });
    let hc = (await meals()).filter((m) => m.eid === "hc");
    expect(hc.map((m) => [m.meal, m.style ?? ""]).sort()).toEqual([["Dinner", "restaurant"], ["Team snack", ""]]);
    await call("PUT", `/teams/${T}/events/hc/dayplan/2026-12-12`, FOOD, { type: "play", wave: "am" });
    hc = (await meals()).filter((m) => m.eid === "hc");
    expect(hc.map((m) => m.meal)).toEqual(["Team snack"]);
    const bundle = (await call("GET", `/teams/${T}`, LEE)).body;
    expect(bundle.playbook.plans["local-pm"].meals[0].style).toBe("restaurant");
    expect(bundle.dayPlans.hc.days["2026-12-12"].wave).toBe("am");
  });

  it("plans the arrival day before a travel tournament, and can turn it off", async () => {
    const r = await call("PUT", `/teams/${T}/events/sq/dayplan/2027-01-28`, COACH, { type: "arrival" });
    expect(r.status).toBe(200);
    const dinner = (await meals()).find((m) => m.eid === "sq" && m.day === "2027-01-28")!;
    expect(dinner).toMatchObject({ meal: "Dinner", style: "restaurant", optional: true });
    // The team drives in the morning instead: the untaken dinner goes, and the day is off the plan.
    const off = await call("PUT", `/teams/${T}/events/sq/dayplan`, COACH, { arrival: false });
    expect(off.body.noArrival).toBe(true);
    expect((await meals()).some((m) => m.eid === "sq" && m.day === "2027-01-28")).toBe(false);
    expect((await call("PUT", `/teams/${T}/events/sq/dayplan/2027-01-28`, COACH, { type: "arrival" })).status).toBe(400);
    expect((await call("PUT", `/teams/${T}/events/sq/dayplan`, COACH, { arrival: true })).body.noArrival).toBe(false);
  });

  it("refuses dates outside the tournament and families setting the plan", async () => {
    expect((await call("PUT", `/teams/${T}/events/sq/dayplan/2027-02-02`, COACH, { type: "play", wave: "am" })).status).toBe(400);
    expect((await call("PUT", `/teams/${T}/events/sq/dayplan/2027-01-31`, LEE, { type: "last", wave: "am" })).status).toBe(403);
    const plan = (await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.dayPlan(T, "sq") }))).Item;
    expect(Object.keys(plan!.days)).toEqual(["2027-01-30"]);
    expect((await call("PUT", `/teams/${T}/events/hc/dayplan/2026-12-11`, COACH, { type: "play", wave: "am" })).status).toBe(400);
  });
});
