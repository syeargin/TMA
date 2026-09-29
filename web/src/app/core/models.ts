import type { Role } from '@shared/permissions';

export interface MyTeam { teamId: string; name?: string; roles: Role[]; pid?: string }
export interface Me { sub?: string; email?: string; teams: MyTeam[]; clubAdmin?: boolean; acceptedInvites?: number }
export interface ClubTeam { teamId: string; name: string; season?: string; age?: string }
export interface Member { sub?: string; email?: string; person?: string; roles: Role[]; pid?: string }
export interface Invite { email: string; roles?: Role[]; pid?: string }

/** GET /teams/:id — everything the caller may see about one team. */
export interface TeamBundle {
  teamId: string;
  team?: { name?: string; season?: string; age?: string };
  settings?: { teamName?: string } & Record<string, unknown>;
  you: { roles: Role[]; pid?: string };
  players: unknown[];
  events: unknown[];
  members: Member[];
  [key: string]: unknown;
}
