import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { record, tournamentDays, tournamentView } from '@shared/matches';
import { daysUntil, fmtRange, today } from '../../core/dates';
import type { ScheduleItem } from '../../core/schedule';
import { TeamStore } from '../../core/team-store';
import { safeUrl } from '../../core/tournament';
import { EventForm } from '../schedule/event-form';
import { MapLink } from '../../shared/map-link';
import { RsvpButtons, RsvpCounts } from '../schedule/rsvp';
import { AddToCalendar } from '../../shared/add-to-calendar';
import { Agenda } from './agenda';
import { GameDay } from './game-day';
import { Meals } from './meals';
import { Matches } from './matches';
import { RefJobs } from './ref-jobs';
import { TravelPlans } from './travel';

type Section = 'gameday' | 'matches' | 'ref' | 'meals' | 'travel' | 'agenda';
const LABELS: Record<Section, string> = { gameday: 'Game day', matches: 'Matches', ref: 'Ref jobs', meals: 'Meals', travel: 'Travel', agenda: 'Agenda' };

/** /teams/:id/tournaments/:eid[/:section] */
@Component({
  selector: 'th-tournament',
  imports: [MapLink, RouterLink, AddToCalendar, RsvpButtons, RsvpCounts, EventForm, GameDay, Matches, RefJobs, Meals, TravelPlans, Agenda],
  template: `
    <a class="link-btn small" [routerLink]="['/teams', store.teamId(), 'tournaments']" style="display:inline-block;margin-bottom:10px">‹ All tournaments</a>
    @if (event(); as e) {
      <div class="thead">
        <div>
          <div class="row" style="margin-bottom:8px">
            <span class="pill" [class.p-travel]="e.travel" [class.p-local]="!e.travel">{{ e.travel ? 'Travel' : 'Local' }}</span>
            @if (e.division) { <span class="pill dim">{{ e.division }}</span> }
            @if (record(); as r) { <a class="pill p-local thead-rec" [routerLink]="['/teams', store.teamId(), 'tournaments', e.eid, 'matches']" [attr.aria-label]="'Record ' + r + ', see matches'">{{ r }} record</a> }
          </div>
          <h2>{{ e.title }}</h2>
          <div class="meta" style="margin-top:8px">
            <span>{{ fmtRange(e.date, e.endDate) }}</span>
            @if (e.location || e.city || e.address) { <span><th-map-link [address]="e.address" [place]="e.location || e.city" [city]="e.location ? e.city : ''" /></span> }
            @if (website()) { <a [href]="website()" target="_blank" rel="noopener">Tournament website ↗</a> }
          </div>
        </div>
        <div class="count">
          @if (away() >= 0) { <div class="v tn">{{ away() }}</div><div class="label" style="color:var(--hdr-mute)">{{ away() === 1 ? 'day away' : 'days away' }}</div> }
          @else { <div class="label" style="color:var(--hdr-mute)">Completed</div> }
        </div>
      </div>
      <nav class="subtabs" aria-label="Tournament sections">
        @for (s of sections(); track s) {
          <a [routerLink]="['/teams', store.teamId(), 'tournaments', e.eid, s]" [class.active]="current() === s" [attr.aria-current]="current() === s ? 'page' : null">{{ labels[s] }}</a>
        }
      </nav>
      <div class="row" style="margin-bottom:14px">
        @if (store.myPid() && store.canAnswerFor(store.myPid())) {
          <span class="label">{{ store.playerName(store.myPid()) }}:</span>
          <th-rsvp [item]="item()!" [pid]="store.myPid()" />
        }
        <th-counts [item]="item()!" />
        <span class="spacer"></span>
        <th-add-to-calendar [item]="item()!" [path]="'/teams/' + store.teamId() + '/tournaments/' + e.eid" />
      </div>
      @switch (current()) {
        @case ('matches') { <th-matches [event]="e" /> }
        @case ('ref') { <th-ref-jobs [event]="e" /> }
        @case ('meals') { <th-meals [event]="e" /> }
        @case ('travel') { <th-travel [event]="e" /> }
        @case ('agenda') { <th-agenda [event]="e" /> }
        @default { <th-game-day [event]="e" (edit)="editing.set(true)" /> }
      }
      @if (store.can('schedule')) {
        <th-event-form [open]="editing()" [event]="e" (closed)="editing.set(false)" />
      }
    } @else {
      <div class="empty">That tournament isn’t on the schedule any more.</div>
    }`
})
export class Tournament {
  readonly eid = input.required<string>();
  readonly section = input<string>('gameday');
  readonly store = inject(TeamStore);
  readonly fmtRange = fmtRange;
  readonly labels = LABELS;
  readonly editing = signal(false);

  readonly event = computed(() => this.store.event(this.eid()));
  /** The record so far, once a match has a result. */
  readonly record = computed(() => {
    const e = this.event();
    if (!e || !this.store.has('matches')) return '';
    const t = tournamentView(this.store.matches()[e.eid], tournamentDays(e.date, e.endDate)).totals;
    return t.played ? record(t) : '';
  });
  readonly item = computed(() => this.store.items().find((i) => i.key === this.eid()) ?? null as ScheduleItem | null);
  readonly sections = computed<Section[]>(() => {
    const s = this.store;
    const travel = !!this.event()?.travel && s.has('travel');
    return (['gameday', 'matches', 'ref', 'meals', 'travel', 'agenda'] as Section[]).filter((x) =>
      x === 'gameday' || (x === 'matches' && s.has('matches')) || (x === 'ref' && s.has('refjobs')) || (x === 'meals' && s.has('meals')) || ((x === 'travel' || x === 'agenda') && travel));
  });
  readonly current = computed<Section>(() => {
    const s = (this.section() || 'gameday') as Section;
    return this.sections().includes(s) ? s : 'gameday';
  });
  readonly away = computed(() => {
    const e = this.event();
    if (!e) return -1;
    return (e.endDate || e.date) < today() ? -1 : Math.max(0, daysUntil(e.date));
  });
  readonly website = computed(() => safeUrl(this.event()?.website));
}
