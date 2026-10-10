import { Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormArray, FormControl, FormGroup, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import type { Settings } from '../../core/models';
import { toCents } from '../../core/money';
import { TeamStore } from '../../core/team-store';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';

type CoachGroup = FormGroup<{ name: FormControl<string>; phone: FormControl<string> }>;
const coachGroup = (name = '', phone = ''): CoachGroup => new FormGroup({
  name: new FormControl(name, { nonNullable: true }), phone: new FormControl(phone, { nonNullable: true })
});
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const dollars = (cents?: number) => (cents ? String(cents / 100) : '');

/** Team settings (admins and coordinators). Practice times stay with the schedule. */
@Component({
  selector: 'th-settings-form',
  imports: [ReactiveFormsModule, Sheet, Messages],
  template: `
    <th-sheet heading="Team settings" [open]="open()" (closed)="closed.emit()">
      <form [formGroup]="form" (ngSubmit)="save()" novalidate>
        <p class="muted small">Roles are set on the Members tab, and practice times on the Schedule.</p>
        <th-messages [error]="error()" />
        <div class="two">
          <label>Team name<input formControlName="teamName" required></label>
          <label>Season<input formControlName="season" placeholder="2026-27"></label>
        </div>
        <div class="two">
          <label>Age group / division<input formControlName="age" placeholder="13U"></label>
          <label>Team code<input formControlName="teamCode"></label>
        </div>
        <fieldset class="group" formArrayName="coaches">
          <legend>Coaches</legend>
          @for (c of coaches.controls; track $index; let i = $index) {
            <div class="two" [formGroupName]="i">
              <label>Coach {{ i + 1 }}<input formControlName="name"></label>
              <label>Phone<input type="tel" formControlName="phone"></label>
            </div>
          }
          @if (coaches.length < 6) { <div><button class="btn sm" type="button" (click)="coaches.push(newCoach())">Add a coach</button></div> }
        </fieldset>
        <fieldset class="group">
          <legend>Dues</legend>
          <div class="two">
            <label>Per family ($)<input formControlName="duesAmount" inputmode="decimal" placeholder="400"></label>
            <label>Due by<input type="date" formControlName="duesDue"></label>
          </div>
          <label>Called<input formControlName="duesLabel" placeholder="Team fund deposit"></label>
        </fieldset>
        <fieldset class="group">
          <legend>Meal budget defaults</legend>
          <div class="two">
            <label>Cost per meal ($)<input formControlName="costPerMeal" inputmode="decimal" placeholder="20"></label>
            <label>Meals per day<input formControlName="mealsPerDay" inputmode="numeric" placeholder="2"></label>
          </div>
          <label>People fed<input formControlName="people" inputmode="numeric" placeholder="Players plus coaches"></label>
        </fieldset>
        <label>What-to-bring checklist<textarea formControlName="checklist" rows="6"></textarea><span class="hint">One item per line. Tournaments use this unless they have their own list.</span></label>
        <label>Uniform order items<textarea formControlName="uniformItems" rows="5"></textarea>
          <span class="hint">One item per line. Families’ sizes follow the line order, so add new items at the end.</span></label>
        <label>Practice uniform colors<textarea formControlName="practiceColors" rows="4" placeholder="Navy&#10;White&#10;Red"></textarea>
          <span class="hint">One color per line. Coaches pick from this list when they add a practice.</span></label>
        <div class="form-actions">
          <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save settings' }}</button>
          <button class="btn ghost" type="button" (click)="closed.emit()">Cancel</button>
        </div>
      </form>
    </th-sheet>`
})
export class SettingsForm {
  readonly open = input(false);
  readonly closed = output<void>();
  private readonly store = inject(TeamStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly newCoach = () => coachGroup();
  readonly coaches = new FormArray<CoachGroup>([]);
  readonly form = this.fb.group({
    teamName: '', season: '', age: '', teamCode: '', coaches: this.coaches,
    duesAmount: '', duesDue: '', duesLabel: '', costPerMeal: '', mealsPerDay: '', people: '', checklist: '', uniformItems: '', practiceColors: ''
  });

  constructor() {
    effect(() => {
      if (!this.open()) return;
      const s = this.store.settings() ?? {};
      untracked(() => {
        this.error.set('');
        this.coaches.clear();
        const cs = s.coaches ?? [];
        for (let i = 0; i < Math.max(2, cs.length); i++) this.coaches.push(coachGroup(cs[i]?.name, cs[i]?.phone));
        this.form.patchValue({
          teamName: s.teamName ?? '', season: s.season ?? '', age: s.age ?? '', teamCode: s.teamCode ?? '',
          duesAmount: dollars(s.dues?.amountCents), duesDue: s.dues?.due ?? '', duesLabel: s.dues?.label ?? '',
          costPerMeal: dollars(s.budget?.costPerMealCents), mealsPerDay: s.budget?.mealsPerDay ? String(s.budget.mealsPerDay) : '',
          people: s.budget?.people ? String(s.budget.people) : '',
          checklist: (s.checklist ?? []).join('\n'), uniformItems: (s.uniformItems ?? []).join('\n'),
          practiceColors: (s.practiceColors ?? []).join('\n')
        });
        this.form.markAsPristine();
      });
    });
  }

  async save() {
    const v = this.form.getRawValue();
    if (!v.teamName.trim()) { this.error.set('Give the team a name.'); return; }
    if (v.duesAmount && !toCents(v.duesAmount)) { this.error.set('Enter dues as a number, like 400.'); return; }
    const saved = this.store.settings() ?? {};
    const int = (x: string) => Math.max(0, Math.floor(Number(x) || 0));
    const budget: Record<string, number> = { ...(saved.budget ?? {}) };
    budget['costPerMealCents'] = toCents(v.costPerMeal) || budget['costPerMealCents'] || 2000;
    budget['mealsPerDay'] = int(v.mealsPerDay) || budget['mealsPerDay'] || 2;
    if (int(v.people)) budget['people'] = int(v.people); else delete budget['people'];
    const next: Settings = {
      teamName: v.teamName.trim(), season: v.season.trim() || undefined, age: v.age.trim() || undefined, teamCode: v.teamCode.trim() || undefined,
      coaches: v.coaches.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), ...(c.phone.trim() ? { phone: c.phone.trim() } : {}) })),
      dues: { amountCents: toCents(v.duesAmount), ...(v.duesDue ? { due: v.duesDue } : {}), ...(v.duesLabel.trim() ? { label: v.duesLabel.trim() } : {}) },
      budget, checklist: lines(v.checklist), uniformItems: lines(v.uniformItems),
      practiceColors: [...new Set(lines(v.practiceColors).map((c) => c.slice(0, 40)))].slice(0, 20)
    };
    this.busy.set(true);
    const ok = await this.store.saveSettings(next);
    this.busy.set(false);
    if (ok) this.closed.emit();
  }
}
