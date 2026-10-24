/**
 * Practice attendance: coaches, coordinators and team admins mark who came to each practice
 * (TEAM#t / ATT#<practice key>). Families see only their own player's marks, through the team
 * bundle (teams.ts). Cancelled practices and practices nobody marked don't count (shared/attendance.ts).
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { loadTeam } from "../../lib/comms/content.js";
import { getComms, zoneOf } from "../../lib/comms/planner.js";
import { localParts } from "../../lib/comms/zoned.js";
import { MARKS } from "../../shared/attendance.js";
import { loadAccess } from "../context.js";
import { badRequest, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, ID, now, optStr, putItem } from "../util.js";

const mark = z.object({ s: z.enum(MARKS), note: optStr(120) });
const marksSchema = z.object({
  /** Player id → their mark; null removes it. Only the players sent change, so two coaches marking at once don't undo each other. */
  marks: z.record(mark.nullable()).refine((m) => Object.keys(m).length > 0 && Object.keys(m).length <= 80, "send between 1 and 80 players")
});

export function attendanceRoutes(r: Router) {
  r.on("PUT", "/teams/{teamId}/attendance/{key}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("takeAttendance");
    a.requireFeature("attendance");
    const key = params.key ?? "";
    if (!ID.test(key) || key.length > 80) throw badRequest("That isn't a practice on the schedule.");
    const b = parseBody(marksSchema, body);

    const t = await loadTeam(a.teamId, a.clubId);
    const item = t.items.find((i) => i.key === key);
    if (!item || item.kind !== "practice") throw notFound("That isn't a practice on the schedule. Only practices are tracked.");
    if (item.cancelled) throw badRequest("That practice was cancelled, so there's no attendance to take.");
    const today = localParts(new Date(), zoneOf(await getComms(a.teamId))).date;
    if (item.date > today) throw badRequest("Attendance can be taken on the day of the practice, not before.");
    const players = new Set(t.players.map((p) => String(p.pid)));
    const unknown = Object.keys(b.marks).filter((pid) => !players.has(pid));
    if (unknown.length) throw badRequest("Some of those players aren't on this team any more. Reload and try again.");

    const at = now();
    const k = keys.attendance(a.teamId, key);
    try {
      await putItem({ ...k, type: "Attendance", key, date: item.date, marks: {}, takenBy: caller.sub, takenAt: at }, "attribute_not_exists(PK)");
    } catch (e) {
      if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
    }
    const sets = ["updatedAt = :at", "updatedBy = :by"];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ":at": at, ":by": caller.sub };
    Object.entries(b.marks).forEach(([pid, m], i) => {
      names[`#p${i}`] = pid;
      if (m === null) removes.push(`marks.#p${i}`);
      else { sets.push(`marks.#p${i} = :m${i}`); values[`:m${i}`] = m.note ? { s: m.s, note: m.note } : { s: m.s }; }
    });
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: k, ReturnValues: "ALL_NEW",
      UpdateExpression: `SET ${sets.join(", ")}${removes.length ? " REMOVE " + removes.join(", ") : ""}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: values
    }));
    console.log(JSON.stringify({ msg: "attendance taken", teamId: a.teamId, key, by: caller.sub, marked: Object.keys(res.Attributes?.marks ?? {}).length }));
    return json(200, { key, date: item.date, marks: res.Attributes?.marks ?? {} });
  });
}
