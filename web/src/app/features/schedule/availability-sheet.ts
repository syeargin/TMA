import { Component, computed, inject } from '@angular/core';
import { fmt } from '../../core/dates';
import { TeamStore } from '../../core/team-store';
import { Sheet } from '../../shared/sheet';
import { RsvpButtons, RsvpStatus } from './rsvp';

/** Everyone's answer for one practice or event. Coaches and coordinators can answer for any player. */
@Component({
  selector: 'th-availability-sheet',
  imports: [Sheet, RsvpButtons, RsvpStatus],
  template: `
    <th-sheet [heading]="heading()" [open]="!!store.availabilityFor()" (closed)="store.availabilityFor.set(null)">
      @if (store.availabilityFor(); as it) {
        <p class="muted small">{{ when() }}</p>
        <ul class="list">
          @for (p of store.players(); track p.pid) {
            <li class="li">
              <span class="grow"><b>{{ p.first }} {{ p.last }}</b>@if (p.jersey) { <span class="muted small"> #{{ p.jersey }}</span> }</span>
              @if (store.canAnswerFor(p.pid)) {
                <th-rsvp [item]="it" [pid]="p.pid" />
              } @else {
                <th-status [value]="store.rsvp(p.pid, it.key)" />
              }
            </li>
          } @empty {
            <li class="empty">No players on the roster yet.</li>
          }
        </ul>
      }
    </th-sheet>`
})
export class AvailabilitySheet {
  readonly store = inject(TeamStore);
  readonly heading = computed(() => this.store.availabilityFor()?.title ?? 'Availability');
  readonly when = computed(() => {
    const it = this.store.availabilityFor();
    if (!it) return '';
    const c = this.store.counts(it.key);
    return `${fmt(it.date, { weekday: 'long', month: 'long', day: 'numeric' })}${it.time ? ' · ' + it.time : ''} — ${c.yes} in, ${c.maybe} maybe, ${c.no} out, ${c.none} no reply`;
  });
}
