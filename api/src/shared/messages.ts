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
  packet:          { channel: "email", label: "Tournament packet", help: "Before each tournament: the game-day sheet, the hotel, and each family's own jobs.", required: false, live: true },
  availability:    { channel: "email", label: "Availability reminder", help: "Asks families who haven't answered In, Maybe or Out, with one-tap answers.", required: false, live: true },
  dues:            { channel: "email", label: "Dues reminder", help: "Before dues are due, to families who still owe.", required: false, live: true },
  payment:         { channel: "email", label: "Payment recorded", help: "Confirms a payment or a reimbursement when finance records it.", required: false, live: true },
  announcement:    { channel: "email", label: "Announcement emails", help: "Posts a coach or coordinator chooses to email, with \"Also email the team\".", required: false, live: true },
  change:          { channel: "email", label: "Cancelled or moved", help: "When the club's calendar cancels a practice or event in the next two weeks, or changes its day, time, place or court.", required: false, live: true },
  feedAlert:       { channel: "email", label: "Calendar feed alerts", help: "Tells team admins and coordinators when the club's calendar feed needs them: events to review, a feed that stopped matching, or one that can't be read.", required: false, live: true },
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

/**
 * When a message goes out, in the team's time zone: every week (day 0 = Sunday, time "18:00"),
 * a number of days before something (a tournament, an event, a due date), or when something happens.
 */
export type Timing =
  | { kind: "weekly"; day: number; time: string }
  | { kind: "before"; days: number; time: string; what: string }
  | { kind: "event"; when: string };

export type Choice = { key: string; label: string; on: boolean };

export type MessageConfig = {
  timing: Timing;
  /** On before a team chooses (most messages start off, so nothing new reaches families the day it ships). */
  defaultOn?: boolean;
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
  },
  packet: {
    timing: { kind: "before", days: 7, time: "09:00", what: "the tournament" },
    audience: [
      { key: "parent", label: "Parents and guardians", on: true },
      { key: "staff", label: "Staff who aren't parents", on: false }
    ],
    rules: [{ key: "travelOnly", label: "Only for travel tournaments", on: false }]
  },
  availability: {
    timing: { kind: "before", days: 2, time: "18:00", what: "the practice or event" },
    audience: [{ key: "parent", label: "Parents who haven't answered", on: true }],
    rules: [
      { key: "tournamentsOnly", label: "Only for tournaments, not practices", on: false },
      { key: "skipIfWeekly", label: "Skip it when the weekly email asked them in the last two days", on: true }
    ]
  },
  dues: {
    timing: { kind: "before", days: 5, time: "09:00", what: "dues are due" },
    audience: [{ key: "parent", label: "Families who still owe", on: true }],
    rules: [{ key: "late", label: "Send one more the day after they're due", on: false }]
  },
  payment: {
    timing: { kind: "event", when: "When finance records a payment or approves a reimbursement." },
    audience: [
      { key: "parent", label: "The family who paid", on: true },
      { key: "reimb", label: "Whoever asked to be paid back", on: true }
    ],
    rules: []
  },
  announcement: {
    timing: { kind: "event", when: "When someone posting ticks \"Also email the team\"." },
    audience: [
      { key: "parent", label: "Parents and guardians", on: true },
      { key: "staff", label: "Staff", on: true }
    ],
    rules: [{ key: "cap", label: "At most 2 announcement emails a week", on: true }]
  },
  change: {
    timing: { kind: "event", when: "When the club's calendar cancels or moves something in the next two weeks." },
    audience: [
      { key: "parent", label: "Parents and guardians", on: true },
      { key: "staff", label: "Staff who aren't parents", on: true }
    ],
    rules: [
      { key: "court", label: "Include court changes", on: true },
      { key: "overnight", label: "Hold changes found after 9 PM until 7 AM", on: true }
    ]
  },
  feedAlert: {
    timing: { kind: "event", when: "When the calendar feed needs a team admin or coordinator." },
    defaultOn: true,
    audience: [
      { key: "admin", label: "Team admins", on: true },
      { key: "coordinator", label: "Team coordinators", on: true }
    ],
    rules: []
  }
};

/** Messages that only make sense with a team feature on. */
export const NEEDS_FEATURE: Partial<Record<MessageId, "fund" | "calfeed">> = { dues: "fund", payment: "fund", change: "calfeed", feedAlert: "calfeed" };

export const CONFIGURABLE = Object.keys(CONFIG) as MessageId[];

/** A team's saved choices (META#COMMS). Only what the team changed is stored. */
export type MessageSettings = { on?: boolean; day?: number; time?: string; days?: number; audience?: Record<string, boolean>; rules?: Record<string, boolean> };
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
  const t = c.timing;
  return {
    // Off until a team turns it on, so nothing new reaches families the day this ships.
    on: mine.on ?? c.defaultOn ?? false,
    kind: t.kind,
    day: mine.day ?? (t.kind === "weekly" ? t.day : 0),
    time: mine.time ?? (t.kind === "event" ? "" : t.time),
    days: mine.days ?? (t.kind === "before" ? t.days : 0),
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
