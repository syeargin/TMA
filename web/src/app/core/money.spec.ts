import type { LedgerEntry, Payment } from './models';
import { budget, duesFor, fundStats, money, toCents } from './money';

const L = (o: Partial<LedgerEntry>): LedgerEntry => ({ lid: 'l', kind: 'in', cat: 'Dues', amountCents: 0, date: '2026-10-01', desc: 'x', ...o });
const P = (o: Partial<Payment>): Payment => ({ payId: 'p', kind: 'in', cat: 'Dues', amountCents: 0, date: '2026-10-01', desc: 'x', status: 'pending', ...o });
const players = [{ pid: 'p1', first: 'Ava' }, { pid: 'p2', first: 'Bea' }, { pid: 'p3', first: 'Cy' }];

describe('fund', () => {
  const ledger = [
    L({ pid: 'p1', amountCents: 40000 }),
    L({ pid: 'p2', amountCents: 20000 }),
    L({ pid: 'p3', amountCents: 40000, status: 'declined' }),
    L({ kind: 'out', cat: 'Team meals', amountCents: 15000 })
  ];
  const payments = [
    P({ pid: 'p2', amountCents: 20000 }),
    P({ kind: 'out', cat: 'Team meals', amountCents: 3500 }),
    P({ pid: 'p3', amountCents: 40000, status: 'confirmed' })
  ];
  it('adds up the ledger, ignoring declined entries', () => {
    const f = fundStats(ledger, payments, players, 40000);
    expect(f).toMatchObject({ inn: 60000, out: 15000, balance: 45000, pendingIn: 20000, pendingOut: 3500, duesPaidFamilies: 1 });
  });
  it('tracks each family’s dues, paid and waiting', () => {
    expect(duesFor('p1', ledger, payments)).toEqual({ paid: 40000, waiting: 0 });
    expect(duesFor('p2', ledger, payments)).toEqual({ paid: 20000, waiting: 20000 });
    expect(duesFor('p3', ledger, payments)).toEqual({ paid: 0, waiting: 0 });
  });
  it('counts nobody as paid when no dues are set', () => {
    expect(fundStats(ledger, payments, players, 0).duesPaidFamilies).toBe(0);
  });
});

describe('meal budget', () => {
  it('matches the workbook model', () => {
    const b = budget({ days: 2, meals: 2, costCents: 2000, people: 15, families: 13 });
    expect(b).toEqual({ meals: 4, perPerson: 8000, total: 120000, perFamily: 9231, perFamilyRounded: 10000 });
  });
});

describe('money', () => {
  it('formats and parses', () => {
    expect(money(-2550)).toBe('−$25.50');
    expect(money(0)).toBe('$0');
    expect(toCents('40')).toBe(4000);
    expect(toCents('-5')).toBe(0);
  });
});
