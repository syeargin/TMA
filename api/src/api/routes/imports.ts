/**
 * Spreadsheet import (the Team setup and Club setup workbooks).
 *
 * The site reads the .xlsx in the browser and sends each sheet's rows. Without `apply` the API only
 * previews: what each team would get, and every problem by tab and row. Nothing is saved while there are
 * errors. A club import is saved in parts (`apply: "club"`, then `apply: "<teamId>"` per team in the
 * preview's `order`), so a large club never runs into the API's time limit and the site can show progress.
 */
import { z } from "zod";
import { forgetTeamClubs, getClub } from "../../lib/clubs.js";
import { applyOrder, importClub, importTeam, type TeamSummary } from "../../lib/import/apply.js";
import { parseClubWorkbook, parseTeamWorkbook, TEAM_ID, workbookKind, type Parsed, type Problem, type Sheets } from "../../lib/import/parse.js";
import { loadAccess, loadClubAccess } from "../context.js";
import { badRequest, forbidden, HttpError, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId } from "../util.js";

const cell = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);
const sheetsSchema = z.record(z.array(z.array(cell).max(80)).max(3001)).refine((s) => Object.keys(s).length <= 30, "Too many tabs.");
const teamBody = z.object({ sheets: sheetsSchema, apply: z.boolean().default(false) });
const clubBody = z.object({
  sheets: sheetsSchema,
  /** Team workbook uploaded on the club page: which team it's for (new or existing). */
  teamId: z.string().trim().toLowerCase().optional(),
  apply: z.union([z.literal(false), z.literal("club"), z.string().regex(TEAM_ID)]).default(false)
});

const errors = (p: Problem[]) => p.filter((x) => x.level === "error");
const sortProblems = (p: Problem[]) => p.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));

function refuse(problems: Problem[]): never {
  throw new HttpError(422, `The workbook has ${errors(problems).length} problem${errors(problems).length === 1 ? "" : "s"} to fix first. Preview it to see them.`, "invalid_workbook");
}

export function importRoutes(r: Router) {
  /** Team workbook into one existing team (club admins and site owners). */
  r.on("POST", "/teams/{teamId}/import", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    if (!a.clubAdmin) throw forbidden("Only club admins and site owners can import a workbook.");
    const b = parseBody(teamBody, body);
    if (workbookKind(b.sheets) !== "team") throw badRequest("That isn't the Team setup workbook. Download the template from this page and fill it in.");
    const parsed = parseTeamWorkbook(b.sheets, a.teamId) as Extract<Parsed, { kind: "team" }>;
    const problems = parsed.problems;
    if (b.apply && errors(problems).length) refuse(problems);
    const team = await importTeam({ clubId: a.clubId, plan: parsed.team, by: caller.sub, write: b.apply, problems });
    if (b.apply && !team) refuse(problems);
    return json(200, { kind: "team", applied: b.apply, teams: team ? [team] : [], order: [a.teamId], problems: sortProblems(problems) });
  });

  /** Club workbook (or a Team workbook plus a team id) on a club's page. */
  r.on("POST", "/clubs/{clubId}/import", async ({ caller, params, body }) => {
    const { clubId } = await loadClubAccess(caller, checkId(params.clubId, "club"));
    if (!(await getClub(clubId))) throw notFound("That club doesn't exist.");
    const b = parseBody(clubBody, body);
    const kind = workbookKind(b.sheets);
    if (!kind) throw badRequest("That isn't a Team setup or Club setup workbook. Download a template from this page and fill it in.");

    let parsed: Parsed;
    if (kind === "team") {
      if (!b.teamId || !TEAM_ID.test(b.teamId)) throw badRequest("Enter the team's Team ID: lowercase letters, numbers and dashes.");
      parsed = parseTeamWorkbook(b.sheets, b.teamId);
    } else parsed = parseClubWorkbook(b.sheets, clubId);
    const problems = parsed.problems;
    const plans = parsed.kind === "team" ? [parsed.team] : parsed.teams;
    const club = parsed.kind === "club" ? parsed.club : null;
    const teamsInFile = parsed.kind === "club" ? new Set(plans.map((t) => t.teamId)) : undefined;
    const order = applyOrder(plans);

    // ----- save one part -----
    if (b.apply !== false) {
      if (errors(problems).length) refuse(problems);
      if (b.apply === "club") {
        if (!club) throw badRequest("A team workbook has no club part.");
        const summary = await importClub({ clubId, plan: club, by: caller.sub, write: true });
        return json(200, { applied: "club", club: summary, problems: sortProblems(problems) });
      }
      const plan = plans.find((t) => t.teamId === b.apply);
      if (!plan) throw badRequest(`${b.apply} isn't in this workbook.`);
      const team = await importTeam({ clubId, plan, by: caller.sub, write: true, problems, defaults: club?.defaults, teamsInFile });
      if (!team) refuse(problems);
      forgetTeamClubs();
      return json(200, { applied: plan.teamId, teams: [team], problems: sortProblems(problems) });
    }

    // ----- preview everything -----
    const teams: TeamSummary[] = [];
    for (const plan of order.map((id) => plans.find((t) => t.teamId === id)!)) {
      const s = await importTeam({ clubId, plan, by: caller.sub, write: false, problems, defaults: club?.defaults, teamsInFile });
      if (s) teams.push(s);
    }
    const clubSummary = club ? await importClub({ clubId, plan: club, by: caller.sub, write: false }) : null;
    return json(200, { kind: parsed.kind, applied: false, club: clubSummary, teams, order, problems: sortProblems(problems) });
  });
}
