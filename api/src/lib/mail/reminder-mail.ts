/**
 * Messaging M2b templates: tournament packet, availability reminder, dues reminder, payment recorded,
 * announcement email. Content comes from lib/comms/reminders.ts and lib/comms/events.ts.
 */
import type { AvailabilityContent, DuesContent, PacketContent } from "../comms/reminders.js";
import { base, footer, label, row, section, table, type Common } from "./digests.js";
import { box, button, esc, FONT, frame, h1, MUTED, p } from "./frame.js";
import type { Rendered } from "./templates.js";

export type PacketData = Common & { firstName?: string; content: PacketContent };
export type AvailabilityData = Common & { firstName?: string; content: AvailabilityContent };
export type DuesData = Common & { firstName?: string; content: DuesContent };
export type PaymentData = Common & {
  firstName?: string; kind: "in" | "out"; amount: string; what: string; playerFirst?: string; date: string; recordedBy?: string; duesLeft?: string;
};
export type AnnouncementData = Common & { author: string; text: string; posted: string; pinned: boolean };

const teamUrl = (d: Common) => `${base(d.siteUrl)}/teams/${encodeURIComponent(d.teamId)}`;
const textFooter = (d: Common, what: string) => ["", `Notification settings: ${base(d.siteUrl)}/account`, ...(d.unsubscribeUrl ? [`Stop the ${what}: ${d.unsubscribeUrl}`] : [])];

export function packet(d: PacketData): Rendered {
  const c = d.content;
  const link = `${teamUrl(d)}/tournaments/${encodeURIComponent(c.eid)}`;
  const parts = [
    label("Tournament packet"),
    h1(c.title),
    p(`${esc(c.dates)}${c.place ? ` · ${esc(c.place)}` : ""}`, true)
  ];
  if (c.rows.length) parts.push(section("Game-day sheet", table(c.rows.map((r) => row(esc(r.label), esc(r.value))))));
  if (c.bring.length) parts.push(section("Bring", `<ul style="margin:0 0 14px;padding-left:20px;font-family:${FONT};font-size:14px">${c.bring.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`));
  if (c.hotel || c.travelMissing) {
    parts.push(box(label("Travel weekend") +
      (c.hotel ? `<div><strong>Team hotel:</strong> ${esc(c.hotel.name)}${c.hotel.code ? ` · code ${esc(c.hotel.code)}` : ""}${c.hotel.by ? ` · book by ${esc(c.hotel.by)}` : ""}${c.hotel.link ? ` · <a href="${esc(c.hotel.link)}" style="color:#15294D">Book</a>` : ""}</div>` : "") +
      (c.travelMissing ? `<div style="margin-top:6px">Your travel plans aren't in yet. <a href="${esc(link)}" style="color:#15294D;font-weight:700">Add them</a> so the coach knows who's driving.</div>` : "")));
  }
  if (c.jobs.length) parts.push(box(label("Your jobs", "#7A4E04") + c.jobs.map((j) => `<div>${esc(j)}</div>`).join("")));
  parts.push(button(link, "Open the game-day sheet"));
  const html = frame({
    preheader: `${c.dates}${c.rows[0] ? ` · ${c.rows[0].label}: ${c.rows[0].value}` : ""}`,
    context: `${d.teamName} · Tournament packet`, colors: d.colors, body: parts.join(""),
    footer: footer(d, "tournament packets", c.playerFirst ? `${c.playerFirst}'s family` : "on the staff")
  });
  const text = [
    `${c.title}: ${c.dates}${c.place ? ` · ${c.place}` : ""}`, "",
    ...c.rows.map((r) => `${r.label}: ${r.value}`),
    ...(c.bring.length ? ["", "BRING", ...c.bring.map((b) => `- ${b}`)] : []),
    ...(c.hotel ? ["", `Team hotel: ${c.hotel.name}${c.hotel.code ? ` (code ${c.hotel.code})` : ""}${c.hotel.by ? `, book by ${c.hotel.by}` : ""}`] : []),
    ...(c.travelMissing ? ["Your travel plans aren't in yet."] : []),
    ...(c.jobs.length ? ["", "YOUR JOBS", ...c.jobs.map((j) => `- ${j}`)] : []),
    "", `Game-day sheet: ${link}`, ...textFooter(d, "tournament packets")
  ].join("\n") + "\n";
  return { subject: `${c.title} packet · ${c.dates}`, fromName: `${d.teamName} via Teem Hub`, html, text };
}

const answerButton = (href: string, text: string, bg: string, fg: string, border: string) =>
  `<td style="padding:0 6px 0 0"><a href="${esc(href)}" style="display:inline-block;min-width:76px;text-align:center;padding:10px 14px;border-radius:8px;border:2px solid ${border};background:${bg};color:${fg};font-family:${FONT};font-size:15px;font-weight:700;text-decoration:none">${text}</a></td>`;

