/**
 * The help guide's counts: which topics people open, and how often searches find nothing. Counts only:
 * no one's id, address or search words are kept. One row per month, role and topic:
 * HELP#<yyyy-mm> / VIEW#<role>#<topic> { n }, plus OPEN#<via>, SEARCH and MISS (searches with no results).
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { HELP_IDS, HELP_ROLES, HELP_TOPICS, HELP_VIA, POPULAR_MIN_VIEWS, STARTER_PICKS, type HelpRole } from "../../shared/help.js";
import { requirePlatformAdmin } from "../context.js";
import { badRequest, json } from "../http.js";
import type { Router } from "../router.js";
import { queryAll } from "../util.js";

const MONTHS = 3;
const PICKS = 5;
const ROLE_OR_NONE = [...HELP_ROLES, "none"] as const;
type RoleOrNone = (typeof ROLE_OR_NONE)[number];

const month = (at: Date, back = 0) => { const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - back, 1)); return d.toISOString().slice(0, 7); };
/** Kept for 13 months, so a year back is always there. */
const ttlFor = (at: Date) => Math.floor(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 13, 1) / 1000);

async function add(at: Date, sk: string) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: `HELP#${month(at)}`, SK: sk },
    UpdateExpression: "ADD n :one SET #t = if_not_exists(#t, :type), #ttl = if_not_exists(#ttl, :ttl)",
    ExpressionAttributeNames: { "#t": "type", "#ttl": "ttl" },
    ExpressionAttributeValues: { ":one": 1, ":type": "HelpCount", ":ttl": ttlFor(at) }
  }));
}

/** Rows of the last few months, added up by SK. */
async function recent(at = new Date(), months = MONTHS): Promise<Map<string, number>> {
  const parts = await Promise.all(Array.from({ length: months }, (_, i) =>
    queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": `HELP#${month(at, i)}` } })));
  const out = new Map<string, number>();
  for (const r of parts.flat()) out.set(String(r.SK), (out.get(String(r.SK)) ?? 0) + Number(r.n ?? 0));
  return out;
}

const views = (c: Map<string, number>, role: RoleOrNone, id: string) => c.get(`VIEW#${role}#${id}`) ?? 0;

/**
 * The "Most used" list for each role: the starting picks until the role has POPULAR_MIN_VIEWS views,
 * then the most-opened topics for that role (topics for other roles count too: a parent who keeps
 * opening "Post an announcement" is telling us something).
 */
export function popularFrom(c: Map<string, number>): Record<HelpRole | "all", { ids: string[]; from: "counts" | "starter" }> {
  const pick = (roles: readonly RoleOrNone[], key: HelpRole | "all") => {
    const total = HELP_TOPICS.reduce((n, t) => n + roles.reduce((m, r) => m + views(c, r, t.id), 0), 0);
    if (total < POPULAR_MIN_VIEWS) return { ids: STARTER_PICKS[key], from: "starter" as const };
    const ranked = HELP_TOPICS.map((t, i) => ({ id: t.id, n: roles.reduce((m, r) => m + views(c, r, t.id), 0), i }))
      .filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.id);
    const ids = [...ranked, ...STARTER_PICKS[key].filter((id) => !ranked.includes(id))].slice(0, PICKS);
    return { ids, from: "counts" as const };
  };
  return {
    all: pick(ROLE_OR_NONE, "all"),
    parent: pick(["parent"], "parent"),
    staff: pick(["staff"], "staff"),
    admin: pick(["admin"], "admin")
  };
}

const eventSchema = z.object({
  kind: z.enum(["view", "search"]),
  topic: z.string().max(64).optional(),
  role: z.enum(ROLE_OR_NONE).default("none"),
  via: z.enum(HELP_VIA).default("browse"),
  /** For searches: whether anything matched. The words themselves are never sent. */
  found: z.boolean().optional()
}).strict();

export function helpPublicRoutes(r: Router) {
  /** One topic opened, or one search finished. No sign-in; the site sends at most one per topic per visit. */
  r.on("POST", "/public/help/events", async ({ body }) => {
    const b = parseEvent(body);
    const at = new Date();
    if (b.kind === "view") {
      if (!b.topic || !HELP_IDS.has(b.topic)) throw badRequest("That help topic doesn't exist.");
      await Promise.all([add(at, `VIEW#${b.role}#${b.topic}`), add(at, `OPEN#${b.via}`)]);
    } else {
      await Promise.all([add(at, "SEARCH"), ...(b.found === false ? [add(at, "MISS")] : [])]);
    }
    return { statusCode: 204, headers: { "cache-control": "no-store" }, body: "" };
  });

  /** "Most used" for each role. Cached for a few minutes: it moves slowly. */
  r.on("GET", "/public/help/popular", async () => {
    const res = json(200, { popular: popularFrom(await recent()), minViews: POPULAR_MIN_VIEWS });
    return { ...res, headers: { ...res.headers, "cache-control": "public, max-age=300" } };
  });
}

function parseEvent(raw: string | null | undefined) {
  let data: unknown;
  try { data = JSON.parse(raw || "{}"); } catch { throw badRequest("The request body isn't valid JSON."); }
  const p = eventSchema.safeParse(data);
  if (!p.success) throw badRequest("That help event isn't valid.");
  return p.data;
}

export function helpAdminRoutes(r: Router) {
  /** Site owners: views per topic and role over the last three months, how topics were opened, searches. */
  r.on("GET", "/admin/help", async ({ caller }) => {
    await requirePlatformAdmin(caller, "Only site owners can see help guide counts.");
    const at = new Date();
    const [c, now] = await Promise.all([recent(at), recent(at, 1)]);
    const topics = HELP_TOPICS.map((t) => {
      const byRole = Object.fromEntries(ROLE_OR_NONE.map((role) => [role, views(c, role, t.id)])) as Record<RoleOrNone, number>;
      return { id: t.id, title: t.title, role: t.role, views: Object.values(byRole).reduce((a, b) => a + b, 0), thisMonth: ROLE_OR_NONE.reduce((n, role) => n + views(now, role, t.id), 0), byRole };
    }).sort((a, b) => b.views - a.views);
    const via = Object.fromEntries(HELP_VIA.map((v) => [v, c.get(`OPEN#${v}`) ?? 0]));
    return json(200, {
      since: `${month(at, MONTHS - 1)}-01`, months: MONTHS, topics, via,
      searches: c.get("SEARCH") ?? 0, misses: c.get("MISS") ?? 0,
      popular: popularFrom(c), minViews: POPULAR_MIN_VIEWS
    });
  });
}
