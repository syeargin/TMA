import { z } from "zod";
import { keys } from "../../lib/keys.js";
import * as F from "../../lib/feedback.js";
import { dispatch, queueEmail } from "../../lib/mail/outbox.js";
import { siteUrl } from "../../lib/mail/invite-mail.js";
import { rolePhrase } from "../../lib/mail/templates.js";
import { clubOfTeam, getClub } from "../../lib/clubs.js";
import { verifiedEmail } from "../../lib/identity.js";
import { requirePlatformAdmin } from "../context.js";
import { badRequest, conflict, forbidden, json, notFound, parseBody, type HttpError } from "../http.js";
import type { Router } from "../router.js";
import { getItem, ID, newId, now, queryAll } from "../util.js";

/**
 * Questions & feedback (lib/feedback.ts): send one (signed in, or signed out from the sign-in page),
 * see your own, and the site owners' inbox with replies by email.
 */

const SHOT = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_SHOT = 360_000;
const line = (max: number) => z.string().trim().max(max);
const base = z.object({
  kind: z.enum(F.KINDS),
  to: z.enum(["team", "teemhub"]).optional(),
  teamId: z.string().regex(ID).optional(),
  message: z.string().trim().min(5, "Write a little more so we can help.").max(4000, "That's too long. Keep it under 4,000 characters."),
  page: z.object({ path: line(300), title: line(120) }).optional(),
  error: z.object({ code: line(60), message: line(300), at: line(40) }).optional(),
  device: line(160).optional(),
  version: line(40).optional(),
  screenshot: z.string().max(MAX_SHOT + 40, "That screenshot is too big. Try a smaller one.").optional()
});
const signedOut = base.extend({
  email: z.string().trim().toLowerCase().email("Enter your email so we can reply.").max(200),
  name: line(80).optional(),
  /** Left empty by people; bots fill it in. */
  website: z.string().max(200).optional()
});

function shotOf(raw?: string): { mime: string; data: string } | undefined {
  if (!raw) return undefined;
  const m = SHOT.exec(raw);
  if (!m || m[2].length > MAX_SHOT) throw badRequest("The screenshot must be a picture (JPEG, PNG or WebP) under about 250 KB.");
  return { mime: m[1], data: m[2] };
}

const where = (f: F.Feedback) => [f.teamName, f.roles?.length ? f.roles.join(", ") : "", f.page?.title, f.device].filter(Boolean).join(" · ") || "Signed out";

/** Tells site owners: anything for Teem Hub, and team questions to those who asked for copies. */
async function notifyOwners(f: F.Feedback) {
  const ids: string[] = [];
  for (const o of await F.owners()) {
    if (!o.settings.emailNew || (f.route === "team" && !o.settings.teamQuestions) || o.sub === f.sub) continue;
    const { id, queued } = await queueEmail({
      msg: "feedbackNew", to: o.email, dedupe: `fb:${f.id}:owner:${o.sub}`,
      data: { ref: f.ref, kind: f.kind, route: f.route, id: f.id, fromName: f.name, fromEmail: f.email, where: where(f), message: f.message, error: f.error ? `${f.error.message} (${f.error.code})` : undefined, shot: f.hasShot, siteUrl: siteUrl() }
    });
    if (queued) ids.push(id);
  }
  return ids;
}

/** The team's coordinators (or its admins, if it has no coordinator), not counting the sender. */
async function coordinators(teamId: string, sender: string) {
  const rows = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :m)", ExpressionAttributeValues: { ":p": `TEAM#${teamId}`, ":m": "MEMBER#" } });
  const active = rows.filter((r) => r.status === "active" && r.email && String(r.SK).slice(7) !== sender);
  const has = (r: Record<string, unknown>, role: string) => ((r.roles as string[] | undefined) ?? []).includes(role);
  const coord = active.filter((r) => has(r, "coordinator"));
  return (coord.length ? coord : active.filter((r) => has(r, "admin"))).map((r) => ({ email: String(r.email), name: [r.firstName, r.lastName].filter(Boolean).join(" ") || String(r.email) }));
}

async function send(f: F.Feedback, shot?: { mime: string; data: string }, recipients: { email: string; name: string }[] = [], team?: { colors?: { primary?: string; accent?: string }; fromRole: string }) {
  await F.save(f, shot);
  const ids: string[] = [];
  for (const r of recipients) {
    const { id, queued } = await queueEmail({
      msg: "teamQuestion", to: r.email, dedupe: `fb:${f.id}:${r.email}`, replyTo: f.email, teamId: f.teamId, clubId: f.clubId, by: f.sub,
      data: { ref: f.ref, teamName: f.teamName ?? "", teamId: f.teamId ?? "", colors: team?.colors, fromName: f.name, fromEmail: f.email, fromRole: team?.fromRole ?? "a member", message: f.message, page: f.page?.title, siteUrl: siteUrl() }
    });
    if (queued) ids.push(id);
  }
  ids.push(...(await notifyOwners(f)));
  await dispatch(ids);
}

