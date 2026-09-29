import { Component, computed, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { fmt, newId } from '../../core/dates';
import type { Meal, TeamEvent } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { MEAL_KINDS, money, sortMeals, toCents, tournamentDays } from '../../core/tournament';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';
import { roleLabel } from '../../shared/roles';

/** Team meals for one tournament. Families claim a meal; food coordinators plan and assign them. */
@Component({
  selector: 'th-meals',
  imports: [ReactiveFormsModule, Sheet, Messages],
  template: `
    <div class="row" style="margin-bottom:12px">
      <p class="muted intro">Food coordinators: {{ foodNames() || 'TBD' }}. Families claim a meal to organize or pay for it; parents pack snacks, water and hydration for their own players.</p>
      @if (food) { <button class="btn sm primary" type="button" (click)="openForm(null)">Add meal</button> }
    </div>
    @if (meals().length) {
      <div class="tw">
        <table>
          <thead><tr><th>Day</th><th>Meal</th><th>Plan</th><th>Family</th><th class="num">Est. cost</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            @for (m of meals(); track m.mid) {
              <tr [class.mine]="!!myPid && m.claimedBy === myPid">
                <td class="nowrap">{{ m.day ? fmt(m.day) : '—' }}</td>
                <td><b>{{ m.meal }}</b>@if (m.time) { <div class="small muted">{{ m.time }}</div> }</td>
                <td>@if (m.plan) { <span class="pw">{{ m.plan }}</span> } @else { <span class="tbd">TBD</span> }</td>
                <td>@if (m.claimedBy) { <span class="pill p-ok">{{ store.playerName(m.claimedBy) || m.claimedBy }}'s family</span> } @else { <span class="pill p-warn">Open</span> }</td>
                <td class="num">{{ m.costCents ? money(m.costCents) : '—' }}</td>
                <td class="nowrap">
                  @if (!m.claimedBy && myPid) { <button class="btn sm red" type="button" (click)="store.claimMeal(m, myPid)">We’ll take it</button> }
                  @if (m.claimedBy && (m.claimedBy === myPid || food)) { <button class="link-btn small" type="button" (click)="store.releaseMeal(m)">Release</button> }
                  @if (food) { <button class="link-btn small" type="button" style="margin-left:8px" (click)="openForm(m)">Edit</button> }
                </td>
              </tr>
            }
            <tr>
              <td colspan="4" class="muted">{{ covered() }} of {{ meals().length }} meals covered</td>
              <td class="num"><b>{{ money(total()) }}</b></td><td></td>
            </tr>
          </tbody>
        </table>
      </div>
    } @else {
      <div class="empty">No team meals planned yet.@if (food) { Add the meals the team will share. }</div>
    }

    @if (food) {
      <th-sheet [heading]="editing() ? 'Edit meal' : 'Add meal'" [open]="formOpen()" (closed)="formOpen.set(false)">
        <form [formGroup]="form" (ngSubmit)="save()" novalidate>
          <th-messages [error]="error()" />
          <div class="two">
            <label>Day<select formControlName="day">@for (d of days(); track d) { <option [value]="d">{{ fmt(d) }}</option> }</select></label>
            <label>Meal<select formControlName="meal">@for (k of kinds; track k) { <option [value]="k">{{ k }}</option> }</select></label>
          </div>
          <div class="two">
            <label>Time<input formControlName="time" placeholder="12:00 PM"></label>
            <label>Estimated cost ($)<input formControlName="cost" inputmode="decimal" placeholder="150"></label>
          </div>
          <label>Plan<textarea formControlName="plan" rows="2"></textarea><span class="hint">Where from, delivered where, who’s picking up</span></label>
          <label>Family
            <select formControlName="claimedBy">
              <option value="">Open — families can claim it</option>
              @for (p of store.players(); track p.pid) { <option [value]="p.pid">{{ p.first }}’s family</option> }
            </select>
          </label>
          <div class="form-actions">
            <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save meal' }}</button>
            <button class="btn ghost" type="button" (click)="formOpen.set(false)">Cancel</button>
            <span class="spacer"></span>
            @if (editing()) {
              <button class="btn" type="button" [class.danger]="!confirmDelete()" [class.confirming]="confirmDelete()" (click)="remove()">{{ confirmDelete() ? 'Tap again to remove' : 'Remove' }}</button>
            }
          </div>
        </form>
      </th-sheet>
    }`
})
export class Meals {
  readonly event = input.required<TeamEvent>();
  readonly store = inject(TeamStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly fmt = fmt;
  readonly money = money;
  readonly kinds = MEAL_KINDS;
  get food() { return this.store.can('meals'); }
  get myPid() { return this.store.myPid(); }

  readonly meals = computed(() => sortMeals(this.store.meals().filter((m) => m.eid === this.event().eid)));
  readonly covered = computed(() => this.meals().filter((m) => m.claimedBy).length);
  readonly total = computed(() => this.meals().reduce((s, m) => s + (m.costCents ?? 0), 0));
  readonly days = computed(() => tournamentDays(this.event().date, this.event().endDate));
  readonly foodNames = computed(() => this.store.members().filter((m) => m.roles.includes('food')).map((m) => this.store.authorName(m.sub)).filter(Boolean).join(' & '));
  readonly roleLabel = roleLabel;

  readonly formOpen = signal(false);
  readonly editing = signal<Meal | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly confirmDelete = signal(false);
  readonly form = this.fb.group({ day: '', meal: 'Lunch', time: '', cost: '', plan: '', claimedBy: '' });

  openForm(m: Meal | null) {
    this.editing.set(m);
    this.error.set('');
    this.confirmDelete.set(false);
    this.form.reset({
      day: m?.day ?? this.days()[0], meal: m?.meal ?? 'Lunch', time: m?.time ?? '',
      cost: m?.costCents ? String(m.costCents / 100) : '', plan: m?.plan ?? '', claimedBy: m?.claimedBy ?? ''
    });
    this.formOpen.set(true);
  }

  async save() {
    const v = this.form.getRawValue();
    if (v.cost && !toCents(v.cost)) { this.error.set('Enter the cost as a number, like 150 or 12.50.'); return; }
    const meal: Meal = {
      eid: this.event().eid, mid: this.editing()?.mid ?? newId('m'),
      meal: v.meal, day: v.day || undefined, time: v.time.trim() || undefined, plan: v.plan.trim() || undefined,
      costCents: toCents(v.cost), claimedBy: v.claimedBy || null
    };
    this.busy.set(true);
    const ok = await this.store.saveMeal(meal, !this.editing());
    this.busy.set(false);
    if (ok) this.formOpen.set(false);
  }

  async remove() {
    const m = this.editing();
    if (!m) return;
    if (!this.confirmDelete()) { this.confirmDelete.set(true); return; }
    if (await this.store.deleteMeal(m)) this.formOpen.set(false);
  }
}
