import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { loadAccess } from "../context.js";
import { badRequest, forbidden, json, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { checkId, getItem, ID, now, optStr, putItem } from "../util.js";

const travel = z.object({
  mode: optStr(40), flight: optStr(200), hotel: optStr(200), conf: optStr(80),
  arrive: optStr(80), depart: optStr(80), notes: optStr(1000)
});
const familySchema = z.object({
  rsvp: z.record(z.enum(["yes", "maybe", "no", ""])).optional(),
  travel: z.record(travel.nullable()).optional(),
  uniform: z.object({ sizes: z.record(z.string().max(10)) }).optional()
}).refine((b) => b.rsvp || b.travel || b.uniform, "send rsvp, travel or uniform");

export function familyRoutes(r: Router) {
  /**
   * One family record per player: TEAM#t / FAMILY#pid.
   * Availability: the player's parents, or coaches/coordinators/admins.
   * Travel and uniform sizes: the player's parents, or coordinators/admins.
   */
  r.on("PUT", "/teams/{teamId}/family/{pid}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    const pid = checkId(params.pid, "player");
    const b = parseBody(familySchema, body);
    const parent = a.isParentOf(pid);
    if (b.rsvp && !parent && !a.can("attendance")) throw forbidden("You can only answer for your own family.");
    if ((b.travel || b.uniform) && !parent && !a.can("roster")) throw forbidden("You can only update your own family.");
    if (!(await getItem(keys.player(a.teamId, pid)))) throw notFound("That player isn't on this team.");

    const key = keys.family(a.teamId, pid);
    // Make sure the maps exist so nested SETs work (no-op if the record is already there).
    try {
      await putItem({ ...key, type: "Family", pid, rsvp: {}, travel: {}, uniform: {} }, "attribute_not_exists(PK)");
    } catch (e) {
      if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
    }

    const at = now();
    const sets: string[] = ["updatedAt = :at", "updatedBy = :by"];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ":at": at, ":by": caller.sub };
    let n = 0;
    for (const [k, v] of Object.entries(b.rsvp ?? {})) {
      if (k.length > 80 || !ID.test(k)) throw badRequest("Invalid availability key.");
      const nk = `#r${n}`, nv = `:r${n++}`;
      names[nk] = k;
      if (v === "") removes.push(`rsvp.${nk}`);
      else { sets.push(`rsvp.${nk} = ${nv}`); values[nv] = { v, at, by: caller.sub }; }
    }
    for (const [eid, t] of Object.entries(b.travel ?? {})) {
      checkId(eid, "event");
      const nk = `#t${n}`, nv = `:t${n++}`;
      names[nk] = eid;
      if (t === null) removes.push(`travel.${nk}`);
      else { sets.push(`travel.${nk} = ${nv}`); values[nv] = { ...t, at, by: caller.sub }; }
    }
    if (b.uniform) { sets.push("uniform = :u"); values[":u"] = { sizes: b.uniform.sizes, at, by: caller.sub }; }
    if (sets.length + removes.length > 200) throw badRequest("Too many changes in one request.");

    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: key,
      UpdateExpression: `SET ${sets.join(", ")}${removes.length ? " REMOVE " + removes.join(", ") : ""}`,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: values
    }));
    return json(200, { pid });
  });
}
