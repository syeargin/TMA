/**
 * Messaging M2: a team's Communications page (which scheduled emails go out, when, to whom, and the
 * next two weeks of sends), each person's own notification settings, and one-click unsubscribe.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { loadTeam, recipients, type Member } from "../../lib/comms/content.js";
import { commsKey, getComms, occurrences, prepare, scheduleText, sends, SETTABLE, zoneOf, type Planned } from "../../lib/comms/planner.js";
import { audienceFor, targets } from "../../lib/comms/reminders.js";
import { readAnswer, readUnsub } from "../../lib/comms/tokens.js";
import { addDays, shortDate } from "../../lib/comms/schedule.js";
import { localParts } from "../../lib/comms/zoned.js";
import { samples } from "../../lib/mail/reminder-mail.js";
import { siteUrl } from "../../lib/mail/invite-mail.js";
import { NEEDS_FEATURE } from "../../shared/messages.js";
import { assertTeamWritable } from "../context.js";
import { clubOfTeam } from "../../lib/clubs.js";
import { validTimeZone } from "../../lib/comms/zoned.js";
import { dispatch, queueEmail } from "../../lib/mail/outbox.js";
import { completeFollow } from "../../lib/mail/stats.js";
import { allows } from "../../lib/club-controls.js";
import { attentionCount, teamHealth } from "../../lib/mail/health.js";
import { render } from "../../lib/mail/templates.js";
import { CONFIG, effective, MESSAGES, type MessageId, type TeamComms } from "../../shared/messages.js";
import { isOn } from "../../shared/features.js";
import { loadAccess } from "../context.js";
import { badRequest, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, date, getItem, now, putItem, queryAll } from "../util.js";

const settable = z.enum(SETTABLE as [string, ...string[]]);
const msgSettings = z.object({
  on: z.boolean().optional(),
  day: z.number().int().min(0).max(6).optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/, "use a time like 18:00").optional(),
  days: z.number().int().min(1).max(14).optional(),
  audience: z.record(z.boolean()).optional(),
  rules: z.record(z.boolean()).optional()
});
const commsSchema = z.object({
  messages: z.record(settable, msgSettings).default({}),
  timeZone: z.string().max(60).refine(validTimeZone, "That isn't a time zone.").optional(),
  pauseUntil: date.nullable().optional()
});
const skipSchema = z.object({ key: z.string().max(120).regex(/^(weekly|staffDigest|packet|availability|dues|dues-late):[A-Za-z0-9_.:-]+$/), skip: z.boolean() });
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
function sampleMember(t: Awaited<ReturnType<typeof loadTeam>>, msg: string, c: TeamComms | null): Member | null {
  if (msg === "staffDigest") {
    const e = effective("staffDigest", c)!;
    return { sub: "preview", roles: Object.keys(e.audience).filter((r) => e.audience[r]), pid: "", email: "", firstName: "", notifyOff: [] };
  }
  // A family: the first player who still owes dues, for the dues reminder; otherwise the first player.
  const p = (msg === "dues" ? t.players.find((x) => duesOwedSafe(t, String(x.pid))) : undefined) ?? t.players[0];
  return p ? { sub: "preview", roles: ["parent"], pid: String(p.pid), email: "", firstName: "", notifyOff: [] } : null;
}
const duesOwedSafe = (t: Awaited<ReturnType<typeof loadTeam>>, pid: string) => {
  const amount = Number((t.settings.dues as Record<string, unknown> | undefined)?.amountCents ?? 0);
  const paid = t.ledger.filter((l) => l.kind === "in" && l.cat === "Dues" && l.pid === pid && l.status !== "declined").reduce((n, l) => n + Number(l.amountCents ?? 0), 0);
  return amount > paid;
};

/** How many people a message reaches as saved. */
function reachOf(t: Awaited<ReturnType<typeof loadTeam>>, msg: string, e: NonNullable<ReturnType<typeof effective>>): number {
  if (msg === "weekly" || msg === "staffDigest") return recipients(t, msg, e.audience).length;
  if (msg === "availability" || msg === "dues") return audienceFor(t, msg, { parent: e.audience.parent }).length;
  if (msg === "payment") return t.members.filter((m) => !m.notifyOff.includes(msg)).length;
  return audienceFor(t, msg, e.audience).length;
}

