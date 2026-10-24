/**
 * Messaging M2: a team's Communications page (which scheduled emails go out, when, to whom, and the
 * next two weeks of sends), each person's own notification settings, and one-click unsubscribe.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { loadTeam, recipients, type Member } from "../../lib/comms/content.js";
import { commsKey, getComms, occurrences, prepare, scheduleText, SCHEDULED, zoneOf } from "../../lib/comms/planner.js";
import { readUnsub } from "../../lib/comms/tokens.js";
import { validTimeZone } from "../../lib/comms/zoned.js";
import { dispatch, queueEmail } from "../../lib/mail/outbox.js";
import { render } from "../../lib/mail/templates.js";
import { CONFIG, effective, MESSAGES, type MessageId, type TeamComms } from "../../shared/messages.js";
import { loadAccess } from "../context.js";
import { badRequest, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, date, getItem, now, putItem, queryAll } from "../util.js";

const scheduled = z.enum(["weekly", "staffDigest"]);
const msgSettings = z.object({
  on: z.boolean().optional(),
  day: z.number().int().min(0).max(6).optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/, "use a time like 18:00").optional(),
  audience: z.record(z.boolean()).optional(),
  rules: z.record(z.boolean()).optional()
});
const commsSchema = z.object({
  messages: z.record(scheduled, msgSettings).default({}),
  timeZone: z.string().max(60).refine(validTimeZone, "That isn't a time zone.").optional(),
  pauseUntil: date.nullable().optional()
});
const skipSchema = z.object({ key: z.string().regex(/^(weekly|staffDigest):\d{4}-\d{2}-\d{2}$/), skip: z.boolean() });
const OPTIONAL = (Object.keys(MESSAGES) as MessageId[]).filter((m) => !MESSAGES[m].required);
const prefsSchema = z.object({ off: z.array(z.enum(["all", ...OPTIONAL] as [string, ...string[]])).max(30).transform((a) => [...new Set(a)]) });

/** Keeps only the audience and rule keys the catalog knows. */
function tidy(messages: Record<string, z.infer<typeof msgSettings>>) {
  const out: Record<string, unknown> = {};
  for (const [msg, s] of Object.entries(messages)) {
    const c = CONFIG[msg as MessageId]!;
    const pick = (rec: Record<string, boolean> | undefined, allowed: string[]) =>
      rec ? Object.fromEntries(Object.entries(rec).filter(([k]) => allowed.includes(k))) : undefined;
    out[msg] = { ...s, audience: pick(s.audience, c.audience.map((a) => a.key)), rules: pick(s.rules, c.rules.map((r) => r.key)) };
  }
  return out;
}

/** A stand-in recipient for previews and tests: the first family, or a staff member with every included role. */
function sampleMember(t: Awaited<ReturnType<typeof loadTeam>>, msg: "weekly" | "staffDigest", c: TeamComms | null): Member | null {
  if (msg === "weekly") {
    const p = t.players[0];
    return p ? { sub: "preview", roles: ["parent"], pid: String(p.pid), email: "", firstName: "", notifyOff: [] } : null;
  }
  const e = effective("staffDigest", c)!;
  return { sub: "preview", roles: Object.keys(e.audience).filter((r) => e.audience[r]), pid: "", email: "", firstName: "", notifyOff: [] };
}

