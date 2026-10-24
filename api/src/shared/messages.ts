// Every email and text Teem Hub sends, shared by the API and the site (the Communications page in M2).
// "live" messages are sent today; the rest are planned (see the build plan, Messaging) and listed so
// the catalog is the one place a message is described. Required messages ignore personal opt-outs.

export type Channel = "email" | "text";

export const MESSAGES = {
  invite:          { channel: "email", label: "Team invites", help: "The link to join a team, sent to the invited address.", required: true, live: true },
  clubInvite:      { channel: "email", label: "Club admin invites", help: "The link to become a club admin, sent to the invited address.", required: true, live: true },
  accountDeleted:  { channel: "email", label: "Account deleted", help: "Confirms that someone deleted their account.", required: true, live: true },
  mfaReset:        { channel: "email", label: "Two-step sign-in reset", help: "Tells a club admin a site owner turned off their authenticator app.", required: true, live: true },
  weekly:          { channel: "email", label: "Weekly at-a-glance", help: "Each family's week: events, what needs an answer, sign-ups, dues and pinned posts.", required: false, live: true },
  staffDigest:     { channel: "email", label: "Staff digest", help: "Who hasn't answered, open meals, missing travel plans, dues and tasks. Each person sees only what their role can see.", required: false, live: true },
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


// ---------- What a team can change (Messaging M2, the Communications page) ----------

/** When a scheduled message goes out. day: 0 = Sunday; time: "18:00" in the team's time zone. */
export type Timing = { kind: "weekly"; day: number; time: string };

export type Choice = { key: string; label: string; on: boolean };

export type MessageConfig = {
  timing: Timing;
  /** Who gets it; each is on or off by default. */
  audience: Choice[];
  /** Rules that keep it relevant. */
  rules: Choice[];
};

/** The scheduled messages a team can set up today. Others follow in later stages. */
export const CONFIG: Partial<Record<MessageId, MessageConfig>> = {
  weekly: {
    timing: { kind: "weekly", day: 0, time: "18:00" },
    audience: [
      { key: "parent", label: "Parents and guardians", on: true },
      { key: "staff", label: "Staff who aren't parents (they also get the staff digest)", on: false }
    ],
    rules: [
      { key: "skipEmpty", label: "Skip the week if nothing is scheduled and nothing needs an answer", on: true },
      { key: "hideEmpty", label: "Leave out sections with nothing in them", on: true }
    ]
  },
  staffDigest: {
    timing: { kind: "weekly", day: 0, time: "18:00" },
    audience: [
      { key: "admin", label: "Team admins", on: true },
      { key: "coach", label: "Coaches", on: true },
      { key: "coordinator", label: "Team coordinators", on: true },
      { key: "food", label: "Food coordinator (meals only)", on: true },
      { key: "finance", label: "Finance (dues only)", on: true }
    ],
    rules: [{ key: "skipEmpty", label: "Skip the week if nothing is open", on: true }]
  }
};

export const CONFIGURABLE = Object.keys(CONFIG) as MessageId[];

/** A team's saved choices (META#COMMS). Only what the team changed is stored. */
export type MessageSettings = { on?: boolean; day?: number; time?: string; audience?: Record<string, boolean>; rules?: Record<string, boolean> };
export type TeamComms = {
  messages?: Partial<Record<MessageId, MessageSettings>>;
  /** IANA time zone the times are in. */
  timeZone?: string;
  /** No optional messages until this date (YYYY-MM-DD), inclusive. */
  pauseUntil?: string;
  /** Single sends skipped from the Upcoming tab, like "weekly:2026-10-25". */
  skipped?: string[];
};

export const DEFAULT_TIME_ZONE = "America/New_York";

/** A message's settings with the team's choices on top of the defaults. */
export function effective(msg: MessageId, comms: TeamComms | null | undefined) {
  const c = CONFIG[msg];
  const mine = comms?.messages?.[msg] ?? {};
  if (!c) return null;
  return {
    // Off until a team turns it on, so nothing new reaches families the day this ships.
    on: mine.on ?? false,
    day: mine.day ?? c.timing.day,
    time: mine.time ?? c.timing.time,
    audience: Object.fromEntries(c.audience.map((a) => [a.key, mine.audience?.[a.key] ?? a.on])) as Record<string, boolean>,
    rules: Object.fromEntries(c.rules.map((r) => [r.key, mine.rules?.[r.key] ?? r.on])) as Record<string, boolean>
  };
}

/** "18:00" → "6:00 PM". */
export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
