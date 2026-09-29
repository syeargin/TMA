import type { Role } from '@shared/permissions';

export interface MyTeam { teamId: string; name?: string; roles: Role[]; pid?: string }
export interface Me { sub?: string; email?: string; teams: MyTeam[]; clubAdmin?: boolean; acceptedInvites?: number }
export interface ClubTeam { teamId: string; name: string; season?: string; age?: string }
export interface Member { sub?: string; email?: string; person?: string; roles: Role[]; pid?: string; status?: string }
export interface Invite { email: string; roles?: Role[]; pid?: string }

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
  [key: string]: unknown;
}
export type Rsvp = 'yes' | 'maybe' | 'no';
export interface FamilyRecord {
  pid?: string;
  rsvp?: Record<string, { v: Rsvp; at?: string; by?: string }>;
  [key: string]: unknown;
}
export interface Announcement { aid: string; text: string; pinned?: boolean; by?: string; at?: string }

/** GET /teams/:id — everything the caller may see about one team. */
export interface TeamBundle {
  teamId: string;
  you: { sub?: string; roles: Role[]; pid?: string; person?: string; clubAdmin?: boolean };
  settings: Settings | null;
  players: Player[];
  events: TeamEvent[];
  family: Record<string, FamilyRecord>;
  announcements: Announcement[];
  members: Member[];
  [key: string]: unknown;
}
