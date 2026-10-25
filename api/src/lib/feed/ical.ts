/**
 * Calendar feed sync, layer 1: reads any iCalendar (.ics, RFC 5545) file into FeedEvents in the
 * team's time zone. It handles what the standard allows, so the import rules never have to:
 * folded lines, escaped text, named, UTC and floating times (and Outlook's Windows zone names),
 * all-day events with exclusive end dates, repeating events (RRULE, RDATE, EXDATE and changed
 * single dates via RECURRENCE-ID), cancellations, and missing or repeated event ids.
 *
 * It doesn't trust the feed's change markers (DTSTAMP, SEQUENCE, LAST-MODIFIED): some feeds change
 * them on every fetch. Changes are found by comparing the fields Teem Hub uses.
 */
import { createHash } from "node:crypto";
import type { FeedEvent } from "../../shared/feed-rules.js";
import { localParts, validTimeZone, zonedInstant } from "../comms/zoned.js";

export class FeedError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export const LIMITS = {
  /** Events (VEVENT blocks) in one file. */
  blocks: 2000,
  /** Dates after repeating events are expanded. */
  events: 3000,
  /** Dates one repeating rule may produce inside the window. */
  perRule: 750
};

type Prop = { name: string; params: Record<string, string>; value: string };
type Block = { type: string; props: Prop[]; children: Block[] };

// ---------- Lines and properties ----------

/** Joins folded lines (a line break followed by a space or tab continues the line). */
export function unfold(text: string): string[] {
  return text.replace(/^﻿/, "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter((l) => l.length > 0);
}

/** NAME;PARAM=a;PARAM2="x:y":value. Colons and semicolons inside quotes belong to the parameter. */
export function parseLine(line: string): Prop | null {
  let i = 0, inQuote = false;
  const parts: string[] = [];
  let cur = "";
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; cur += ch; continue; }
    if (!inQuote && ch === ";") { parts.push(cur); cur = ""; continue; }
    if (!inQuote && ch === ":") break;
    cur += ch;
  }
  if (i >= line.length) return null;
  parts.push(cur);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: parts[0].toUpperCase(), params, value: line.slice(i + 1) };
}

/** TEXT values: \n, \, \; and \\ are escapes. */
export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Splits a list value on unescaped commas (CATEGORIES, EXDATE). */
function splitList(v: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "\\" && i + 1 < v.length) { cur += v[i] + v[i + 1]; i++; continue; }
    if (v[i] === ",") { out.push(cur); cur = ""; continue; }
    cur += v[i];
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseBlocks(text: string): Block {
  const root: Block = { type: "ROOT", props: [], children: [] };
  const stack: Block[] = [root];
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const b: Block = { type: p.value.trim().toUpperCase(), props: [], children: [] };
      stack[stack.length - 1].children.push(b);
      stack.push(b);
      if (b.type === "VEVENT" && ++veventCount > LIMITS.blocks) throw new FeedError("feed_too_many_events", `The calendar has more than ${LIMITS.blocks} events. Use a calendar link for just this team.`);
    } else if (p.name === "END") {
      if (stack.length > 1) stack.pop();
    } else stack[stack.length - 1].props.push(p);
  }
  return root;
}
let veventCount = 0;

const prop = (b: Block, name: string) => b.props.find((p) => p.name === name);
const props = (b: Block, name: string) => b.props.filter((p) => p.name === name);
const text = (b: Block, name: string) => { const p = prop(b, name); return p ? unescapeText(p.value).trim() : ""; };

// ---------- Time zones ----------

/** Outlook and Exchange name zones the Windows way. The common North American ones, plus a few more. */
const WINDOWS_ZONES: Record<string, string> = {
  "eastern standard time": "America/New_York", "us eastern standard time": "America/Indiana/Indianapolis",
  "central standard time": "America/Chicago", "mountain standard time": "America/Denver",
  "us mountain standard time": "America/Phoenix", "pacific standard time": "America/Los_Angeles",
  "alaskan standard time": "America/Anchorage", "hawaiian standard time": "Pacific/Honolulu",
  "atlantic standard time": "America/Halifax", "newfoundland standard time": "America/St_Johns",
  "canada central standard time": "America/Regina", "utc": "UTC", "coordinated universal time": "UTC",
  "gmt standard time": "Europe/London", "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest", "romance standard time": "Europe/Paris",
  "e. australia standard time": "Australia/Brisbane", "aus eastern standard time": "Australia/Sydney"
};

