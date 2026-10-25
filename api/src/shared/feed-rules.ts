// Calendar feed sync: the import rules each team's feed is read with, shared by the API and the site.
// The parser (api/src/lib/feed) turns any .ics file into FeedEvents; these rules decide which of them
// are the team's and what they become. Nothing about one club's calendar style lives in code: a
// preset only fills in starting rules, and the admin can change every one of them.

/** One event from a feed, already in the team's time zone. Recurring events arrive one per date. */
export type FeedEvent = {
  /** The feed's id for this event (with "#<date>" for one date of a repeating event). */
  uid: string;
  title: string;
  description: string;
  location: string;
  categories: string[];
  /** Local day it starts, "2026-11-02". */
  date: string;
  /** Local day it ends (same as date for most events). Inclusive. */
  endDate: string;
  /** "17:30", absent for all-day events. */
  time?: string;
  endTime?: string;
  allDay: boolean;
  /** Marked cancelled in the feed (STATUS:CANCELLED or "CANCELLED" in the title). */
  cancelled: boolean;
  /** One date of a repeating event. */
  repeating?: boolean;
};

export const FEED_KINDS = ["practice", "tournament", "event"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
export const FEED_KIND_LABELS: Record<FeedKind, string> = { practice: "Practice", tournament: "Tournament", event: "Event" };

export type FeedFilter =
  | { mode: "all" }
  | { mode: "prefix" | "contains"; text: string };

export type TypeRule =
  | { when: "title"; text: string; kind: FeedKind }
  | { when: "category"; text: string; kind: FeedKind }
  | { when: "allDay"; kind: FeedKind }
  | { when: "longer"; hours: number; kind: FeedKind };

export type FeedRules = {
  /** Which events are the team's. */
  filter: FeedFilter;
  /** Remove the filter's text from the start of titles ("13-2 Tom - Practice" → "Practice"). */
  stripFilter: boolean;
  /** More text to remove from the start of titles, like "[14U] ". */
  strip: string[];
  /** Run top to bottom; the first match decides the type. */
  types: TypeRule[];
  /** The type when no rule matches. */
  fallback: FeedKind;
  /** Where the court or field is written: "Court: 8" in the description, "Field 3" in the location. */
  court: { from: "description" | "location" | "none"; label: string };
  /** How the location splits into venue and address. */
  venue: "firstLine" | "whole";
  /** The preset these rules started from. */
  preset?: PresetId;
};

/** One event as Teem Hub would show it. */
export type MappedEvent = {
  uid: string;
  /** The title in the feed, before cleanup. */
  feedTitle: string;
  title: string;
  kind: FeedKind;
  /** Which rule decided the type: its index in rules.types, or -1 for the fallback. */
  rule: number;
  date: string;
  endDate: string;
  time?: string;
  endTime?: string;
  allDay: boolean;
  venue: string;
  address: string;
  court: string;
  cancelled: boolean;
};

export type RulesResult = {
  matched: MappedEvent[];
  leftOut: FeedEvent[];
  counts: Record<FeedKind, number>;
  /** How many matched events each type rule decided (same order as rules.types), then the fallback. */
  ruleCounts: number[];
  /** Matched events where the court rule found a court. */
  courts: number;
};

const lower = (s: string) => s.toLocaleLowerCase("en-US");

export function inFilter(e: FeedEvent, f: FeedFilter): boolean {
  if (f.mode === "all") return true;
  const t = lower(e.title.trim()), x = lower(f.text.trim());
  if (!x) return true;
  return f.mode === "prefix" ? t.startsWith(x) : t.includes(x);
}

function stripStart(title: string, text: string): string {
  const x = text.trim();
  if (!x) return title;
  const t = title.trimStart();
  return lower(t).startsWith(lower(x)) ? t.slice(x.length).replace(/^[\s\-–—|:]+/, "") : title;
}

export function cleanTitle(e: FeedEvent, rules: FeedRules): string {
  let t = e.title.trim();
  if (rules.stripFilter && rules.filter.mode === "prefix") t = stripStart(t, rules.filter.text);
  for (const s of rules.strip) t = stripStart(t, s);
  return t.trim() || e.title.trim();
}

const minutes = (hhmm?: string) => (hhmm ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) : 0);
const dayNo = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);

