import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/db.js";
import { keys } from "../lib/keys.js";
import { can, type Permission } from "../shared/permissions.js";
import { forbidden } from "./http.js";

export const CLUB_ID = () => process.env.CLUB_ID ?? "a5";

export type Membership = {
  sub: string; status: string; person?: string; pid?: string; roles: string[]; email?: string; at?: string;
};

export type Caller = { sub: string; username: string };

/** Everything a route needs to decide what this caller may do on one team. */
export class TeamAccess {
  constructor(
    public caller: Caller,
    public teamId: string,
    public member: Membership | null,
    public clubAdmin: boolean
  ) {}

  get roles(): Set<string> {
    const r = new Set(this.member?.status === "active" ? this.member.roles : []);
    if (this.clubAdmin) r.add("admin");
    return r;
  }

  get isMember() { return this.clubAdmin || this.member?.status === "active"; }

  can(perm: Permission) { return can(this.roles, perm); }

  require(perm: Permission) {
    if (!this.can(perm)) throw forbidden();
  }

  /** Parent of this player (the membership's family), with the family role. */
  isParentOf(pid: string | undefined) {
    return !!pid && this.member?.status === "active" && this.member.pid === pid && this.roles.has("parent");
  }
}

export async function loadAccess(caller: Caller, teamId: string): Promise<TeamAccess> {
  const res = await ddb.send(new BatchGetCommand({
    RequestItems: {
      [TABLE]: { Keys: [keys.member(teamId, caller.sub), keys.clubAdmin(CLUB_ID(), caller.sub)] }
    }
  }));
  const items = res.Responses?.[TABLE] ?? [];
  const member = items.find((i) => String(i.SK).startsWith("MEMBER#")) as Membership | undefined;
  const clubAdmin = items.some((i) => String(i.SK).startsWith("ADMIN#"));
  const access = new TeamAccess(caller, teamId, member ?? null, clubAdmin);
  if (!access.isMember) throw forbidden("You're not a member of this team.");
  return access;
}
