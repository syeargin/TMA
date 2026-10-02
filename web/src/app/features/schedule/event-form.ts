import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { DAYS, newId, pd } from '../../core/dates';
import { describe, expandPattern } from '../../core/series';
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
        @if (kind() !== 'tournament') {
          <fieldset class="group">
            <legend>Repeat</legend>
            <label>Repeats
              <select formControlName="every">
                <option [ngValue]="0">Does not repeat</option>
                <option [ngValue]="1">Every week</option>
                <option [ngValue]="2">Every 2 weeks</option>
                <option [ngValue]="3">Every 3 weeks</option>
              </select>
            </label>
            @if (repeating()) {
              <div class="checks" role="group" aria-label="On these days" formGroupName="days">
                @for (d of dayNames; track $index) {
                  <label><input type="checkbox" [formControlName]="'d' + $index"> {{ d.slice(0, 3) }}</label>
                }
              </div>
              <div class="two">
                <label>Ends on<input type="date" formControlName="until"></label>
                <label class="checks" style="flex-direction:row;align-items:flex-end"><span><input type="checkbox" formControlName="skipTournaments"> Skip tournament days</span></label>
              </div>
              @if (preview()) { <p class="hint">{{ preview() }}</p> }
              @if (event()?.repeat) { <p class="hint">Changes apply to every date in the series. To call off one date, use “Cancel this date” on the schedule.</p> }
            }
          </fieldset>
        }
        @if (kind() === 'tournament') {
          <fieldset class="group">
            <legend>Game day</legend>
            <label>Tournament website<input type="url" formControlName="website" placeholder="https://"></label>
            <label>Parking<input formControlName="parking"></label>
            <div class="two">
              <label>Wave<input formControlName="waves" placeholder="Wave 2 (PM)"></label>
              <label>Arrival time<input formControlName="arrival" placeholder="7:15 AM"></label>
            </div>
            <div class="two">
              <label>First match<input formControlName="start" placeholder="8:00 AM"></label>
              <label>Where to meet<input formControlName="meet" placeholder="Court 12"></label>
            </div>
            <label>Uniforms<textarea formControlName="uniforms" rows="2" placeholder="Saturday: navy long sleeve · Sunday: red sleeveless"></textarea></label>
            <div class="two">
              <label>Admission link<input formControlName="admissions"></label>
              <label>Team code<input formControlName="teamCode" [placeholder]="teamCodeDefault()"></label>
            </div>
            <label>Match schedule link<input formControlName="scheduleLink" placeholder="https://"></label>
            <label>Ticket help<input formControlName="ticketHelp"></label>
            <label>Balls &amp; cart family
              <select formControlName="dutyPid">
                <option value="">—</option>
                @for (p of store.players(); track p.pid) { <option [value]="p.pid">{{ p.first }} {{ p.last }}</option> }
              </select>
            </label>
            <label>Food plan<textarea formControlName="foodPlan" rows="3"></textarea></label>
            <label>Restaurant reservations<textarea formControlName="reservations" rows="2"></textarea></label>
            <label>What to bring<textarea formControlName="checklist" rows="5"></textarea>
              <span class="hint">One item per line. Leave blank to use the team’s standard list.</span></label>
          </fieldset>
        }
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

  readonly store = inject(TeamStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly kinds: EventKind[] = ['tournament', 'event', 'deadline'];
  readonly kindLabel = KIND_LABEL;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly confirmDelete = signal(false);

  readonly form = this.fb.group({
    kind: 'event' as EventKind, title: '', date: '', endDate: '', time: '', location: '', city: '', division: '',
    travel: false, notes: '',
    website: '', parking: '', waves: '', arrival: '', start: '', meet: '', uniforms: '', admissions: '', teamCode: '',
    scheduleLink: '', ticketHelp: '', dutyPid: '', foodPlan: '', reservations: '', checklist: '',
    every: 0, until: '', skipTournaments: true,
    days: this.fb.group({ d0: false, d1: false, d2: false, d3: false, d4: false, d5: false, d6: false })
  });
  readonly dayNames = DAYS;
  private readonly values = signal(this.form.getRawValue());
  readonly repeating = computed(() => this.values().every > 0 && this.values().kind !== 'tournament');
  private pickedDays(v = this.values()) { return [0, 1, 2, 3, 4, 5, 6].filter((i) => v.days[`d${i}` as keyof typeof v.days]); }
  /** "Weekly on Tue & Thu until Mar 31 · 34 dates" */
  readonly preview = computed(() => {
    const v = this.values();
    const days = this.pickedDays(v);
    if (!this.repeating() || !v.date || !v.until || !days.length || v.until < v.date) return '';
    const n = expandPattern(v.date, v.until, days, v.every).length;
    return `${describe({ every: v.every, days, until: v.until })} · ${n} date${n === 1 ? '' : 's'}`;
  });
  readonly teamCodeDefault = computed(() => this.store.settings()?.teamCode ?? '');
  readonly kind = signal<EventKind>('event');
  readonly heading = computed(() => (this.event() ? `Edit ${KIND_LABEL[this.kind()].toLowerCase()}` : `Add ${KIND_LABEL[this.kind()].toLowerCase()}`));

  constructor() {
    this.form.controls.kind.valueChanges.subscribe((k) => this.kind.set(k));
    this.form.valueChanges.subscribe(() => this.values.set(this.form.getRawValue()));
    // Turning repeat on: start with the event's own weekday.
    this.form.controls.every.valueChanges.subscribe((every) => {
      const v = this.form.getRawValue();
      if (every > 0 && !this.pickedDays(v).length && v.date) this.form.controls.days.patchValue({ [`d${pd(v.date).getDay()}`]: true });
    });
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
          location: e?.location ?? '', city: e?.city ?? '', division: e?.division ?? '', travel: !!e?.travel, notes: e?.notes ?? '',
          website: e?.website ?? '', parking: e?.parking ?? '', waves: e?.waves ?? '', arrival: e?.arrival ?? '', start: e?.start ?? '',
          meet: e?.meet ?? '', uniforms: e?.uniforms ?? '', admissions: e?.admissions ?? '', teamCode: e?.teamCode ?? '',
          scheduleLink: e?.scheduleLink ?? '', ticketHelp: e?.ticketHelp ?? '', dutyPid: e?.dutyPid ?? '', foodPlan: e?.foodPlan ?? '',
          reservations: e?.reservations ?? '', checklist: (e?.checklist ?? []).join('\n'),
          every: e?.repeat?.every ?? 0, until: e?.repeat?.until ?? '', skipTournaments: e?.repeat?.skipTournaments ?? true,
          days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((i) => [`d${i}`, !!e?.repeat?.days.includes(i)]))
        });
        this.values.set(this.form.getRawValue());
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
    const days = this.pickedDays(v);
    if (!isT && v.every > 0) {
      if (!days.length) { this.error.set('Pick at least one day for it to repeat on.'); return; }
      if (!v.until) { this.error.set('Pick the date the series ends.'); return; }
      if (v.until < v.date) { this.error.set('The series ends before it starts.'); return; }
    }
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
    if (isT) {
      const text = ['website', 'parking', 'waves', 'arrival', 'start', 'meet', 'uniforms', 'admissions', 'teamCode', 'scheduleLink',
        'ticketHelp', 'dutyPid', 'foodPlan', 'reservations'] as const;
      for (const k of text) next[k] = v[k].trim() || undefined;
      const list = v.checklist.split('\n').map((s) => s.trim()).filter(Boolean);
      next.checklist = list.length ? list : undefined;
    }
    if (!isT && v.every > 0) {
      next.repeat = { every: v.every, days, until: v.until, skipTournaments: v.skipTournaments };
    } else {
      delete next.repeat; delete next.cancelled; delete next.skip;
    }
    // Drop bookkeeping fields the API sets itself.
    for (const k of ['type', 'updatedAt', 'updatedBy', 'GSI2PK', 'GSI2SK']) delete next[k];
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
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