const tooMany = () => conflict("You've sent a lot today. Try again tomorrow, or email support@teemhub.net.", "too_many") as HttpError;

/** What the sender sees of their own message. */
const mineView = (f: F.Feedback) => ({
  id: f.id, ref: f.ref, kind: f.kind, route: f.route, status: f.status, message: f.message, teamName: f.teamName ?? null,
  sentTo: f.sentTo ?? [], createdAt: f.createdAt, replies: (f.replies ?? []).map((r) => ({ at: r.at, byName: r.byName, message: r.message }))
});

export function feedbackRoutes(r: Router) {
  r.on("POST", "/feedback", async ({ caller, body, event }) => {
    const b = parseBody(base, body);
    const shot = shotOf(b.screenshot);
    const profile = await getItem(keys.profile(caller.sub));
    // Replies go only to a verified address: the profile's, or the sign-in service's (as /me checks it).
    const email = String(profile?.email ?? "") || await verifiedEmail(caller.username || caller.sub, String(event.requestContext.authorizer?.jwt?.claims?.email ?? ""));
    if (!email) throw badRequest("Your account has no verified email for a reply. Email support@teemhub.net instead.");
    if (!(await F.underLimit(caller.sub))) throw tooMany();
    const name = [profile?.firstName, profile?.lastName].filter(Boolean).join(" ") || email;

    // The team it's about: only one you're on.
    let team: { teamId: string; teamName: string; clubId: string; roles: string[]; pid: string } | undefined;
    if (b.teamId) {
      const m = await getItem(keys.member(b.teamId, caller.sub));
      if (m?.status === "active") {
        const settings = await getItem(keys.settings(b.teamId));
        team = { teamId: b.teamId, teamName: String(settings?.teamName ?? b.teamId), clubId: await clubOfTeam(b.teamId), roles: (m.roles as string[]) ?? [], pid: String(m.pid ?? "") };
      }
    }
    const route: F.Route = b.kind === "question" && b.to === "team" ? "team" : "teemhub";
    if (route === "team" && !team) throw forbidden("You can only ask the coordinators of a team you're on.");

    let recipients: { email: string; name: string }[] = [];
    let extra: { colors?: { primary?: string; accent?: string }; fromRole: string } | undefined;
    if (route === "team" && team) {
      recipients = await coordinators(team.teamId, caller.sub);
      if (!recipients.length) throw conflict("This team doesn't have a coordinator or admin with an email yet. Choose Teem Hub instead.", "no_coordinator");
      const player = team.pid ? await getItem(keys.player(team.teamId, team.pid)) : null;
      const club = await getClub(team.clubId);
      extra = { colors: club?.colors, fromRole: rolePhrase(team.roles, player ? String(player.firstName ?? player.name ?? "") || undefined : undefined) };
    }
    const at = now();
    const f: F.Feedback = {
      id: newId("fb"), ref: await F.nextRef(), kind: b.kind, route, status: route === "team" ? "waiting" : "new", message: b.message,
      sub: caller.sub, email, name,
      ...(team ? { teamId: team.teamId, teamName: team.teamName, clubId: team.clubId, roles: team.roles } : {}),
      ...(b.page ? { page: b.page } : {}), ...(b.error ? { error: b.error } : {}), ...(b.device ? { device: b.device } : {}), ...(b.version ? { version: b.version } : {}),
      hasShot: !!shot, ownerCopy: route !== "team", createdAt: at, updatedAt: at, replies: [],
      ...(route === "team" ? { sentTo: recipients.map((x) => x.name) } : {})
    };
    await send(f, shot, recipients, extra);
    return json(201, { id: f.id, ref: f.ref, route, sentTo: f.sentTo ?? [], email });
  });

  r.on("GET", "/me/feedback", async ({ caller }) => json(200, { items: (await F.mine(caller.sub)).map(mineView) }));

  // ---------- site owners ----------

  r.on("GET", "/admin/feedback", async ({ caller }) => {
    await requirePlatformAdmin(caller, "Only site owners can see feedback.");
    const settings = await F.settingsOf(caller.sub);
    const items = (await F.all()).filter((f) => f.route !== "team" || settings.teamQuestions);
    const t = Date.now();
    const days = (iso: string) => (t - Date.parse(iso)) / 864e5;
    // Problems with the same error in the last two weeks are probably the same thing.
    const byError = new Map<string, string[]>();
    for (const f of items) if (f.kind === "problem" && f.error?.code && days(f.createdAt) <= 14) byError.set(f.error.code, [...(byError.get(f.error.code) ?? []), f.id]);
    const news = items.filter((f) => f.status === "new");
    const answered = items.filter((f) => f.route !== "team" && days(f.createdAt) <= 30 && days(f.createdAt) >= 1);
    const problemsWeek = items.filter((f) => f.kind === "problem" && days(f.createdAt) <= 7);
    const sameError = Math.max(0, ...[...byError.values()].map((v) => v.length));
    return json(200, {
      settings,
      stats: {
        new: news.length, oldestNewAt: news.length ? news[news.length - 1].createdAt : null,
        problemsWeek: problemsWeek.length, sameError: sameError > 1 ? sameError : 0,
        ideas: { open: items.filter((f) => f.kind === "idea" && f.route !== "team" && f.status !== "closed" && f.status !== "planned").length, planned: items.filter((f) => f.kind === "idea" && f.status === "planned").length, closed: items.filter((f) => f.kind === "idea" && f.status === "closed").length },
        repliedInADay: answered.length ? Math.round((100 * answered.filter((f) => f.firstReplyAt && Date.parse(f.firstReplyAt) - Date.parse(f.createdAt) <= 864e5).length) / answered.length) : null
      },
      items: items.map((f) => {
        const { sub: _s, ...rest } = f;
        void _s;
        return { ...rest, similar: f.kind === "problem" && f.error?.code ? (byError.get(f.error.code) ?? []).filter((x) => x !== f.id) : [] };
      })
    });
  });

  // Settings before {id}, so "settings" isn't read as an id.
  r.on("PUT", "/admin/feedback/settings", async ({ caller, body }) => {
    await requirePlatformAdmin(caller, "Only site owners can change this.");
    const s = parseBody(z.object({ teamQuestions: z.boolean(), emailNew: z.boolean() }), body);
    await F.saveSettings(caller.sub, s);
    return json(200, s);
  });

  r.on("GET", "/admin/feedback/{id}/screenshot", async ({ caller, params }) => {
    await requirePlatformAdmin(caller, "Only site owners can see feedback.");
    if (!ID.test(params.id)) throw notFound();
    const shot = await F.shotOf(params.id);
    if (!shot) throw notFound("The screenshot has been deleted (they're kept 60 days).");
    return json(200, { screenshot: shot });
  });

  r.on("PUT", "/admin/feedback/{id}", async ({ caller, params, body }) => {
    await requirePlatformAdmin(caller, "Only site owners can change feedback.");
    const { status } = parseBody(z.object({ status: z.enum(F.STATUSES) }), body);
    if (!ID.test(params.id) || !(await F.get(params.id))) throw notFound();
    await F.update(params.id, { status, updatedAt: now() });
    return json(200, { id: params.id, status });
  });

  r.on("POST", "/admin/feedback/{id}/reply", async ({ caller, params, body }) => {
    await requirePlatformAdmin(caller, "Only site owners can reply.");
    const { message } = parseBody(z.object({ message: z.string().trim().min(2, "Write a reply.").max(4000) }), body);
    const f = ID.test(params.id) ? await F.get(params.id) : null;
    if (!f) throw notFound();
    const me = await getItem(keys.profile(caller.sub));
    const byName = String(me?.firstName ?? "") || "The Teem Hub team";
    const at = now();
    const firstName = f.sub ? String((await getItem(keys.profile(f.sub)))?.firstName ?? "") : f.name.includes("@") ? "" : (f.name.split(" ")[0] ?? "");
    const { id, queued } = await queueEmail({
      msg: "feedbackReply", to: f.email, dedupe: `fb:${f.id}:reply:${at}`, by: caller.sub,
      data: { ref: f.ref, firstName: firstName || undefined, kind: f.kind, original: f.message, reply: message, byName, siteUrl: siteUrl() }
    });
    const replies = [...(f.replies ?? []), { at, by: caller.sub, byName, message }];
    await F.update(f.id, { replies, status: f.status === "planned" ? "planned" : "waiting", updatedAt: at, ...(f.firstReplyAt ? {} : { firstReplyAt: at }) });
    if (queued) await dispatch([id]);
    return json(200, { replies, status: f.status === "planned" ? "planned" : "waiting" });
  });
}

