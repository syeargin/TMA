import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../../lib/db.js";
import { keys } from "../../lib/keys.js";
import { loadAccess } from "../context.js";
import { conflict, forbidden, json, mapDbError, notFound, parseBody } from "../http.js";
import type { Router } from "../router.js";
import { cents, checkId, date, deleteItem, getItem, newId, now, optStr, putItem, str } from "../util.js";

const CATS = ["Dues", "Team meals", "Coach care", "Reimbursement", "Tournament costs", "Other"] as const;

const paymentSchema = z.object({
  kind: z.enum(["in", "out"]),
  cat: z.enum(CATS).default("Other"),
  pid: optStr(64),
  amountCents: cents.refine((v) => v > 0, "must be more than $0"),
  date,
  desc: str(300).min(1)
});
const ledgerSchema = z.object({
  kind: z.enum(["in", "out"]),
  cat: z.enum(CATS).default("Other"),
  pid: optStr(64), payee: optStr(120),
  amountCents: cents.refine((v) => v > 0, "must be more than $0"),
  date, desc: str(300).min(1)
});

export function moneyRoutes(r: Router) {
  /** A family records a dues payment (kind "in", own player) or anyone asks to be paid back (kind "out"). */
  r.on("POST", "/teams/{teamId}/payments", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    const p = parseBody(paymentSchema, body);
    if (p.kind === "in" && !a.isParentOf(p.pid)) throw forbidden("You can only record payments for your own family.");
    if (p.kind === "out" && !a.can("reimb")) throw forbidden();
    const payId = newId("pay");
    await putItem({ ...keys.payment(a.teamId, payId), type: "Payment", ...p, pid: p.pid ?? a.member?.pid ?? "",
      status: "pending", submittedBy: caller.sub, submittedAt: now() });
    return json(201, { payId });
  });

  r.on("DELETE", "/teams/{teamId}/payments/{payId}", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    const key = keys.payment(a.teamId, checkId(params.payId, "payment"));
    const pay = await getItem(key);
    if (!pay) throw notFound("That payment doesn't exist.");
    if (pay.status !== "pending") throw conflict("Only payments still waiting for finance can be withdrawn.");
    if (pay.submittedBy !== caller.sub && !a.can("finance")) throw forbidden("Only the person who sent it or finance can withdraw it.");
    await deleteItem(key);
    return json(204, undefined);
  });

  /** Finance settles a pending payment: confirmed payments are copied to the ledger in the same transaction. */
  for (const action of ["confirm", "decline"] as const) {
    r.on("POST", `/teams/{teamId}/payments/{payId}/${action}`, async ({ caller, params }) => {
      const a = await loadAccess(caller, checkId(params.teamId, "team"));
      a.require("finance");
      const payId = checkId(params.payId, "payment");
      const key = keys.payment(a.teamId, payId);
      const pay = await getItem(key);
      if (!pay) throw notFound("That payment doesn't exist.");
      const at = now();
      const settle = {
        Update: {
          TableName: TABLE, Key: key,
          UpdateExpression: "SET #s = :s, settledBy = :by, settledAt = :at",
          ConditionExpression: "#s = :pending",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":s": action === "confirm" ? "confirmed" : "declined", ":by": caller.sub, ":at": at, ":pending": "pending" }
        }
      };
      const lid = `l-${payId}`;
      const items = action === "confirm"
        ? [settle, { Put: { TableName: TABLE, ConditionExpression: "attribute_not_exists(PK)", Item: {
            ...keys.ledger(a.teamId, lid), type: "Ledger",
            kind: pay.kind, cat: pay.cat, pid: pay.pid ?? "", payee: pay.kind === "out" ? pay.submittedBy : "",
            amountCents: pay.amountCents, date: pay.date, desc: pay.desc, src: payId, status: "confirmed",
            by: caller.sub, at, GSI2PK: `TEAM#${a.teamId}#LEDGER`, GSI2SK: `${pay.date}#${lid}` } } }]
        : [settle];
      try {
        await ddb.send(new TransactWriteCommand({ TransactItems: items }));
      } catch (e) { mapDbError(e, "This payment was already settled."); }
      return json(200, { payId, status: action === "confirm" ? "confirmed" : "declined", lid: action === "confirm" ? lid : undefined });
    });
  }

  r.on("PUT", "/teams/{teamId}/ledger/{lid}", async ({ caller, params, body }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("finance");
    const lid = checkId(params.lid, "ledger entry");
    const l = parseBody(ledgerSchema, body);
    const existing = await getItem(keys.ledger(a.teamId, lid));
    await putItem({ ...(existing ?? {}), ...keys.ledger(a.teamId, lid), type: "Ledger", ...l,
      status: existing?.status ?? "confirmed", by: existing?.by ?? caller.sub, at: existing?.at ?? now(),
      updatedAt: now(), updatedBy: caller.sub, GSI2PK: `TEAM#${a.teamId}#LEDGER`, GSI2SK: `${l.date}#${lid}` });
    return json(200, { lid });
  });

  r.on("DELETE", "/teams/{teamId}/ledger/{lid}", async ({ caller, params }) => {
    const a = await loadAccess(caller, checkId(params.teamId, "team"));
    a.require("finance");
    await deleteItem(keys.ledger(a.teamId, checkId(params.lid, "ledger entry")));
    return json(204, undefined);
  });

}
