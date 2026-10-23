/**
 * Email templates for site owners: the list of messages, a preview with made-up data, and "Send me a
 * test" to their own address, so a template change can be checked in a real inbox before families see it.
 */
import { keys } from "../../lib/keys.js";
import { siteUrl } from "../../lib/mail/invite-mail.js";
import { dispatch, queueEmail } from "../../lib/mail/outbox.js";
import { isLiveMessage, render, sample, type LiveMessage } from "../../lib/mail/templates.js";
import { MESSAGES, type MessageId } from "../../shared/messages.js";
import { requirePlatformAdmin } from "../context.js";
import { badRequest, json, notFound } from "../http.js";
import type { Router } from "../router.js";
import { getItem } from "../util.js";

function liveMsg(id: string): LiveMessage {
  if (!(id in MESSAGES)) throw notFound("There's no message with that name.");
  if (!isLiveMessage(id)) throw badRequest("That message isn't built yet.");
  return id;
}

export function mailRoutes(r: Router) {
  r.on("GET", "/admin/emails", async ({ caller }) => {
    await requirePlatformAdmin(caller, "Only site owners can see email templates.");
    const messages = (Object.keys(MESSAGES) as MessageId[]).map((id) => ({ id, ...MESSAGES[id] }));
    return json(200, { messages, sending: !!process.env.MAIL_FROM || process.env.MAIL_TRANSPORT === "memory" });
  });

  r.on("GET", "/admin/emails/{msg}/preview", async ({ caller, params }) => {
    await requirePlatformAdmin(caller, "Only site owners can see email templates.");
    const msg = liveMsg(params.msg);
    const out = render(msg, sample(msg, siteUrl(), "jordan.parker@example.com") as never);
    return json(200, out);
  });

  r.on("POST", "/admin/emails/{msg}/test", async ({ caller, params }) => {
    await requirePlatformAdmin(caller, "Only site owners can send test emails.");
    const msg = liveMsg(params.msg);
    const profile = await getItem(keys.profile(caller.sub));
    const to = String(profile?.email ?? "");
    if (!to) throw badRequest("Your account has no email address to send to.");
    const { id } = await queueEmail({ msg, to, by: caller.sub, dedupe: `test:${msg}:${caller.sub}:${Date.now()}`, data: sample(msg, siteUrl(), to) as never });
    await dispatch([id]);
    console.log(JSON.stringify({ msg: "test email", by: caller.sub, template: msg }));
    return json(202, { to });
  });
}
