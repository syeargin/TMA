import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { DAYS, fmt, newId, pd } from '../../core/dates';
import { describe, expandPattern } from '../../core/series';
import type { EventKind, Occurrence, TeamEvent } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';

const KIND_LABEL: Record<EventKind, string> = { practice: 'Practice', tournament: 'Tournament', event: 'Team event', deadline: 'Deadline' };

/**
 * How an existing repeating event is being edited:
 *  - series: every date (dates changed on their own keep their changes)
 *  - date: one date only, saved as that date's change
 *  - following: this date and the rest; the series is split here
 */
export type EditMode = 'series' | 'date' | 'following';

/** Fields one date of a series can change on its own. */
const OCCURRENCE_FIELDS = ['title', 'time', 'endTime', 'location', 'court', 'uniformColor', 'notes'] as const;

/** Add or edit a practice, tournament, team event or deadline. Fields it doesn't show are kept as they were. */
@Component({
  selector: 'th-event-form',
  imports: [ReactiveFormsModule, Sheet, Messages],
  template: `
    <th-sheet [heading]="heading()" [open]="open()" (closed)="closed.emit()">
      <form [formGroup]="form" (ngSubmit)="save()" novalidate>
        <th-messages [error]="error()" />
        @if (mode() === 'date') {
          <p class="hint">Changes apply to {{ atLabel() }} only. The rest of the series stays as it is.</p>
        } @else if (mode() === 'following') {
          <p class="hint">Changes apply from {{ atLabel() }} on. Earlier dates keep the current details, and families' answers for later dates move with them.</p>
        }
        <div class="two">
          @if (mode() !== 'date') {
            <label>Type
              <select formControlName="kind">
                @for (k of kinds; track k) { <option [value]="k">{{ kindLabel[k] }}</option> }
              </select>
            </label>
          }
          @if (kind() === 'tournament') {
            <label>Travel
              <select formControlName="travel"><option [ngValue]="false">Local</option><option [ngValue]="true">Travel</option></select>
            </label>
          } @else if (kind() !== 'practice') {
            <label>Time<input formControlName="time" placeholder="7:00 PM"></label>
          }
        </div>
        <label>Name<input formControlName="title" required [placeholder]="placeholder()"></label>
        @if (kind() === 'practice') {
          <div class="two">
            <label>Start time<input formControlName="time" placeholder="6:30 PM"></label>
            <label>End time<input formControlName="endTime" placeholder="8:30 PM"></label>
          </div>
        }
        @if (mode() !== 'date') {
          <div class="two">
            <label>{{ kind() === 'tournament' ? 'Start date' : repeating() ? 'Starts on' : 'Date' }}<input type="date" formControlName="date" required></label>
            @if (kind() === 'tournament') { <label>End date<input type="date" formControlName="endDate"></label> }
            @else if (repeating()) { <label>Ends on<input type="date" formControlName="until"></label> }
          </div>
        }
        @if (kind() === 'tournament') {
          <div class="two">
            <label>City<input formControlName="city" placeholder="Columbus, OH"></label>
            <label>Division<input formControlName="division" placeholder="13 Open"></label>
          </div>
        }
        <label>{{ kind() === 'tournament' ? 'Venue' : 'Location' }}<input formControlName="location" [placeholder]="kind() === 'practice' ? 'A5 Sportsplex' : ''"></label>
        @if (kind() === 'practice') {
          <div class="two">
            <label>Court<input formControlName="court" placeholder="3"></label>
            <label>Practice uniform
              <select formControlName="uniformColor">
                <option value="">Not set</option>
                @for (c of colors(); track c) { <option [value]="c">{{ c }}</option> }
              </select>
            </label>
          </div>
          @if (!store.settings()?.practiceColors?.length) {
            <p class="hint">Add the team's practice uniform colors under Team Info › Team settings to choose one here.</p>
          }
        }
        <label>{{ kind() === 'tournament' ? 'Notes' : 'Details' }}<textarea formControlName="notes" rows="3"></textarea></label>
        @if (kind() !== 'tournament' && mode() !== 'date') {
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
              <label class="checks" style="flex-direction:row"><span><input type="checkbox" formControlName="skipTournaments"> Skip tournament days</span></label>
              @if (preview()) { <p class="hint">{{ preview() }}</p> }
              @if (mode() === 'series' && event()?.repeat) { <p class="hint">Changes apply to every date in the series, except details changed on a single date. To call off one date, use “Cancel this date” on the schedule.</p> }
            }
            @if (lostAnswers()) {
              <p class="hint warn" role="status">{{ lostAnswers() }} families' answers are on dates this change removes from the series.</p>
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
            <div class="two">
              <label>Ball cart family
                <select formControlName="cartPid">
                  <option value="">—</option>
                  <option value="na">Not needed</option>
                  @for (p of store.players(); track p.pid) { <option [value]="p.pid">{{ p.first }} {{ p.last }}</option> }
                </select>
              </label>
              <label>Volleyballs family
                <select formControlName="ballsPid">
                  <option value="">—</option>
                  <option value="na">Not needed</option>
                  @for (p of store.players(); track p.pid) { <option [value]="p.pid">{{ p.first }} {{ p.last }}</option> }
                </select>
              </label>
            </div>
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
          @if (mode() === 'date' && hasDateChange()) {
            <button class="btn" type="button" [disabled]="busy()" (click)="undoDate()">Match the series again</button>
          }
          @if (event() && mode() === 'series') {
            <button class="btn" type="button" [class.danger]="!confirmDelete()" [class.confirming]="confirmDelete()" [disabled]="busy()" (click)="remove()">
              {{ confirmDelete() ? 'Tap again to delete' : event()?.repeat ? 'Delete series' : 'Delete' }}
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
  readonly mode = input<EditMode>('series');
  /** The date picked on the schedule, for "this date" and "this and following". */
  readonly at = input('');
  readonly closed = output<void>();

  readonly store = inject(TeamStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly kinds: EventKind[] = ['practice', 'event', 'tournament', 'deadline'];
  readonly kindLabel = KIND_LABEL;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly confirmDelete = signal(false);

  readonly form = this.fb.group({
    kind: 'event' as EventKind, title: '', date: '', endDate: '', time: '', endTime: '', location: '', court: '', uniformColor: '',
    city: '', division: '', travel: false, notes: '',
    website: '', parking: '', waves: '', arrival: '', start: '', meet: '', uniforms: '', admissions: '', teamCode: '',
    scheduleLink: '', ticketHelp: '', cartPid: '', ballsPid: '', foodPlan: '', reservations: '', checklist: '',
    every: 0, until: '', skipTournaments: true,
    days: this.fb.group({ d0: false, d1: false, d2: false, d3: false, d4: false, d5: false, d6: false })
  });
  readonly dayNames = DAYS;
  private readonly values = signal(this.form.getRawValue());
  readonly kind = signal<EventKind>('event');
  readonly repeating = computed(() => this.values().every > 0 && this.values().kind !== 'tournament');
  private pickedDays(v = this.values()) { return [0, 1, 2, 3, 4, 5, 6].filter((i) => v.days[`d${i}` as keyof typeof v.days]); }
  /** "Every 2 weeks on Tue & Thu until Mar 31 · 12 dates" */
  readonly preview = computed(() => {
    const v = this.values();
    const days = this.pickedDays(v);
    if (!this.repeating() || !v.date || !v.until || !days.length || v.until < v.date) return '';
    const n = expandPattern(v.date, v.until, days, v.every).length;
    return `${describe({ every: v.every, days, until: v.until })} · ${n} date${n === 1 ? '' : 's'}`;
  });
  /** The team's practice uniform colors, plus whatever this practice already uses. */
  readonly colors = computed(() => {
    const list = [...(this.store.settings()?.practiceColors ?? [])];
    const cur = this.values().uniformColor;
    if (cur && !list.includes(cur)) list.push(cur);
    return list;
  });
  readonly teamCodeDefault = computed(() => this.store.settings()?.teamCode ?? '');
  readonly placeholder = computed(() => ({ practice: 'Team practice', tournament: 'Winter Classic', event: 'Team dinner', deadline: 'Fund deposit due' })[this.kind()]);
  readonly atLabel = computed(() => (this.at() ? fmt(this.at(), { weekday: 'long', month: 'short', day: 'numeric' }) : ''));
  readonly heading = computed(() => {
    const label = KIND_LABEL[this.kind()].toLowerCase();
    if (this.mode() === 'date') return `Edit ${label} · ${fmt(this.at())} only`;
    if (this.mode() === 'following') return `Edit ${label} · ${fmt(this.at())} and after`;
    return this.event() ? `Edit ${this.event()?.repeat ? label + ' series' : label}` : `Add ${label}`;
  });
  readonly hasDateChange = computed(() => !!this.event()?.overrides?.[this.at()]);

  /**
   * How many families' answers sit on dates a series edit (or split) would drop, so a coach sees it before saving.
   */
  readonly lostAnswers = computed(() => {
    const e = this.event();
    const v = this.values();
    if (!e?.repeat || this.mode() === 'date') return 0;
    const from = this.mode() === 'following' ? this.at() : '';
    const before = expandPattern(e.date, e.repeat.until, e.repeat.days, e.repeat.every).filter((d) => d >= from);
    const days = this.pickedDays(v);
    const after = new Set(this.repeating() && v.date && v.until && days.length ? expandPattern(v.date, v.until, days, v.every) : [v.date]);
    const gone = new Set(before.filter((d) => !after.has(d)).map((d) => `${e.eid}-${d}`));
    if (!gone.size) return 0;
    return Object.values(this.store.family()).filter((f) => Object.keys(f.rsvp ?? {}).some((k) => gone.has(k))).length;
  });

  constructor() {
    this.form.controls.kind.valueChanges.subscribe((k) => {
      this.kind.set(k);
      // Practices usually repeat: start a new one as weekly.
      if (k === 'practice' && !this.event() && this.form.controls.every.value === 0) this.form.controls.every.setValue(1);
    });
    this.form.valueChanges.subscribe(() => this.values.set(this.form.getRawValue()));
    // Turning repeat on, or picking the date of a repeating event: start with that date's weekday.
    const fillDay = () => {
      const v = this.form.getRawValue();
      if (v.every > 0 && !this.pickedDays(v).length && v.date) this.form.controls.days.patchValue({ [`d${pd(v.date).getDay()}`]: true });
    };
    this.form.controls.every.valueChanges.subscribe(() => fillDay());
    this.form.controls.date.valueChanges.subscribe(() => fillDay());
    // Fill the form each time it opens.
    effect(() => {
      if (!this.open()) return;
      const e = this.event();
      const mode = this.mode();
      const at = this.at();
      const k = e?.kind ?? this.defaultKind();
      untracked(() => {
        this.error.set('');
        this.confirmDelete.set(false);
        // One date: the series' details with that date's own changes on top.
        const o: Occurrence = mode === 'date' && e ? e.overrides?.[at] ?? {} : {};
        const pick = (f: (typeof OCCURRENCE_FIELDS)[number]) => String(o[f] || e?.[f] || '');
        this.form.reset({
          kind: k, title: pick('title'), date: mode === 'series' ? e?.date ?? '' : at, endDate: e?.endDate ?? '',
          time: pick('time'), endTime: pick('endTime'), location: pick('location'), court: pick('court'), uniformColor: pick('uniformColor'),
          city: e?.city ?? '', division: e?.division ?? '', travel: !!e?.travel, notes: pick('notes'),
          website: e?.website ?? '', parking: e?.parking ?? '', waves: e?.waves ?? '', arrival: e?.arrival ?? '', start: e?.start ?? '',
          meet: e?.meet ?? '', uniforms: e?.uniforms ?? '', admissions: e?.admissions ?? '', teamCode: e?.teamCode ?? '',
          scheduleLink: e?.scheduleLink ?? '', ticketHelp: e?.ticketHelp ?? '', cartPid: e?.cartPid ?? e?.dutyPid ?? '', ballsPid: e?.ballsPid ?? e?.dutyPid ?? '', foodPlan: e?.foodPlan ?? '',
          reservations: e?.reservations ?? '', checklist: (e?.checklist ?? []).join('\n'),
          every: e?.repeat?.every ?? (k === 'practice' ? 1 : 0), until: e?.repeat?.until ?? '', skipTournaments: e?.repeat?.skipTournaments ?? true,
          days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((i) => [`d${i}`, !!e?.repeat?.days.includes(i)]))
        });
        if (mode === 'following') this.form.controls.kind.disable(); else this.form.controls.kind.enable();
        this.values.set(this.form.getRawValue());
        this.kind.set(k);
      });
    });
  }

  async save() {
    const v = this.form.getRawValue();
    if (!v.title.trim()) { this.error.set('Give it a name.'); return; }
    if (this.mode() === 'date') return this.saveDate(v);
    if (!v.date) { this.error.set('Pick a date.'); return; }
    if (v.kind === 'tournament' && v.endDate && v.endDate < v.date) { this.error.set('The end date is before the start date.'); return; }
    const isT = v.kind === 'tournament';
    const isP = v.kind === 'practice';
    const days = this.pickedDays(v);
    if (!isT && v.every > 0) {
      if (!days.length) { this.error.set('Pick at least one day for it to repeat on.'); return; }
      if (!v.until) { this.error.set('Pick the date the series ends.'); return; }
      if (v.until < v.date) { this.error.set('The series ends before it starts.'); return; }
    }
    if (this.mode() === 'following' && v.date < this.at()) { this.error.set(`The new details can't start before ${this.atLabel()}.`); return; }
    const following = this.mode() === 'following';
    const next: TeamEvent = {
      ...(following ? {} : this.event() ?? {}),
      eid: following ? newId('e') : this.event()?.eid ?? newId('e'),
      kind: v.kind, title: v.title.trim(), date: v.date,
      endDate: isT && v.endDate ? v.endDate : undefined,
      time: !isT ? v.time.trim() || undefined : undefined,
      endTime: isP ? v.endTime.trim() || undefined : undefined,
      location: v.location.trim() || undefined,
      court: isP ? v.court.trim() || undefined : undefined,
      uniformColor: isP ? v.uniformColor || undefined : undefined,
      city: isT ? v.city.trim() || undefined : undefined,
      division: isT ? v.division.trim() || undefined : undefined,
      travel: isT ? v.travel : false,
      notes: v.notes.trim() || undefined
    };
    if (isT) {
      const text = ['website', 'parking', 'waves', 'arrival', 'start', 'meet', 'uniforms', 'admissions', 'teamCode', 'scheduleLink',
        'ticketHelp', 'cartPid', 'ballsPid', 'foodPlan', 'reservations'] as const;
      for (const k of text) next[k] = v[k].trim() || undefined;
      delete next['dutyPid']; // replaced by cartPid and ballsPid
      const list = v.checklist.split('\n').map((s) => s.trim()).filter(Boolean);
      next.checklist = list.length ? list : undefined;
    }
    if (!isT && v.every > 0) {
      next.repeat = { every: v.every, days, until: v.until, skipTournaments: v.skipTournaments };
    } else {
      delete next.repeat; delete next.cancelled; delete next.skip; delete next.overrides;
    }
    // Drop bookkeeping fields the API sets itself.
    for (const k of ['type', 'updatedAt', 'updatedBy', 'GSI2PK', 'GSI2SK', 'convertedFrom']) delete next[k];
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    this.busy.set(true);
    const e = this.event();
    const ok = following && e ? await this.store.splitSeries(e, this.at(), next) : await this.store.saveEvent(next, !e);
    this.busy.set(false);
    if (ok) this.closed.emit();
  }

  /** Keeps only what differs from the series, so later series edits still reach the rest of this date. */
  private async saveDate(v: ReturnType<typeof this.form.getRawValue>) {
    const e = this.event();
    if (!e) return;
    const change: Occurrence = {};
    for (const f of OCCURRENCE_FIELDS) {
      const val = String(v[f] ?? '').trim();
      if (val && val !== String(e[f] ?? '')) change[f] = val;
    }
    this.busy.set(true);
    const ok = await this.store.saveOccurrence(e, this.at(), Object.keys(change).length ? change : null);
    this.busy.set(false);
    if (ok) this.closed.emit();
  }

  async undoDate() {
    const e = this.event();
    if (!e) return;
    this.busy.set(true);
    const ok = await this.store.saveOccurrence(e, this.at(), null);
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