export function commsRoutes(r: Router) {
  r.on("GET", "/teams/{teamId}/comms", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("settings");
    const c = await getComms(a.teamId);
    const t = await loadTeam(a.teamId, a.clubId);
    const messages = SETTABLE.map((msg) => {
      const e = effective(msg, c)!;
      const feature = NEEDS_FEATURE[msg];
      return {
        id: msg, ...MESSAGES[msg], config: CONFIG[msg], settings: e, schedule: scheduleText(msg, c), reach: reachOf(t, msg, e),
        ...(feature && !isOn(t.features, feature) ? { featureOff: feature } : {})
      };
    });
    const upcoming = occurrences(c, new Date(), 14, t).map((o) => ({
      key: o.key, msg: o.msg, label: o.label, date: o.date, sendAt: o.sendAt.toISOString(), skipped: o.skipped, paused: o.paused,
      reach: reachOf(t, o.msg, effective(o.msg, c)!)
    })).filter((o) => new Date(o.sendAt).getTime() > Date.now());
    return json(200, {
      // False when the club is inactive or doesn't include Team emails: nothing on this page is sent.
      clubEmail: a.club.status === "active" && allows(a.club, "email"),
      timeZone: zoneOf(c), pauseUntil: c?.pauseUntil ?? null, messages, upcoming,
      catalog: (Object.keys(MESSAGES) as MessageId[]).map((id) => ({ id, ...MESSAGES[id] }))
    });
  });

  /** Delivery health (Messaging M3): the last 30 days of this team's email, and who it isn't reaching. */
  r.on("GET", "/teams/{teamId}/comms/health", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("settings");
    const [c, t] = await Promise.all([getComms(a.teamId), loadTeam(a.teamId, a.clubId)]);
    const h = await teamHealth(t, c);
    return json(200, { ...h, count: attentionCount(h) });
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
      const parsed = settable.safeParse(params.msg);
      if (!parsed.success) throw notFound("There's no message with that name.");
      const msg = parsed.data as Planned | "payment" | "announcement";
      const c = await getComms(a.teamId);
      const t = await loadTeam(a.teamId, a.clubId);
      let data: Record<string, unknown>;
      let empty = false, sendDate = "", family = "";
      const base = { teamName: t.teamName, teamId: t.teamId, clubName: t.club?.name, colors: t.club?.colors, siteUrl: siteUrl(), schedule: scheduleText(msg, c) };
      if (msg === "payment" || msg === "announcement") {
        // Made-up details in the team's name and colors: these go out when something happens.
        const latest = msg === "announcement" ? [...t.announcements].sort((x, y) => String(y.at ?? "").localeCompare(String(x.at ?? "")))[0] : undefined;
        data = { ...samples[msg](siteUrl()), ...base, ...(latest ? { text: String(latest.text ?? ""), pinned: !!latest.pinned } : {}) };
      } else {
        const m = sampleMember(t, msg, c);
        if (!m) throw badRequest("Add a player first: this email is written for one family.");
        // The next send, as if the message were on.
        const on = { ...c, messages: { ...c?.messages, [msg]: { ...c?.messages?.[msg], on: true } } } as TeamComms;
        const horizon = msg === "dues" ? 120 : msg === "packet" ? 60 : 14;
        const next = occurrences(on, new Date(), horizon, t).find((o) => o.msg === msg);
        if (!next && msg !== "weekly" && msg !== "staffDigest") {
          throw badRequest(msg === "packet" ? "There's no tournament coming up to make a packet for." : msg === "dues" ? "Set a dues amount and due date in team settings first." : "Nothing is coming up that takes an answer.");
        }
        sendDate = next?.date ?? localParts(new Date(), zoneOf(c)).date;
        const [p] = await prepare({ ...t, members: [m] }, on, { msg, date: sendDate, target: next?.target }, [m]);
        if (!p) throw badRequest(msg === "dues" ? "Every family has paid, so nobody would get a dues reminder." : "There's nobody this email would go to.");
        data = { ...p.data, unsubscribeUrl: undefined, firstName: undefined };
        empty = p.empty;
        family = String(t.players.find((x) => x.pid === m.pid)?.first ?? "");
      }
      if (action === "preview") {
        const out = render(msg, data as never);
        return json(200, { ...out, empty, sendDate, family });
      }
      const profile = await getItem(keys.profile(caller.sub));
      const to = String(profile?.email ?? "");
      if (!to) throw badRequest("Your account has no email address to send to.");
      const { id } = await queueEmail({ msg, to, by: caller.sub, teamId: a.teamId, dedupe: `test:${msg}:${a.teamId}:${caller.sub}:${Date.now()}`, data: data as never });
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
      const parent = roles.includes("parent");
      const forMe = SETTABLE.filter((msg) => (msg === "staffDigest" ? staff : msg === "availability" || msg === "dues" ? parent : true));
      const options = forMe.map((msg) => ({
        id: msg, label: MESSAGES[msg].label, help: MESSAGES[msg].help,
        teamSends: sends(msg, c), schedule: scheduleText(msg, c)
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
  /**
   * One-tap answers from the availability reminder (the site's /answer page). With peek it only says
   * what the link would record; without, it records it. Only the family's own parent's link works, only
   * for that player and that date, and only until the day after.
   */
  r.on("POST", "/public/answer", async ({ body }) => {
    const b = parseBody(z.object({ t: z.string().max(800), peek: z.boolean().default(false) }), body);
    const a = await readAnswer(b.t);
    if (a === "expired") throw badRequest("That link has expired: the date has passed. Open the schedule to see what's next.");
    if (!a) throw badRequest("That link isn't valid. Answer on the team's schedule instead.");
    const member = await getItem(keys.member(a.teamId, a.sub));
    if (!member || member.status !== "active" || member.pid !== a.pid || !((member.roles as string[]) ?? []).includes("parent")) {
      throw notFound("That link no longer works for your account. Answer on the team's schedule instead.");
    }
    const t = await loadTeam(a.teamId, await clubOfTeam(a.teamId));
    const item = t.items.find((i) => i.key === a.key);
    if (!item) throw notFound("That date isn't on the schedule any more.");
    if (item.cancelled) throw badRequest("That date was cancelled, so there's nothing to answer.");
    const player = t.players.find((p) => p.pid === a.pid);
    const current = ((t.family[a.pid]?.rsvp as Record<string, { v?: string }> | undefined) ?? {})[a.key]?.v ?? "";
    const about = { teamId: a.teamId, teamName: t.teamName, player: String(player?.first ?? ""), title: item.title, date: shortDate(item.date), time: item.time, answer: a.v, current };
    if (b.peek) return json(200, { ...about, recorded: false });
    await assertTeamWritable(a.teamId);
    const key = keys.family(a.teamId, a.pid);
    try {
      await ddb.send(new UpdateCommand({ TableName: TABLE, Key: key, ConditionExpression: "attribute_not_exists(PK)", UpdateExpression: "SET #t = :f, pid = :p, rsvp = :e, travel = :e, uniform = :e", ExpressionAttributeNames: { "#t": "type" }, ExpressionAttributeValues: { ":f": "Family", ":p": a.pid, ":e": {} } }));
    } catch (e) {
      if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
    }
    const at = now();
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: key, UpdateExpression: "SET rsvp.#k = :v, updatedAt = :at, updatedBy = :by",
      ExpressionAttributeNames: { "#k": a.key }, ExpressionAttributeValues: { ":v": { v: a.v, at, by: a.sub, via: "email" }, ":at": at, ":by": a.sub }
    }));
    console.log(JSON.stringify({ msg: "answered from email", teamId: a.teamId, sub: a.sub, key: a.key }));
    await completeFollow(a.teamId, "availability", a.pid, [a.key]);
    return json(200, { ...about, current: a.v, recorded: true });
  });

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