/** The IANA zone a TZID means, or null when it's unknown. */
export function zoneFromTzid(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const t = tzid.trim();
  if (validTimeZone(t) && t.includes("/")) return t;
  if (/^(utc|gmt|z)$/i.test(t)) return "UTC";
  const win = WINDOWS_ZONES[t.toLowerCase()];
  if (win) return win;
  // "/mozilla.org/20050126_1/America/New_York" and similar: the zone is at the end.
  const tail = /([A-Za-z_]+\/[A-Za-z_\-]+(?:\/[A-Za-z_\-]+)?)$/.exec(t);
  if (tail && validTimeZone(tail[1])) return tail[1];
  return null;
}

type Stamp = { date: string; time?: string; zone: string | "floating" | "utc" };

/** DTSTART-style value → a local stamp in its own zone. */
function readStamp(p: Prop, warn: (w: string) => void): Stamp | null {
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4] || p.params.VALUE === "DATE") return { date, zone: "floating" };
  const time = `${m[4]}:${m[5]}`;
  if (m[7]) return { date, time, zone: "utc" };
  if (p.params.TZID) {
    const z = zoneFromTzid(p.params.TZID);
    if (z) return { date, time, zone: z };
    warn(`Unknown time zone "${p.params.TZID.slice(0, 60)}"; used the team's time zone.`);
  }
  return { date, time, zone: "floating" };
}

/** A stamp as the team sees it. */
function toTeam(s: Stamp, teamZone: string): { date: string; time?: string } {
  if (!s.time) return { date: s.date };
  if (s.zone === "floating" || s.zone === teamZone) return { date: s.date, time: s.time };
  const at = s.zone === "utc" ? new Date(`${s.date}T${s.time}:00Z`) : zonedInstant(s.date, s.time, s.zone);
  const lp = localParts(at, teamZone);
  return { date: lp.date, time: lp.hhmm };
}

// ---------- Dates ----------

const dayNo = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);
const fromDayNo = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
export const addDays = (date: string, n: number) => fromDayNo(dayNo(date) + n);
const dow = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** DURATION (P1D, PT2H30M, P1W) in minutes. */
function durationMinutes(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const total = (+(m[2] ?? 0)) * 10080 + (+(m[3] ?? 0)) * 1440 + (+(m[4] ?? 0)) * 60 + (+(m[5] ?? 0));
  return m[1] === "-" ? -total : total;
}

// ---------- Repeating events ----------

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

type Rule = { freq: string; interval: number; count?: number; until?: string; byday: { n: number; d: number }[]; bymonthday: number[]; bymonth: number[] };

