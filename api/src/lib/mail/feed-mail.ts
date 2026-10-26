/**
 * Calendar feed sync, stage C4: "Cancelled or moved" for families and "Calendar feed alerts" for team
 * admins and coordinators. Content comes from lib/comms/feed-notices.ts.
 */
import { base, footer, label, pill, row, table, type Common } from "./digests.js";
import { box, button, esc, frame, h1, p } from "./frame.js";
import type { Rendered } from "./templates.js";

export type ChangeItem = { date: string; title: string; text: string; cancelled: boolean; when?: string; place?: string };
/** `source` is how the club's calendar is called ("A5"). */
export type ChangeData = Common & { firstName?: string; source: string; changes: ChangeItem[] };
export type FeedAlertData = Common & { firstName?: string; source: string; kind: "review" | "attention" | "failing"; items: string[]; detail?: string };

const teamUrl = (d: Common) => `${base(d.siteUrl)}/teams/${encodeURIComponent(d.teamId)}`;
const textFooter = (d: Common, what: string) => ["", `Notification settings: ${base(d.siteUrl)}/account`, ...(d.unsubscribeUrl ? [`Stop the ${what}: ${d.unsubscribeUrl}`] : [])];

export function change(d: ChangeData): Rendered {
  const n = d.changes.length;
  const first = d.changes[0];
  const allCancelled = d.changes.every((c) => c.cancelled);
  const title = n === 1 ? (first.cancelled ? `Cancelled: ${first.title}, ${first.date}` : `Changed: ${first.title}, ${first.date}`) : allCancelled ? `${n} events cancelled` : `${n} schedule changes`;
  const rows = d.changes.map((c) => row(esc(c.date),
    `<strong>${esc(c.title)}</strong> ${c.cancelled ? pill("Cancelled", "#FDE7E4", "#8E1C13") : pill("Changed", "#FAEFD6", "#7A4E04")}` +
    `<div>${esc(c.cancelled ? "Cancelled in the club's calendar." : `${c.text.charAt(0).toUpperCase()}${c.text.slice(1)}.`)}</div>` +
    (!c.cancelled && (c.when || c.place) ? `<div style="color:#47546C">${esc([c.when, c.place].filter(Boolean).join(" · "))}</div>` : "")));
  const html = frame({
    preheader: d.changes.map((c) => `${c.date} ${c.title}: ${c.cancelled ? "cancelled" : c.text}`).join(" · ").slice(0, 140),
    context: `${d.teamName} · Schedule change`, colors: d.colors,
    body: [
      label(`From ${d.source}'s calendar`), h1(title),
      p(n === 1 ? "The club changed this in its calendar, so the team's schedule changed too." : "The club changed these in its calendar, so the team's schedule changed too."),
      table(rows),
      p("Your answers (In, Maybe or Out) stay as they were. If you can't make it now, change your answer on the schedule.", true),
      button(`${teamUrl(d)}/schedule`, "Open the schedule")
    ].join(""),
    footer: footer(d, "cancelled-or-moved emails", "on the team")
  });
  const text = [title, "", ...d.changes.map((c) => `- ${c.date} · ${c.title}: ${c.cancelled ? "cancelled" : c.text}${!c.cancelled && (c.when || c.place) ? ` (${[c.when, c.place].filter(Boolean).join(" · ")})` : ""}`),
    "", "Your answers stay as they were. If you can't make it now, change your answer on the schedule.", `Open the schedule: ${teamUrl(d)}/schedule`, ...textFooter(d, "cancelled-or-moved emails")].join("\n") + "\n";
  return { subject: `${d.teamName}: ${title}`, fromName: `${d.teamName} via Teem Hub`, html, text };
}

const ALERT_TITLE = {
  review: (n: number) => `${n} ${n === 1 ? "thing needs" : "things need"} your review`,
  attention: () => "Syncing is paused: the rules stopped matching",
  failing: () => "The club's calendar can't be read"
};

export function feedAlert(d: FeedAlertData): Rendered {
  const title = ALERT_TITLE[d.kind](d.items.length);
  const lead = {
    review: `Teem Hub won't guess about these, so the team's schedule keeps them as they are until you decide.`,
    attention: `${d.detail ?? ""} Nothing on the schedule changed, and families weren't told anything.`.trim(),
    failing: `${d.detail ?? "Syncing hasn't worked for a few hours."} Nothing on the schedule changed. If the club gave out a new calendar link, paste it under Team info › Calendar feed.`
  }[d.kind];
  const link = `${teamUrl(d)}/info?feed=1`;
  const html = frame({
    preheader: `${title} · ${d.teamName}`, context: `${d.teamName} · Calendar feed`, colors: d.colors,
    body: [
      label(`${d.source}'s calendar`), h1(title), p(esc(lead)),
      ...(d.items.length ? [box(d.items.map((i) => `<div>${esc(i)}</div>`).join(""))] : []),
      button(link, "Open Calendar feed")
    ].join(""),
    footer: footer(d, "calendar feed alerts", "a team admin or coordinator")
  });
  const text = [title, "", lead, ...(d.items.length ? ["", ...d.items.map((i) => `- ${i}`)] : []), "", `Open Calendar feed: ${link}`, ...textFooter(d, "calendar feed alerts")].join("\n") + "\n";
  return { subject: `${d.teamName}: ${title}`, fromName: "Teem Hub", html, text };
}

const common = (siteUrl: string): Common => ({ teamName: "Test 13 Blue", teamId: "test-13", clubName: "Test Club", siteUrl, schedule: "when the club's calendar cancels or moves something" });

export const feedSamples = {
  change: (siteUrl: string): ChangeData => ({ ...common(siteUrl), source: "A5", changes: [
    { date: "Sat, Nov 7", title: "Practice", text: "now 8:00 AM (was 7:30 AM); now Court 9 (was Court 6)", cancelled: false, when: "8:00 AM – 10:30 AM", place: "A5 Sportsplex · Court 9" },
    { date: "Thu, Nov 12", title: "Practice", text: "cancelled", cancelled: true }
  ] }),
  feedAlert: (siteUrl: string): FeedAlertData => ({ ...common(siteUrl), schedule: "when the calendar feed needs you", source: "A5", kind: "review", items: [
    "Thu, Nov 12 · Practice: not on A5's calendar any more (cancel it or keep it)",
    "Sat, Nov 7 · Practice: A5 now has Court 9; your override says Court 6"
  ] })
};
