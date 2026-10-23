// Every email and text Teem Hub sends, shared by the API and the site (the Communications page in M2).
// "live" messages are sent today; the rest are planned (see the build plan, Messaging) and listed so
// the catalog is the one place a message is described. Required messages ignore personal opt-outs.

export type Channel = "email" | "text";

export const MESSAGES = {
  invite:          { channel: "email", label: "Team invites", help: "The link to join a team, sent to the invited address.", required: true, live: true },
  clubInvite:      { channel: "email", label: "Club admin invites", help: "The link to become a club admin, sent to the invited address.", required: true, live: true },
  accountDeleted:  { channel: "email", label: "Account deleted", help: "Confirms that someone deleted their account.", required: true, live: true },
  mfaReset:        { channel: "email", label: "Two-step sign-in reset", help: "Tells a club admin a site owner turned off their authenticator app.", required: true, live: true },
  weekly:          { channel: "email", label: "Weekly at-a-glance", help: "Each family's week.", required: false, live: false },
  staffDigest:     { channel: "email", label: "Staff digest", help: "What's still open, for coaches and coordinators.", required: false, live: false },
  packet:          { channel: "email", label: "Tournament packet", help: "Game-day details a week before a tournament.", required: false, live: false },
  availability:    { channel: "email", label: "Availability reminder", help: "For families who haven't answered.", required: false, live: false },
  dues:            { channel: "email", label: "Dues reminder", help: "Before an installment is due.", required: false, live: false },
  payment:         { channel: "email", label: "Payment recorded", help: "Confirms what the treasurer logged.", required: false, live: false },
  announcement:    { channel: "email", label: "Announcement emails", help: "Posts a coach chooses to email.", required: false, live: false },
  changeText:      { channel: "text", label: "Cancelled or moved", help: "Last-minute changes.", required: false, live: false },
  gameDayText:     { channel: "text", label: "Game-day morning", help: "Arrival time and where to meet.", required: false, live: false },
  waveText:        { channel: "text", label: "Wave or court posted", help: "Tournament schedule posted.", required: false, live: false },
  urgentText:      { channel: "text", label: "Urgent announcements", help: "Weather and closures.", required: false, live: false },
  dutyText:        { channel: "text", label: "Duty reminder", help: "Line judge, scorebook and snacks.", required: false, live: false }
} as const satisfies Record<string, { channel: Channel; label: string; help: string; required: boolean; live: boolean }>;

export type MessageId = keyof typeof MESSAGES;
export const LIVE_MESSAGES = (Object.keys(MESSAGES) as MessageId[]).filter((m) => MESSAGES[m].live);

/** Where a sent email stands, as shown next to an invite. */
export type EmailStatus = "queued" | "sent" | "delivered" | "bounced" | "complained" | "failed" | "skipped";

export const EMAIL_STATUS_LABELS: Record<EmailStatus, string> = {
  queued: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  bounced: "Bounced",
  complained: "Marked as spam",
  failed: "Couldn't send",
  skipped: "Email off here"
};