/** Signed out (the sign-in page, "I can't sign in"): always to Teem Hub, with an email to reply to. */
export function feedbackPublicRoutes(r: Router) {
  r.on("POST", "/public/feedback", async ({ body, event }) => {
    const b = parseBody(signedOut, body);
    const shot = shotOf(b.screenshot);
    const at = now();
    // A bot filled in the hidden field: say thanks and keep nothing.
    if (b.website) return json(201, { id: "", ref: "TH-0000", route: "teemhub", sentTo: [], email: b.email });
    const ip = String(event.requestContext?.http?.sourceIp ?? "");
    if (!(await F.underLimit(`email:${b.email}`)) || (ip && !(await F.underLimit(`ip:${ip}`)))) throw tooMany();
    const f: F.Feedback = {
      id: newId("fb"), ref: await F.nextRef(), kind: b.kind, route: "teemhub", status: "new", message: b.message,
      email: b.email, name: b.name || b.email,
      ...(b.page ? { page: b.page } : {}), ...(b.error ? { error: b.error } : {}), ...(b.device ? { device: b.device } : {}), ...(b.version ? { version: b.version } : {}),
      hasShot: !!shot, ownerCopy: true, createdAt: at, updatedAt: at, replies: []
    };
    await send(f, shot);
    return json(201, { id: f.id, ref: f.ref, route: "teemhub", sentTo: [], email: f.email });
  });
}
