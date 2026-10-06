import { Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { addDays, daysUntil, fmt, fmtRange, newId, pd, today } from '../../core/dates';
import type { Announcement } from '../../core/models';
import { money, pending } from '../../core/money';
import { ScheduleItem, takesRsvp } from '../../core/schedule';
import { TeamStore } from '../../core/team-store';
import { Sheet } from '../../shared/sheet';
import { roleLabel } from '../../shared/roles';
import { AddToCalendar } from '../../shared/add-to-calendar';
import { KindPill, RsvpButtons, RsvpCounts, RsvpStatus } from '../schedule/rsvp';

interface Todo { title: string; sub: string; link: string | string[]; tone?: 'warn' | 'ok' }
interface Contact { name: string; role: string; phone?: string }

@Component({
  selector: 'th-team-home',
  imports: [RouterLink, ReactiveFormsModule, Sheet, AddToCalendar, KindPill, RsvpButtons, RsvpCounts, RsvpStatus],
  templateUrl: './team-home.html'
})
export class TeamHome {
  readonly store = inject(TeamStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly fmt = fmt;
  readonly fmtRange = fmtRange;
  readonly pd = pd;
  readonly pid = this.store.myPid;
  readonly money = money;

  readonly upcoming = computed(() => this.store.items().filter((i) => i.end >= today()));
  readonly next = computed(() => this.upcoming().find((i) => !i.cancelled && i.kind !== 'deadline') ?? null);
  readonly nextTournament = computed(() => this.upcoming().find((i) => i.kind === 'tournament') ?? null);
  readonly week = computed(() => this.upcoming().filter((i) => i.date <= addDays(today(), 7)));
  readonly weekCount = computed(() => this.week().filter((i) => !i.cancelled).length);

  /** "today" / "tomorrow" / "in 5 days" */
  until(date: string) {
    const d = daysUntil(date);
    return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
  }
  daysUntil = daysUntil;
  whenOf(it: ScheduleItem) { return it.kind === 'tournament' ? fmtRange(it.date, it.end) : it.time; }

  readonly needsLink = computed(() => !this.store.archived() && this.store.you().roles.includes('parent') && !this.store.you().pid);

  readonly todos = computed<Todo[]>(() => {
    const out: Todo[] = [];
    const pid = this.pid();
    if (pid) {
      const soon = this.upcoming().filter((i) => takesRsvp(i) && !i.cancelled && i.date <= addDays(today(), 14) && !this.store.rsvp(pid, i.key));
      if (soon.length) out.push({
        title: `Mark ${this.store.playerName(pid) || 'your player'}'s availability`,
        sub: `${soon.length} practice${soon.length > 1 ? 's and events' : ' or event'} in the next 2 weeks need${soon.length > 1 ? '' : 's'} a reply`,
        link: 'schedule'
      });
    }
    const t0 = today();
    if (pid && this.store.duesCents()) {
      const d = this.store.dues(pid);
      const left = this.store.duesCents() - d.paid;
      const due = this.store.settings()?.dues?.due;
      if (left > 0) out.push({
        title: `Team fund: ${money(left)} to go`,
        sub: d.waiting ? `${money(d.waiting)} recorded, waiting to be confirmed` : `${due ? 'Due ' + fmt(due, { month: 'long', day: 'numeric' }) + '. ' : ''}Record it here once you’ve paid.`,
        link: 'fund', tone: d.waiting ? 'warn' : undefined
      });
    }
    if (this.store.can('finance')) {
      const p = pending(this.store.payments());
      if (p.length) out.push({ title: `Confirm ${p.length} payment${p.length > 1 ? 's or requests' : ' or request'}`, sub: 'Sent in by families', link: 'fund' });
    }
    if (pid) {
      const need = this.store.tournaments().filter((e) => e.travel && e.date >= t0 && daysUntil(e.date) <= 150 && !this.store.travelOf(pid, e.eid));
      if (need.length) out.push({
        title: `Add travel plans for ${need[0].title}`,
        sub: `${fmtRange(need[0].date, need[0].endDate)}${need[0].city ? ' · ' + need[0].city : ''}${need.length > 1 ? ` · plus ${need.length - 1} more trip${need.length > 2 ? 's' : ''}` : ''}`,
        link: ['tournaments', need[0].eid, 'travel'], tone: 'warn'
      });
    }
    if (pid || this.store.can('meals')) {
      const upcomingIds = new Set(this.store.tournaments().filter((e) => (e.endDate || e.date) >= t0).map((e) => e.eid));
      const open = this.store.meals().filter((m) => !m.claimedBy && upcomingIds.has(m.eid));
      if (open.length) {
        const first = this.store.tournaments().find((e) => e.eid === open[0].eid)!;
        out.push({ title: `${open.length} team meal${open.length > 1 ? 's' : ''} need a family`, sub: `Starting with ${first.title}`, link: ['tournaments', first.eid, 'meals'], tone: 'warn' });
      }
    }
    if (this.store.can('refjobs')) {
      const nt = this.store.tournaments().find((e) => (e.endDate || e.date) >= t0);
      if (nt && !Object.keys(this.store.refjobs()[nt.eid]?.assign ?? {}).length && this.store.players().length) {
        out.push({ title: `Assign ref jobs for ${nt.title}`, sub: fmtRange(nt.date, nt.endDate), link: ['tournaments', nt.eid, 'ref'], tone: 'ok' });
      }
    }
    if (this.store.can('tasks')) {
      const open = this.store.tasks().filter((x) => x.status !== 'Done' && x.status !== 'N/A');
      if (open.length) out.push({ title: `${open.length} coordinator task${open.length > 1 ? 's' : ''} open`, sub: open[0].title, link: ['info', 'tasks'], tone: 'ok' });
    }
    if (this.store.can('settings') && !this.store.duesCents()) {
      out.push({ title: 'Set team dues', sub: 'Dues, coaches, checklist and uniform items live in team settings', link: 'info', tone: 'ok' });
    }
    if (this.store.can('schedule') && !this.store.settings()?.practices?.length) {
      out.push({ title: 'Add practice times', sub: 'Weekly practices fill the schedule for the season', link: 'schedule', tone: 'ok' });
    }
    if (this.store.can('accounts')) {
      const unlinked = this.store.members().filter((m) => m.roles.includes('parent') && !m.pid);
      if (unlinked.length) out.push({
        title: `Link ${unlinked.length} parent${unlinked.length > 1 ? 's' : ''} to their player`,
        sub: 'So they can mark availability for their family', link: 'members', tone: 'warn'
      });
    }
    return out;
  });

  readonly contacts = computed<Contact[]>(() => {
    const out: Contact[] = (this.store.settings()?.coaches ?? []).map((c) => ({ name: c.name, role: 'Coach', phone: c.phone }));
    for (const role of ['coordinator', 'food'] as const) {
      for (const m of this.store.members().filter((x) => x.roles.includes(role))) {
        const name = this.store.authorName(m.sub);
        if (!name) continue;
        const parent = this.store.players().find((p) => p.pid === m.pid)?.parents?.[0];
        out.push({ name, role: roleLabel(role), phone: parent?.cell });
      }
    }
    return out;
  });

  // ----- announcements -----
  readonly annOpen = signal(false);
  readonly annBusy = signal(false);
  readonly confirmDelete = signal<string | null>(null);
  readonly annForm = this.fb.group({ text: '', pinned: false });

  postAnnouncement() {
    this.annForm.reset({ text: '', pinned: false });
    this.annOpen.set(true);
  }
  async submitAnnouncement() {
    const v = this.annForm.getRawValue();
    if (!v.text.trim()) return;
    this.annBusy.set(true);
    const ok = await this.store.saveAnnouncement(newId('a'), { text: v.text.trim(), pinned: v.pinned });
    this.annBusy.set(false);
    if (ok) this.annOpen.set(false);
  }
  togglePin(a: Announcement) {
    void this.store.saveAnnouncement(a.aid, { text: a.text, pinned: !a.pinned }, a.pinned ? 'Unpinned' : 'Pinned');
  }
  deleteAnnouncement(a: Announcement) {
    if (this.confirmDelete() !== a.aid) { this.confirmDelete.set(a.aid); return; }
    this.confirmDelete.set(null);
    void this.store.deleteAnnouncement(a.aid);
  }
  annDate(a: Announcement) { return a.at ? fmt(a.at.slice(0, 10), { month: 'short', day: 'numeric' }) : ''; }
}
