import { sendDeliveries } from "../lib/mail/outbox.js";

/**
 * Sends queued emails (template.yaml MailSenderFunction). The API calls it without waiting, with the
 * ids it queued; Lambda retries a failed call twice. A delivery is only ever sent once: see outbox.ts.
 */
export const handler = async (event: { ids?: unknown }) => {
  const ids = Array.isArray(event.ids) ? event.ids.filter((i): i is string => typeof i === "string" && /^[0-9a-f]{32}$/.test(i)) : [];
  const result = await sendDeliveries(ids);
  console.log(JSON.stringify({ msg: "mail sent", ...result }));
  return result;
};
