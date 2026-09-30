import type { LedgerEntry, Payment, Player } from './models';

export const CATS = ['Dues', 'Team meals', 'Coach care', 'Reimbursement', 'Tournament costs', 'Other'] as const;
export type Cat = (typeof CATS)[number];

export const money = (cents: number) =>
  (cents < 0 ? '−$' : '$') + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });

/** "12.50" → 1250; blank or bad → 0 */
export const toCents = (v: string | number | null | undefined) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};

const counts = (l: LedgerEntry) => l.status !== 'declined';
export const pending = (payments: Payment[]) => payments.filter((p) => p.status === 'pending');

/** Dues a family has paid (confirmed in the ledger) and sent but not yet confirmed. */
export function duesFor(pid: string, ledger: LedgerEntry[], payments: Payment[]) {
  let paid = 0, waiting = 0;
  for (const l of ledger) if (counts(l) && l.pid === pid && l.cat === 'Dues' && l.kind === 'in') paid += l.amountCents;
  for (const p of pending(payments)) if (p.kind === 'in' && p.pid === pid && p.cat === 'Dues') waiting += p.amountCents;
  return { paid, waiting };
}

export interface FundStats { inn: number; out: number; balance: number; pendingIn: number; pendingOut: number; duesPaidFamilies: number }
export function fundStats(ledger: LedgerEntry[], payments: Payment[], players: Player[], duesCents: number): FundStats {
  let inn = 0, out = 0, pendingIn = 0, pendingOut = 0;
  for (const l of ledger) if (counts(l)) { if (l.kind === 'in') inn += l.amountCents; else out += l.amountCents; }
  for (const p of pending(payments)) { if (p.kind === 'in') pendingIn += p.amountCents; else pendingOut += p.amountCents; }
  const duesPaidFamilies = duesCents > 0 ? players.filter((p) => duesFor(p.pid, ledger, payments).paid >= duesCents).length : 0;
  return { inn, out, balance: inn - out, pendingIn, pendingOut, duesPaidFamilies };
}

/** The workbook's meal planning model. */
export interface Budget { days: number; meals: number; costCents: number; people: number; families: number }
export function budget(b: Budget) {
  const meals = b.days * b.meals;
  const perPerson = meals * b.costCents;
  const total = perPerson * b.people;
  const perFamily = Math.round(total / Math.max(1, b.families));
  return { meals, perPerson, total, perFamily, perFamilyRounded: Math.ceil(perFamily / 1000) * 1000 };
}