/** How long an event lasts, in hours (all-day events count 24 hours a day). */
export function hoursLong(e: FeedEvent): number {
  const days = dayNo(e.endDate) - dayNo(e.date);
  if (e.allDay) return (days + 1) * 24;
  return (days * 1440 + minutes(e.endTime ?? e.time) - minutes(e.time)) / 60;
}

export function ruleMatches(e: FeedEvent, r: TypeRule): boolean {
  switch (r.when) {
    case "title": return !!r.text.trim() && lower(e.title).includes(lower(r.text.trim()));
    case "category": return !!r.text.trim() && e.categories.some((c) => lower(c) === lower(r.text.trim()));
    case "allDay": return e.allDay;
    case "longer": return hoursLong(e) > r.hours;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Court: Court 8" → "Court 8"; "Court 5" → "Court 5"; "Field: 3" → "Field 3". */
export function findCourt(text: string, label: string): string {
  const l = label.trim();
  if (!l || !text) return "";
  const re = new RegExp(`\\b${escapeRe(l)}\\s*[:#-]?\\s*(?:${escapeRe(l)}\\s*)?([A-Za-z]?\\d+[A-Za-z]?|[A-Z])\\b`, "i");
  const m = re.exec(text);
  return m ? `${l.charAt(0).toUpperCase()}${l.slice(1)} ${m[1]}` : "";
}

/** "A5 Sportsplex\n11000 Alpharetta Highway, Roswell, GA 30076" → venue and address. */
export function splitVenue(location: string, how: FeedRules["venue"]): { venue: string; address: string } {
  const lines = location.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { venue: "", address: "" };
  if (how === "whole" || lines.length === 1) return { venue: lines.join(", "), address: "" };
  return { venue: lines[0], address: lines.slice(1).join(", ") };
}

export function mapEvent(e: FeedEvent, rules: FeedRules): MappedEvent {
  const rule = rules.types.findIndex((r) => ruleMatches(e, r));
  const kind = rule >= 0 ? rules.types[rule].kind : rules.fallback;
  const { venue, address } = splitVenue(e.location, rules.venue);
  const court = rules.court.from === "none" ? "" : findCourt(rules.court.from === "description" ? e.description : e.location, rules.court.label);
  return {
    uid: e.uid, feedTitle: e.title, title: cleanTitle(e, rules), kind, rule,
    date: e.date, endDate: e.endDate, time: e.time, endTime: e.endTime, allDay: e.allDay,
    venue, address, court, cancelled: e.cancelled
  };
}

export function applyRules(events: FeedEvent[], rules: FeedRules): RulesResult {
  const out: RulesResult = { matched: [], leftOut: [], counts: { practice: 0, tournament: 0, event: 0 }, ruleCounts: rules.types.map(() => 0).concat(0), courts: 0 };
  for (const e of events) {
    if (!inFilter(e, rules.filter)) { out.leftOut.push(e); continue; }
    const m = mapEvent(e, rules);
    out.matched.push(m);
    out.counts[m.kind]++;
    out.ruleCounts[m.rule >= 0 ? m.rule : rules.types.length]++;
    if (m.court) out.courts++;
  }
  return out;
}

// ---------- Suggested filters ----------

export type FilterSuggestion = { filter: FeedFilter; count: number };

const SEPARATORS = [" - ", " – ", " — ", " | ", ": "];

/**
 * Filters worth offering, from the titles in a feed: shared starts that end at a separator
 * ("13-2 Tom - "), and bracketed tags ("[14U]"). Most events first. A start shared by every event
 * isn't offered (it filters nothing), and neither is one shared by fewer than 3.
 */
export function suggestFilters(events: FeedEvent[], max = 3): FilterSuggestion[] {
  const counts = new Map<string, { text: string; n: number }>();
  for (const e of events) {
    const title = e.title.trim();
    const seen = new Set<string>();
    const add = (text: string) => {
      const k = lower(text);
      if (seen.has(k)) return;
      seen.add(k);
      const c = counts.get(k);
      if (c) c.n++; else counts.set(k, { text, n: 1 });
    };
    for (const sep of SEPARATORS) {
      let i = title.indexOf(sep);
      while (i > 0) { add(title.slice(0, i + sep.length)); i = title.indexOf(sep, i + 1); }
    }
    const tag = /^\[[^\]]{1,30}\]/.exec(title);
    if (tag) add(tag[0]);
  }
  const all = events.length;
  const list = [...counts.values()].filter((c) => c.n >= 3 && c.n < all);
  // A longer start that covers exactly the same events as a shorter one adds nothing.
  const kept = list.filter((c) => !list.some((o) => o !== c && o.n === c.n && lower(c.text).startsWith(lower(o.text)) && o.text.length < c.text.length));
  kept.sort((a, b) => b.n - a.n || a.text.length - b.text.length);
  return kept.slice(0, max).map((c) => ({ filter: { mode: "prefix", text: c.text.trim() }, count: c.n }));
}

// ---------- Presets ----------

export type PresetId = "sprocket" | "google" | "outlook" | "teamsnap" | "generic";

export const PRESETS: Record<PresetId, { label: string; rules: Omit<FeedRules, "filter"> }> = {
  sprocket: {
    label: "Sprocket Sports",
    rules: {
      stripFilter: true, strip: [], fallback: "event", venue: "firstLine",
      types: [{ when: "title", text: "Practice", kind: "practice" }, { when: "allDay", kind: "tournament" }],
      court: { from: "description", label: "Court" }, preset: "sprocket"
    }
  },
  google: { label: "Google Calendar", rules: genericRules("google") },
  outlook: { label: "Outlook", rules: genericRules("outlook") },
  teamsnap: { label: "TeamSnap", rules: genericRules("teamsnap") },
  generic: { label: "Another calendar", rules: genericRules("generic") }
};

function genericRules(preset: PresetId): Omit<FeedRules, "filter"> {
  return {
    stripFilter: true, strip: [], fallback: "event", venue: "firstLine",
    types: [
      { when: "title", text: "Practice", kind: "practice" },
      { when: "title", text: "Tournament", kind: "tournament" },
      { when: "allDay", kind: "tournament" },
      { when: "longer", hours: 6, kind: "tournament" }
    ],
    court: { from: "location", label: "Court" }, preset
  };
}

/** Which system made a feed, from the software it names, the link's host and its event ids. */
export function detectPreset(info: { prodid: string; host: string; uids: string[] }): PresetId {
  const p = lower(info.prodid), h = lower(info.host);
  if (info.uids.some((u) => /^sprocketsports-/i.test(u)) || h.includes("sprocket") || /^ss-func-[a-z0-9-]+\.azurewebsites\.net$/.test(h)) return "sprocket";
  if (p.includes("google")) return "google";
  if (p.includes("microsoft") || p.includes("outlook") || p.includes("exchange")) return "outlook";
  if (p.includes("teamsnap") || h.includes("teamsnap")) return "teamsnap";
  return "generic";
}

/** Starting rules for a feed: its preset, filtered to the most common shared title start if there is one. */
export function startingRules(preset: PresetId, events: FeedEvent[]): FeedRules {
  const top = suggestFilters(events, 1)[0];
  return { filter: top ? top.filter : { mode: "all" }, ...structuredClone(PRESETS[preset].rules) };
}

/** Rules as one line for history and logs. */
export function describeFilter(f: FeedFilter): string {
  return f.mode === "all" ? "Everything in the feed" : `Title ${f.mode === "prefix" ? "starts with" : "contains"} "${f.text}"`;
}

export function describeRule(r: TypeRule): string {
  const to = FEED_KIND_LABELS[r.kind].toLowerCase();
  switch (r.when) {
    case "title": return `Title contains "${r.text}" → ${to}`;
    case "category": return `Category is "${r.text}" → ${to}`;
    case "allDay": return `All-day → ${to}`;
    case "longer": return `Longer than ${r.hours} hours → ${to}`;
  }
}

/** Same rules? (Saving unchanged rules doesn't make a new version.) */
export function sameRules(a: FeedRules, b: FeedRules): boolean {
  const norm = (r: FeedRules) => JSON.stringify({ ...r, preset: undefined });
  return norm(a) === norm(b);
}