export function availability(d: AvailabilityData): Rendered {
  const c = d.content;
  const who = c.playerFirst || "your player";
  const parts = [h1(`Can ${who} make it?`), p(`The coach is planning and doesn't have ${esc(who)}'s answer yet. Tap one: it's recorded right away.`)];
  for (const i of c.items) {
    parts.push(`<div style="border:1px solid #E6EAF1;border-radius:10px;padding:14px 16px;margin:0 0 12px">` +
      `<div style="font-family:${FONT};font-size:16px;font-weight:700;color:#101B2E">${esc(i.date)} · ${esc(i.title)}</div>` +
      `<div style="font-family:${FONT};font-size:14px;color:${MUTED};margin:2px 0 10px">${esc([i.time, i.location].filter(Boolean).join(" · "))}</div>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
      answerButton(i.links.yes, "In", "#DFF2E8", "#105C3A", "#17744A") +
      answerButton(i.links.maybe, "Maybe", "#FAEFD6", "#6E4704", "#8F5C05") +
      answerButton(i.links.no, "Out", "#FDE7E4", "#8E1C13", "#B42318") +
      `</tr></table></div>`);
  }
  parts.push(p(`You can change it any time, or add a note, on the <a href="${esc(teamUrl(d))}/schedule" style="color:#15294D">schedule</a>.`, true));
  const first = c.items[0];
  const html = frame({
    preheader: first ? `${first.date} · ${first.title}. One tap to answer In, Maybe or Out.` : "One tap to answer.",
    context: `${d.teamName} · Availability`, colors: d.colors, body: parts.join(""),
    footer: footer(d, "availability reminders", `${who}'s family`)
  });
  const text = [
    `Can ${who} make it?`, "",
    ...c.items.flatMap((i) => [`${i.date} · ${i.title}${i.time ? ` (${i.time})` : ""}`, `  In: ${i.links.yes}`, `  Maybe: ${i.links.maybe}`, `  Out: ${i.links.no}`, ""]),
    `Schedule: ${teamUrl(d)}/schedule`, ...textFooter(d, "availability reminders")
  ].join("\n") + "\n";
  const subject = c.items.length === 1 ? `Can ${who} make ${first!.title.toLowerCase().startsWith("practice") ? first!.date.split(",")[0] + "'s practice" : first!.title}?` : `Can ${who} make it? ${c.items.length} dates to answer`;
  return { subject, fromName: `${d.teamName} via Teem Hub`, html, text };
}

export function dues(d: DuesData): Rendered {
  const c = d.content;
  const fund = `${teamUrl(d)}/fund`;
  const html = frame({
    preheader: c.late ? `${c.owed} in ${c.label.toLowerCase()} was due ${c.due}.` : `${c.owed} in ${c.label.toLowerCase()} is due ${c.due}.`,
    context: `${d.teamName} · Dues`, colors: d.colors,
    body: [
      label(c.late ? `Was due ${c.due}` : `Due ${c.due}`),
      h1(c.owed),
      p(`Still owed for ${esc(c.playerFirst || "your player")}'s ${esc(c.label.toLowerCase())}.`),
      table([row("Total", esc(c.total)), row("Paid", esc(c.paid)), row("Owed", `<strong>${esc(c.owed)}</strong>`)]),
      button(fund, "See the team fund"),
      p("Already paid? It shows once finance records it. Questions go to the team's finance contact through Teem Hub.", true)
    ].join(""),
    footer: footer(d, "dues reminders", `${c.playerFirst || "a"}'s family`)
  });
  const text = [`${c.owed} in ${c.label.toLowerCase()} ${c.late ? "was" : "is"} due ${c.due}`, `Total ${c.total}, paid ${c.paid}.`, "", `Team fund: ${fund}`, ...textFooter(d, "dues reminders")].join("\n") + "\n";
  return { subject: c.late ? `${d.teamName}: dues were due ${c.due}` : `${d.teamName}: ${c.owed} in dues due ${c.due}`, fromName: `${d.teamName} via Teem Hub`, html, text };
}

