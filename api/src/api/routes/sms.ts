/**
 * Text alerts opt-in (Messaging M4 groundwork). A person adds a mobile number and agrees to texts on
 * their Account page; the record keeps the exact words they agreed to and when, which US carriers
 * require. It lives on the profile (USER#<sub> / PROFILE), so "Download my data" includes it and
 * "Delete my account" removes it.
 *
 * Until the toll-free number is approved and the stack has SMS_ORIGINATION set, texting isn't live:
 * only site owners can save a number (to try the screen and capture it for the registration), and
 * nothing is texted. M4 sends the confirmation text and turns status "pending" into "on".
 */
import { BatchGetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { SMS } from "../../shared/privacy.js";
import { badRequest, forbidden, json, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { getItem, now, queryAll } from "../util.js";
import { clubsOfTeams } from "../../lib/clubs.js";
import { allows, getControlsMany, isActive } from "../../lib/club-controls.js";

export const smsLive = () => !!process.env.SMS_ORIGINATION;

/** A US mobile number as +1 and 10 digits, or null. Accepts (555) 555-0123, 555.555.0123, +1 555… */
export function usPhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "");
  const d = digits.startsWith("+") ? digits.slice(1) : digits;
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  // NANP: area code and exchange don't start with 0 or 1.
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
}
export const showPhone = (e164: string) => e164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3");

const saveSchema = z.object({
  phone: z.string().max(30),
  agree: z.literal(true, { errorMap: () => ({ message: "Tick the box to agree to text alerts." }) }),
  consentVersion: z.string().max(20)
});

/** Whether any of this person's teams is in an active club that includes text alerts (site admin dashboard). */
async function clubsAllowTexts(sub: string): Promise<boolean> {
  const teams = (await queryAll({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :u AND begins_with(GSI1SK, :t)", ExpressionAttributeValues: { ":u": `USER#${sub}`, ":t": "TEAM#" } }))
    .filter((m) => m.status === "active").map((m) => String(m.GSI1SK).slice(5));
  if (!teams.length) return false;
  const clubs = [...new Set((await clubsOfTeams(teams)).values())];
  const controls = await getControlsMany(clubs);
  return [...controls.values()].some((c) => isActive(c) && allows(c, "texts"));
}

/** Who may turn text alerts on: site owners always (to try it before launch); others once texting is live and a club of theirs includes it. */
async function mayOptIn(sub: string, live: boolean): Promise<boolean> {
  if (await isSiteOwner(sub)) return true;
  return live && (await clubsAllowTexts(sub));
}

async function isSiteOwner(sub: string): Promise<boolean> {
  const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: [keys.platformAdmin(sub)] } } }));
  return !!res.Responses?.[TABLE]?.length;
}

function view(sms: Record<string, unknown> | undefined) {
  if (!sms || !sms.phone) return { status: "off" as const };
  return { status: String(sms.status), phone: showPhone(String(sms.phone)), agreedAt: String((sms.consent as { at?: string } | undefined)?.at ?? "") };
}

export function smsRoutes(r: Router) {
  r.on("GET", "/me/sms", async ({ caller }) => {
    const live = smsLive();
    const profile = await getItem(keys.profile(caller.sub));
    return json(200, {
      live, allowed: await mayOptIn(caller.sub, live),
      consent: { text: SMS.consent, version: SMS.consentVersion }, ...view(profile?.sms as Record<string, unknown> | undefined)
    });
  });

  r.on("PUT", "/me/sms", async ({ caller, body, event }) => {
    const live = smsLive();
    if (!(await mayOptIn(caller.sub, live))) throw forbidden(live ? "Text alerts aren't included for your teams' club." : "Text alerts aren't available yet.");
    const b = parseBody(saveSchema, body);
    const phone = usPhone(b.phone);
    if (!phone) throw badRequest("Enter a US mobile number, like (555) 555-0123.");
    if (b.consentVersion !== SMS.consentVersion) throw forbidden("The text alerts wording changed. Reload the page and read it again.");
    const at = now();
    const consent = {
      at, version: SMS.consentVersion, text: SMS.consent, method: "web form (Account page)",
      ip: event.requestContext.http?.sourceIp ?? "", userAgent: String(event.headers?.["user-agent"] ?? "").slice(0, 300)
    };
    // "pending" until the confirmation text goes out (M4); then "on".
    const sms = { phone, status: "pending", consent, updatedAt: at };
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.profile(caller.sub), ConditionExpression: "attribute_exists(PK)",
      UpdateExpression: "SET sms = :s", ExpressionAttributeValues: { ":s": sms }
    }));
    console.log(JSON.stringify({ msg: "sms opt-in", sub: caller.sub, live }));
    return json(200, { live, ...view(sms) });
  });

  /** Turn text alerts off: the number is removed; when and how they stopped is kept. */
  r.on("DELETE", "/me/sms", async ({ caller }) => {
    const at = now();
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: keys.profile(caller.sub), ConditionExpression: "attribute_exists(PK)",
      UpdateExpression: "SET sms = :s", ExpressionAttributeValues: { ":s": { status: "off", offAt: at, offBy: "web" } }
    }));
    console.log(JSON.stringify({ msg: "sms opt-out", sub: caller.sub, via: "web" }));
    return json(200, { status: "off" });
  });
}
