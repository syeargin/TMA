/**
 * Team fund totals, worked out on the server for people who don't see every entry (R3).
 * Mirrors web/src/app/core/money.ts fundStats(): declined entries don't count; pending payments
 * are shown separately.
 */
type Row = Record<string, unknown>;
const cents = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface FundSummary { inn: number; out: number; balance: number; pendingIn: number; pendingOut: number; duesPaidFamilies: number }

export function fundSummary(ledger: Row[], payments: Row[], pids: string[], duesCents: number): FundSummary {
  let inn = 0, out = 0, pendingIn = 0, pendingOut = 0;
  const paid = new Map<string, number>();
  for (const l of ledger) {
    if (l.status === "declined") continue;
    if (l.kind === "in") inn += cents(l.amountCents); else out += cents(l.amountCents);
    if (l.kind === "in" && l.cat === "Dues" && l.pid) paid.set(String(l.pid), (paid.get(String(l.pid)) ?? 0) + cents(l.amountCents));
  }
  for (const p of payments) {
    if (p.status !== "pending") continue;
    if (p.kind === "in") pendingIn += cents(p.amountCents); else pendingOut += cents(p.amountCents);
  }
  const duesPaidFamilies = duesCents > 0 ? pids.filter((pid) => (paid.get(pid) ?? 0) >= duesCents).length : 0;
  return { inn, out, balance: inn - out, pendingIn, pendingOut, duesPaidFamilies };
}
