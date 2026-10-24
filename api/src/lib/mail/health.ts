/**
 * The Delivery health tab (Messaging M3): how a team's email is doing over the last 30 days, and the
 * people it isn't reaching. Built from the counters in stats.ts plus the team's own members, so it
 * only ever names people on the team (or invited to it).
 */
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { keys, normEmail } from "../keys.js";
import { queryAll } from "../../api/util.js";
import { effective, MESSAGES, type MessageId, type TeamComms } from "../../shared/messages.js";
import { str, type Team } from "../comms/content.js";
import { FOLLOWS, statsPk, type FollowMsg } from "./stats.js";

export const WINDOW_DAYS = 30;
/** A family "isn't opening" after this many delivered emails and four weeks without an open. */
export const NOT_OPENING_AFTER = 4;
const NOT_OPENING_DAYS = 28;

/** Messages a family can get, for "turned everything off". */
const FAMILY_MSGS: MessageId[] = ["weekly", "packet", "availability", "dues", "payment", "announcement"];

/** Common misspellings of the big mail providers, for "Did you mean gmail.com?". */
const TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmal.com": "gmail.com", "gnail.com": "gmail.com", "gmail.co": "gmail.com",
  "gmail.con": "gmail.com", "gmaill.com": "gmail.com", "gamil.com": "gmail.com", "gmail.cm": "gmail.com", "gmali.com": "gmail.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.con": "yahoo.com", "yhoo.com": "yahoo.com", "yahoo.co": "yahoo.com",
  "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmail.con": "hotmail.com", "hotmal.com": "hotmail.com", "homail.com": "hotmail.com",
  "outlok.com": "outlook.com", "outloo.com": "outlook.com", "outlook.con": "outlook.com", "otulook.com": "outlook.com",
  "icloud.con": "icloud.com", "iclod.com": "icloud.com", "icoud.com": "icloud.com", "icluod.com": "icloud.com",
  "aol.con": "aol.com", "comcast.ner": "comcast.net", "att.ner": "att.net", "verizon.ner": "verizon.net"
};
export function suggestDomain(email: string): string | undefined {
  const d = email.split("@")[1]?.toLowerCase();
  return d ? TYPOS[d] : undefined;
}

type Row = Record<string, unknown>;
type Person = { sub: string; name: string; email: string; roles: string[]; pid: string; notifyOff: string[] };
export type Attention =
  | { kind: "bounced"; email: string; who: string; invite: boolean; bounces: number; since: string; suggest?: string; detail: string }
  | { kind: "complained"; email: string; who: string; at: string }
  | { kind: "unreachable"; family: string; pid: string; why: string }
  | { kind: "notOpening"; families: { family: string; pid: string; emails: number; lastOpen: string }[] };
export type MessageHealth = {
  id: string; label: string; sent: number; delivered: number; opened: number; bounced: number; complained: number;
  next: number; nextLabel: string; off: number | null;
};
export type Health = {
  since: string; sent: number; delivered: number; bounced: number; complained: number;
  families: number; familiesOpening: number; turnedOff: number; opensSince: string | null;
  attention: Attention[]; messages: MessageHealth[];
};

const daysAgo = (n: number, now: number) => new Date(now - n * 86400_000).toISOString();
const n = (v: unknown) => Number(v ?? 0) || 0;
const familyName = (p: Row | undefined) => (str(p?.last) ? `${str(p?.last)} family` : str(p?.first) ? `${str(p?.first)}'s family` : "A family");