function parseRrule(v: string, startZone: string, warn: (w: string) => void): Rule | null {
  const kv = Object.fromEntries(v.split(";").map((s) => s.split("=")).filter((x) => x.length === 2).map(([k, x]) => [k.toUpperCase(), x]));
  const freq = String(kv.FREQ ?? "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) { warn(`A repeating event uses "${freq || "?"}" repeats, which Teem Hub doesn't read; only its first date was used.`); return null; }
  const unsupported = Object.keys(kv).filter((k) => !["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST"].includes(k));
  if (unsupported.length) { warn(`A repeating event uses ${unsupported.join(", ")}, which Teem Hub doesn't read; only its first date was used.`); return null; }
  let until: string | undefined;
  if (kv.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(kv.UNTIL);
    if (m) {
      // A UTC UNTIL can fall on the next calendar day locally; compare in the event's own zone.
      if (m[7] && m[4] && startZone !== "floating" && startZone !== "utc") until = localParts(new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`), startZone).date;
      else until = `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
  const byday = (kv.BYDAY ? String(kv.BYDAY).split(",") : []).map((s) => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(s.trim());
    return m ? { n: m[1] ? Number(m[1]) : 0, d: DAYS.indexOf(m[2].toUpperCase()) } : null;
  }).filter((x): x is { n: number; d: number } => !!x);
  const nums = (s: unknown) => (s ? String(s).split(",").map(Number).filter((n) => Number.isFinite(n) && n !== 0) : []);
  return { freq, interval: Math.max(1, Number(kv.INTERVAL ?? 1) || 1), count: kv.COUNT ? Number(kv.COUNT) : undefined, until, byday, bymonthday: nums(kv.BYMONTHDAY), bymonth: nums(kv.BYMONTH) };
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The weekday dates of one month that match BYDAY entries like 2TU or -1FR (or every TU). */
function monthDays(y: number, m: number, byday: Rule["byday"]): string[] {
  const out: string[] = [];
  const n = daysInMonth(y, m);
  for (const { n: nth, d } of byday) {
    const all: number[] = [];
    for (let day = 1; day <= n; day++) if (dow(ymd(y, m, day)) === d) all.push(day);
    if (nth === 0) all.forEach((day) => out.push(ymd(y, m, day)));
    else { const day = nth > 0 ? all[nth - 1] : all[all.length + nth]; if (day) out.push(ymd(y, m, day)); }
  }
  return out;
}

/** The local start dates a rule makes, from the first date on, in order. Stops at `last` or the limits. */
export function expandRule(start: string, r: Rule, last: string): string[] {
  const out: string[] = [];
  const end = r.until && r.until < last ? r.until : last;
  const push = (d: string) => { if (d >= start && d <= end) out.push(d); };
  const done = () => (r.count !== undefined && out.length >= r.count) || out.length >= LIMITS.perRule;
  const [sy, sm, sd] = start.split("-").map(Number);
  for (let i = 0; i < 4000 && !done(); i++) {
    let cands: string[] = [];
    if (r.freq === "DAILY") {
      cands = [addDays(start, i * r.interval)];
    } else if (r.freq === "WEEKLY") {
      // Weeks start on Monday (WKST default); the first week is the one holding the start date.
      const weekStart = addDays(start, -((dow(start) + 6) % 7) + i * 7 * r.interval);
      const days = r.byday.length ? r.byday.map((b) => b.d) : [dow(start)];
      cands = days.map((d) => addDays(weekStart, (d + 6) % 7)).sort();
    } else if (r.freq === "MONTHLY") {
      const mi = sm - 1 + i * r.interval, y = sy + Math.floor(mi / 12), m = (mi % 12) + 1;
      if (r.byday.length) cands = monthDays(y, m, r.byday);
      else {
        const n = daysInMonth(y, m);
        cands = (r.bymonthday.length ? r.bymonthday : [sd]).map((d) => (d > 0 ? d : n + d + 1)).filter((d) => d >= 1 && d <= n).map((d) => ymd(y, m, d));
      }
      cands.sort();
    } else {
      const y = sy + i * r.interval;
      const months = r.bymonth.length ? r.bymonth : [sm];
      for (const m of months) {
        if (r.byday.length) cands.push(...monthDays(y, m, r.byday));
        else { const d = r.bymonthday[0] ?? sd; if (d <= daysInMonth(y, m)) cands.push(ymd(y, m, d)); }
      }
      cands.sort();
    }
    if (cands.length && cands[0] > end) break;
    for (const c of cands) { if (done()) break; push(c); }
  }
  return out;
}

// ---------- The whole file ----------

export type ParsedFeed = {
  name: string;
  prodid: string;
  /** The zone the calendar says it's in (X-WR-TIMEZONE), if any. */
  zone: string;
  events: FeedEvent[];
  /** First and last dates of the events read. */
  from: string;
  to: string;
  warnings: string[];
};

export type ParseOptions = {
  teamZone: string;
  /** Repeating events are expanded from here (local date)… */
  windowStart: string;
  /** …to here. */
  windowEnd: string;
};

const CANCELLED_TITLE = /^\s*(?:\*+\s*)?(?:cancell?ed|canceled)\s*(?:[:\-–|]\s*|\s+)/i;

export function parseFeed(body: string, opt: ParseOptions): ParsedFeed {
  veventCount = 0;
  if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(body)) throw new FeedError("feed_not_calendar", "That link doesn't lead to a calendar (.ics) file. Check that you copied the subscribe or export link.");
  const root = parseBlocks(body);
  const cal = root.children.find((b) => b.type === "VCALENDAR");
  if (!cal) throw new FeedError("feed_not_calendar", "That link doesn't lead to a calendar (.ics) file.");
  const warnings = new Set<string>();
  const warn = (w: string) => { if (warnings.size < 20) warnings.add(w); };
  const calZone = zoneFromTzid(text(cal, "X-WR-TIMEZONE")) ?? "";

  const vevents = cal.children.filter((b) => b.type === "VEVENT");
  // Changed single dates of repeating events, by event id and original date.
  const overrides = new Map<string, Map<string, Block>>();
  const masters: Block[] = [];
  for (const b of vevents) {
    const rid = prop(b, "RECURRENCE-ID");
    const uid = text(b, "UID");
    if (rid && uid) {
      const s = readStamp(rid, warn);
      if (!s) continue;
      if (!overrides.has(uid)) overrides.set(uid, new Map());
      overrides.get(uid)!.set(s.date, b);
    } else masters.push(b);
  }

  const out: FeedEvent[] = [];
  const usedIds = new Map<string, number>();
  const uniqueId = (id: string) => {
    const n = usedIds.get(id) ?? 0;
    usedIds.set(id, n + 1);
    if (n === 0) return id;
    warn("Some events in the calendar share an id; Teem Hub tells them apart by date.");
    return `${id}~${n + 1}`;
  };

  for (const b of masters) {
    const start = prop(b, "DTSTART");
    if (!start) continue;
    const s0 = readStamp(start, warn);
    if (!s0) { warn("An event with an unreadable date was skipped."); continue; }
    const allDay = !s0.time;
    let title = text(b, "SUMMARY") || "(No title)";
    let cancelled = text(b, "STATUS").toUpperCase() === "CANCELLED";
    if (CANCELLED_TITLE.test(title)) { cancelled = true; title = title.replace(CANCELLED_TITLE, "").trim() || title; }
    const base = {
      title,
      description: text(b, "DESCRIPTION"),
      location: text(b, "LOCATION"),
      categories: props(b, "CATEGORIES").flatMap((p) => splitList(p.value).map(unescapeText))
    };
    // Length, in its own zone's minutes (or days for all-day events).
    const endP = prop(b, "DTEND");
    const durP = prop(b, "DURATION");
    let lengthMin = 0;
    if (endP) {
      const e = readStamp(endP, warn);
      if (e) {
        if (allDay) lengthMin = Math.max(0, dayNo(e.date) - dayNo(s0.date) - 1) * 1440; // the end date is exclusive
        else if (e.time) {
          const sAt = s0.zone === "utc" ? Date.parse(`${s0.date}T${s0.time}:00Z`) : s0.zone === "floating" ? Date.parse(`${s0.date}T${s0.time}:00Z`) : zonedInstant(s0.date, s0.time!, s0.zone).getTime();
          const eAt = e.zone === "utc" ? Date.parse(`${e.date}T${e.time}:00Z`) : e.zone === "floating" ? Date.parse(`${e.date}T${e.time}:00Z`) : zonedInstant(e.date, e.time, e.zone).getTime();
          lengthMin = Math.max(0, Math.round((eAt - sAt) / 60000));
        }
      }
    } else if (durP) {
      const d = durationMinutes(durP.value);
      if (d !== null) lengthMin = allDay ? Math.max(0, d - 1440) : Math.max(0, d);
    }

    const uid = text(b, "UID") || `gen-${createHash("sha1").update(`${title}|${start.value}|${base.location}`).digest("hex").slice(0, 16)}`;
    const make = (stamp: Stamp, id: string, extra: Partial<FeedEvent> & { lengthMin?: number } = {}): FeedEvent => {
      const len = extra.lengthMin ?? lengthMin;
      const st = toTeam(stamp, opt.teamZone);
      let endDate = st.date, endTime: string | undefined;
      if (!stamp.time) endDate = addDays(st.date, Math.floor(len / 1440));
      else if (len > 0) {
        // The end in the team's zone: start instant plus length.
        const startAt = stamp.zone === "utc" ? new Date(`${stamp.date}T${stamp.time}:00Z`) : zonedInstant(stamp.date, stamp.time, stamp.zone === "floating" ? opt.teamZone : stamp.zone);
        const lp = localParts(new Date(startAt.getTime() + len * 60000), opt.teamZone);
        endDate = lp.date; endTime = lp.hhmm;
      }
      const { lengthMin: _l, ...rest } = extra;
      return { uid: id, ...base, date: st.date, endDate, time: st.time, endTime, allDay: !stamp.time, cancelled, ...rest };
    };

    const rrule = prop(b, "RRULE");
    const rdates = props(b, "RDATE");
    if (!rrule && !rdates.length) {
      out.push(make(s0, uniqueId(uid)));
      continue;
    }
    // Repeating: the dates in the event's own zone, skipping EXDATEs, with changed dates swapped in.
    const ownZone = s0.zone;
    let dates: string[] = [s0.date];
    if (rrule) {
      const r = parseRrule(rrule.value, ownZone, warn);
      if (r) dates = expandRule(s0.date, r, opt.windowEnd);
    }
    for (const p of rdates) for (const v of splitList(p.value)) { const s = readStamp({ ...p, value: v }, warn); if (s) dates.push(s.date); }
    const ex = new Set<string>();
    for (const p of props(b, "EXDATE")) for (const v of splitList(p.value)) { const s = readStamp({ ...p, value: v }, warn); if (s) ex.add(s.date); }
    const changed = overrides.get(uid);
    for (const date of [...new Set(dates)].sort()) {
      if (ex.has(date)) continue;
      const id = `${uid}#${date.replace(/-/g, "")}`;
      const ov = changed?.get(date);
      if (ov) {
        changed!.delete(date);
        out.push(...occurrenceFromOverride(ov, id, opt, warn));
        continue;
      }
      if (date < opt.windowStart) continue;
      out.push({ ...make({ ...s0, date }, id), repeating: true });
    }
    // Changed dates whose original date isn't one the rule makes (an extra date): keep them.
    if (changed) for (const [date, ov] of changed) out.push(...occurrenceFromOverride(ov, `${uid}#${date.replace(/-/g, "")}`, opt, warn));
    if (out.length > LIMITS.events) throw new FeedError("feed_too_many_events", `The calendar has more than ${LIMITS.events} dates. Use a calendar link for just this team.`);
  }
  // Changed single dates whose repeating event isn't in the file at all.
  const masterIds = new Set(masters.map((b) => text(b, "UID")));
  for (const [uid, map] of overrides) if (!masterIds.has(uid)) for (const [date, ov] of map) out.push(...occurrenceFromOverride(ov, `${uid}#${date.replace(/-/g, "")}`, opt, warn));
  if (out.length > LIMITS.events) throw new FeedError("feed_too_many_events", `The calendar has more than ${LIMITS.events} dates. Use a calendar link for just this team.`);

  out.sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")) || a.uid.localeCompare(b.uid));
  return {
    name: text(cal, "X-WR-CALNAME"), prodid: text(cal, "PRODID"), zone: calZone, events: out,
    from: out[0]?.date ?? "", to: out.reduce((m, e) => (e.endDate > m ? e.endDate : m), ""), warnings: [...warnings]
  };
}

/** One changed date of a repeating event, read as an event of its own. */
function occurrenceFromOverride(ov: Block, id: string, opt: ParseOptions, warn: (w: string) => void): FeedEvent[] {
  const copy: Block = { ...ov, props: ov.props.filter((p) => p.name !== "RECURRENCE-ID" && p.name !== "RRULE" && p.name !== "UID").concat({ name: "UID", params: {}, value: id }) };
  const wrapped = `BEGIN:VCALENDAR\r\n${serialize(copy)}END:VCALENDAR\r\n`;
  const saved = veventCount;
  const parsed = parseFeed(wrapped, opt);
  veventCount = saved;
  parsed.warnings.forEach(warn);
  return parsed.events.map((e) => ({ ...e, uid: id, repeating: true }));
}

function serialize(b: Block): string {
  const esc = (v: string) => v;
  const line = (p: Prop) => `${p.name}${Object.entries(p.params).map(([k, v]) => `;${k}=${/[:;,]/.test(v) ? `"${v}"` : v}`).join("")}:${esc(p.value)}\r\n`;
  return `BEGIN:${b.type}\r\n${b.props.map(line).join("")}${b.children.map(serialize).join("")}END:${b.type}\r\n`;
}

export { hhmm as minutesToHhmm, minutes as hhmmToMinutes };
