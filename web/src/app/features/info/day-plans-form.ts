import { Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import {
  DEFAULT_PLAYBOOK, MEAL_SLOTS, MEAL_STYLES, PLAN_KEYS, PLAN_LABELS, STYLE_LABELS, minutesOf, type MealSlot, type MealStyle, type PlanKey, type Playbook, type TemplateLine
} from '@shared/dayplans';
import { TeamStore } from '../../core/team-store';
import { toCents } from '../../core/tournament';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Team settings › Tournament day plans: what the team does for meals and the agenda on each kind of
 * tournament day, the budget per person for each kind of team meal, and the order defaults.
 * Every tournament day starts from these once its wave is set (shared/dayplans.ts).
 */
@Component({
  selector: 'th-day-plans-form',
  imports: [Sheet, Messages],
  template: `
    <th-sheet heading="Tournament day plans" [open]="open()" (closed)="closed.emit()">
      @if (draft(); as p) {
        <form (submit)="save($event)" novalidate class="dpf">
          <p class="muted small">What the team does for meals on each kind of tournament day. A tournament day is filled in from these when its wave is set; you can still change one tournament.</p>
          <th-messages [error]="error()" />

          <h3>Budget per person</h3>
          <div class="dpf-budgets">
            <label>Brought to court ($)<input id="dpf-b-court" inputmode="decimal" [value]="dollars(p.budgets.court)" (input)="setBudget('court', $event)"></label>
            <label>Delivered to venue ($)<input id="dpf-b-delivered" inputmode="decimal" [value]="dollars(p.budgets.delivered)" (input)="setBudget('delivered', $event)"></label>
            <label>Team restaurant ($)<input id="dpf-b-restaurant" inputmode="decimal" [value]="dollars(p.budgets.restaurant)" (input)="setBudget('restaurant', $event)"></label>
          </div>
          <p class="hint">Counted for team meals: players who answered In, plus the team's coaches. Whoever orders can change the number.</p>

          <h3>Ordering</h3>
          <div class="two">
            <label>Usual delivery service<input id="dpf-vendor" [value]="p.vendor" (input)="set('vendor', $event)" placeholder="ezCater"><span class="hint">Just the starting suggestion. Each meal can use any service.</span></label>
            <label>Order by (the day before)<input id="dpf-time" type="time" [value]="p.orderTime" (input)="set('orderTime', $event)"></label>
          </div>
          <div class="two">
            <label>How to order (link)<input id="dpf-howto" type="url" [value]="p.howTo" (input)="set('howTo', $event)" placeholder="https://…"><span class="hint">Shown to whoever orders. A Team Info page or a guide.</span></label>
            <label>Families' to-do starts (hours before the deadline)<input id="dpf-lead" inputmode="numeric" [value]="'' + p.familyLeadHours" (input)="setLead($event)"><span class="hint">Or when the group order link is posted, if that's later.</span></label>
          </div>

          @for (k of keys; track k; let i = $index) {
            @if (i === 0 || labels[k].group !== labels[keys[i - 1]].group) { <h3>{{ labels[k].group }}</h3> }
            <fieldset class="dpf-plan">
              <legend><b>{{ labels[k].day }}</b>@if (labels[k].wave) { · {{ labels[k].wave }}}</legend>
              @for (m of p.plans[k].meals; track $index; let j = $index) {
                <div class="dpf-meal">
                  <select [attr.aria-label]="'Meal ' + (j + 1)" (change)="setMeal(k, j, 'meal', $event)">@for (s of slots; track s) { <option [value]="s" [selected]="s === m.meal">{{ s }}</option> }</select>
                  <select [attr.aria-label]="'How ' + m.meal" (change)="setMeal(k, j, 'style', $event)">@for (s of styles; track s) { <option [value]="s" [selected]="s === m.style">{{ styleLabels[s] }}</option> }</select>
                  <label class="check-row small"><input type="checkbox" [checked]="!!m.optional" (change)="setOptional(k, j, $event)"> Optional</label>
                  <button class="link-btn small" type="button" (click)="removeMeal(k, j)">Remove</button>
                </div>
              }
              @if (p.plans[k].meals.length < 6) { <button class="link-btn small" type="button" (click)="addMeal(k)">+ Add a meal</button> }
              <span class="small dpf-agh">Agenda</span>
              @for (l of p.plans[k].agenda; track $index; let j = $index) {
                <div class="dpf-line">
                  <input class="dpf-time" [attr.aria-label]="'Time for agenda line ' + (j + 1)" placeholder="Time" [value]="timeOf(l)" (change)="setLine(k, j, 'time', $event)">
                  <input [attr.aria-label]="'Agenda line ' + (j + 1)" [value]="textOf(l)" (change)="setLine(k, j, 'what', $event)">
                  <button class="link-btn small" type="button" (click)="removeLine(k, j)">Remove</button>
                </div>
              }
              @if (p.plans[k].agenda.length < 12) { <button class="link-btn small" type="button" (click)="addLine(k)">+ Add a line</button> }
            </fieldset>
          }

          <div class="form-actions">
            <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save day plans' }}</button>
            <button class="btn ghost" type="button" (click)="closed.emit()">Cancel</button>
            <span class="spacer"></span>
            <button class="link-btn small" type="button" (click)="reset()">Start from the defaults</button>
          </div>
        </form>
      }
    </th-sheet>`,
  styles: [`
    .dpf h3{margin:16px 0 8px;font-size:15px}
    .dpf-budgets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
    @media (max-width:460px){.dpf-budgets{grid-template-columns:1fr}}
    .dpf-plan{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 10px;display:flex;flex-direction:column;gap:8px;min-width:0}
    .dpf-plan legend{padding:0 4px}
    .dpf-meal{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
    .dpf-agh{font-weight:600;color:var(--ink-2)}
    .dpf-line{display:grid;grid-template-columns:100px minmax(0,1fr) auto;gap:8px;align-items:center}
    .dpf-line input{height:38px}
    .dpf-meal select{width:auto;flex:1 1 140px;height:40px;padding-block:0}
    .dpf-plan > .link-btn{align-self:flex-start}
    .dpf-plan textarea{font-weight:400}
  `]
})
export class DayPlansForm {
  readonly open = input(false);
  readonly closed = output<void>();
  readonly store = inject(TeamStore);
  readonly keys = PLAN_KEYS;
  readonly labels = PLAN_LABELS;
  readonly slots = MEAL_SLOTS;
  readonly styles = MEAL_STYLES;
  readonly styleLabels = STYLE_LABELS;
  readonly draft = signal<Playbook | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');

  constructor() {
    effect(() => { if (this.open()) untracked(() => { this.error.set(''); this.draft.set(clone(this.store.playbook())); }); });
  }

  dollars(c: number) { return (c / 100).toFixed(2).replace(/\.00$/, ''); }
  private edit(fn: (p: Playbook) => void) { const p = clone(this.draft()!); fn(p); this.draft.set(p); }
  private val(ev: Event) { return (ev.target as HTMLInputElement).value; }
  set(field: 'vendor' | 'orderTime' | 'howTo', ev: Event) { const v = this.val(ev); this.edit((p) => { p[field] = v; }); }
  setLead(ev: Event) { const n = Number(this.val(ev)); this.edit((p) => { p.familyLeadHours = Number.isFinite(n) ? Math.max(0, Math.min(168, Math.round(n))) : 48; }); }
  setBudget(k: 'court' | 'delivered' | 'restaurant', ev: Event) { const c = toCents(this.val(ev)) ?? 0; this.edit((p) => { p.budgets[k] = c; }); }
  setMeal(k: PlanKey, j: number, field: 'meal' | 'style', ev: Event) {
    const v = (ev.target as HTMLSelectElement).value;
    this.edit((p) => { if (field === 'meal') p.plans[k].meals[j].meal = v as MealSlot; else p.plans[k].meals[j].style = v as MealStyle; });
  }
  setOptional(k: PlanKey, j: number, ev: Event) { const on = (ev.target as HTMLInputElement).checked; this.edit((p) => { p.plans[k].meals[j].optional = on || undefined; }); }
  removeMeal(k: PlanKey, j: number) { this.edit((p) => { p.plans[k].meals.splice(j, 1); }); }
  addMeal(k: PlanKey) {
    this.edit((p) => { const used = new Set(p.plans[k].meals.map((m) => m.meal)); p.plans[k].meals.push({ meal: MEAL_SLOTS.find((s) => !used.has(s)) ?? 'Lunch', style: 'own' }); });
  }
  textOf(l: TemplateLine) { return typeof l === 'string' ? l : l.what; }
  timeOf(l: TemplateLine) { return typeof l === 'string' ? '' : l.time ?? ''; }
  setLine(k: PlanKey, j: number, field: 'time' | 'what', ev: Event) {
    const v = this.val(ev).trim();
    this.edit((p) => {
      const l = p.plans[k].agenda[j];
      const cur = { what: this.textOf(l), time: this.timeOf(l) };
      cur[field] = v;
      p.plans[k].agenda[j] = cur.time ? { what: cur.what, time: cur.time } : cur.what;
    });
  }
  removeLine(k: PlanKey, j: number) { this.edit((p) => { p.plans[k].agenda.splice(j, 1); }); }
  addLine(k: PlanKey) { this.edit((p) => { p.plans[k].agenda.push(''); }); }
  reset() { this.draft.set(clone(DEFAULT_PLAYBOOK)); }

  async save(ev: Event) {
    ev.preventDefault();
    const p = this.draft()!;
    if (p.howTo && !/^https?:\/\//i.test(p.howTo)) { this.error.set('The how-to link needs to start with https://.'); return; }
    for (const k of PLAN_KEYS) {
      p.plans[k].agenda = p.plans[k].agenda.filter((l) => this.textOf(l).trim());
      const badTime = p.plans[k].agenda.find((l) => this.timeOf(l) && minutesOf(this.timeOf(l)) === null);
      if (badTime) { this.error.set(`"${this.timeOf(badTime)}" isn't a time. Use one like 7:00 PM.`); return; }
      const names = p.plans[k].meals.map((m) => m.meal);
      if (new Set(names).size !== names.length) { this.error.set(`${PLAN_LABELS[k].day}${PLAN_LABELS[k].wave ? ' · ' + PLAN_LABELS[k].wave : ''} lists the same meal twice.`); return; }
    }
    this.busy.set(true);
    const ok = await this.store.savePlaybook(p);
    this.busy.set(false);
    if (ok) this.closed.emit();
  }
}
