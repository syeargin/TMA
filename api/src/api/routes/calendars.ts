import { z } from "zod";
import { keys } from "../../lib/keys.js";
import { CAL_TYPES, byToken, feedIcs, noteFetch, resetSub, saveSub, stopSub, subKey, type CalSub, type CalType, type FeedTeam } from "../../lib/calendar-feed.js";
import { loadTeam } from "../../lib/comms/content.js";
import { getComms, zoneOf } from "../../lib/comms/planner.js";
import { clubOfTeam } from "../../lib/clubs.js";
import { siteUrl } from "../../lib/mail/invite-mail.js";
import { badRequest, forbidden, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { getItem, ID, now, queryAll } from "../util.js";

/**
 * Calendar links (lib/calendar-feed.ts): each person's own links, and the feed a calendar app checks.
 * The feed's link is private, so it is never logged: the token rides in the query string, which
 * neither the request log nor API Gateway's access log records.
 */

const APPS = ["apple", "google", "outlook", "office", "copy", "download"] as const;
const types = z.array(z.enum(CAL_TYPES)).max(3).transform((t) => CAL_TYPES.filter((x) => t.includes(x)));
const teamBody = z.object({ types: types.refine((t) => t.length > 0, "Pick at least one kind of event."), app: z.enum(APPS).optional() });
const allBody = z.object({ teams: z.record(z.string().regex(ID), types), app: z.enum(APPS).optional() });

const isMember = async (teamId: string, sub: string) => (await getItem(keys.member(teamId, sub)))?.status === "active";

/** What the site shows about a link. The token comes back only to its owner, who builds the link from it. */
const view = (s: CalSub) => ({
  scope: s.scope, teamId: s.teamId, types: s.types, teams: s.teams, app: s.app ?? null, token: s.token,
  createdAt: s.createdAt, updatedAt: s.updatedAt, lastFetchAt: s.lastFetchAt ?? null
});

function which(params: Record<string, string>): string {
  if (params.teamId === undefined) return subKey("all");
  if (!ID.test(params.teamId)) throw notFound();
  return subKey("team", params.teamId);
}

export function calendarRoutes(r: Router) {
  r.on("GET", "/me/calendars", async ({ caller }) => {
    const rows = await queryAll({ KeyConditionExpression: "PK = :p AND begins_with(SK, :c)", ExpressionAttributeValues: { ":p": `USER#${caller.sub}`, ":c": "CAL#" } });
    return json(200, { links: rows.map((x) => view(x as unknown as CalSub)) });
  });

  r.on("PUT", "/me/calendars/teams/{teamId}", async ({ caller, params, body }) => {
    if (!ID.test(params.teamId)) throw notFound();
    const b = parseBody(teamBody, body);
    if (!(await isMember(params.teamId, caller.sub))) throw forbidden("You're not on that team.");
    return json(200, view(await saveSub(caller.sub, { scope: "team", teamId: params.teamId, types: b.types, app: b.app }, now())));
  });

  r.on("PUT", "/me/calendars/all", async ({ caller, body }) => {
    const b = parseBody(allBody, body);
    const teams = Object.fromEntries(Object.entries(b.teams).filter(([, t]) => t.length));
    if (!Object.keys(teams).length) throw badRequest("Pick at least one team.");
    if (Object.keys(teams).length > 30) throw badRequest("That's too many teams for one calendar.");
    for (const t of Object.keys(teams)) if (!(await isMember(t, caller.sub))) throw forbidden("You're not on one of those teams.");
    return json(200, view(await saveSub(caller.sub, { scope: "all", teams, app: b.app }, now())));
  });

  for (const path of ["/me/calendars/all", "/me/calendars/teams/{teamId}"]) {
    /** A new link, for one shared by mistake: the old link stops working at once. */
    r.on("POST", `${path}/reset`, async ({ caller, params }) => {
      const s = await resetSub(caller.sub, which(params), now());
      if (!s) throw notFound("There's no calendar link to reset.");
      return json(200, view(s));
    });
    /** Stop the link: the calendar app finds nothing there, and the events leave that calendar. */
    r.on("DELETE", path, async ({ caller, params }) => {
      await stopSub(caller.sub, which(params));
      return json(204, undefined);
    });
  }
}

const ics = (status: number, body: string, head = false) => ({
  statusCode: status,
  headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=900", "content-disposition": 'inline; filename="teem-hub.ics"', "x-robots-tag": "noindex" },
  body: head ? "" : body
});

/** The calendar for one link. Each team is checked every time: someone who leaves a team stops getting its dates. */
export async function feedFor(sub: string, s: CalSub, at = new Date()): Promise<string> {
  const wanted: [string, CalType[]][] = s.scope === "team" && s.teamId ? [[s.teamId, s.types ?? [...CAL_TYPES]]] : Object.entries(s.teams ?? {});
  const teams: FeedTeam[] = [];
  for (const [teamId, t] of wanted) {
    if (!ID.test(teamId) || !(await isMember(teamId, sub))) continue;
    const [team, comms] = await Promise.all([loadTeam(teamId, await clubOfTeam(teamId)), getComms(teamId)]);
    if (!team.members.some((m) => m.sub === sub)) continue;
    teams.push({ team, zone: zoneOf(comms), types: t.filter((x) => CAL_TYPES.includes(x)), prefix: s.scope === "all" });
  }
  const name = s.scope === "all" ? "My teams (Teem Hub)" : `${teams[0]?.team.teamName ?? "Team"} (Teem Hub)`;
  return feedIcs(name, teams, siteUrl(), at);
}

export function calendarPublicRoutes(r: Router) {
  for (const method of ["GET", "HEAD"]) {
    r.on(method, "/public/calendar.ics", async ({ event }) => {
      const token = String(event.queryStringParameters?.k ?? "");
      const found = token ? await byToken(token) : null;
      if (!found) return { statusCode: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" }, body: "This calendar link has been stopped or reset. Add the calendar again from Teem Hub." };
      const body = await feedFor(found.sub, found.s);
      await noteFetch(found.sub, found.s);
      return ics(200, body, method === "HEAD");
    });
  }
}

