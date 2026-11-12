import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { loadAccess } from "../context.js";
import { badRequest, forbidden, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, date, deleteItem, getItem, newId, now, optStr, putItem, queryAll, str } from "../util.js";
import {
  DAY_TYPES, MEAL_SLOTS, MEAL_STYLES, PLAN_KEYS, defaultDayType, isJob, orderDeadline, planKey, playbookOf,
  type EventDayPlan, type PlanDay, type Playbook
} from "../../shared/dayplans.js";

/**
 * Tournament day plans (shared/dayplans.ts): the team's playbook, each tournament day's kind and wave, and
 * the meal jobs a wave fills in. Families mark their own part of a group order and the family doing a
 * job posts its link.
 */

const dayTemplate = z.object({
  meals: z.array(z.object({ meal: z.enum(MEAL_SLOTS), style: z.enum(MEAL_STYLES), optional: z.boolean().optional() })).max(6),
  agenda: z.array(str(200).min(1)).max(12)
});
const playbookSchema = z.object({
  plans: z.object(Object.fromEntries(PLAN_KEYS.map((k) => [k, dayTemplate])) as Record<(typeof PLAN_KEYS)[number], typeof dayTemplate>),
  budgets: z.object({ court: z.number().int().min(0).max(20000), delivered: z.number().int().min(0).max(20000), restaurant: z.number().int().min(0).max(20000) }),
  count: z.literal("players-coaches").default("players-coaches"),
  vendor: str(80).default(""),
  howTo: z.string().trim().max(500).refine((v) => !v || /^https?:\/\//i.test(v) || !v.includes("://"), "Use a web link or a short note.").default(""),
  orderTime: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
  familyLeadHours: z.number().int().min(0).max(168).default(48)
}).refine((p) => Object.values(p.plans).every((d) => new Set(d.meals.map((m) => m.meal)).size === d.meals.length), "A day lists the same meal twice.");
const daySchema = z.object({
  type: z.enum(DAY_TYPES),
  wave: z.enum(["am", "pm"]).nullable().optional(),
  /** Leave out to fill in from the playbook; send to keep your own lines. */
  agenda: z.array(str(200).min(1)).max(20).optional()
});
const orderLinkSchema = z.object({
  vendor: optStr(80),
  orderLink: z.string().trim().max(500).refine((v) => !v || /^https:\/\//i.test(v), "The group order link needs to start with https://.")
});
const myOrderSchema = z.object({ pid: str(64).min(1), state: z.enum(["added", "skip"]).nullable() });

type Item = Record<string, unknown>;

/** Every date of a tournament (at most 10). */
function datesOf(e: Item): string[] {
  const out: string[] = [];
  const start = String(e.date), end = String(e.endDate || e.date);
  for (let d = start; d <= end && out.length < 10; ) {
    out.push(d);
    const n = new Date(`${d}T12:00:00Z`); n.setUTCDate(n.getUTCDate() + 1); d = n.toISOString().slice(0, 10);
  }
  return out;
}

/**
 * Sets one day's kind and wave, and makes its meal jobs match the playbook:
 *  - a job the plan still has keeps its family, link and order marks (its style follows the plan);
 *  - a new job is added, open for families to claim;
 *  - a job the plan no longer has is removed if nobody took it, or kept and flagged if a family has it.
 * Meals added by hand (not from the plan) are never touched.
 */
export async function applyDay(teamId: string, e: Item, day: string, set: PlanDay, by: string, saved?: Playbook) {
  const pb = saved ?? playbookOf((await getItem(keys.playbook(teamId))) as Partial<Playbook> | undefined);
  const eid = String(e.eid);
  const travel = !!e.travel;
  const key = planKey(travel, set.type, set.wave);
  const template = key ? pb.plans[key] : null;
  const at = now();
  const want = (template?.meals ?? []).filter((m) => isJob(m.style));
  const existing = (await queryAll({
    KeyConditionExpression: "PK = :p AND begins_with(SK, :m)",
    ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":m": `EVENT#${eid}#MEAL#` }
  })).filter((m) => m.fromPlan && m.planDay === day);
  const changed: string[] = [];
  for (const w of want) {
    const have = existing.find((m) => m.meal === w.meal);
    if (have) {
      if (have.style !== w.style || have.stale) {
        await putItem({ ...have, style: w.style, optional: !!w.optional, familyOrders: w.style === "delivered" ? (have.familyOrders ?? true) : false, stale: false, styleChangedAt: at, updatedAt: at, updatedBy: by });
        if (have.claimedBy) changed.push(String(have.claimedBy));
      }
      continue;
    }
    const mid = newId("m");
    await putItem({
      ...keys.meal(teamId, eid, mid), type: "Meal", meal: w.meal, day, style: w.style, optional: !!w.optional,
      fromPlan: true, planDay: day, claimedBy: null, costCents: 0,
      vendor: w.style === "delivered" ? pb.vendor : "", orderBy: w.style === "delivered" ? orderDeadline(day, pb.orderTime) : undefined,
      familyOrders: w.style === "delivered", updatedAt: at, updatedBy: by
    });
  }
  for (const m of existing) {
    if (want.some((w) => w.meal === m.meal)) continue;
    if (!m.claimedBy && !m.orderLink) await deleteItem({ PK: String(m.PK), SK: String(m.SK) });
    else if (!m.stale) { await putItem({ ...m, stale: true, updatedAt: at, updatedBy: by }); if (m.claimedBy) changed.push(String(m.claimedBy)); }
  }
  const saved2 = (await getItem(keys.dayPlan(teamId, eid))) as EventDayPlan | undefined;
  const days = { ...(saved2?.days ?? {}) };
  days[day] = { type: set.type, ...(set.wave ? { wave: set.wave } : {}), agenda: set.agenda ?? template?.agenda ?? [] };
  await putItem({ ...keys.dayPlan(teamId, eid), type: "DayPlan", days, updatedAt: at, updatedBy: by });
  return { days, changed };
}

export function dayPlanRoutes(r: Router) {
  r.on("PUT", "/teams/{teamId}/dayplans", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("meals");
    a.requireFeature("meals");
    const b = parseBody(playbookSchema, body);
    const item = { ...b, updatedAt: now(), updatedBy: caller.sub };
    await putItem({ ...keys.playbook(a.teamId), type: "Playbook", ...item });
    return json(200, item);
  });

  /** One tournament day: its kind, its wave once posted, and its agenda lines. */
  r.on("PUT", "/teams/{teamId}/events/{eid}/dayplan/{day}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    if (!a.can("schedule") && !a.can("meals")) throw forbidden("Only coaches, coordinators and food coordinators can set the day plan.");
    a.requireFeature("meals");
    const eid = checkId(params.eid, "event");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(params.day)) throw badRequest("Use a date like 2026-01-30.");
    const e = await getItem(keys.event(a.teamId, eid));
    if (!e || e.kind !== "tournament") throw notFound("That tournament isn't on the schedule any more.");
    const dates = datesOf({ ...e, eid });
    if (!dates.includes(params.day)) throw badRequest("That date isn't part of this tournament.");
    const b = parseBody(daySchema, body);
    const set: PlanDay = { type: b.type, ...(b.wave ? { wave: b.wave } : {}), ...(b.agenda ? { agenda: b.agenda } : {}) };
    const out = await applyDay(a.teamId, { ...e, eid }, params.day, set, caller.sub);
    return json(200, out);
  });

  /** The family doing a meal job (or a food coordinator) posts the group order link and service. */
  r.on("PUT", "/teams/{teamId}/events/{eid}/meals/{mid}/order-link", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.requireFeature("meals");
    const key = keys.meal(a.teamId, checkId(params.eid, "event"), checkId(params.mid, "meal"));
    const meal = await getItem(key);
    if (!meal) throw notFound("That meal doesn't exist.");
    if (!a.can("meals") && !(meal.claimedBy && a.isParentOf(String(meal.claimedBy)))) throw forbidden("Only the family doing this meal, or a food coordinator, can add its order link.");
    const b = parseBody(orderLinkSchema, body);
    const set: Item = { orderLink: b.orderLink, updatedAt: now(), updatedBy: caller.sub };
    if (b.vendor !== undefined) set.vendor = b.vendor;
    if (b.orderLink && b.orderLink !== meal.orderLink) set.linkAt = now();
    await putItem({ ...meal, ...set });
    return json(200, { orderLink: b.orderLink, vendor: set.vendor ?? meal.vendor ?? "", linkAt: set.linkAt ?? meal.linkAt ?? null });
  });

  /** A family's own part of a group order: "I've added it", "not eating with the team", or undo. */
  r.on("POST", "/teams/{teamId}/events/{eid}/meals/{mid}/my-order", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.requireFeature("meals");
    const { pid, state } = parseBody(myOrderSchema, body);
    if (!a.isParentOf(pid) && !a.can("meals")) throw forbidden("You can only answer for your own family.");
    const key = keys.meal(a.teamId, checkId(params.eid, "event"), checkId(params.mid, "meal"));
    if (!(await getItem(key))) throw notFound("That meal doesn't exist.");
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: key,
      UpdateExpression: "SET orders = if_not_exists(orders, :empty)",
      ExpressionAttributeValues: { ":empty": {} }
    }));
    await ddb.send(new UpdateCommand(state
      ? { TableName: TABLE, Key: key, UpdateExpression: "SET orders.#p = :v", ExpressionAttributeNames: { "#p": pid }, ExpressionAttributeValues: { ":v": { state, at: now(), by: caller.sub } } }
      : { TableName: TABLE, Key: key, UpdateExpression: "REMOVE orders.#p", ExpressionAttributeNames: { "#p": pid } }));
    return json(200, { pid, state });
  });
}

export { datesOf, defaultDayType };
