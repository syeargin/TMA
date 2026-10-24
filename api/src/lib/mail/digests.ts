/**
 * The weekly at-a-glance and the staff digest (Messaging M2). The content is worked out in
 * lib/comms/content.ts; these only lay it out.
 */
import type { StaffContent, WeeklyContent } from "../comms/content.js";
import { box, button, esc, FONT, frame, h1, MUTED, p } from "./frame.js";
import type { Rendered } from "./templates.js";

type Common = {
  teamName: string; teamId: string; clubName?: string; colors?: { primary?: string; accent?: string };
  firstName?: string; siteUrl: string;
  /** "Sundays at 6:00 PM" */
  schedule: string;
  /** The page that turns this email off without signing in. */
  unsubscribeUrl?: string;
};
export type WeeklyData = Common & { hideEmpty: boolean; content: WeeklyContent };
export type StaffData = Common & { content: StaffContent };

const base = (u: string) => u.replace(/\/$/, "");
const label = (text: string, color = MUTED) =>
  `<div style="font-family:${FONT};font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${color};margin:0 0 6px">${esc(text)}</div>`;
const row = (left: string, right: string) =>
  `<tr><td valign="top" style="width:92px;padding:9px 10px 9px 0;border-top:1px solid #E6EAF1;font-family:${FONT};font-size:13px;font-weight:700;color:#47546C;text-transform:uppercase">${left}</td>` +
  `<td valign="top" style="padding:9px 0;border-top:1px solid #E6EAF1;font-family:${FONT};font-size:14px;line-height:1.45;color:#101B2E">${right}</td></tr>`;
const table = (rows: string[]) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border-bottom:1px solid #E6EAF1">${rows.join("")}</table>`;
const pill = (text: string, bg: string, fg: string) => `<span style="display:inline-block;padding:1px 8px;border-radius:999px;background:${bg};color:${fg};font-size:12px;font-weight:700">${esc(text)}</span>`;
const section = (title: string, inner: string) => `<div style="margin:0 0 18px">${label(title)}${inner}</div>`;

function footer(d: Common, what: string, who: string): string[] {
  const settings = `${base(d.siteUrl)}/account`;
  return [
    `You get the ${esc(what)} ${esc(d.schedule)} because you're ${esc(who)} on ${esc(d.teamName)}.`,
    `<a href="${esc(settings)}" style="color:#15294D">Notification settings</a>${d.unsubscribeUrl ? ` · <a href="${esc(d.unsubscribeUrl)}" style="color:#15294D">Stop the ${esc(what)}</a>` : ""}`,
    "Teem Hub"
  ];
}

