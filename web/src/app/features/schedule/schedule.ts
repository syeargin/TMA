import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { addDays, fmt, fmtRange, pd, today } from '../../core/dates';
import type { EventKind, TeamEvent } from '../../core/models';
import { ScheduleItem } from '../../core/schedule';
import { TeamStore } from '../../core/team-store';
import { EventForm } from './event-form';
import { PracticesForm } from './practices-form';
import { KindPill, RsvpButtons, RsvpCounts } from './rsvp';

type Filter = 'all' | 'practice' | 'tournament' | 'event';
type Range = '8w' | 'season';

@Component({
  selector: 'th-schedule',
  imports: [RouterLink, EventForm, PracticesForm, KindPill, RsvpButtons, RsvpCounts],
  templateUrl: './schedule.html'
})
export class Schedule {
  readonly store = inject(TeamStore);
  readonly filter = signal<Filter>('all');
  readonly range = signal<Range>('8w');
  readonly fmt = fmt;
  readonly pd = pd;
  readonly filters: [Filter, string][] = [['all', 'Everything'], ['practice', 'Practices'], ['tournament', 'Tournaments'], ['event', 'Team events']];
  readonly ranges: [Range, string][] = [['8w', 'Next 8 weeks'], ['season', 'Rest of season']];

  readonly eventOpen = signal(false);
  readonly editing = signal<TeamEvent | null>(null);
  readonly newKind = signal<EventKind>('event');
  readonly practicesOpen = signal(false);

  readonly pid = this.store.myPid;
  readonly note = computed(() => {
    const name = this.store.playerName(this.pid());
    if (this.pid() && name) return `Marking availability for ${name}. Tap In, Maybe or Out on each row.`;
    if (this.store.can('attendance')) return 'Tap the counts on any row to see and mark each player’s availability.';
    if (this.store.can('family')) return 'Your account isn’t linked to a player yet. Ask your team admin to link you so you can mark availability.';
    return 'Families mark their player’s availability here.';
  });

  /** Items in range and filter, grouped under month headings. */
  readonly months = computed(() => {
    const from = today();
    const lim = this.range() === '8w' ? addDays(from, 56) : '9999';
    const f = this.filter();
    const items = this.store.items().filter((i) => i.end >= from && i.date <= lim &&
      (f === 'all' || (f === 'event' ? i.kind === 'event' || i.kind === 'deadline' : i.kind === f)));
    const out: { key: string; label: string; items: ScheduleItem[] }[] = [];
    for (const it of items) {
      const key = it.date.slice(0, 7);
      if (out.at(-1)?.key !== key) out.push({ key, label: fmt(it.date, { month: 'long', year: 'numeric' }), items: [] });
      out.at(-1)!.items.push(it);
    }
    return out;
  });

  when(it: ScheduleItem) {
    if (it.kind !== 'tournament') return it.time;
    return it.end !== it.date ? fmtRange(it.date, it.end) : '';
  }

  add(kind: EventKind) { this.editing.set(null); this.newKind.set(kind); this.eventOpen.set(true); }
  edit(it: ScheduleItem) { if (it.event) { this.editing.set(it.event); this.eventOpen.set(true); } }
  toggleCancelled(it: ScheduleItem) { void this.store.setPracticeCancelled(it.key, !it.cancelled); }
}
