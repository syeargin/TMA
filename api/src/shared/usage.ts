/**
 * Site usage counts (site admin › Usage and Health), shared by the API and the site. Counted on our
 * own servers as daily totals by club, team, role and page: never which pages one person opened.
 * Kept 13 months.
 */

/** Pages, as the site reports them. Team pages first (they carry the team), then the rest. */
export const TEAM_AREAS = [
  "home", "schedule", "tournaments", "gameday", "matches", "ref", "meals", "travel", "agenda",
  "stats", "fund", "roster", "attendance", "info", "members", "communications"
] as const;
export const SITE_AREAS = ["teams", "account", "help", "admin", "club", "signin", "landing", "answer", "other"] as const;
export const AREAS = [...TEAM_AREAS, ...SITE_AREAS] as const;
export type TeamArea = (typeof TEAM_AREAS)[number];
export type Area = (typeof AREAS)[number];
/** Pages anyone can open without signing in (the public counter takes only these). */
export const PUBLIC_AREAS = ["help", "signin", "landing", "answer", "other"] as const satisfies readonly Area[];

export const AREA_LABELS: Record<Area, string> = {
  home: "Team home", schedule: "Schedule", tournaments: "Tournaments", gameday: "Game-day sheet", matches: "Tournament › Matches",
  ref: "Tournament › Ref jobs", meals: "Tournament › Meals", travel: "Tournament › Travel", agenda: "Tournament › Agenda",
  stats: "Stats", fund: "Team fund", roster: "Roster", attendance: "Roster › Attendance", info: "Team info", members: "Members",
  communications: "Communications", teams: "Your teams", account: "Your account", help: "Help", admin: "Site admin", club: "Club admin",
  signin: "Sign-in pages", landing: "Front page", answer: "One-tap answer", other: "Other pages"
};

/** How a visit started (counted once per visit). */
export const SOURCES = ["email", "text", "app", "link", "direct"] as const;
export type Source = (typeof SOURCES)[number];
export const SOURCE_LABELS: Record<Source, string> = {
  email: "Link in an email", text: "Link in a text", app: "Home-screen app", link: "Link on another site", direct: "Bookmark or typed in"
};

export const DEVICES = ["phone", "tablet", "computer"] as const;
export type Device = (typeof DEVICES)[number];

/** Things people do, counted when the request succeeds. */
export const ACTIONS = ["answers", "events", "announcements", "payments", "attendance", "scores", "meals", "shares"] as const;
export type Action = (typeof ACTIONS)[number];
export const ACTION_LABELS: Record<Action, string> = {
  answers: "Availability answers", events: "Schedule changes", announcements: "Announcements posted or edited", payments: "Payments recorded",
  attendance: "Practices with attendance saved", scores: "Match scores entered", meals: "Meals claimed", shares: "Results shared"
};

/** What a request was, for counting: an action on a team, or nothing. Paths are after the stage. */
export function actionOf(method: string, path: string, body: string | null): { action: Action; teamId: string } | null {
  const t = /^\/teams\/([^/]+)\/(.+)$/.exec(path);
  if (method === "POST" && path === "/public/answer") return { action: "answers", teamId: "" };
  if (!t) return null;
  const [, teamId, rest] = t;
  const is = (re: RegExp) => re.test(rest);
  if (method === "PUT" && is(/^family\/[^/]+$/)) return body && /"rsvp"\s*:/.test(body) ? { action: "answers", teamId } : null;
  if ((method === "PUT" || method === "DELETE") && is(/^events\/[^/]+$/)) return { action: "events", teamId };
  if (method === "POST" && is(/^events\/(combine|[^/]+\/split)$/)) return { action: "events", teamId };
  if (method === "PUT" && is(/^announcements\/[^/]+$/)) return { action: "announcements", teamId };
  if (method === "POST" && is(/^payments$/)) return { action: "payments", teamId };
  if (method === "PUT" && is(/^attendance\/[^/]+$/)) return { action: "attendance", teamId };
  if (method === "PUT" && is(/^events\/[^/]+\/matches\/[^/]+$/)) return { action: "scores", teamId };
  if (method === "POST" && is(/^events\/[^/]+\/meals\/[^/]+\/claim$/)) return { action: "meals", teamId };
  return null;
}

/** Where a failed request was, for Health › Errors by page. */
export function errorAreaOf(path: string): string {
  const t = /^\/teams\/[^/]+\/([^/]+)(?:\/[^/]+\/([^/]+))?/.exec(path);
  if (t) {
    const [, seg, sub] = t;
    if (seg === "events") return sub === "matches" || sub === "matchslots" || sub === "scorekeeper" ? "Matches" : sub === "meals" ? "Meals" : sub === "refjobs" ? "Ref jobs" : "Schedule";
    const map: Record<string, string> = {
      family: "Answers and family details", announcements: "Announcements", payments: "Team fund", ledger: "Team fund", attendance: "Attendance",
      players: "Roster", feed: "Calendar feed", import: "Spreadsheet import", export: "Spreadsheet export", invites: "Invites", members: "Members",
      comms: "Communications", settings: "Team settings", features: "Team settings", practices: "Schedule", tasks: "Coordinator tasks", handbook: "Handbook"
    };
    return map[seg] ?? "Team page";
  }
  if (/^\/teams\/[^/]+\/?$/.test(path)) return "Opening a team";
  if (path.startsWith("/teams")) return "Your teams";
  if (path.startsWith("/clubs")) return "Club admin";
  if (path.startsWith("/admin")) return "Site admin";
  if (path.startsWith("/me")) return "Your account";
  if (path.startsWith("/public/answer")) return "One-tap answer";
  if (path.startsWith("/public")) return "Public pages";
  return "Other";
}

/** Page-open times: the upper edge of each bucket, in ms (the last is everything slower). */
export const LOAD_BUCKETS = [250, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, Infinity] as const;
export const bucketOf = (ms: number) => LOAD_BUCKETS.findIndex((b) => ms <= b);

/** The time 95% of loads were within (a bucket's upper edge), or null with no loads. */
export function p95(counts: number[]): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i];
    if (seen >= total * 0.95) return LOAD_BUCKETS[i] === Infinity ? 10000 : LOAD_BUCKETS[i];
  }
  return null;
}

/** Staff or family, for People active each week. */
export const kindOf = (roles: readonly string[]): "staff" | "family" =>
  roles.some((r) => r !== "parent") ? "staff" : "family";

export type Period = "7d" | "30d" | "season";
export const PERIODS: Period[] = ["7d", "30d", "season"];
