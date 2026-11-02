/**
 * Questions, problems and ideas (lib/feedback.ts): a family's question to their team's coordinators,
 * the notice site owners get for a new item, and a site owner's reply.
 */
import { box, button, esc, frame, h1, p, textPart } from "./frame.js";
import type { Rendered } from "./templates.js";

const base = (u: string) => u.replace(/\/$/, "");
const privacy = (siteUrl: string) => `<a href="${esc(base(siteUrl))}/privacy" style="color:#15294D">Privacy notice</a>`;
/** The person's own words, kept as they wrote them (line breaks too). */
const words = (s: string) => esc(s).replace(/\r?\n/g, "<br>");

export type TeamQuestionData = {
  ref: string; teamName: string; teamId: string; colors?: { primary?: string; accent?: string };
  fromName: string; fromEmail: string; fromRole: string; message: string; page?: string; siteUrl: string;
};
export type FeedbackNewData = {
  ref: string; kind: "question" | "problem" | "idea"; route: "team" | "teemhub"; id: string;
  fromName: string; fromEmail: string; where: string; message: string; error?: string; shot: boolean; siteUrl: string;
};
export type FeedbackReplyData = { ref: string; firstName?: string; kind: "question" | "problem" | "idea"; original: string; reply: string; byName: string; siteUrl: string };

const KIND: Record<FeedbackNewData["kind"], string> = { question: "Question", problem: "Problem", idea: "Idea" };

/** To a team's coordinators. Replying to the email answers the family directly (Reply-To). */
export function teamQuestion(d: TeamQuestionData): Rendered {
  const html = frame({
    preheader: d.message.slice(0, 140),
    context: `${d.teamName} · Question`, colors: d.colors,
    body: [
      h1(`A question from ${d.fromName}`),
      p(`${esc(d.fromName)} (${esc(d.fromRole)}) asked through Teem Hub${d.page ? `, from <strong>${esc(d.page)}</strong>` : ""}:`),
      box(words(d.message)),
      p(`<strong>Reply to this email</strong> to answer: it goes straight to ${esc(d.fromEmail)}.`),
      p(`Reference ${esc(d.ref)}. You get these as one of ${esc(d.teamName)}'s coordinators.`, true)
    ].join(""),
    footer: [`Questions from families go to the team's coordinators. Teem Hub · ${privacy(d.siteUrl)}`]
  });
  const text = textPart([
    `A question from ${d.fromName} (${d.fromRole})${d.page ? `, from ${d.page}` : ""}:`, "", d.message, "",
    `Reply to this email to answer: it goes straight to ${d.fromEmail}.`, `Reference ${d.ref}.`
  ]);
  return { subject: `Question from ${d.fromName} · ${d.teamName}`, fromName: `${d.teamName} via Teem Hub`, html, text };
}

/** To site owners: a new question, problem or idea. */
export function feedbackNew(d: FeedbackNewData): Rendered {
  const link = `${base(d.siteUrl)}/admin/feedback?item=${encodeURIComponent(d.id)}`;
  const label = d.route === "team" ? "Team question (copy)" : KIND[d.kind];
  const html = frame({
    preheader: d.message.slice(0, 140),
    context: "Site admin · Feedback",
    body: [
      h1(`${label} · ${d.ref}`),
      p(`From <strong>${esc(d.fromName)}</strong> (${esc(d.fromEmail)}) · ${esc(d.where)}`),
      box(words(d.message)),
      d.error ? p(`Error: ${esc(d.error)}`, true) : "",
      d.shot ? p("Includes a screenshot.", true) : "",
      button(link, d.route === "team" ? "Open in Site admin" : "Open and reply"),
      d.route === "team" ? p("This went to the team's coordinators, who answer it. You get a copy because you turned on team questions.", true) : ""
    ].join(""),
    footer: [`Turn these off in Site admin › Feedback. Teem Hub · ${privacy(d.siteUrl)}`]
  });
  const text = textPart([`${label} · ${d.ref}`, `From ${d.fromName} (${d.fromEmail}) · ${d.where}`, "", d.message, "", d.error ? `Error: ${d.error}` : false, `Open: ${link}`]);
  return { subject: `${label} ${d.ref}: ${d.message.replace(/\s+/g, " ").slice(0, 60)}`, fromName: "Teem Hub", html, text };
}

/** A site owner's reply to the person who wrote in. */
export function feedbackReply(d: FeedbackReplyData): Rendered {
  const hi = d.firstName ? `Hi ${d.firstName},` : "Hi,";
  const what = d.kind === "idea" ? "your idea" : d.kind === "problem" ? "the problem you reported" : "your question";
  const html = frame({
    preheader: d.reply.slice(0, 140),
    context: "Teem Hub support",
    body: [
      h1(`About ${what}`),
      p(esc(hi)),
      p(words(d.reply)),
      p(`— ${esc(d.byName)}, Teem Hub`),
      p(`<strong>You wrote</strong> (${esc(d.ref)}):`, true),
      box(words(d.original)),
      p(`Something else? Use <strong>Questions &amp; feedback</strong> at the bottom of any page. Your messages and replies are on <a href="${esc(base(d.siteUrl))}/account" style="color:#15294D">your Account page</a>.`, true)
    ].join(""),
    footer: [`A reply to a message you sent. Teem Hub · ${privacy(d.siteUrl)}`]
  });
  const text = textPart([hi, "", d.reply, "", `— ${d.byName}, Teem Hub`, "", `You wrote (${d.ref}):`, d.original, "",
    `Something else? Use Questions & feedback at the bottom of any page. Your messages: ${base(d.siteUrl)}/account`]);
  return { subject: `Re: ${what} (${d.ref})`, fromName: "Teem Hub", html, text };
}

export const feedbackSamples = {
  teamQuestion: (siteUrl: string): TeamQuestionData => ({ ref: "TH-1040", teamName: "Test 13 Blue", teamId: "test-13", fromName: "Mia Stone", fromEmail: "mom@example.com", fromRole: "parent of Ava", message: "Do we need to bring our own volleyballs to the Fall Classic?", page: "Fall Classic", siteUrl }),
  feedbackNew: (siteUrl: string): FeedbackNewData => ({ ref: "TH-1042", kind: "problem", route: "teemhub", id: "sample", fromName: "Mia Stone", fromEmail: "mom@example.com", where: "Test 13 Blue · Parent · Fall Classic · Travel plans · iPhone", message: "Tried to save our hotel for the Fall Classic and it said it didn't save. Tried twice.", error: "That didn't save (save_failed)", shot: true, siteUrl }),
  feedbackReply: (siteUrl: string): FeedbackReplyData => ({ ref: "TH-1042", firstName: "Mia", kind: "problem", original: "Tried to save our hotel for the Fall Classic and it said it didn't save.", reply: "Thanks, we found the problem and fixed it this morning. Your hotel should save now.", byName: "Sam", siteUrl })
};
