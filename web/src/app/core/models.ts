import type { EventSource, FeedEvent, FeedRules, FilterSuggestion, PresetId, ReviewItem } from '@shared/feed-rules';
import type { EmailStatus } from '@shared/messages';
import type { ClubFeature, FeatureMap } from '@shared/features';
import type { AttendanceRecord } from '@shared/attendance';
import type { Role } from '@shared/permissions';

export interface MyTeam { teamId: string; name?: string; roles: Role[]; pid?: string; clubId?: string; archived?: boolean; clubInactive?: boolean }
export interface ClubLink { label: string; url: string }
export interface Club { clubId: string; name: string; short: string; colors: { primary: string; accent: string }; links: ClubLink[]; notes: string }
/** A club you're in through a team (admin: false) or run (admin: true). */
export interface MyClub extends Club { admin: boolean; inactive?: boolean }
/** What a site owner set for a club (site admin dashboard), as team members see it. */
export interface ClubControlsView { status: 'active' | 'inactive'; features: Partial<Record<ClubFeature, boolean>>; teamLimit: number | null; activeTeams?: number }
/** One club on the site admin dashboard. */
export interface AdminClub {
  clubId: string; name: string; short: string; colors?: { primary: string; accent: string };
  status: 'active' | 'inactive'; statusReason: string; statusAt: string;
  teamLimit: number | null; activeTeams: number; archivedTeams: number; admins: number;
  features: Partial<Record<ClubFeature, boolean>>; teams: { teamId: string; name: string }[];
}
export interface ClubHistory { at: string; by: string; changes: string[]; reason: string }
export interface Me {
  sub?: string; email?: string; firstName?: string; lastName?: string; teams: MyTeam[];
  /** Runs at least one club. */
  clubAdmin?: boolean;
  /** Site owner: adds clubs, can open any club. */
  platformAdmin?: boolean;
  clubs?: MyClub[];
  acceptedInvites?: number;
  /** Two-step sign-in: required for club admins and site owners; enabled is checked only then. */
  mfa?: { required: boolean; enabled?: boolean };
  /** The privacy notice version and whether this person has accepted it (R4). */
  privacy?: { version: string; accepted: boolean; acceptedAt?: string };
}
export interface ClubTeam {
  teamId: string; name: string; season?: string; age?: string; clubId?: string; archived?: boolean; archivedAt?: string;
  /** When an archived team is deleted for good (R4: 90 days after archiving; R31: 7 days after Delete team). */
  purgeAt?: string; deleteRequestedAt?: string;
}
/** POST …/import: a preview (applied false) or the result of saving one part. */
export interface ImportProblem { sheet: string; row?: number; message: string; level: 'error' | 'warning' }
export interface ImportInvite { email: string; name: string; roles: string[]; player: string; status: 'new' | 'member'; flags: string[] }
export interface ImportTeamSummary {
  teamId: string; name: string; status: 'new' | 'update';
  players: { add: number; update: number; kept: number };
  events: { add: number; update: number };
  practices: number | null;
  invites: { staff: number; parents: number; alreadyOnTeam: number; flagged?: number };
  /** Every address the import would invite, flagged ones first (R30). */
  inviteList?: ImportInvite[];
  lists: string[];
  copiedFrom?: string;
}
export interface ImportResult {
  kind?: 'team' | 'club';
  applied: false | string | boolean;
  club?: { changes: string[]; admins: { invite: number; already: number } } | null;
  teams?: ImportTeamSummary[];
  order?: string[];
  problems: ImportProblem[];
}
export interface ClubAdmin { sub: string; email: string; firstName?: string; lastName?: string; /** Two-step sign-in on: their admin tools work. */ mfa?: boolean }
export interface ClubDetail { club: Club; controls?: ClubControlsView; teams: ClubTeam[]; admins: ClubAdmin[]; invites: { email: string; firstName?: string; lastName?: string; expires?: string; expired?: boolean; emailStatus?: EmailStatus; emailAt?: string; emailDetail?: string }[] }
export interface Member { sub?: string; email?: string; firstName?: string; lastName?: string; person?: string; roles: Role[]; pid?: string; status?: string }
/** The Communications page (Messaging M2). */
export interface CommsMessage {
  id: string; label: string; help: string; schedule: string; reach: number;
  config: {
    timing: { kind: 'weekly'; day: number; time: string } | { kind: 'before'; days: number; time: string; what: string } | { kind: 'event'; when: string };
    audience: { key: string; label: string; on: boolean }[]; rules: { key: string; label: string; on: boolean }[];
  };
  settings: { on: boolean; kind: string; day: number; time: string; days: number; audience: Record<string, boolean>; rules: Record<string, boolean> };
  /** The feature it needs is off for this team (the team fund for dues emails). */
  featureOff?: string;
}
export interface UpcomingSend { key: string; msg: string; label: string; date: string; sendAt: string; skipped: boolean; paused: boolean; reach: number }
export interface CommsPage { clubEmail?: boolean; timeZone: string; pauseUntil: string | null; messages: CommsMessage[]; upcoming: UpcomingSend[]; catalog: EmailTemplate[] }
export type HealthAttention =
  | { kind: 'bounced'; email: string; who: string; invite: boolean; bounces: number; since: string; suggest?: string; detail: string }
  | { kind: 'complained'; email: string; who: string; at: string }
  | { kind: 'unreachable'; family: string; pid: string; why: string }
  | { kind: 'notOpening'; families: { family: string; pid: string; emails: number; lastOpen: string }[] };
