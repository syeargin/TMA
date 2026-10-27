import { reviewItems } from '@shared/feed-rules';
import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { Permission, can as roleCan } from '@shared/permissions';
import { clubAllows, FEATURES, Feature, isOn, type ClubFeature } from '@shared/features';
import { ApiError, ApiService } from './api.service';
import { explain } from './errors';
import { LiveService } from './live.service';
import type { Agenda, Announcement, Handbook, Settings, Task, LedgerEntry, Meal, Member, MoneyKind, Occurrence, Payment, Player, RefAssign, Rsvp, TeamBundle, TeamEvent, Travel } from './models';
import { duesFor, fundStats } from './money';
import { fullName } from './me.service';
import type { PatternSuggestion } from './series';
import type { MatchDoc } from '@shared/matches';
import { ScheduleItem, buildItems, countsFor, rsvpOf, untimedPractices } from './schedule';
import { summarize, type AttendanceRecord, type PlayerMark, type Summary } from '@shared/attendance';
import { today } from './dates';
import { ToastService } from './toast.service';

/**
 * Everything about the open team, shared by its tabs. Provided by the team shell, so it lives
 * exactly as long as someone is on a team page. Live notices refresh it; the refresh is held while
 * someone is typing or has a pop-up form open, and the header offers "New changes · Show".
 */
