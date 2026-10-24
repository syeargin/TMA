/**
 * One function per live message (shared/messages.ts): the data saved with the delivery record in,
 * subject, sender name, HTML and plain text out. Rendered when the email is sent, so a template fix
 * applies to anything still waiting.
 */
import type { MessageId } from "../../shared/messages.js";
import { box, button, esc, frame, h1, list, p, textPart } from "./frame.js";
import { sampleStaff, sampleWeekly, staffDigest, weekly, type StaffData, type WeeklyData } from "./digests.js";

export type Rendered = { subject: string; fromName: string; html: string; text: string };

export type InviteData = {
  teamName: string; clubName?: string; colors?: { primary?: string; accent?: string };
  inviterName?: string; roles: string[]; playerName?: string; email: string; expires?: string; siteUrl: string;
};
export type ClubInviteData = {
  clubName: string; colors?: { primary?: string; accent?: string }; inviterName?: string; email: string; expires?: string; siteUrl: string;
};
export type AccountDeletedData = { firstName?: string; teams: string[]; siteUrl: string };
export type MfaResetData = { firstName?: string; clubName: string; siteUrl: string };

export type MailData = {
  invite: InviteData; clubInvite: ClubInviteData; accountDeleted: AccountDeletedData; mfaReset: MfaResetData;
  weekly: WeeklyData; staffDigest: StaffData;
};
export type LiveMessage = keyof MailData;

const ROLE_PHRASE: Record<string, string> = {
  admin: "a team admin", coach: "a coach", coordinator: "a team coordinator",
  food: "the food coordinator", finance: "the team's finance contact"
};

/** "Maya Parker's parent or guardian and a coach". */
export function rolePhrase(roles: string[], playerName?: string): string {
  const parts = roles.map((r) => (r === "parent" ? (playerName ? `${playerName}'s parent or guardian` : "a parent or guardian") : ROLE_PHRASE[r])).filter(Boolean) as string[];
  if (!parts.length) return "a member";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "Friday, November 6" in the club's time zone. */
export function longDate(iso?: string, timeZone = "America/New_York"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone }).format(d);
}

const signupLink = (siteUrl: string, email: string) => `${siteUrl.replace(/\/$/, "")}/signup#email=${encodeURIComponent(email)}`;
const signinLink = (siteUrl: string) => `${siteUrl.replace(/\/$/, "")}/signin`;
const privacy = (siteUrl: string) => `<a href="${esc(siteUrl.replace(/\/$/, ""))}/privacy" style="color:#15294D">Privacy notice</a>`;

function invite(d: InviteData): Rendered {
  const who = d.inviterName ? d.inviterName : `The ${d.teamName} staff`;
  const as = rolePhrase(d.roles, d.playerName);
  const until = longDate(d.expires);
  const html = frame({
    preheader: `Join ${d.teamName} on Teem Hub to see the schedule and answer for practices and games.`,
    context: d.clubName ? `${d.teamName} · ${d.clubName}` : d.teamName,
    colors: d.colors,
    body: [
      h1(`You're invited to ${d.teamName}`),
      p(`${esc(who)} added you as <strong>${esc(as)}</strong>. Teem Hub is where the team keeps its schedule, availability, tournament details and sign-ups.`),
      button(signupLink(d.siteUrl, d.email), "Accept the invite"),
      p(`Create your account with <strong>${esc(d.email)}</strong>. You'll choose a password, and we'll email a code to confirm the address.`, true),
      p(`Already have a Teem Hub account with this address? <a href="${esc(signinLink(d.siteUrl))}" style="color:#15294D">Sign in</a> and the team appears on Your teams.`, true),
      box(`This invite works only for <strong>${esc(d.email)}</strong>${until ? ` and expires on <strong>${esc(until)}</strong>` : ""}. If it runs out, ask the coach or team coordinator to send a new one.`)
    ].join(""),
    footer: [
      `Not expecting this, or not ${esc(as)}? Ignore this email. Nothing happens unless you accept, and the invite expires on its own.`,
      `Teem Hub · ${privacy(d.siteUrl)}`
    ]
  });
  const text = textPart([
    `You're invited to ${d.teamName}`,
    "",
    `${who} added you as ${as}. Teem Hub is where the team keeps its schedule, availability, tournament details and sign-ups.`,
    "",
    `Accept the invite: ${signupLink(d.siteUrl, d.email)}`,
    "",
    `Create your account with ${d.email}. Already have an account with this address? Sign in at ${signinLink(d.siteUrl)} and the team appears on Your teams.`,
    "",
    `This invite works only for ${d.email}${until ? ` and expires on ${until}` : ""}.`,
    "",
    "Not expecting this? Ignore this email. Nothing happens unless you accept.",
    `Privacy notice: ${d.siteUrl.replace(/\/$/, "")}/privacy`
  ]);
  return { subject: `${who} invited you to ${d.teamName} on Teem Hub`, fromName: `${d.teamName} via Teem Hub`, html, text };
}

