import { exportClub, exportTeam } from "../../lib/export/export.js";
import { getClub } from "../../lib/clubs.js";
import { loadAccess, loadClubAccess } from "../context.js";
import { json, notFound } from "../http.js";
import type { Router } from "../router.js";
import { checkId, getItem } from "../util.js";
import { keys } from "../../lib/keys.js";

/**
 * Team and club export into the setup workbooks (lib/export). The files hold every family's contact
 * details and allergies, so: team exports for that team's admins (the people who can already see and
 * change all of it), club exports for club admins and site owners, and every export is logged.
 */
export function exportRoutes(r: Router) {
  r.on("GET", "/teams/{teamId}/export", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("accounts");
    if (!(await getItem(keys.settings(a.teamId)))) throw notFound("There's no team with that id.");
    const out = await exportTeam(a.teamId);
    console.log(JSON.stringify({ msg: "export", kind: "team", teamId: a.teamId, clubId: a.clubId, by: caller.sub, players: out.sheets["Roster"].length }));
    return json(200, { kind: "team", teamId: a.teamId, ...out });
  });

  r.on("GET", "/clubs/{clubId}/export", async ({ caller, params }) => {
    const { clubId } = await loadClubAccess(caller, checkId(params.clubId, "club"));
    if (!(await getClub(clubId))) throw notFound("That club doesn't exist.");
    const out = await exportClub(clubId);
    console.log(JSON.stringify({ msg: "export", kind: "club", clubId, by: caller.sub, teams: out.teams.length, players: out.sheets["Rosters"].length }));
    return json(200, { kind: "club", clubId, ...out });
  });
}
