import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { Permission, can as roleCan } from '@shared/permissions';
import { ApiError, ApiService } from './api.service';
import { explain } from './errors';
import { LiveService } from './live.service';
import type { Agenda, Announcement, Handbook, Settings, Task, LedgerEntry, Meal, Member, MoneyKind, Payment, Player, Practice, RefAssign, Rsvp, TeamBundle, TeamEvent, Travel } from './models';
import { duesFor, fundStats } from './money';
import { ScheduleItem, buildItems, countsFor, rsvpOf } from './schedule';
import { ToastService } from './toast.service';

/**
 * Everything about the open team, shared by its tabs. Provided by the team shell, so it lives
 * exactly as long as someone is on a team page. Live notices refresh it; the refresh is held while
 * someone is typing or has a pop-up form open, and the header offers "New changes · Show".
 */
@Injectable()
export class TeamStore implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  private readonly toast = inject(ToastService);
  private readonly subs = new Subscription();
  private readonly editors = new Set<() => boolean>();

  readonly teamId = signal('');
  readonly bundle = signal<TeamBundle | null>(null);
  readonly loadError = signal('');
  /** Fired with the collections that changed (after the bundle reloads). */
  readonly changed = new Subject<string[]>();
  /** The person lost access (removed from the team while looking at it). */
  readonly lost = new Subject<string>();
  /** Which item's availability list is open (rendered once by the team shell). */
  readonly availabilityFor = signal<ScheduleItem | null>(null);

  readonly you = computed(() => this.bundle()?.you ?? { roles: [] });
  readonly settings = computed(() => this.bundle()?.settings ?? null);
  readonly players = computed<Player[]>(() => [...(this.bundle()?.players ?? [])].sort((a, b) =>
    (a.order ?? 999) - (b.order ?? 999) || String(a.last ?? '').localeCompare(String(b.last ?? '')) || a.first.localeCompare(b.first)));
  readonly events = computed<TeamEvent[]>(() => this.bundle()?.events ?? []);
  readonly family = computed(() => this.bundle()?.family ?? {});
  readonly members = computed<Member[]>(() => this.bundle()?.members ?? []);
  readonly announcements = computed<Announcement[]>(() => [...(this.bundle()?.announcements ?? [])].sort((a, b) =>
    Number(!!b.pinned) - Number(!!a.pinned) || String(b.at ?? '').localeCompare(String(a.at ?? ''))));
  readonly items = computed(() => buildItems(this.events(), this.settings()));
  readonly meals = computed<Meal[]>(() => this.bundle()?.meals ?? []);
  readonly ledger = computed<LedgerEntry[]>(() => [...(this.bundle()?.ledger ?? [])].sort((a, b) =>
    b.date.localeCompare(a.date) || String(b.at ?? '').localeCompare(String(a.at ?? ''))));
  readonly payments = computed<Payment[]>(() => this.bundle()?.payments ?? []);
  readonly handbook = computed<Handbook>(() => this.bundle()?.handbook ?? { sections: [] });
  readonly tasks = computed<Task[]>(() => [...(this.bundle()?.tasks ?? [])].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.title.localeCompare(b.title)));
  readonly duesCents = computed(() => this.settings()?.dues?.amountCents ?? 0);
  readonly fund = computed(() => fundStats(this.ledger(), this.payments(), this.players(), this.duesCents()));
  dues(pid: string) { return duesFor(pid, this.ledger(), this.payments()); }
  uniformOf(pid: string): Record<string, string> { return this.family()[pid]?.uniform?.sizes ?? {}; }
  readonly refjobs = computed(() => this.bundle()?.refjobs ?? {});
  readonly agenda = computed(() => this.bundle()?.agenda ?? {});
  /** Tournaments, soonest first. */
  readonly tournaments = computed(() => this.events().filter((e) => e.kind === 'tournament').sort((a, b) => a.date.localeCompare(b.date)));
  readonly teamName = computed(() => this.settings()?.teamName || this.teamId());
  /** The player this account answers for (parents), if linked. */
  readonly myPid = computed(() => (this.can('family') ? this.you().pid || '' : ''));

  constructor() {
    this.subs.add(this.live.changes.subscribe((c) => { if (c.teamId === this.teamId()) void this.refresh(c.collections); }));
    this.subs.add(this.live.showHeld.subscribe(() => void this.refresh(['*'], true)));
    this.subs.add(this.live.denied.subscribe((id) => { if (id === this.teamId()) this.lost.next(id); }));
  }

  can(perm: Permission): boolean { return roleCan(this.you().roles, perm); }
  playerName(pid: string | undefined): string {
    const p = this.players().find((x) => x.pid === pid);
    return p ? p.first : '';
  }
  rsvp(pid: string, key: string) { return rsvpOf(this.family(), pid, key); }
  counts(key: string) { return countsFor(this.players(), this.family(), key); }
  /** Anyone may mark their own player; coaches, coordinators and admins may mark anyone. */
  canAnswerFor(pid: string) { return (!!pid && pid === this.myPid()) || this.can('attendance'); }

  async open(teamId: string): Promise<void> {
    this.teamId.set(teamId);
    this.bundle.set(null);
    this.loadError.set('');
    try {
      await this.load();
      this.live.watch(teamId);
    } catch (err) {
      this.loadError.set((err as Error).message);
    }
  }

  async load(): Promise<void> {
    const b = await this.api.team(this.teamId());
    this.bundle.set(b);
    this.live.held.set(false);
  }

  /** A form or panel registers "am I mid-edit?" so live refreshes wait for it. */
  registerEditor(isEditing: () => boolean): () => void {
    this.editors.add(isEditing);
    return () => this.editors.delete(isEditing);
  }

  isEditing(): boolean {
    const a = document.activeElement;
    if (a && a.closest('main form, dialog') && a.matches('input,select,textarea')) return true;
    if (document.querySelector('dialog[open]')) return true;
    for (const f of this.editors) if (f()) return true;
    return false;
  }

  /** Called on focus changes: apply a held change once nobody is editing. */
  applyHeldIfIdle() {
    setTimeout(() => { if (this.live.held() && !this.isEditing()) void this.refresh(['*']); }, 0);
  }

  async refresh(collections: string[], force = false): Promise<void> {
    if (!this.teamId()) return;
    if (!force && this.isEditing()) { this.live.held.set(true); return; }
    try {
      await this.load();
      this.changed.next(collections);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) { this.lost.next(this.teamId()); return; }
      console.warn('Live refresh failed', err);
    }
  }

  /** Runs a change, shows a short confirmation, and reloads so the page shows what was saved. */
  async save(done: string, fn: (teamId: string) => Promise<unknown>): Promise<boolean> {
    try {
      await fn(this.teamId());
      if (done) this.toast.show(done);
      await this.load();
      return true;
    } catch (err) {
      this.toast.show(explain(err), true);
      return false;
    }
  }

  /** Availability shows at once, then saves; if the save fails it rolls back. */
  async setRsvp(pid: string, key: string, v: Rsvp | ''): Promise<void> {
    const before = this.bundle();
    if (!before) return;
    const fam = before.family[pid] ?? { pid, rsvp: {} };
    const rsvp = { ...(fam.rsvp ?? {}) };
    if (v) rsvp[key] = { v }; else delete rsvp[key];
    this.bundle.set({ ...before, family: { ...before.family, [pid]: { ...fam, rsvp } } });
    try {
      await this.api.setRsvp(this.teamId(), pid, { [key]: v });
    } catch (err) {
      this.toast.show(explain(err), true);
      await this.load().catch(() => this.bundle.set(before));
    }
  }

  saveEvent(e: TeamEvent, isNew: boolean) { return this.save(isNew ? 'Added to the schedule' : 'Saved', (t) => this.api.saveEvent(t, e)); }
  deleteEvent(eid: string) { return this.save('Removed from the schedule', (t) => this.api.deleteEvent(t, eid)); }
  savePractices(p: Practice[]) { return this.save('Practice times saved', (t) => this.api.savePractices(t, p)); }
  setPracticeCancelled(key: string, cancelled: boolean) {
    return this.save(cancelled ? 'Practice cancelled' : 'Practice restored', (t) => this.api.setPracticeCancelled(t, key, cancelled));
  }
  saveAnnouncement(aid: string, a: { text: string; pinned: boolean }, done = 'Posted') {
    return this.save(done, (t) => this.api.saveAnnouncement(t, aid, a));
  }
  deleteAnnouncement(aid: string) { return this.save('Announcement deleted', (t) => this.api.deleteAnnouncement(t, aid)); }

  event(eid: string) { return this.events().find((e) => e.eid === eid) ?? null; }
  travelOf(pid: string, eid: string): Travel | null { return this.family()[pid]?.travel?.[eid] ?? null; }
  saveRefJobs(eid: string, assign: RefAssign, done = '') { return this.save(done, (t) => this.api.saveRefJobs(t, eid, assign)); }
  setRefGroups(groups: Record<string, 'A' | 'B'>) { return this.save('Groups saved', (t) => this.api.setRefGroups(t, groups)); }
  saveAgenda(eid: string, agenda: Agenda, done: string) { return this.save(done, (t) => this.api.saveAgenda(t, eid, agenda)); }
  saveMeal(m: Meal, isNew: boolean) { return this.save(isNew ? 'Meal added' : 'Meal saved', (t) => this.api.saveMeal(t, m)); }
  deleteMeal(m: Meal) { return this.save('Meal removed', (t) => this.api.deleteMeal(t, m.eid, m.mid)); }
  claimMeal(m: Meal, pid: string) { return this.save("Thanks! It's yours.", (t) => this.api.claimMeal(t, m.eid, m.mid, pid)); }
  releaseMeal(m: Meal) { return this.save('Meal reopened', (t) => this.api.releaseMeal(t, m.eid, m.mid)); }
  recordPayment(p: { kind: MoneyKind; cat: string; pid?: string; amountCents: number; date: string; desc: string }) {
    return this.save(p.kind === 'in' ? 'Payment recorded. Finance will confirm it.' : 'Request sent to finance', (t) => this.api.recordPayment(t, p));
  }
  withdrawPayment(payId: string) { return this.save('Withdrawn', (t) => this.api.withdrawPayment(t, payId)); }
  settlePayment(p: Payment, action: 'confirm' | 'decline') {
    const done = action === 'decline' ? 'Declined' : p.kind === 'in' ? 'Marked received' : 'Marked paid back';
    return this.save(done, (t) => this.api.settlePayment(t, p.payId, action));
  }
  saveLedger(l: LedgerEntry, isNew: boolean) { return this.save(isNew ? 'Entry added' : 'Entry saved', (t) => this.api.saveLedger(t, l)); }
  deleteLedger(lid: string) { return this.save('Entry removed', (t) => this.api.deleteLedger(t, lid)); }
  savePlayer(p: Player, isNew: boolean) { return this.save(isNew ? 'Player added' : 'Player saved', (t) => this.api.savePlayer(t, p)); }
  deletePlayer(pid: string) { return this.save('Player removed', (t) => this.api.deletePlayer(t, pid)); }
  saveHandbook(h: Handbook, done: string) { return this.save(done, (t) => this.api.saveHandbook(t, h)); }
  saveTask(task: Task, done = 'Task saved') { return this.save(done, (t) => this.api.saveTask(t, task)); }
  deleteTask(kid: string) { return this.save('Task deleted', (t) => this.api.deleteTask(t, kid)); }
  saveSettings(s: Settings) { return this.save('Settings saved', (t) => this.api.saveSettings(t, s)); }
  setUniform(pid: string, sizes: Record<string, string>) { return this.save('Sizes saved', (t) => this.api.setUniform(t, pid, sizes)); }
  setTravel(pid: string, eid: string, travel: Travel | null) {
    return this.save(travel ? 'Travel plans saved' : 'Travel plans cleared', (t) => this.api.setTravel(t, pid, eid, travel));
  }

  /** Who wrote something, as this viewer can see them. */
  authorName(sub?: string): string {
    const m = this.members().find((x) => x.sub === sub);
    if (!m) return '';
    if (m.person) return m.person;
    if (m.pid && this.playerName(m.pid)) return `${this.playerName(m.pid)}'s family`;
    return m.email ?? '';
  }

  close() {
    this.live.stop();
    this.teamId.set('');
  }

  ngOnDestroy() {
    this.close();
    this.subs.unsubscribe();
  }
}