function clubInvite(d: ClubInviteData): Rendered {
  const who = d.inviterName || "A site owner";
  const until = longDate(d.expires);
  const html = frame({
    preheader: `Run ${d.clubName}'s teams on Teem Hub.`,
    context: d.clubName,
    colors: d.colors,
    body: [
      h1(`You're invited to run ${d.clubName}`),
      p(`${esc(who)} made you a <strong>club admin</strong> of ${esc(d.clubName)} on Teem Hub. Club admins add teams, upload the club's spreadsheets and help every team's staff.`),
      button(signupLink(d.siteUrl, d.email), "Accept the invite"),
      p(`Create your account with <strong>${esc(d.email)}</strong>, or <a href="${esc(signinLink(d.siteUrl))}" style="color:#15294D">sign in</a> if you already have one. Club admins turn on two-step sign-in before using the club tools; the site walks you through it.`, true),
      box(`This invite works only for <strong>${esc(d.email)}</strong>${until ? ` and expires on <strong>${esc(until)}</strong>` : ""}.`)
    ].join(""),
    footer: [
      "Not expecting this? Ignore this email. Nothing happens unless you accept.",
      `Teem Hub · ${privacy(d.siteUrl)}`
    ]
  });
  const text = textPart([
    `You're invited to run ${d.clubName}`,
    "",
    `${who} made you a club admin of ${d.clubName} on Teem Hub.`,
    "",
    `Accept the invite: ${signupLink(d.siteUrl, d.email)}`,
    `Already have an account? Sign in: ${signinLink(d.siteUrl)}`,
    "",
    `This invite works only for ${d.email}${until ? ` and expires on ${until}` : ""}.`,
    "Not expecting this? Ignore this email."
  ]);
  return { subject: `You're invited to be a club admin of ${d.clubName}`, fromName: `${d.clubName} via Teem Hub`, html, text };
}

function accountDeleted(d: AccountDeletedData): Rendered {
  const hi = d.firstName ? `Hi ${d.firstName},` : "Hi,";
  const teams = d.teams.length ? list(d.teams.map(esc)) : "";
  const html = frame({
    preheader: "Your Teem Hub account and sign-in are gone.",
    context: "Your account",
    body: [
      h1("Your account was deleted"),
      p(`${esc(hi)} as you asked, we deleted your Teem Hub account: your sign-in, your profile, your team memberships and pending invites, and your name, phone and email on your player's roster entry.`),
      d.teams.length ? p("You're no longer on:") + teams + "<div style=\"height:12px\"></div>" : "",
      p("A team's own records, like its schedule and fund entries, stay with the team. To have your player removed from a roster, ask that team's coordinator.", true),
      p("Didn't do this? Replies to this address aren't read, so contact your team coordinator right away.", true)
    ].join(""),
    footer: [
      "This is a required notice about your Teem Hub account. It's the last email we'll send to this address unless you're invited again.",
      `Teem Hub · ${privacy(d.siteUrl)}`
    ]
  });
  const text = textPart([
    "Your account was deleted",
    "",
    `${hi} as you asked, we deleted your Teem Hub account: your sign-in, profile, team memberships, pending invites, and your name, phone and email on your player's roster entry.`,
    d.teams.length ? `\nYou're no longer on: ${d.teams.join(", ")}` : false,
    "",
    "A team's own records stay with the team. To have your player removed from a roster, ask that team's coordinator.",
    "Didn't do this? Contact your team coordinator right away."
  ]);
  return { subject: "Your Teem Hub account was deleted", fromName: "Teem Hub", html, text };
}

function mfaReset(d: MfaResetData): Rendered {
  const hi = d.firstName ? `Hi ${d.firstName},` : "Hi,";
  const link = `${d.siteUrl.replace(/\/$/, "")}/security`;
  const html = frame({
    preheader: "Set up your authenticator app again to keep using the club tools.",
    context: "Your account",
    body: [
      h1("Two-step sign-in was reset"),
      p(`${esc(hi)} a Teem Hub site owner turned off the authenticator app on your account, usually because a phone was lost or replaced. You're still an admin of <strong>${esc(d.clubName)}</strong>.`),
      p("Set it up again before you use the club tools:"),
      button(link, "Set up two-step sign-in"),
      p("Didn't ask for this? Tell the site owner who runs Teem Hub for your club right away, and change your password.", true)
    ].join(""),
    footer: ["This is a required security notice about your Teem Hub account.", `Teem Hub · ${privacy(d.siteUrl)}`]
  });
  const text = textPart([
    "Two-step sign-in was reset",
    "",
    `${hi} a Teem Hub site owner turned off the authenticator app on your account. You're still an admin of ${d.clubName}.`,
    `Set it up again before you use the club tools: ${link}`,
    "",
    "Didn't ask for this? Tell the site owner right away and change your password."
  ]);
  return { subject: "Your Teem Hub two-step sign-in was reset", fromName: "Teem Hub", html, text };
}

const RENDER: { [K in LiveMessage]: (d: MailData[K]) => Rendered } = { invite, clubInvite, accountDeleted, mfaReset, weekly, staffDigest };

export function render<K extends LiveMessage>(msg: K, data: MailData[K]): Rendered {
  return RENDER[msg](data);
}

export const isLiveMessage = (m: string): m is LiveMessage => m in RENDER;

/** Made-up data for previews and "Send me a test". */
export function sample(msg: LiveMessage, siteUrl: string, email: string): MailData[LiveMessage] {
  const expires = new Date(Date.now() + 14 * 86400_000).toISOString();
  switch (msg) {
    case "invite": return { teamName: "Test 13 Blue", clubName: "Test Club", inviterName: "Coach Rivera", roles: ["parent"], playerName: "Maya", email, expires, siteUrl };
    case "clubInvite": return { clubName: "Test Club", inviterName: "Sam Y.", email, expires, siteUrl };
    case "accountDeleted": return { firstName: "Jordan", teams: ["Test 13 Blue"], siteUrl };
    case "mfaReset": return { firstName: "Jordan", clubName: "Test Club", siteUrl };
    case "weekly": return sampleWeekly(siteUrl);
    case "staffDigest": return sampleStaff(siteUrl);
  }
}

export type { MessageId };