/** Permissions that only let you see things; everything else changes something. */
const VIEW_ONLY = new Set<Permission>(['contacts', 'allergies', 'fundView', 'ledger']);
/** Permissions that belong to an optional feature: they don't apply while it's switched off. */
const PERM_FEATURE: Partial<Record<Permission, Feature>> = {
  fundView: 'fund', ledger: 'fund', finance: 'fund', reimb: 'fund',
  meals: 'meals', refjobs: 'refjobs', scores: 'matches', tasks: 'tasks', handbook: 'handbook', takeAttendance: 'attendance', calendarFeed: 'calfeed'
};

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
  /** Which practice's attendance is being taken (rendered once by the team shell). */
  readonly attendanceFor = signal<ScheduleItem | null>(null);

  readonly you = computed(() => this.bundle()?.you ?? { roles: [] });
  readonly settings = computed(() => this.bundle()?.settings ?? null);
  /** The club this team belongs to: name, colors, and the links shown on Team Info. */
  readonly club = computed(() => this.bundle()?.club ?? null);
  readonly clubId = computed(() => this.bundle()?.clubId ?? '');
  /**
   * Calendar feed sync: what needs a feed admin's eye (team admins and coordinators): events gone from the
   * club's calendar, possible duplicates, overrides the calendar has changed, a paused or failing feed.
   */
  readonly feedAlert = computed(() => {
    const st = this.bundle()?.feedStatus;
    if (!st || !this.can('calendarFeed')) return null;
    const review = reviewItems(this.events(), today()).length;
    const failing = st.failures >= 3;
    if (!review && !st.attention && !failing && !(st.paused && this.has('calfeed'))) return null;
    return { review, attention: st.attention, failing, catchUp: st.paused && this.has('calfeed') };
  });
  readonly players = computed<Player[]>(() => [...(this.bundle()?.players ?? [])].sort((a, b) =>
    (a.order ?? 999) - (b.order ?? 999) || String(a.last ?? '').localeCompare(String(b.last ?? '')) || a.first.localeCompare(b.first)));
  readonly events = computed<TeamEvent[]>(() => this.bundle()?.events ?? []);
  readonly family = computed(() => this.bundle()?.family ?? {});
  readonly members = computed<Member[]>(() => this.bundle()?.members ?? []);
  readonly announcements = computed<Announcement[]>(() => [...(this.bundle()?.announcements ?? [])].sort((a, b) =>
    Number(!!b.pinned) - Number(!!a.pinned) || String(b.at ?? '').localeCompare(String(a.at ?? ''))));
  readonly items = computed(() => buildItems(this.events(), this.settings()));
  /**
   * Practices coming up that have no start time (one-off practices from a spreadsheet's Schedule tab can
   * leave it blank). A series counts once, at its first date without a time. Soonest first.
   */
  readonly practicesWithoutTime = computed(() => untimedPractices(this.items(), today()));
  /** Practice attendance records (staff: everyone's; a family: their own player's marks). */
  readonly attendance = computed<AttendanceRecord[]>(() => this.bundle()?.attendance ?? []);
  /** Practices that still count toward attendance: cancelled ones don't. */
  readonly practiceKeys = computed(() => new Set(this.items().filter((i) => i.kind === 'practice' && !i.cancelled).map((i) => i.key)));
  attendanceOf(key: string): AttendanceRecord | undefined { return this.attendance().find((r) => r.key === key); }
  /** Attendance can be taken on a practice's day or after, by coaches, coordinators and admins. */
  canTakeAttendance(it: ScheduleItem): boolean { return it.kind === 'practice' && !it.cancelled && it.date <= today() && this.can('takeAttendance'); }
  /** Totals per player, optionally between two dates (YYYY-MM-DD). */
  attendanceSummary(from?: string, to?: string): Summary {
    return summarize(this.attendance(), this.players().map((p) => p.pid), { practices: this.practiceKeys(), excusedCount: this.settings()?.attendanceExcusedCounts !== false, from, to });
  }
  readonly meals = computed<Meal[]>(() => this.bundle()?.meals ?? []);
  readonly ledger = computed<LedgerEntry[]>(() => [...(this.bundle()?.ledger ?? [])].sort((a, b) =>
    b.date.localeCompare(a.date) || String(b.at ?? '').localeCompare(String(a.at ?? ''))));
  readonly payments = computed<Payment[]>(() => this.bundle()?.payments ?? []);
  readonly handbook = computed<Handbook>(() => this.bundle()?.handbook ?? { sections: [] });
  readonly tasks = computed<Task[]>(() => [...(this.bundle()?.tasks ?? [])].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.title.localeCompare(b.title)));
  readonly duesCents = computed(() => this.settings()?.dues?.amountCents ?? 0);
  /** Team totals: added up here from the full ledger, or sent by the server when you see only your own entries. */
  readonly fund = computed(() => this.bundle()?.fundSummary ?? fundStats(this.ledger(), this.payments(), this.players(), this.duesCents()));
  dues(pid: string) { return duesFor(pid, this.ledger(), this.payments()); }
  uniformOf(pid: string): Record<string, string> { return this.family()[pid]?.uniform?.sizes ?? {}; }
  /** Sizes entered: from the sizes themselves, or the server's yes/no for other families. */
  hasSizes(pid: string): boolean { const u = this.family()[pid]?.uniform; return !!u?.entered || Object.values(u?.sizes ?? {}).some(Boolean); }
  /** Whether your family shares its contact details with the other families. */
  readonly sharingContacts = computed(() => { const pid = this.myPid(); return !!pid && this.family()[pid]?.shareContacts === true; });
  readonly refjobs = computed(() => this.bundle()?.refjobs ?? {});
  /** Match tracker per tournament. */
  readonly matches = computed<Record<string, MatchDoc>>(() => this.bundle()?.matches ?? {});
  /** Whether you can enter scores at this tournament: staff, or its scorekeeper. */
  canScore(eid: string): boolean {
    if (this.readOnly() || !this.has('matches')) return false;
    return this.can('scores') || (!!this.matches()[eid]?.scorekeeper && this.matches()[eid]?.scorekeeper === (this.you() as { sub?: string }).sub);
  }
  /** Tournaments where you're the scorekeeper and something is still to play (for "For you"). */
  readonly keeperOf = computed(() => {
    const sub = (this.you() as { sub?: string }).sub;
    if (!sub || !this.has('matches')) return [];
    return this.tournaments().filter((e) => this.matches()[e.eid]?.scorekeeper === sub && (e.endDate || e.date) >= today());
  });
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

  /** Archived teams are read-only: everyone keeps what they could see, nobody can change anything. */
  readonly archived = computed(() => !!this.bundle()?.team?.archived);
  /** Every team in an inactive club is read-only too, except for site owners (site admin dashboard). */
  readonly clubInactive = computed(() => this.bundle()?.clubControls?.status === 'inactive');
  readonly readOnly = computed(() => this.archived() || (this.clubInactive() && !this.bundle()?.you?.siteOwner));
  /** Optional features: on unless the team or its club switched them off. */
  has(f: Feature): boolean { return isOn(this.settings()?.features, f); }
  /** Whether the club includes a feature at all (site admin dashboard). */
  clubAllows(f: ClubFeature): boolean { return clubAllows(this.bundle()?.clubControls?.features, f); }
  can(perm: Permission): boolean {
    if (this.readOnly() && !VIEW_ONLY.has(perm)) return false;
    const f = PERM_FEATURE[perm];
    if (f && !this.has(f)) return false;
    return roleCan(this.you().roles, perm);
  }
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
    void this.convertPracticeTimes();
  }

  private converting = false;
  /**
   * Teams set up before practices were events still have weekly "practice times". The first time someone who
   * can edit the schedule opens the team, they become practice series (answers and cancelled dates carry over).
   */
  private async convertPracticeTimes() {
    const s = this.settings();
    if (this.converting || this.readOnly() || !this.can('schedule') || !(s?.practices ?? []).some((p) => p.from)) return;
    this.converting = true;
    try {
      const r = await this.api.convertPractices(this.teamId());
      if (r.converted) {
        this.toast.show(`Weekly practices are now on the schedule as ${r.converted === 1 ? 'a practice series' : `${r.converted} practice series`}. Edit them from any practice date.`);
        await this.load();
      }
    } catch (err) {
      console.warn('Practice conversion failed', err);
    } finally {
      this.converting = false;
    }
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
  /** Turn one-at-a-time events that follow a weekly pattern into one repeating event. Answers carry over. */
  combineEvents(s: PatternSuggestion) {
    return this.save(`Combined ${s.count} dates into a series`, (t) => this.api.combineEvents(t, { eids: s.eids, repeat: s.repeat, skip: s.skip }));
  }
  /** Call off (or restore) one date of a repeating event. */
  setOccurrenceCancelled(e: TeamEvent, date: string, cancel: boolean) {
    const set = new Set(e.cancelled ?? []);
    if (cancel) set.add(date); else set.delete(date);
    const next = { ...e, cancelled: [...set].sort() } as TeamEvent & Record<string, unknown>;
    for (const k of ['type', 'updatedAt', 'updatedBy', 'GSI2PK', 'GSI2SK']) delete next[k];
    return this.save(cancel ? 'Cancelled for that date' : 'Restored', (t) => this.api.saveEvent(t, next));
  }
  /** Change one date of a series on its own; null puts it back to match the series. */
  saveOccurrence(e: TeamEvent, date: string, change: Occurrence | null) {
    const overrides = { ...(e.overrides ?? {}) };
    if (change && Object.values(change).some(Boolean)) overrides[date] = change; else delete overrides[date];
    const next = { ...e, overrides } as TeamEvent & Record<string, unknown>;
    for (const k of ['type', 'updatedAt', 'updatedBy', 'GSI2PK', 'GSI2SK']) delete next[k];
    return this.save(change ? 'Saved for that date' : 'That date matches the series again', (t) => this.api.saveEvent(t, next));
  }
  /** "This and following dates": the series ends before `from` and `next` carries on. Answers move with the dates. */
  splitSeries(e: TeamEvent, from: string, next: TeamEvent) {
    return this.save('Saved from that date on', (t) => this.api.splitEvent(t, e.eid, from, next));
  }
  /** Old weekly practice times still showing until the team is converted. */
  setPracticeCancelled(key: string, cancelled: boolean) {
    return this.save(cancelled ? 'Practice cancelled' : 'Practice restored', (t) => this.api.setPracticeCancelled(t, key, cancelled));
  }
  saveAnnouncement(aid: string, a: { text: string; pinned: boolean; email?: boolean }, done = 'Posted') {
    if (!a.email) return this.save(done, (t) => this.api.saveAnnouncement(t, aid, a));
    // "Also email the team": the toast says how many it went to, or why it didn't go.
    let msg = done;
    return this.save('', async (t) => {
      const r = await this.api.saveAnnouncement(t, aid, a);
      msg = r.reason === 'cap' ? 'Posted. Not emailed: the team already sent two announcement emails this week.'
        : r.reason === 'off' ? 'Posted. Announcement emails are turned off for this team.'
        : `Posted and emailed to ${r.emailed ?? 0} ${r.emailed === 1 ? 'person' : 'people'}.`;
    }).then((ok) => { if (ok) this.toast.show(msg); return ok; });
  }
  /** Whether "Also email the team" is offered when posting. */
  readonly emailPosts = computed(() => !!this.bundle()?.emailPosts);
  deleteAnnouncement(aid: string) { return this.save('Announcement deleted', (t) => this.api.deleteAnnouncement(t, aid)); }

  event(eid: string) { return this.events().find((e) => e.eid === eid) ?? null; }
  travelOf(pid: string, eid: string): Travel | null { return this.family()[pid]?.travel?.[eid] ?? null; }
  saveMatch(eid: string, mid: string, m: Parameters<ApiService['saveMatch']>[3]) { return this.save('Match saved', (t) => this.api.saveMatch(t, eid, mid, m)); }
  clearMatch(eid: string, mid: string) { return this.save('Match cleared', (t) => this.api.clearMatch(t, eid, mid)); }
  setMatchSlots(eid: string, date: string, slots: number, done: string) { return this.save(done, (t) => this.api.setMatchSlots(t, eid, date, slots)); }
  setScorekeeper(eid: string, sub: string | null) { return this.save(sub ? 'Scorekeeper set' : 'Scorekeeper removed', (t) => this.api.setScorekeeper(t, eid, sub)); }
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
  setFeature(f: Feature, on: boolean) {
    return this.save(`${FEATURES[f].label} turned ${on ? 'on' : 'off'}`, (t) => this.api.saveFeatures(t, { [f]: on }));
  }
  setShareContacts(share: boolean) {
    const pid = this.myPid();
    return this.save(share ? 'Your contact details are shared with the team' : 'Your contact details are now staff-only', (t) => this.api.setShareContacts(t, pid, share));
  }
  saveAttendance(key: string, marks: Record<string, PlayerMark | null>) { return this.save('Attendance saved', (t) => this.api.saveAttendance(t, key, marks)); }
  setUniform(pid: string, sizes: Record<string, string>) { return this.save('Sizes saved', (t) => this.api.setUniform(t, pid, sizes)); }
  setTravel(pid: string, eid: string, travel: Travel | null) {
    return this.save(travel ? 'Travel plans saved' : 'Travel plans cleared', (t) => this.api.setTravel(t, pid, eid, travel));
  }

  /** Who wrote something, as this viewer can see them. */
  authorName(sub?: string): string {
    const m = this.members().find((x) => x.sub === sub);
    if (!m) return '';
    if (fullName(m)) return fullName(m);
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
