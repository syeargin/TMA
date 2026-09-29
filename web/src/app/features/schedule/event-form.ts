import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { newId } from '../../core/dates';
import type { EventKind, TeamEvent } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';

const KIND_LABEL: Record<EventKind, string> = { tournament: 'Tournament', event: 'Team event', deadline: 'Deadline' };

/** Add or edit a tournament, team event or deadline. Fields it doesn't show are kept as they were. */
@Component({
  selector: 'th-event-form',
  imports: [ReactiveFormsModule, Sheet, Messages],
  template: `
    <th-sheet [heading]="heading()" [open]="open()" (closed)="closed.emit()">
      <form [formGroup]="form" (ngSubmit)="save()" novalidate>
        <th-messages [error]="error()" />
        <div class="two">
          <label>Kind
            <select formControlName="kind">
              @for (k of kinds; track k) { <option [value]="k">{{ kindLabel[k] }}</option> }
            </select>
          </label>
          @if (kind() === 'tournament') {
            <label>Type
              <select formControlName="travel"><option [ngValue]="false">Local</option><option [ngValue]="true">Travel</option></select>
            </label>
          } @else {
            <label>Time<input formControlName="time" placeholder="7:00 PM"></label>
          }
        </div>
        <label>Name<input formControlName="title" required [placeholder]="kind() === 'tournament' ? 'Winter Classic' : 'Team dinner'"></label>
        <div class="two">
          <label>{{ kind() === 'tournament' ? 'Start date' : 'Date' }}<input type="date" formControlName="date" required></label>
          @if (kind() === 'tournament') { <label>End date<input type="date" formControlName="endDate"></label> }
        </div>
        @if (kind() === 'tournament') {
          <div class="two">
            <label>City<input formControlName="city" placeholder="Columbus, OH"></label>
            <label>Division<input formControlName="division" placeholder="13 Open"></label>
          </div>
        }
        <label>{{ kind() === 'tournament' ? 'Venue' : 'Location' }}<input formControlName="location"></label>
        <label>{{ kind() === 'tournament' ? 'Notes' : 'Details' }}<textarea formControlName="notes" rows="3"></textarea></label>
        @if (kind() === 'tournament') { <p class="hint">Game-day details (parking, arrival, uniforms, hotel) arrive with the tournament pages in the next step.</p> }
        <div class="form-actions">
          <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save' }}</button>
          <button class="btn ghost" type="button" (click)="closed.emit()">Cancel</button>
          <span class="spacer"></span>
          @if (event()) {
            <button class="btn" type="button" [class.danger]="!confirmDelete()" [class.confirming]="confirmDelete()" [disabled]="busy()" (click)="remove()">
              {{ confirmDelete() ? 'Tap again to delete' : 'Delete' }}
            </button>
          }
        </div>
      </form>
    </th-sheet>`
})
export class EventForm {
  readonly open = input(false);
  /** The event being edited; null to add a new one. */
  readonly event = input<TeamEvent | null>(null);
  readonly defaultKind = input<EventKind>('event');
  readonly closed = output<void>();

  private readonly store = inject(TeamStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly kinds: EventKind[] = ['tournament', 'event', 'deadline'];
  readonly kindLabel = KIND_LABEL;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly confirmDelete = signal(false);

  readonly form = this.fb.group({
    kind: 'event' as EventKind, title: '', date: '', endDate: '', time: '', location: '', city: '', division: '',
    travel: false, notes: ''
  });
  readonly kind = signal<EventKind>('event');
  readonly heading = computed(() => (this.event() ? `Edit ${KIND_LABEL[this.kind()].toLowerCase()}` : `Add ${KIND_LABEL[this.kind()].toLowerCase()}`));

  constructor() {
    this.form.controls.kind.valueChanges.subscribe((k) => this.kind.set(k));
    // Fill the form each time it opens.
    effect(() => {
      if (!this.open()) return;
      const e = this.event();
      const k = e?.kind ?? this.defaultKind();
      untracked(() => {
        this.error.set('');
        this.confirmDelete.set(false);
        this.form.reset({
          kind: k, title: e?.title ?? '', date: e?.date ?? '', endDate: e?.endDate ?? '', time: e?.time ?? '',
          location: e?.location ?? '', city: e?.city ?? '', division: e?.division ?? '', travel: !!e?.travel, notes: e?.notes ?? ''
        });
        this.kind.set(k);
      });
    });
  }

  async save() {
    const v = this.form.getRawValue();
    if (!v.title.trim()) { this.error.set('Give it a name.'); return; }
    if (!v.date) { this.error.set('Pick a date.'); return; }
    if (v.kind === 'tournament' && v.endDate && v.endDate < v.date) { this.error.set('The end date is before the start date.'); return; }
    const isT = v.kind === 'tournament';
    const next: TeamEvent = {
      ...(this.event() ?? {}),
      eid: this.event()?.eid ?? newId('e'),
      kind: v.kind, title: v.title.trim(), date: v.date,
      endDate: isT && v.endDate ? v.endDate : undefined,
      time: !isT ? v.time.trim() || undefined : undefined,
      location: v.location.trim() || undefined,
      city: isT ? v.city.trim() || undefined : undefined,
      division: isT ? v.division.trim() || undefined : undefined,
      travel: isT ? v.travel : false,
      notes: v.notes.trim() || undefined
    };
    // Drop bookkeeping fields the API sets itself.
    for (const k of ['type', 'updatedAt', 'updatedBy', 'GSI2PK', 'GSI2SK']) delete next[k];
    this.busy.set(true);
    const ok = await this.store.saveEvent(next, !this.event());
    this.busy.set(false);
    if (ok) this.closed.emit();
  }

  async remove() {
    const e = this.event();
    if (!e) return;
    if (!this.confirmDelete()) { this.confirmDelete.set(true); return; }
    this.busy.set(true);
    const ok = await this.store.deleteEvent(e.eid);
    this.busy.set(false);
    if (ok) this.closed.emit();
  }
}
