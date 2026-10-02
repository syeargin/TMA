import { Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { DAYS, newId } from '../../core/dates';
import type { Practice } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';

type Row = FormGroup<{
  id: FormControl<string>; label: FormControl<string>; dow: FormControl<number>; start: FormControl<string>; end: FormControl<string>;
  from: FormControl<string>; until: FormControl<string>; location: FormControl<string>; note: FormControl<string>;
}>;

const c = <T>(v: T) => new FormControl(v, { nonNullable: true });
const row = (p?: Partial<Practice>): Row => new FormGroup({
  id: c(p?.id ?? newId('p')), label: c(p?.label ?? 'Practice'), dow: c(Number(p?.dow ?? 2)), start: c(p?.start ?? ''), end: c(p?.end ?? ''),
  from: c(p?.from ?? ''), until: c(p?.until ?? ''), location: c(p?.location ?? ''), note: c(p?.note ?? '')
});

/** Weekly practice times. Each row repeats on its day from the first date to the last. */
@Component({
  selector: 'th-practices-form',
  imports: [ReactiveFormsModule, Sheet, Messages],
  template: `
    <th-sheet heading="Practice times" [open]="open()" (closed)="closed.emit()">
      <form [formGroup]="form" (ngSubmit)="save()" novalidate>
        <p class="muted small">Each practice repeats weekly between its first and last date. Tournament weekends are skipped automatically, and you can cancel single dates from the schedule.</p>
        <th-messages [error]="error()" />
        @for (r of rows.controls; track r.controls.id.value; let i = $index) {
          <fieldset class="practice-row" [formGroup]="r" style="margin:0">
            <legend class="sr-only">Practice {{ i + 1 }}</legend>
            <div class="two">
              <label>Name<input formControlName="label"></label>
              <label>Day<select formControlName="dow">@for (d of days; track $index) { <option [ngValue]="$index">{{ d }}</option> }</select></label>
            </div>
            <div class="two">
              <label>Start<input formControlName="start" placeholder="7:30 PM"></label>
              <label>End<input formControlName="end" placeholder="9:30 PM"></label>
            </div>
            <div class="two">
              <label>First date<input type="date" formControlName="from"></label>
              <label>Last date<input type="date" formControlName="until"></label>
            </div>
            <label>Location<input formControlName="location" placeholder="Main gym, Court 3"></label>
            <label>Note<input formControlName="note" placeholder="Bring both jerseys"></label>
            <div><button class="btn sm danger" type="button" (click)="rows.removeAt(i)">Remove this practice</button></div>
          </fieldset>
        } @empty {
          <div class="empty">No weekly practices yet.</div>
        }
        <div><button class="btn sm" type="button" (click)="rows.push(row())">Add a practice</button></div>
        <div class="form-actions">
          <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save practice times' }}</button>
          <button class="btn ghost" type="button" (click)="closed.emit()">Cancel</button>
        </div>
      </form>
    </th-sheet>`
})
export class PracticesForm {
  readonly open = input(false);
  readonly closed = output<void>();
  private readonly store = inject(TeamStore);
  readonly days = DAYS;
  readonly row = row;
  readonly rows = new FormArray<Row>([]);
  readonly form = new FormGroup({ rows: this.rows });
  readonly busy = signal(false);
  readonly error = signal('');

  constructor() {
    effect(() => {
      if (!this.open()) return;
      const saved = this.store.settings()?.practices ?? [];
      untracked(() => {
        this.error.set('');
        this.rows.clear();
        saved.forEach((p) => this.rows.push(row(p)));
      });
    });
  }

  async save() {
    const list = this.rows.getRawValue();
    const bad = list.findIndex((p) => !p.label.trim() || !p.from);
    if (bad >= 0) { this.error.set(`Practice ${bad + 1} needs a name and a first date.`); return; }
    if (list.some((p) => p.until && p.until < p.from)) { this.error.set('A last date is before its first date.'); return; }
    const practices: Practice[] = list.map((p) => {
      const out: Practice = { id: p.id, label: p.label.trim(), dow: Number(p.dow) };
      for (const k of ['start', 'end', 'from', 'until', 'location', 'note'] as const) if (p[k].trim()) out[k] = p[k].trim();
      return out;
    });
    this.busy.set(true);
    const ok = await this.store.savePractices(practices);
    this.busy.set(false);
    if (ok) this.closed.emit();
  }
}