export function weekly(d: WeeklyData): Rendered {
  const c = d.content;
  const team = `${base(d.siteUrl)}/teams/${encodeURIComponent(d.teamId)}`;
  const parts: string[] = [];
  parts.push(h1(d.firstName ? `Your week, ${d.firstName}` : "Your week"));
  parts.push(p(`${esc(c.week)}${c.playerFirst ? ` for ${esc(c.playerFirst)}` : ""}.`, true));

  if (c.needs.length) {
    parts.push(box(label("Needs your answer", "#7A4E04") + c.needs.map((n) =>
      `<div style="padding:4px 0"><strong>${esc(n.date)} · ${esc(n.title)}</strong>${n.time ? ` <span style="color:${MUTED}">${esc(n.time)}</span>` : ""}</div>`).join("") +
      `<div style="margin-top:8px"><a href="${esc(team)}/schedule" style="color:#15294D;font-weight:700">Answer In, Maybe or Out</a></div>`));
  }
  if (c.items.length) {
    parts.push(section("This week", table(c.items.map((i) => row(esc(i.date),
      `<strong>${esc(i.title)}</strong>${i.time ? ` · ${esc(i.time)}` : ""}${i.cancelled ? ` ${pill("Cancelled", "#FDE7E4", "#8E1C13")}` : ""}` +
      (i.location ? `<div style="color:${MUTED};font-size:13px">${esc(i.location)}</div>` : ""))))));
  } else if (!d.hideEmpty) {
    parts.push(section("This week", p("Nothing on the schedule.", true)));
  }
  if (c.meals.length) parts.push(section("Your sign-ups", c.meals.map((m) => p(`${esc(m.meal)}${m.event ? ` · ${esc(m.event)}` : ""}${m.date ? ` · ${esc(m.date)}` : ""}`)).join("")));
  if (c.dues) parts.push(section("Money", p(`<strong>${esc(c.dues.amount)}</strong> in dues ${c.dues.late ? "was due" : "due"} <strong>${esc(c.dues.due)}</strong>. <a href="${esc(team)}/fund" style="color:#15294D">See the team fund</a>`)));
  if (c.pinned.length) parts.push(section("Pinned", c.pinned.map((t) => p(esc(t).replace(/\n/g, "<br>"))).join("")));
  parts.push(button(team, "Open Teem Hub"));

  const html = frame({
    preheader: c.needs.length ? `${c.needs.length} thing${c.needs.length === 1 ? "" : "s"} need${c.needs.length === 1 ? "s" : ""} your answer this week.` : `${c.items.length} on the schedule for ${c.week}.`,
    context: `${d.teamName} · Week at a glance`, colors: d.colors, body: parts.join(""),
    footer: footer(d, "weekly email", c.playerFirst ? `${c.playerFirst}'s family` : "on the staff")
  });
  const text = [
    d.firstName ? `Your week, ${d.firstName}` : "Your week",
    `${c.week}${c.playerFirst ? ` for ${c.playerFirst}` : ""}`,
    "",
    ...(c.needs.length ? ["NEEDS YOUR ANSWER", ...c.needs.map((n) => `- ${n.date} · ${n.title}${n.time ? ` (${n.time})` : ""}`), `Answer at ${team}/schedule`, ""] : []),
    ...(c.items.length ? ["THIS WEEK", ...c.items.map((i) => `- ${i.date} · ${i.title}${i.time ? ` · ${i.time}` : ""}${i.location ? ` · ${i.location}` : ""}${i.cancelled ? " (CANCELLED)" : ""}`), ""] : []),
    ...(c.meals.length ? ["YOUR SIGN-UPS", ...c.meals.map((m) => `- ${m.meal}${m.event ? ` · ${m.event}` : ""}`), ""] : []),
    ...(c.dues ? [`MONEY: ${c.dues.amount} in dues ${c.dues.late ? "was due" : "due"} ${c.dues.due}`, ""] : []),
    ...(c.pinned.length ? ["PINNED", ...c.pinned.map((t) => `- ${t}`), ""] : []),
    `Open Teem Hub: ${team}`,
    "",
    `Notification settings: ${base(d.siteUrl)}/account`,
    ...(d.unsubscribeUrl ? [`Stop the weekly email: ${d.unsubscribeUrl}`] : [])
  ].join("\n") + "\n";
  const subject = c.needs.length
    ? `${d.teamName}: your week, ${c.week} · ${c.needs.length} to answer`
    : `${d.teamName}: your week, ${c.week}`;
  return { subject, fromName: `${d.teamName} via Teem Hub`, html, text };
}

