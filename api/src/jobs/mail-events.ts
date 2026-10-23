import { applySesEvent, type SesEvent } from "../lib/mail/outbox.js";

/**
 * SES delivery, bounce, complaint and reject events for this environment's emails, from the domain
 * stack's configuration set through EventBridge (template.yaml MailEventsFunction). The rule only
 * passes events tagged with this environment, so dev never sees prod's mail or the reverse.
 */
export const handler = async (event: { detail?: SesEvent }) => {
  if (event.detail) await applySesEvent(event.detail);
};