export function commsRoutes(r: Router) {
  r.on("GET", "/teams/{teamId}/comms", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("settings");
    const c = await getComms(a.teamId);
    const t = await loadTeam(a.teamId, a.clubId);
    const messages = SCHEDULED.map((msg) => {
      const e = effective(msg, c)!;
      return { id: msg, ...MESSAGES[msg], config: CONFIG[msg], settings: e, schedule: scheduleText(msg, c), reach: recipients(t, msg, e.audience).length };
    });
    const upcoming = occurrences(c, new Date(), 14).map((o) => {
      const e = effective(o.msg, c)!;
      return { key: o.key, msg: o.msg, label: MESSAGES[o.msg].label, date: o.date, sendAt: o.sendAt.toISOString(), skipped: o.skipped, paused: o.paused, reach: recipients(t, o.msg, e.audience).length };
    }).filter((o) => new Date(o.sendAt).getTime() > Date.now());
    return json(200, {
      timeZone: zoneOf(c), pauseUntil: c?.pauseUntil ?? null, messages, upcoming,
      catalog: (Object.keys(MESSAGES) as MessageId[]).map((id) => ({ id, ...MESSAGES[id] }))
    });
  });

  r.on("PUT", "/teams/{teamId}/comms", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("settings");
    const b = parseBody(commsSchema, body);
    const cur = (await getComms(a.teamId)) ?? {};
    const messages = { ...(cur.messages ?? {}), ...tidy(b.messages) };
    await putItem({
      ...commsKey(a.teamId), type: "Comms", messages,
      timeZone: b.timeZone ?? cur.timeZone, pauseUntil: b.pauseUntil === undefined ? cur.pauseUntil : b.pauseUntil ?? undefined,
      skipped: (cur.skipped ?? []).slice(-60), updatedAt: now(), updatedBy: caller.sub
    });
    console.log(JSON.stringify({ msg: "comms settings", teamId: a.teamId, by: caller.sub }));
    return json(200, { ok: true });
  });

  /** Skip (or un-skip) one send without turning the message off. */
  r.on("PUT", "/teams/{teamId}/comms/skip", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("settings");
    const b = parseBody(skipSchema, body);
    const cur = (await getComms(a.teamId)) ?? {};
    const skipped = new Set(cur.skipped ?? []);
    if (b.skip) skipped.add(b.key); else skipped.delete(b.key);
    await putItem({ ...commsKey(a.teamId), type: "Comms", ...cur, skipped: [...skipped].slice(-60), updatedAt: now(), updatedBy: caller.sub });
    return json(200, { key: b.key, skipped: b.skip });
  });

  /** This week's email as one family (or one staff member) would get it, from the team's real records. */
  for (const action of ["preview", "test"] as const) {
    r.on(action === "preview" ? "GET" : "POST", `/teams/{teamId}/comms/{msg}/${action}`, async ({ caller, params }) => {
      const a = await loadAccess(caller, checkId(params.teamId, "team"));
      a.require("settings");
      const msg = scheduled.safeParse(params.msg);
      if (!msg.success) throw notFound("There's no scheduled message with that name.");
      const c = await getComms(a.teamId);
      const t = await loadTeam(a.teamId, a.clubId);
      const m = sampleMember(t, msg.data, c);
      if (!m) throw badRequest("Add a player first: the weekly email is written for one family.");
      const next = occurrences({ ...c, messages: { ...c?.messages, [msg.data]: { ...c?.messages?.[msg.data], on: true } } }, new Date(), 8)
        .find((o) => o.msg === msg.data);
      const day = next?.date ?? new Date().toISOString().slice(0, 10);
      const team = { ...t, members: [m] };
      const [p] = await prepare(team, { ...c, messages: { ...c?.messages, [msg.data]: { ...c?.messages?.[msg.data], audience: msg.data === "weekly" ? { parent: true } : undefined } } }, msg.data, day);
      if (!p) throw badRequest("There's nobody this email would go to.");
      const data = { ...p.data, unsubscribeUrl: undefined, firstName: undefined };
      if (action === "preview") {
        const out = render(msg.data, data as never);
        return json(200, { ...out, empty: p.empty, sendDate: day, family: msg.data === "weekly" ? String(t.players[0]?.first ?? "") : "" });
      }
      const profile = await getItem(keys.profile(caller.sub));
      const to = String(profile?.email ?? "");
      if (!to) throw badRequest("Your account has no email address to send to.");
      const { id } = await queueEmail({ msg: msg.data, to, by: caller.sub, teamId: a.teamId, dedupe: `test:${msg.data}:${a.teamId}:${caller.sub}:${Date.now()}`, data: data as never });
      await dispatch([id]);
      return json(202, { to });
    });
  }

  // ---------- each person's own settings ----------

  r.on("GET", "/me/notifications", async ({ caller }) => {
    const mine = (await queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :t)", ExpressionAttributeValues: { ":u": `USER#${caller.sub}`, ":t": "TEAM#" } }))
      .filter((m) => m.status === "active");
    const teams = [];
    for (const m of mine) {
      const teamId = String(m.GSI1SK).slice(5);
      const settings = await getItem(keys.settings(teamId));
      const roles = (m.roles as string[]) ?? [];
      const staff = roles.some((r) => r !== "parent");
      const c = await getComms(teamId);
      const options = SCHEDULED.filter((msg) => msg === "weekly" || staff).map((msg) => ({
        id: msg, label: MESSAGES[msg].label, help: MESSAGES[msg].help,
        teamSends: effective(msg, c)!.on, schedule: scheduleText(msg, c)
      }));
      teams.push({ teamId, teamName: String(settings?.teamName ?? teamId), roles, off: (m.notifyOff as string[]) ?? [], options });
    }
    return json(200, { teams });
  });

  r.on("PUT", "/me/notifications/{teamId}", async ({ caller, params, body }) => {
    const teamId = checkId(params.teamId, "team");
    const { off } = parseBody(prefsSchema, body);
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: keys.member(teamId, caller.sub), ConditionExpression: "attribute_exists(PK) AND #s = :a",
        UpdateExpression: "SET notifyOff = :o, notifyAt = :t", ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":o": off, ":t": now(), ":a": "active" }
      }));
    } catch (e) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") throw notFound("You aren't on that team.");
      throw e;
    }
    return json(200, { teamId, off });
  });
}

/**
 * Routes that need no sign-in: the unsubscribe link in an email (the site's /unsubscribe page) and the
 * one-click unsubscribe that mail apps send on their own (RFC 8058, a POST to the List-Unsubscribe URL).
 */
export function publicRoutes(r: Router) {
  r.on("POST", "/public/unsubscribe", async ({ body, event }) => {
    let token = new URLSearchParams(event.rawQueryString ?? "").get("t") ?? "";
    let undo = false;
    if (body && body.trim().startsWith("{")) {
      try { const j = JSON.parse(body); token = String(j.t ?? token); undo = j.undo === true; } catch { /* form body from a mail app */ }
    }
    const u = await readUnsub(token);
    if (!u) throw badRequest("That link isn't valid. Change what you get from Notification settings on your account page instead.");
    const member = await getItem(keys.member(u.teamId, u.sub));
    if (!member || member.status !== "active") throw notFound("You're no longer on that team, so you won't get its emails.");
    const off = new Set((member.notifyOff as string[] | undefined) ?? []);
    if (undo) off.delete(u.msg); else off.add(u.msg);
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.member(u.teamId, u.sub),
      UpdateExpression: "SET notifyOff = :o, notifyAt = :t", ExpressionAttributeValues: { ":o": [...off], ":t": now() }
    }));
    const settings = await getItem(keys.settings(u.teamId));
    console.log(JSON.stringify({ msg: undo ? "resubscribed" : "unsubscribed", teamId: u.teamId, sub: u.sub, message: u.msg }));
    return json(200, { teamName: String(settings?.teamName ?? u.teamId), message: MESSAGES[u.msg as MessageId]?.label ?? u.msg, off: !undo });
  });
}
