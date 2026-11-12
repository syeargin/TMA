/**
 * Tournament day plans: what the team does for meals and the agenda on each kind of tournament day.
 *
 * A team keeps one playbook (TEAM#<t> / DAYPLANS). Each tournament keeps its days (TEAM#<t> / EVENT#<e>#DAYPLAN):
 * what kind of day each date is (arrival, play, last) and, once posted, its wave (AM or PM). Setting a day's wave
 * fills in that day's agenda lines and its meal jobs (Meal items) from the playbook. Meals that need a family
 * (brought to court, delivered, restaurant) become jobs; "on your own" and "no team meal" are shown, not stored.
 *
 * Shared by the API (which fills the meals in) and the site (which shows the plan and edits the playbook).
 */

export const MEAL_STYLES = ["own", "court", "delivered", "restaurant", "none"] as const;
export type MealStyle = (typeof MEAL_STYLES)[number];
/** Styles that need a family to do something, and so become a meal job with a budget. */
export const JOB_STYLES: MealStyle[] = ["court", "delivered", "restaurant"];
export const STYLE_LABELS: Record<MealStyle, string> = {
  own: "On your own", court: "Brought to court", delivered: "Delivered to venue", restaurant: "Team restaurant", none: "No team meal"
};
export const STYLE_SHORT: Record<MealStyle, string> = { own: "Own", court: "Court", delivered: "Delivered", restaurant: "Restaurant", none: "None" };

export const MEAL_SLOTS = ["Breakfast", "Lunch", "Between matches", "Dinner"] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];

export const DAY_TYPES = ["arrival", "play", "last"] as const;
export type DayType = (typeof DAY_TYPES)[number];
export const DAY_TYPE_LABELS: Record<DayType, string> = { arrival: "Arrival", play: "Play day", last: "Last day" };
export type Wave = "am" | "pm";