export function staffDigest(d: StaffData): Rendered {
  const c = d.content;
  const team = `${base(d.siteUrl)}/teams/${encodeURIComponent(d.teamId)}`;
  const parts: string[] = [h1(d.firstName ? `The week ahead, ${d.firstName}` : "The week ahead"), p(`What's still open for ${esc(c.week)}.`, true)];
  const text: string[] = [`The week ahead: ${c.week}`, ""];
  if (c.unanswered?.length) {
    parts.push(section("Haven't answered", table(c.unanswered.map((u) => row(esc(u.date), `<strong>${esc(u.title)}</strong><div style="color:${MUTED};font-size:13px">${esc(u.names.join(", "))}</div>`)))));
    text.push("HAVEN'T ANSWERED", ...c.unanswered.map((u) => `- ${u.date} · ${u.title}: ${u.names.join(", ")}`), "");
  }
  if (c.openMeals?.length) {
    parts.push(section("Open meal sign-ups", table(c.openMeals.map((m) => row(esc(m.date || "—"), `${esc(m.meal)}${m.event ? ` · ${esc(m.event)}` : ""}`)))));
    text.push("OPEN MEAL SIGN-UPS", ...c.openMeals.map((m) => `- ${m.meal}${m.event ? ` · ${m.event}` : ""}`), "");
  }
  if (c.travelMissing?.length) {
    parts.push(section("Travel plans missing", table(c.travelMissing.map((x) => row(esc(x.date), `<strong>${esc(x.title)}</strong><div style="color:${MUTED};font-size:13px">${esc(x.families.join(", "))}</div>`)))));
    text.push("TRAVEL PLANS MISSING", ...c.travelMissing.map((x) => `- ${x.title}: ${x.families.join(", ")}`), "");
  }
  if (c.dues) {
    parts.push(section("Dues still owed", p(`Due <strong>${esc(c.dues.due)}</strong>: ${esc(c.dues.families.join(", "))}`)));
    text.push(`DUES STILL OWED (due ${c.dues.due}): ${c.dues.families.join(", ")}`, "");
  }
  if (c.tasks?.length) {
    parts.push(section("Open tasks", table(c.tasks.slice(0, 8).map((k) => row(esc(k.status), `${esc(k.title)}${k.owner ? ` <span style="color:${MUTED}">· ${esc(k.owner)}</span>` : ""}`)))));
    text.push("OPEN TASKS", ...c.tasks.slice(0, 8).map((k) => `- ${k.title}${k.owner ? ` (${k.owner})` : ""}`), "");
  }
  parts.push(button(team, "Open the team"));
  text.push(`Open the team: ${team}`, "", `Notification settings: ${base(d.siteUrl)}/account`, ...(d.unsubscribeUrl ? [`Stop the staff digest: ${d.unsubscribeUrl}`] : []));
  const html = frame({
    preheader: c.unanswered?.length ? `${c.unanswered.reduce((n, u) => n + u.names.length, 0)} answers still missing this week.` : `What's open for ${c.week}.`,
    context: `${d.teamName} · Staff digest`, colors: d.colors, body: parts.join(""),
    footer: footer(d, "staff digest", "on the staff")
  });
  return { subject: `${d.teamName}: staff digest for ${c.week}`, fromName: `${d.teamName} via Teem Hub`, html, text: text.join("\n") + "\n" };
}

export function sampleWeekly(siteUrl: string): WeeklyData {
  return {
    teamName: "Test 13 Blue", teamId: "test-13", clubName: "Test Club", firstName: "Jordan", siteUrl, schedule: "on Sundays at 6:00 PM", hideEmpty: true,
    content: {
      week: "Mon, Oct 26 – Sun, Nov 1", playerFirst: "Maya",
      needs: [{ date: "Thu, Oct 29", title: "Practice", time: "6:00 PM – 8:00 PM" }],
      items: [
        { date: "Tue, Oct 27", title: "Practice", time: "6:00 PM – 8:00 PM", location: "Main gym", cancelled: false, kind: "practice" },
        { date: "Thu, Oct 29", title: "Practice", time: "6:00 PM – 8:00 PM", location: "Main gym", cancelled: false, kind: "practice" },
        { date: "Sat, Oct 31", title: "Fall Classic", time: "Arrive 7:15 AM", location: "Eastside Sports Center", cancelled: false, kind: "tournament" }
      ],
      meals: [{ date: "Sat, Oct 31", meal: "Team snacks", event: "Fall Classic" }],
      dues: { amount: "$150", due: "Sun, Nov 1", late: false },
      pinned: ["Warm-ups and new jerseys are in. Pick them up after Thursday's practice."]
    }
  };
}

export function sampleStaff(siteUrl: string): StaffData {
  return {
    teamName: "Test 13 Blue", teamId: "test-13", clubName: "Test Club", firstName: "Pat", siteUrl, schedule: "on Sundays at 6:00 PM",
    content: {
      week: "Mon, Oct 26 – Sun, Nov 1",
      unanswered: [{ date: "Thu, Oct 29", title: "Practice", names: ["Ella M.", "Grace T.", "Nora P."] }],
      openMeals: [{ date: "Sat, Oct 31", meal: "Saturday lunch", event: "Fall Classic" }],
      travelMissing: [{ date: "Sat, Nov 14", title: "Harvest Open", families: ["Sophie K.", "Ava T."] }],
      dues: { due: "Sun, Nov 1", families: ["Maya P.", "Ella M."] },
      tasks: [{ title: "Hand out warm-ups and jerseys", owner: "Coach Rivera", status: "To do" }]
    }
  };
}
