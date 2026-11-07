import type { PostConfirmationTriggerHandler } from "aws-lambda";
import { linkNewAccount } from "../lib/link-account.js";

/**
 * Cognito post-confirmation trigger. Runs once the person has verified their email.
 *  - Writes USER#<sub>/PROFILE.
 *  - Turns every INVITE#<email>/TEAM#<t> into TEAM#<t>/MEMBER#<sub> (roles, family) and deletes the invite.
 *  - Turns every INVITE#<email>/CLUB#<c> into CLUB#<c>/ADMIN#<sub>.
 *  - Emails in CLUB_ADMIN_EMAILS also get CLUB#<default club>/ADMIN#<sub>; PLATFORM_ADMIN_EMAILS get PLATFORM/ADMIN#<sub>.
 *    Only here, once (listGrantsAt on the profile): later removal of those records sticks (R17).
 * See lib/link-account.ts. If this fails, the Members page can finish it ("Finish their sign-up").
 */
export const handler: PostConfirmationTriggerHandler = async (event) => {
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") return event;
  const sub = event.request.userAttributes.sub;
  const r = await linkNewAccount(sub, event.request.userAttributes.email ?? "");
  console.log(JSON.stringify({ msg: "linked account", sub, ...r }));
  return event;
};