/** The six kinds of day a playbook covers. */
export const PLAN_KEYS = ["local-am", "local-pm", "travel-arrival", "travel-am", "travel-pm", "travel-last-am", "travel-last-pm"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export const PLAN_LABELS: Record<PlanKey, { group: string; day: string; wave?: string }> = {
  "local-am": { group: "Local tournament", day: "Play day", wave: "AM wave" },
  "local-pm": { group: "Local tournament", day: "Play day", wave: "PM wave" },
  "travel-arrival": { group: "Travel tournament", day: "Arrival day" },
  "travel-am": { group: "Travel tournament", day: "Play day", wave: "AM wave" },
  "travel-pm": { group: "Travel tournament", day: "Play day", wave: "PM wave" },
  "travel-last-am": { group: "Travel tournament", day: "Last day", wave: "AM wave" },
  "travel-last-pm": { group: "Travel tournament", day: "Last day", wave: "PM wave" }
};

export type PlanMeal = { meal: MealSlot; style: MealStyle; optional?: boolean };
/** A playbook agenda line: just words, or words with a default time ("7:00 PM"). */
export type TemplateLine = string | { what: string; time?: string };
export type DayTemplate = { meals: PlanMeal[]; agenda: TemplateLine[] };
export type Budgets = { court: number; delivered: number; restaurant: number };
export interface Playbook {
  plans: Record<PlanKey, DayTemplate>;
  /** Per person, in cents. */
  budgets: Budgets;
  /** Who's counted for team meals: players who answered In, plus the team's coaches. */
  count: "players-coaches";
  /** The usual delivery service (just a starting suggestion; any meal can use another). */
  vendor: string;
  /** A link explaining how to order (often a Team Info section). */
  howTo: string;
  /** Orders are due this time on the day before the meal ("18:00"). */
  orderTime: string;
  /** Families get the "add your order" to-do this long before the order deadline (or when the link is posted, if later). */
  familyLeadHours: number;
  updatedAt?: string; updatedBy?: string;
}

/** The team's defaults until it changes them (the A5 13 Tom decisions, Nov 2026). */
export const DEFAULT_PLAYBOOK: Playbook = {
  plans: {
    "local-am": { meals: [{ meal: "Breakfast", style: "own" }], agenda: ["Arrive per the game-day sheet", "Head home after the last match"] },
    "local-pm": {
      meals: [{ meal: "Breakfast", style: "own" }, { meal: "Between matches", style: "court" }],
      agenda: ["Arrive per the game-day sheet", "Food at the court between matches"]
    },
    "travel-arrival": {
      meals: [{ meal: "Dinner", style: "restaurant", optional: true }],
      agenda: ["Check in at the hotel", { what: "Team meeting in the hotel lobby", time: "7:00 PM" }]
    },
    "travel-am": {
      meals: [{ meal: "Breakfast", style: "own" }, { meal: "Lunch", style: "delivered" }, { meal: "Dinner", style: "own" }],
      agenda: ["Meet in the hotel lobby, go to the venue together", "Lunch at the venue"]
    },
    "travel-pm": {
      meals: [{ meal: "Breakfast", style: "own" }, { meal: "Lunch", style: "own" }, { meal: "Dinner", style: "delivered" }],
      agenda: ["Meet in the hotel lobby, go to the venue together", "Dinner at the venue"]
    },
    "travel-last-am": {
      meals: [{ meal: "Breakfast", style: "own" }, { meal: "Lunch", style: "delivered" }, { meal: "Dinner", style: "none" }],
      agenda: ["Check out before leaving for the venue", "Meet in the hotel lobby, go to the venue together", "Head home from the venue"]
    },
    "travel-last-pm": {
      meals: [{ meal: "Breakfast", style: "own" }, { meal: "Lunch", style: "own" }, { meal: "Dinner", style: "none" }],
      agenda: ["Check out, then meet in the hotel lobby", "Go to the venue together", "Head home from the venue"]
    }
  },
  budgets: { court: 2000, delivered: 2000, restaurant: 3000 },
  count: "players-coaches",
  vendor: "ezCater",
  howTo: "",
  orderTime: "18:00",
  familyLeadHours: 48
};

/** The saved playbook, with anything missing filled in from the defaults. */
export function playbookOf(saved?: Partial<Playbook> | null): Playbook {
  const p = saved ?? {};
  return {
    ...DEFAULT_PLAYBOOK, ...p,
    plans: { ...DEFAULT_PLAYBOOK.plans, ...(p.plans ?? {}) },
    budgets: { ...DEFAULT_PLAYBOOK.budgets, ...(p.budgets ?? {}) }
  };
}

/**
 * One thing on a tournament day's timeline. fromPlan: it came from the playbook (it's swapped when the wave
 * changes, unless someone edited it); src is the playbook line it came from. cal: also goes in families'
 * subscribed calendars (only with a time).
 */
export type AgendaItem = {
  id: string; what: string; time?: string; where?: string; note?: string;
  fromPlan?: boolean; edited?: boolean; src?: string; cal?: boolean; by?: string; at?: string;
  /** A playbook line someone removed: kept out of sight so a change of wave doesn't bring it back. */
  removed?: boolean;
};
/** agenda: saved items (older days saved plain lines). */
export type PlanDay = { type: DayType; wave?: Wave; agenda?: (AgendaItem | string)[] };

const lineText = (l: TemplateLine) => (typeof l === "string" ? l : l.what);
/** A day's items, oldest saves (plain lines) included. */
export function agendaOf(day?: PlanDay | null): AgendaItem[] {
  return (day?.agenda ?? []).map((a, i) => (typeof a === "string" ? { id: `p${i}`, what: a, fromPlan: true, src: a } : a));
}
/** The playbook's lines for a day, as timeline items. */
export function templateItems(t: DayTemplate | null | undefined, id: (i: number) => string): AgendaItem[] {
  return (t?.agenda ?? []).map((l, i) => ({ id: id(i), what: lineText(l), ...(typeof l !== "string" && l.time ? { time: l.time } : {}), fromPlan: true, src: lineText(l) }));
}
/**
 * The day's items after a change of wave or kind: the new playbook lines, plus everything someone added
 * or edited by hand (an edited playbook line replaces the line it came from).
 */
export function mergeAgenda(current: AgendaItem[], fresh: AgendaItem[]): AgendaItem[] {
  const kept = current.filter((a) => !a.fromPlan || a.edited);
  const keptSrc = new Set(kept.map((a) => a.src).filter(Boolean));
  return [...fresh.filter((a) => !keptSrc.has(a.src)), ...kept];
}

/** Minutes after midnight for "7:30 PM" or "19:30"; null without a time (sorted first, as "Any time"). */
export function minutesOf(t?: string): number | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*$/i.exec(t ?? "");
  if (!m) return null;
  let h = +m[1];
  const min = +(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  if (m[3]) h = (h % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0);
  return h * 60 + min;
}
/** noArrival: a travel tournament without the arrival day before it (the team travels the morning of). */
export type EventDayPlan = { days: Record<string, PlanDay>; noArrival?: boolean };

const shift = (d: string, n: number) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

/** The tournament's own dates, as listed on the schedule (at most 10). */
export function listedDates(date: string, endDate?: string): string[] {
  const out: string[] = [];
  for (let d = date; d <= (endDate || date) && out.length < 10; d = shift(d, 1)) out.push(d);
  return out;
}

/**
 * The days a day plan covers: the listed dates, and for a travel tournament the arrival day before the
 * listed start (unless the team turned it off). The schedule's dates don't change.
 */
export function planDates(travel: boolean, date: string, endDate?: string, noArrival = false): string[] {
  const listed = listedDates(date, endDate);
  return travel && !noArrival ? [shift(date, -1), ...listed] : listed;
}

/**
 * What kind of day each date is, until someone changes it: local tournaments are all play days. On a travel
 * tournament the day before the listed start is the arrival day, the last listed date is the last day, and
 * the dates between are play days.
 */
export function defaultDayType(travel: boolean, listed: string[], date: string): DayType {
  if (!travel) return "play";
  if (date < listed[0]) return "arrival";
  return date === listed[listed.length - 1] ? "last" : "play";
}

/** The playbook entry for a day, or null while a play or last day's wave isn't posted. */
export function planKey(travel: boolean, type: DayType, wave?: Wave): PlanKey | null {
  if (!travel) return wave ? (`local-${wave}` as PlanKey) : null;
  if (type === "arrival") return "travel-arrival";
  if (!wave) return null;
  return type === "last" ? (`travel-last-${wave}` as PlanKey) : (`travel-${wave}` as PlanKey);
}

export const isJob = (s?: string) => JOB_STYLES.includes(s as MealStyle);
export const budgetOf = (b: Budgets, style?: string) => (style === "court" || style === "delivered" || style === "restaurant" ? b[style] : 0);

/** "2026-01-29T18:00": the order deadline for a meal on `date`, at `time` the day before. */
export function orderDeadline(date: string, time: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.toISOString().slice(0, 10)}T${/^\d{2}:\d{2}$/.test(time) ? time : "18:00"}`;
}

/**
 * When families get the "add your order" to-do: once the group order link is posted, but no earlier than
 * `leadHours` before the order deadline. Times in milliseconds (the site reads the deadline in local time).
 */
export function familyTaskFrom(linkAtMs: number | null, orderByMs: number | null, leadHours: number): number | null {
  if (linkAtMs == null || Number.isNaN(linkAtMs)) return null;
  if (orderByMs == null || Number.isNaN(orderByMs)) return linkAtMs;
  return Math.max(linkAtMs, orderByMs - leadHours * 3600_000);
}
