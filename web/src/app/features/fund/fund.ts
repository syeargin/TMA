import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { fmt, newId, today } from '../../core/dates';
import type { LedgerEntry, MoneyKind, Payment } from '../../core/models';
import { CATS, budget, money, pending, toCents } from '../../core/money';
import { TeamStore } from '../../core/team-store';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';

type FormKind = 'pay' | 'reimb' | 'entry' | null;

/** Team fund: balance, payments waiting for finance, the ledger, dues by family and the meal budget model. */
@Component({
  selector: 'th-fund',
  imports: [ReactiveFormsModule, FormsModule, Sheet, Messages],
  templateUrl: './fund.html'
})
export class Fund {
  readonly store = inject(TeamStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly money = money;
  readonly fmt = fmt;
  readonly cats = CATS;
  readonly reimbCats = ['Team meals', 'Coach care', 'Tournament costs', 'Other'];

  get finance() { return this.store.can('finance'); }
  get myPid() { return this.store.myPid(); }
  readonly f = this.store.fund;
  readonly dues = computed(() => this.store.settings()?.dues ?? {});
  readonly duesLabel = computed(() => this.dues().label || 'Team fund deposit');
  readonly waiting = computed(() => pending(this.store.payments()).sort((a, b) => a.date.localeCompare(b.date)));
  readonly duesRows = computed(() => this.store.players().map((p) => {
    const d = this.store.dues(p.pid);
    const amt = this.store.duesCents();
    return { p, ...d, pct: amt ? Math.min(100, Math.round((100 * d.paid) / amt)) : 0, done: amt > 0 && d.paid >= amt };
  }));
  readonly confirmers = computed(() => this.store.members().filter((m) => m.roles.includes('finance') || m.roles.includes('coordinator'))
    .map((m) => this.store.authorName(m.sub)).filter(Boolean).join(', ') || 'the team coordinator');

  // ----- meal budget model -----
  readonly calc = signal(this.defaultCalc());
  readonly calcOut = computed(() => budget(this.calc()));
  private defaultCalc() {
    const b = this.store.settings()?.budget ?? {};
    const coaches = this.store.settings()?.coaches?.length ?? 0;
    return {
      days: 2, meals: b.mealsPerDay ?? 2, costCents: b.costPerMealCents ?? 2000,
      people: b.people ?? (this.store.players().length + coaches || 15), families: this.store.players().length || b.families || 13
    };
  }
  setCalc(k: 'days' | 'meals' | 'people' | 'families', v: unknown) { this.calc.update((c) => ({ ...c, [k]: Math.max(0, Math.floor(Number(v) || 0)) })); }
  setCost(v: unknown) { this.calc.update((c) => ({ ...c, costCents: toCents(String(v)) })); }
  readonly travelNames = computed(() => this.store.tournaments().filter((e) => e.travel).map((e) => e.title).join(', '));

  // ----- people -----
  who(p: Payment) { return this.store.authorName(p.submittedBy) || 'A team member'; }
  payee(l: LedgerEntry) { return l.pid ? `${this.store.playerName(l.pid)}'s family` : this.store.authorName(l.payee) || l.payee || ''; }
  canWithdraw(p: Payment) { return p.submittedBy === this.store.you().sub || this.finance; }

  // ----- forms -----
  readonly form = signal<FormKind>(null);
  readonly editing = signal<LedgerEntry | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly confirmDelete = signal(false);
  readonly payForm = this.fb.group({ amount: '', date: '', cat: 'Dues', desc: '' });
  readonly entryForm = this.fb.group({ kind: 'in' as MoneyKind, amount: '', date: '', cat: 'Other', desc: '', pid: '', payee: '' });

  openPay() {
    const left = Math.max(0, this.store.duesCents() - this.store.dues(this.myPid).paid - this.store.dues(this.myPid).waiting);
    this.payForm.reset({ amount: left ? String(left / 100) : '', date: today(), cat: 'Dues', desc: this.duesLabel() });
    this.open('pay');
  }
  openReimb() { this.payForm.reset({ amount: '', date: today(), cat: 'Team meals', desc: '' }); this.open('reimb'); }
  openEntry(l: LedgerEntry | null) {
    this.editing.set(l);
    this.entryForm.reset({
      kind: l?.kind ?? 'in', amount: l ? String(l.amountCents / 100) : '', date: l?.date ?? today(), cat: l?.cat ?? 'Other',
      desc: l?.desc ?? '', pid: l?.pid ?? '', payee: l?.pid ? '' : this.store.authorName(l?.payee) || l?.payee || ''
    });
    this.open('entry');
  }
  private open(k: FormKind) { this.error.set(''); this.confirmDelete.set(false); this.form.set(k); }

  async submitPayment() {
    const v = this.payForm.getRawValue();
    const amountCents = toCents(v.amount);
    if (!amountCents) { this.error.set('Enter the amount, like 400 or 35.50.'); return; }
    if (!v.desc.trim()) { this.error.set('Say what it was for.'); return; }
    const kind: MoneyKind = this.form() === 'pay' ? 'in' : 'out';
    await this.busyRun(() => this.store.recordPayment({ kind, cat: v.cat, pid: kind === 'in' ? this.myPid : undefined, amountCents, date: v.date || today(), desc: v.desc.trim() }));
  }

  async submitEntry() {
    const v = this.entryForm.getRawValue();
    const amountCents = toCents(v.amount);
    if (!amountCents) { this.error.set('Enter the amount, like 400 or 35.50.'); return; }
    if (!v.desc.trim()) { this.error.set('Add a description.'); return; }
    const e = this.editing();
    const entry: LedgerEntry = {
      lid: e?.lid ?? newId('l'), kind: v.kind, cat: v.cat, amountCents, date: v.date || today(), desc: v.desc.trim(),
      pid: v.pid || undefined, payee: v.pid ? undefined : (e?.payee && this.store.authorName(e.payee) === v.payee ? e.payee : v.payee.trim() || undefined)
    };
    await this.busyRun(() => this.store.saveLedger(entry, !e));
  }

  async removeEntry() {
    const e = this.editing();
    if (!e) return;
    if (!this.confirmDelete()) { this.confirmDelete.set(true); return; }
    await this.busyRun(() => this.store.deleteLedger(e.lid));
  }

  private async busyRun(fn: () => Promise<boolean>) {
    this.busy.set(true);
    const ok = await fn();
    this.busy.set(false);
    if (ok) this.form.set(null);
  }

  // ----- pending actions -----
  readonly confirmWithdraw = signal<string | null>(null);
  settle(p: Payment, action: 'confirm' | 'decline') { void this.store.settlePayment(p, action); }
  withdraw(p: Payment) {
    if (this.confirmWithdraw() !== p.payId) { this.confirmWithdraw.set(p.payId); return; }
    this.confirmWithdraw.set(null);
    void this.store.withdrawPayment(p.payId);
  }
}