export interface MessageHealth { id: string; label: string; sent: number; delivered: number; opened: number; bounced: number; complained: number; next: number; nextLabel: string; off: number | null }
export interface CommsHealth {
  since: string; sent: number; delivered: number; bounced: number; complained: number;
  families: number; familiesOpening: number; turnedOff: number; opensSince: string | null;
  attention: HealthAttention[]; messages: MessageHealth[]; count: number;
}
export interface MessageSettings { on?: boolean; day?: number; time?: string; days?: number; audience?: Record<string, boolean>; rules?: Record<string, boolean> }
export interface MyNotifications { teamId: string; teamName: string; roles: string[]; off: string[]; options: { id: string; label: string; help: string; teamSends: boolean; schedule: string }[] }

export interface EmailTemplate { id: string; channel: 'email' | 'text'; label: string; help: string; required: boolean; live: boolean }

export interface Invite {
  email: string; firstName?: string; lastName?: string; roles?: Role[]; pid?: string;
  /** Past its date: can no longer be accepted (R30). */ expired?: boolean;
  /** When it stops working, in seconds (DynamoDB's TTL). */ ttl?: number;
  /** The latest invite email (Messaging M1). None: never emailed. */
  emailStatus?: EmailStatus; emailAt?: string; emailDetail?: string; emailCount?: number;
}

export interface Coach { name: string; phone?: string }
export interface Practice {
  id: string; label: string; dow: number;
  start?: string; end?: string; from?: string; until?: string; location?: string; note?: string;
}
export interface Settings {
  teamName?: string; season?: string; age?: string; teamCode?: string;
  coaches?: Coach[]; practices?: Practice[]; cancelled?: string[];
  checklist?: string[]; uniformItems?: string[];
  /** Practice uniform colors offered when adding a practice. */
  practiceColors?: string[];
  /** Optional features switched off ({ fund: false, ... }) by the team or its club; missing = on. */
  features?: FeatureMap;
  /** The team's own switches only, for Team settings → Features. */
  teamFeatures?: FeatureMap;
  /** Practice attendance: excused absences lower the percentage unless this is false. */
  attendanceExcusedCounts?: boolean;
  dues?: { amountCents?: number; due?: string; label?: string };
  budget?: { costPerMealCents?: number; mealsPerDay?: number; people?: number; families?: number };
  [key: string]: unknown;
}
export interface Parent { name: string; cell?: string; email?: string }
export interface Player {
  pid: string; first: string; last?: string; jersey?: string; shirt?: string; town?: string;
  allergies?: string; refTeam?: 'A' | 'B'; order?: number; parents?: Parent[];
}
export type EventKind = 'tournament' | 'event' | 'deadline' | 'practice';
/** One date of a series changed on its own. Blank fields fall back to the series. */
export interface Occurrence { title?: string; time?: string; endTime?: string; location?: string; address?: string; court?: string; uniformColor?: string; notes?: string }
export interface TeamEvent {
  eid: string; kind: EventKind; title: string; date: string; endDate?: string;
  time?: string; location?: string; city?: string; division?: string; website?: string;
  /** Street address; shown as a map link. */
  address?: string;
  travel?: boolean; notes?: string;
  // Practices
  endTime?: string; court?: string; uniformColor?: string;
  // Game day (tournaments)
  parking?: string; waves?: string; arrival?: string; start?: string; meet?: string; uniforms?: string;
  admissions?: string; teamCode?: string; scheduleLink?: string; ticketHelp?: string; dutyPid?: string; cartPid?: string; ballsPid?: string;
  foodPlan?: string; reservations?: string; checklist?: string[];
  // Team hotel (travel tournaments)
  hotel?: string; hotelLink?: string; hotelCode?: string; hotelBy?: string; hotelAddress?: string;
  // Repeating events
  repeat?: { every: number; days: number[]; until: string; skipTournaments?: boolean };
  cancelled?: string[];
  skip?: string[];
  /** Dates of a series changed on their own ("Edit this date"), by YYYY-MM-DD. */
  overrides?: Record<string, Occurrence>;
  /** From the club's calendar (calendar feed sync). */
  src?: EventSource;
  [key: string]: unknown;
}

