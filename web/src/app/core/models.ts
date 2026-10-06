import type { Role } from '@shared/permissions';

export interface MyTeam { teamId: string; name?: string; roles: Role[]; pid?: string; clubId?: string; archived?: boolean }
export interface ClubLink { label: string; url: string }
export interface Club { clubId: string; name: string; short: string; colors: { primary: string; accent: string }; links: ClubLink[]; notes: string }
/** A club you're in through a team (admin: false) or run (admin: true). */
export interface MyClub extends Club { admin: boolean }
export interface Me {
  sub?: string; email?: string; firstName?: string; lastName?: string; teams: MyTeam[];
  /** Runs at least one club. */
  clubAdmin?: boolean;
  /** Site owner: adds clubs, can open any club. */
  platformAdmin?: boolean;
  clubs?: MyClub[];
  acceptedInvites?: number;
}
export interface ClubTeam { teamId: string; name: string; season?: string; age?: string; clubId?: string; archived?: boolean; archivedAt?: string }
export interface ClubAdmin { sub: string; email: string; firstName?: string; lastName?: string }
export interface ClubDetail { club: Club; teams: ClubTeam[]; admins: ClubAdmin[]; invites: { email: string; firstName?: string; lastName?: string }[] }
export interface Member { sub?: string; email?: string; firstName?: string; lastName?: string; person?: string; roles: Role[]; pid?: string; status?: string }
export interface Invite { email: string; firstName?: string; lastName?: string; roles?: Role[]; pid?: string }

export interface Coach { name: string; phone?: string }
export interface Practice {
  id: string; label: string; dow: number;
  start?: string; end?: string; from?: string; until?: string; location?: string; note?: string;
}
export interface Settings {
  teamName?: string; season?: string; age?: string; teamCode?: string;
  coaches?: Coach[]; practices?: Practice[]; cancelled?: string[];
  checklist?: string[]; uniformItems?: string[];
  dues?: { amountCents?: number; due?: string; label?: string };
  budget?: { costPerMealCents?: number; mealsPerDay?: number; people?: number; families?: number };
  [key: string]: unknown;
}
export interface Parent { name: string; cell?: string; email?: string }
export interface Player {
  pid: string; first: string; last?: string; jersey?: string; shirt?: string; town?: string;
  allergies?: string; refTeam?: 'A' | 'B'; order?: number; parents?: Parent[];
}
export type EventKind = 'tournament' | 'event' | 'deadline';
export interface TeamEvent {
  eid: string; kind: EventKind; title: string; date: string; endDate?: string;
  time?: string; location?: string; city?: string; division?: string; website?: string;
  travel?: boolean; notes?: string;
  // Game day (tournaments)
  parking?: string; waves?: string; arrival?: string; start?: string; meet?: string; uniforms?: string;
  admissions?: string; teamCode?: string; scheduleLink?: string; ticketHelp?: string; dutyPid?: string; cartPid?: string; ballsPid?: string;
  foodPlan?: string; reservations?: string; checklist?: string[];
  // Team hotel (travel tournaments)
  hotel?: string; hotelLink?: string; hotelCode?: string; hotelBy?: string;
  // Repeating events
  repeat?: { every: number; days: number[]; until: string; skipTournaments?: boolean };
  cancelled?: string[];
  skip?: string[];
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
export interface Travel { mode?: string; flight?: string; hotel?: string; conf?: string; arrive?: string; depart?: string; notes?: string; at?: string }
export type Rsvp = 'yes' | 'maybe' | 'no';
export interface FamilyRecord {
  pid?: string;
  rsvp?: Record<string, { v: Rsvp; at?: string; by?: string }>;
  travel?: Record<string, Travel>;
  uniform?: { sizes?: Record<string, string>; at?: string };
  [key: string]: unknown;
}
export interface HandbookSection { t: string; b: string }
export interface Handbook { sections: HandbookSection[] }
export type TaskStatus = 'To do' | 'In progress' | 'Done' | 'N/A';
export interface Task { kid: string; title: string; desc?: string; owner?: string; status?: TaskStatus; order?: number }
export interface Announcement { aid: string; text: string; pinned?: boolean; by?: string; at?: string; /** Who it's from when that isn't a member (e.g. imported). */ byName?: string }

/** GET /teams/:id — everything the caller may see about one team. */
export interface TeamBundle {
  teamId: string;
  you: { sub?: string; roles: Role[]; pid?: string; person?: string; clubAdmin?: boolean };
  clubId?: string;
  club?: Club | null;
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
  handbook: Handbook | null;
  tasks: Task[];
  payments: Payment[];
  refjobs: Record<string, RefJobs>;
  agenda: Record<string, Agenda>;
  [key: string]: unknown;
}
