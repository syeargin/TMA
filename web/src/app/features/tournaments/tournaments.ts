import { Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { fmt, fmtRange, today } from '../../core/dates';
import type { TeamEvent } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { duties } from '../../core/tournament';
import { EventForm } from '../schedule/event-form';
import { RsvpStatus } from '../schedule/rsvp';

@Component({
  selector: 'th-tournaments',
  imports: [RouterLink, NgTemplateOutlet, EventForm, RsvpStatus],
  template: `
    <div class="sec-h">
      <div>
        <h2>Tournaments</h2>
        <p class="muted" style="margin-top:6px">{{ upcoming().length }} to go · {{ travelCount() }} travel weekend{{ travelCount() === 1 ? '' : 's' }} this season</p>
      </div>
      <span class="spacer"></span>
      @if (store.can('schedule')) { <button class="btn sm primary" type="button" (click)="adding.set(true)">Add tournament</button> }
    </div>
    <div class="tgrid">
      @for (e of upcoming(); track e.eid) { <ng-container *ngTemplateOutlet="card; context: { $implicit: e }" /> }
      @empty { <div class="empty">No upcoming tournaments.</div> }
    </div>
    @if (past().length) {
      <h3 class="month">Completed</h3>
      <div class="tgrid">@for (e of past(); track e.eid) { <ng-container *ngTemplateOutlet="card; context: { $implicit: e }" /> }</div>
    }

    <ng-template #card let-e>
      <a class="tcard" [class.past]="(e.endDate || e.date) < todayStr" [routerLink]="['/teams', store.teamId(), 'tournaments', e.eid]">
        <div class="top">
          <div class="when"><div class="m">{{ fmt(e.date, { month: 'short' }) }}</div><div class="dd tn">{{ days(e) }}</div></div>
          <div style="min-width:0"><h3>{{ e.title }}</h3><div class="small muted">{{ e.city || e.location || '' }}</div></div>
        </div>
        <div class="foot2">
          <span class="pill" [class.p-travel]="e.travel" [class.p-local]="!e.travel">{{ e.travel ? 'Travel' : 'Local' }}</span>
          @if (e.division) { <span class="pill p-mute">{{ e.division }}</span> }
          @for (d of duties(e); track d.label) { @if (d.pid !== 'na') { <span>{{ d.label }}: <b>{{ store.playerName(d.pid) }}</b></span> } }
          @if (e.travel) { <span>{{ travelPlans(e) }}/{{ store.players().length }} travel plans</span> }
          @if (store.myPid()) { <th-status [value]="store.rsvp(store.myPid(), e.eid)" [showNone]="false" /> }
        </div>
      </a>
    </ng-template>

    @if (store.can('schedule')) {
      <th-event-form [open]="adding()" defaultKind="tournament" (closed)="adding.set(false)" />
    }`
})
export class Tournaments {
  readonly duties = duties;
  readonly store = inject(TeamStore);
  readonly fmt = fmt;
  readonly todayStr = today();
  readonly adding = signal(false);
  readonly upcoming = computed(() => this.store.tournaments().filter((e) => (e.endDate || e.date) >= this.todayStr));
  readonly past = computed(() => this.store.tournaments().filter((e) => (e.endDate || e.date) < this.todayStr).reverse());
  readonly travelCount = computed(() => this.store.tournaments().filter((e) => e.travel).length);
  /** "7" or "7–8" (month shown above) */
  days(e: TeamEvent) { return fmtRange(e.date, e.endDate).replace(/^[A-Za-z]{3},? (?:[A-Za-z]{3} )?/, ''); }
  travelPlans(e: TeamEvent) { return this.store.players().filter((p) => this.store.travelOf(p.pid, e.eid)).length; }
}