export type RefSet = 's1' | 's2' | 's3';
export type RefAssign = Record<string, Partial<Record<RefSet, string>>>;
export interface RefJobs { assign: RefAssign }
export interface AgendaItem { what: string; where?: string; who?: string }
export interface Agenda { note?: string; days: { label: string; items: AgendaItem[] }[] }
export interface Meal {
  eid: string; mid: string; meal: string; day?: string; time?: string; plan?: string; costCents?: number;
  claimedBy?: string | null;
}
export type MoneyKind = 'in' | 'out';
/** Finance's record of money in or out. */
export interface LedgerEntry {
  lid: string; kind: MoneyKind; cat: string; amountCents: number; date: string; desc: string;
  pid?: string; payee?: string; status?: string; src?: string; by?: string; at?: string;
}
/** Sent by a family (dues) or anyone (reimbursement); finance confirms or declines it. */
export interface Payment {
  payId: string; kind: MoneyKind; cat: string; amountCents: number; date: string; desc: string;
  pid?: string; status: 'pending' | 'confirmed' | 'declined'; submittedBy?: string; submittedAt?: string;
}
export interface Travel { mode?: string; flight?: string; hotel?: string; conf?: string; arrive?: string; depart?: string; notes?: string; at?: string;
  /** Another family's plans, for people who may only see that they're entered (R3). */
  entered?: boolean }
export type Rsvp = 'yes' | 'maybe' | 'no';
export interface FamilyRecord {
  pid?: string;
  rsvp?: Record<string, { v: Rsvp; at?: string; by?: string }>;
  travel?: Record<string, Travel>;
  uniform?: { sizes?: Record<string, string>; at?: string; /** Another family: only whether sizes are entered (R3). */ entered?: boolean };
  /** The family lets other team families see their phone numbers and emails. */
  shareContacts?: boolean;
  [key: string]: unknown;
}
export interface HandbookSection { t: string; b: string }
export interface Handbook { sections: HandbookSection[] }
export type TaskStatus = 'To do' | 'In progress' | 'Done' | 'N/A';
export interface Task { kid: string; title: string; desc?: string; owner?: string; status?: TaskStatus; order?: number }
export interface Announcement { aid: string; text: string; pinned?: boolean; by?: string; at?: string; /** Who it's from when that isn't a member (e.g. imported). */ byName?: string }

/** GET /teams/:id — everything the caller may see about one team. */
export interface TeamBundle {
  /** "Also email the team" is offered when posting (Messaging M2b). */
  emailPosts?: boolean;
  /** The club's status and features (site admin dashboard). */
  clubControls?: ClubControlsView;
  /** Practice attendance: every player's marks for staff who take it, only your own player's for a family. */
  attendance?: AttendanceRecord[];
  teamId: string;
  you: { sub?: string; roles: Role[]; pid?: string; person?: string; clubAdmin?: boolean; siteOwner?: boolean };
  clubId?: string;
  club?: Club | null;
  /** Calendar feed sync health, for the team's feed admins. */
  feedStatus?: { attention: boolean; failures: number; paused: boolean; lastOkAt: string | null };
  /** The team's entry in its club's team list. */
  team?: ClubTeam | null;
  settings: Settings | null;
  players: Player[];
  events: TeamEvent[];
  family: Record<string, FamilyRecord>;
  announcements: Announcement[];
  members: Member[];
  meals: Meal[];
  ledger: LedgerEntry[];
  /** The team's totals, sent when the ledger was trimmed to your own family's entries (R3). */
  fundSummary?: { inn: number; out: number; balance: number; pendingIn: number; pendingOut: number; duesPaidFamilies: number };
  handbook: Handbook | null;
  tasks: Task[];
  payments: Payment[];
  refjobs: Record<string, RefJobs>;
  agenda: Record<string, Agenda>;
  [key: string]: unknown;
}

// ---------- Calendar feed sync ----------
export type FeedHistory = { v: number; at: string; by: string; note?: string; summary: string };
export type FeedRun = { at: string; ok: boolean; trigger: 'import' | 'job' | 'manual'; added: number; changed: number; unchanged: number; missing: number; total: number; error?: string; changes: { eid: string; title: string; date: string; text: string }[] };
export type FeedView = {
  connected: boolean;
  source?: {
    host: string; masked: string; preset: PresetId; presetLabel: string; calendarName: string; savedAt: string; savedBy: string; lastCheck: { at: string; total: number; matched: number } | null;
    importedAt: string | null; importFrom: string | null; lastSync: Omit<FeedRun, 'changes'> | null; lastOkAt: string | null; failures: number; nextManualAt: string | null;
    attention: { at: string; was: number; now: number } | null; pausedSince: string | null;
    /** When the job next syncs it, and how often it does right now (30 or 120 minutes). */
    nextSyncAt?: string | null; everyMinutes?: number | null;
    catchUp: { at: string; changes: { eid: string; title: string; date: string; text: string }[]; added: { title: string; date: string }[]; addedCount: number; missing: number } | null;
  };
  runs?: FeedRun[];
  review?: ReviewItem[];
  version: number;
  rules: FeedRules | null;
  history: FeedHistory[];
};
export type ReplaceResult = { practicesRemoved: number; seriesEnded: number; answersMoved: number; attendanceMoved: number };
export type FeedCheck = {
  calendar: { name: string; prodid: string; zone: string; teamZone: string; total: number; from: string; to: string; warnings: string[] };
  host: string; masked: string; preset: PresetId; presetLabel: string;
  suggestions: FilterSuggestion[];
  rules: FeedRules;
  template?: { at: string; used: boolean } | null;
  events: FeedEvent[];
};