/** Pure: the tab from the rows. Exported for tests. */
export function buildHealth(t: Team, people: Person[], invites: Row[], rows: Row[], c: TeamComms | null, now = Date.now()): Health {
  const since = daysAgo(WINDOW_DAYS, now).slice(0, 10);
  const days = rows.filter((r) => String(r.SK).startsWith("DAY#") && String(r.day) >= since);
  const addrs = new Map(rows.filter((r) => String(r.SK).startsWith("ADDR#")).map((r) => [String(r.email), r]));
  const byEmail = new Map<string, Person[]>();
  for (const p of people) if (p.email) byEmail.set(normEmail(p.email), [...(byEmail.get(normEmail(p.email)) ?? []), p]);
  const inviteOf = new Map(invites.map((i) => [normEmail(str(i.email)), i]));

  // ---------- by message ----------
  const sums = new Map<string, MessageHealth>();
  const offCount = (msg: string) => people.filter((p) => p.notifyOff.includes(msg) || p.notifyOff.includes("all")).length;
  for (const r of days) {
    const id = String(r.msg);
    if (!(id in MESSAGES)) continue;
    const m = sums.get(id) ?? {
      id, label: MESSAGES[id as MessageId].label, sent: 0, delivered: 0, opened: 0, bounced: 0, complained: 0, next: 0,
      nextLabel: FOLLOWS[id as FollowMsg] ?? "", off: MESSAGES[id as MessageId].required ? null : offCount(id)
    };
    m.sent += n(r.sent); m.delivered += n(r.delivered); m.opened += n(r.opened); m.bounced += n(r.bounced); m.complained += n(r.complained); m.next += n(r.next);
    sums.set(id, m);
  }
  const order = Object.keys(MESSAGES);
  const messages = [...sums.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const total = (k: "sent" | "delivered" | "bounced" | "complained") => messages.reduce((s, m) => s + m[k], 0);

  // ---------- families ----------
  const parentsOf = (pid: string) => people.filter((p) => p.pid === pid && p.roles.includes("parent"));
  const familyMsgsOn = FAMILY_MSGS.filter((m) => effective(m, c)?.on);
  const turnedAllOff = (p: Person) => p.notifyOff.includes("all") || (familyMsgsOn.length > 0 && familyMsgsOn.every((m) => p.notifyOff.includes(m)));
  const blocked = (email: string) => { const a = addrs.get(normEmail(email)); return !!(a?.bouncedAt || a?.complainedAt); };
  const recent = (iso: unknown, days: number) => !!iso && String(iso) >= daysAgo(days, now);

  let families = 0, familiesOpening = 0;
  const unreachable: Attention[] = [];
  const notOpening: { family: string; pid: string; emails: number; lastOpen: string }[] = [];
  for (const pl of t.players) {
    const pid = String(pl.pid);
    const parents = parentsOf(pid);
    const fam = familyName(pl);
    if (!parents.length) {
      const invited = invites.some((i) => str(i.pid) === pid);
      unreachable.push({ kind: "unreachable", family: fam, pid, why: invited ? "Invited, but no parent has joined yet, so they don't get team email." : "No parent is on Teem Hub, so they don't get team email." });
      continue;
    }
    const reachable = parents.filter((p) => p.email && !blocked(p.email) && !turnedAllOff(p));
    if (!reachable.length) {
      const why = parents.every((p) => p.email && blocked(p.email)) ? "Every parent's address bounced or marked team email as spam."
        : parents.some((p) => p.email && blocked(p.email)) ? "One parent's address bounces and the other turned off team email."
        : "Turned off team email, so they only see changes when they open Teem Hub.";
      unreachable.push({ kind: "unreachable", family: fam, pid, why });
      continue;
    }
    const a = reachable.map((p) => addrs.get(normEmail(p.email))).filter((x): x is Row => !!x);
    if (!a.some((x) => recent(x.lastDeliveredAt, WINDOW_DAYS))) continue;
    families++;
    if (a.some((x) => recent(x.lastOpenAt, WINDOW_DAYS))) familiesOpening++;
    if (a.every((x) => n(x.sinceOpen) >= NOT_OPENING_AFTER && !recent(x.lastOpenAt, NOT_OPENING_DAYS))) {
      const last = a.map((x) => str(x.lastOpenAt)).sort().pop() ?? "";
      notOpening.push({ family: fam, pid, emails: Math.min(...a.map((x) => n(x.sinceOpen))), lastOpen: last });
    }
  }

  // ---------- addresses ----------
  const attention: Attention[] = [];
  const who = (email: string) => {
    const ps = byEmail.get(email);
    if (ps?.length) return { who: ps.map((p) => p.name).join(", "), invite: false };
    const i = inviteOf.get(email);
    if (i) {
      const named = str(i.person) || [str(i.firstName), str(i.lastName)].filter(Boolean).join(" ");
      const player = t.players.find((p) => String(p.pid) === str(i.pid));
      return { who: named || (player ? `Invite for the ${familyName(player)}` : "An invite"), invite: true };
    }
    return null;
  };
  for (const a of addrs.values()) {
    const email = String(a.email);
    const w = who(email);
    if (!w) continue; // left the team, or an invite that was cancelled or accepted under another address
    if (a.bouncedAt) {
      attention.push({
        kind: "bounced", email, who: w.who, invite: w.invite, bounces: n(a.bounces) || 1, since: str(a.firstBounceAt) || str(a.bouncedAt),
        suggest: suggestDomain(email), detail: str(a.bounceDetail)
      });
    } else if (a.complainedAt) {
      attention.push({ kind: "complained", email, who: w.who, at: str(a.complainedAt) });
    }
  }
  attention.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "bounced" ? -1 : 1));
  attention.push(...unreachable);
  if (notOpening.length) attention.push({ kind: "notOpening", families: notOpening });

  const opens = rows.filter((r) => String(r.SK).startsWith("DAY#") && n(r.opened) > 0).map((r) => String(r.day)).sort();
  return {
    since, sent: total("sent"), delivered: total("delivered"), bounced: total("bounced"), complained: total("complained"),
    families, familiesOpening, turnedOff: people.filter((p) => p.notifyOff.length > 0).length, opensSince: opens[0] ?? null,
    attention, messages
  };
}

/** Loads everything the tab needs for one team. */
export async function teamHealth(t: Team, c: TeamComms | null): Promise<Health> {
  const rows = await queryAll({ KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": statsPk(t.teamId) } });
  const people: Person[] = await Promise.all(t.members.map(async (m) => {
    const prof = (await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.profile(m.sub) }))).Item ?? {};
    const name = [str(prof.firstName) || m.firstName, str(prof.lastName)].filter(Boolean).join(" ") || str(prof.email) || m.email || "Someone";
    return { sub: m.sub, name, email: m.email || str(prof.email), roles: m.roles, pid: m.pid, notifyOff: m.notifyOff };
  }));
  const invites = (await ddb.send(new QueryCommand({
    TableName: TABLE, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :p AND begins_with(GSI1SK, :i)",
    ExpressionAttributeValues: { ":p": `TEAM#${t.teamId}`, ":i": "INVITE#" }
  }))).Items ?? [];
  return buildHealth(t, people, invites, rows, c);
}

/** How many things need attention, for the tab's count. */
export const attentionCount = (h: Health) => h.attention.reduce((s, a) => s + (a.kind === "notOpening" ? a.families.length : 1), 0);
