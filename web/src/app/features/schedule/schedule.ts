import { Component, computed, effect, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { addDays, fmt, fmtRange, iso, pd, today } from '../../core/dates';
import { PatternSuggestion, describe, findPatterns, shortLabel } from '../../core/series';
import type { EventKind, TeamEvent } from '../../core/models';
import { ScheduleItem, courtLabel } from '../../core/schedule';
import { TeamStore } from '../../core/team-store';
import { AddToCalendar } from '../../shared/add-to-calendar';
import { EditMode, EventForm } from './event-form';
import { KindPill, RsvpButtons, RsvpCounts } from './rsvp';

type Filter = 'all' | 'practice' | 'tournament' | 'event';
type Range = '8w' | 'season';
type View = 'list' | 'month';
const VIEW_KEY = 'th.schedule.view';

function savedView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'month' ? 'month' : 'list'; } catch { return 'list'; }
}

export interface MonthCell { date: string; inMonth: boolean; isToday: boolean; items: ScheduleItem[] }

@Component({
  selector: 'th-schedule',
  imports: [NgTemplateOutlet, RouterLink, AddToCalendar, EventForm, KindPill, RsvpButtons, RsvpCounts],
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
  readonly describe = describe;
  readonly shortLabel = shortLabel;
  readonly weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  readonly view = signal<View>(savedView());
  /** First of the month shown in month view. */
  readonly monthStart = signal(today().slice(0, 7) + '-01');
  readonly selectedDay = signal<string | null>(today());
  readonly combining = signal('');

  readonly eventOpen = signal(false);
  readonly editing = signal<TeamEvent | null>(null);
  readonly newKind = signal<EventKind>('event');
  readonly editMode = signal<EditMode>('series');
  /** The schedule date picked for "this date" and "this and following". */
  readonly editAt = signal('');
  readonly courtLabel = courtLabel;

  readonly pid = this.store.myPid;

  constructor() {
    effect(() => { const v = this.view(); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } });
  }

  private matches(i: ScheduleItem): boolean {
    const f = this.filter();
    return f === 'all' || (f === 'event' ? i.kind === 'event' || i.kind === 'deadline' : i.kind === f);
  }

  /** One-time events that look like a series a coach could combine. */
  readonly patterns = computed(() => (this.store.can('schedule') ? findPatterns(this.store.events()) : []));
  patternText(p: PatternSuggestion) {
    const extra = p.skip.length ? ` (${p.skip.length} week${p.skip.length === 1 ? '' : 's'} off kept off)` : '';
    return `${p.count} separate “${p.title}” entries${p.time ? ' at ' + p.time : ''} follow a pattern: ${describe(p.repeat)}${extra}.`;
  }
  async combine(p: PatternSuggestion) {
    this.combining.set(p.eids[0]);
    await this.store.combineEvents(p);
    this.combining.set('');
  }

  /** Six Sunday-start weeks covering the shown month. Multi-day tournaments appear on each of their days. */
  readonly grid = computed(() => {
    const first = this.monthStart();
    const month = first.slice(0, 7);
    const start = addDays(first, -pd(first).getDay());
    // Always six weeks, so the calendar keeps the same size from month to month.
    const end = addDays(start, 41);
    const items = this.store.items().filter((i) => i.end >= start && i.date <= end && this.matches(i));
    const now = today();
    const weeks: MonthCell[][] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (pd(d).getDay() === 0) weeks.push([]);
      weeks.at(-1)!.push({ date: d, inMonth: d.startsWith(month), isToday: d === now, items: items.filter((i) => i.date <= d && i.end >= d) });
    }
    return weeks;
  });
  readonly monthLabel = computed(() => fmt(this.monthStart(), { month: 'long', year: 'numeric' }));
  readonly dayItems = computed(() => {
    const d = this.selectedDay();
    if (!d) return [];
    for (const w of this.grid()) for (const c of w) if (c.date === d) return c.items;
    return [];
  });
  shiftMonth(n: number) {
    const d = pd(this.monthStart());
    this.monthStart.set(iso(new Date(d.getFullYear(), d.getMonth() + n, 1)));
    this.selectedDay.set(null);
  }
  thisMonth() { this.monthStart.set(today().slice(0, 7) + '-01'); this.selectedDay.set(today()); }
  pick(c: MonthCell) {
    this.selectedDay.set(c.date);
    if (!c.inMonth) this.monthStart.set(c.date.slice(0, 7) + '-01');
  }
  cellLabel(c: MonthCell) {
    const n = c.items.length;
    return `${fmt(c.date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${n ? n + (n === 1 ? ' item' : ' items') : 'nothing scheduled'}`;
  }
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
    const items = this.store.items().filter((i) => i.end >= from && i.date <= lim && this.matches(i));
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

  add(kind: EventKind) { this.editing.set(null); this.editMode.set('series'); this.editAt.set(''); this.newKind.set(kind); this.eventOpen.set(true); }
  edit(it: ScheduleItem, mode: EditMode = 'series') {
    if (!it.event) return;
    this.editing.set(it.event);
    this.editMode.set(it.series ? mode : 'series');
    this.editAt.set(it.date);
    this.eventOpen.set(true);
  }
  toggleCancelled(it: ScheduleItem) {
    if (it.practice) void this.store.setPracticeCancelled(it.key, !it.cancelled);
    else if (it.event && it.series) void this.store.setOccurrenceCancelled(it.event, it.date, !it.cancelled);
  }
}