export function payment(d: PaymentData): Rendered {
  const isIn = d.kind === "in";
  const title = isIn ? "Payment recorded" : "Reimbursement approved";
  const rows = [
    row("Amount", `<strong>${esc(d.amount)}</strong>`),
    row("For", esc([d.playerFirst, d.what].filter(Boolean).join(" · "))),
    row("Date", esc(d.date)),
    ...(d.recordedBy ? [row("By", esc(d.recordedBy))] : []),
    ...(d.duesLeft ? [row("Dues left", esc(d.duesLeft))] : [])
  ];
  const html = frame({
    preheader: `${d.amount} · ${d.what}`, context: `${d.teamName} · Team fund`, colors: d.colors,
    body: [h1(title), p(isIn ? "Here's what the team's finance contact logged." : "Finance approved your request to be paid back."), table(rows),
      p("This is the team's record, not a bank or card receipt.", true), button(`${teamUrl(d)}/fund`, "See the team fund")].join(""),
    footer: footer(d, "payment emails", isIn ? "a family" : "on the team")
  });
  const text = [title, `${d.amount} · ${d.what}${d.playerFirst ? ` · ${d.playerFirst}` : ""}`, d.date, ...(d.duesLeft ? [`Dues left: ${d.duesLeft}`] : []), "", "This is the team's record, not a bank or card receipt.", ...textFooter(d, "payment emails")].join("\n") + "\n";
  return { subject: isIn ? `Payment recorded: ${d.amount}${d.playerFirst ? ` for ${d.playerFirst}` : ""}` : `Reimbursement approved: ${d.amount}`, fromName: `${d.teamName} via Teem Hub`, html, text };
}

export function announcement(d: AnnouncementData): Rendered {
  const firstLine = d.text.split("\n")[0].slice(0, 80);
  const html = frame({
    preheader: d.text.slice(0, 120), context: `${d.teamName} · Announcement`, colors: d.colors,
    body: [
      p(`<strong>${esc(d.author)}</strong> <span style="color:${MUTED}">· ${esc(d.posted)}${d.pinned ? " · pinned" : ""}</span>`),
      `<div style="font-family:${FONT};font-size:15px;line-height:1.6;color:#101B2E;margin:0 0 16px">${esc(d.text).replace(/\n/g, "<br>")}</div>`,
      button(teamUrl(d), "Open Teem Hub"),
      p("Replies to this email aren't read. Answer in Teem Hub so the team sees it.", true)
    ].join(""),
    footer: footer(d, "announcement emails", "on the team")
  });
  const text = [`${d.author} · ${d.posted}`, "", d.text, "", `Open Teem Hub: ${teamUrl(d)}`, ...textFooter(d, "announcement emails")].join("\n") + "\n";
  return { subject: `${d.teamName}: ${firstLine}`, fromName: `${d.author} via Teem Hub`, html, text };
}

const common = (siteUrl: string): Common => ({ teamName: "Test 13 Blue", teamId: "test-13", clubName: "Test Club", siteUrl, schedule: "a week before each tournament" });

export const samples = {
  packet: (siteUrl: string): PacketData => ({ ...common(siteUrl), content: {
    eid: "e1", title: "Fall Classic", dates: "Sat, Oct 31 – Sun, Nov 1", place: "Eastside Sports Center, Columbus", travel: true,
    rows: [{ label: "Arrive", value: "7:15 AM" }, { label: "First match", value: "8:00 AM, Court 6" }, { label: "Wear", value: "Red jersey, black shorts" }],
    bring: ["Water bottle", "Both jerseys", "Knee pads"], hotel: { name: "Example Inn", by: "Oct 27", code: "TEAM13", link: "" },
    travelMissing: true, jobs: ["You signed up for Saturday lunch (Sat, Oct 31)."], playerFirst: "Maya"
  } }),
  availability: (siteUrl: string): AvailabilityData => ({ ...common(siteUrl), schedule: "2 days before each practice and event", content: {
    playerFirst: "Maya", items: [{ date: "Thu, Oct 29", title: "Practice", time: "6:00 PM – 8:00 PM", location: "Main gym", links: { yes: `${siteUrl}/answer#t=sample`, maybe: `${siteUrl}/answer#t=sample`, no: `${siteUrl}/answer#t=sample` } }]
  } }),
  dues: (siteUrl: string): DuesData => ({ ...common(siteUrl), schedule: "5 days before dues are due", content: { playerFirst: "Maya", owed: "$150", total: "$300", paid: "$150", due: "Sun, Nov 1", label: "Season dues", late: false } }),
  payment: (siteUrl: string): PaymentData => ({ ...common(siteUrl), schedule: "when finance records a payment", kind: "in", amount: "$150", what: "Dues", playerFirst: "Maya", date: "Wed, Oct 28", recordedBy: "Pat Lee", duesLeft: "$150" }),
  announcement: (siteUrl: string): AnnouncementData => ({ ...common(siteUrl), schedule: "when a coach emails a post", author: "Coach Rivera", text: "Warm-ups and new jerseys are in!\nPick them up after Thursday's practice.", posted: "Mon, Oct 26", pinned: true })
};
