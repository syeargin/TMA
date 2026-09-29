import { Component, computed, inject, input } from '@angular/core';
import { today } from '../../core/dates';
import type { Rsvp } from '../../core/models';
import { ScheduleItem, takesRsvp } from '../../core/schedule';
import { TeamStore } from '../../core/team-store';

/** In / Maybe / Out for one player on one item. Tap the chosen answer again to clear it. */
@Component({
  selector: 'th-rsvp',
  template: `
    @if (show()) {
      <span class="rsvp" role="group" [attr.aria-label]="label()">
        <button class="y" type="button" [attr.aria-pressed]="value() === 'yes'" (click)="set('yes')">In</button>
        <button class="m" type="button" [attr.aria-pressed]="value() === 'maybe'" (click)="set('maybe')">Maybe</button>
        <button class="n" type="button" [attr.aria-pressed]="value() === 'no'" (click)="set('no')">Out</button>
      </span>
    }`
})
export class RsvpButtons {
  readonly item = input.required<ScheduleItem>();
  readonly pid = input.required<string>();
  private readonly store = inject(TeamStore);

  readonly value = computed(() => this.store.rsvp(this.pid(), this.item().key));
  readonly show = computed(() => {
    const it = this.item();
    return this.store.canAnswerFor(this.pid()) && takesRsvp(it) && !it.cancelled && it.end >= today();
  });
  readonly label = computed(() => `${this.store.playerName(this.pid()) || 'Player'}'s availability for ${this.item().title}`);

  set(v: Rsvp) { void this.store.setRsvp(this.pid(), this.item().key, this.value() === v ? '' : v); }
}

/** "3 in · 1 maybe · 0 out · 5 no reply" — opens the list of every player's answer. */
@Component({
  selector: 'th-counts',
  template: `
    @if (show()) {
      <button class="link-btn counts" type="button" (click)="store.availabilityFor.set(item())">
        <span class="tn">{{ c().yes }}</span> in · <span class="tn">{{ c().maybe }}</span> maybe · <span class="tn">{{ c().no }}</span> out
        @if (c().none) { · <span class="tn">{{ c().none }}</span> no reply }
      </button>
    }`
})
export class RsvpCounts {
  readonly item = input.required<ScheduleItem>();
  readonly store = inject(TeamStore);
  readonly c = computed(() => this.store.counts(this.item().key));
  readonly show = computed(() => takesRsvp(this.item()) && !this.item().cancelled && this.store.players().length > 0);
}

/** Travel / Local / Team event / Deadline / Cancelled. */
@Component({
  selector: 'th-kind-pill',
  template: `
    @switch (item().kind) {
      @case ('tournament') { <span class="pill" [class.p-travel]="item().travel" [class.p-local]="!item().travel">{{ item().travel ? 'Travel' : 'Local' }}</span> }
      @case ('practice') { @if (item().cancelled) { <span class="pill p-bad">Cancelled</span> } }
      @case ('deadline') { <span class="pill p-mute">Deadline</span> }
      @default { <span class="pill p-warn">Team event</span> }
    }`
})
export class KindPill {
  readonly item = input.required<ScheduleItem>();
}

/** A player's answer as a pill (In / Maybe / Out / No reply). */
@Component({
  selector: 'th-status',
  template: `
    @switch (value()) {
      @case ('yes') { <span class="pill p-ok">In</span> }
      @case ('maybe') { <span class="pill p-warn">Maybe</span> }
      @case ('no') { <span class="pill p-bad">Out</span> }
      @default { @if (showNone()) { <span class="pill p-mute">No reply</span> } }
    }`
})
export class RsvpStatus {
  readonly value = input.required<Rsvp | ''>();
  readonly showNone = input(true);
}
