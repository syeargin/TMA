import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  DAY_TYPE_LABELS, MEAL_SLOTS, MEAL_STYLES, STYLE_LABELS, STYLE_SHORT, budgetOf, defaultDayType, isJob, listedDates, orderDeadline, planDates,
  agendaOf, minutesOf, planKey, templateItems, type AgendaItem, type DayTemplate, type DayType, type MealStyle, type PlanMeal, type Wave
} from '@shared/dayplans';
import { fmt, newId, today } from '../../core/dates';
import type { Meal, TeamEvent } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { ToastService } from '../../core/toast.service';
import { MEAL_KINDS, money, orderByLabel, safeUrl, taskStart, toCents } from '../../core/tournament';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';

const SLOT_ORDER: Record<string, number> = { Breakfast: 0, Lunch: 1, 'Between matches': 2, Dinner: 3 };
type Line = { kind: 'meal'; meal: string; style: MealStyle; optional?: boolean } | { kind: 'agenda'; text: string };
/** When a meal has no time, where it sorts in the day. */
const SLOT_MINUTES: Record<string, number> = { Breakfast: 7 * 60, Lunch: 12 * 60, 'Between matches': 14 * 60, Dinner: 18 * 60 };
type Entry = {
  key: string; kind: 'own' | 'item' | 'match' | 'planmeal' | 'meal'; time: string; sort: number;
  own?: PlanMeal[]; item?: AgendaItem; meal?: Meal; planMeal?: PlanMeal; detail?: string; sub?: string;
};

/**
 * A tournament's day plan: each day's agenda and team meals in one timeline (shared/dayplans.ts).
 * Coaches, coordinators and food coordinators set each day's wave once it's posted, which fills the day in
 * from the team's playbook. Families take a meal job, or add their own order to a group order.
 */
@Component({
  selector: 'th-day-plan',
  imports: [ReactiveFormsModule, RouterLink, Sheet, Messages],
  template: `
    <div class="dp-days" role="tablist" aria-label="Tournament days">
      @for (d of dates(); track d) {
        <button class="dp-day" type="button" role="tab" [attr.aria-selected]="d === day()" (click)="day.set(d)">
          <b>{{ fmt(d, { weekday: 'short' }) }}</b><span>{{ dayLabel(d) }}</span>
        </button>
      }
    </div>

    @if (canPlan) {
      <div class="dp-controls">
        @if (event().travel && !isArrivalDay()) {
          <label class="dp-ctl">Day
            <select [value]="info().type" (change)="setType($any($event.target).value)" [disabled]="busy()">
              @for (t of dayTypes; track t[0]) { <option [value]="t[0]" [selected]="t[0] === info().type">{{ t[1] }}</option> }
            </select>
          </label>
        }
        @if (event().travel && isArrivalDay()) {
          <div class="dp-ctl"><span>Arrival day</span><span class="small muted" style="font-weight:400">The day before the tournament starts. Not on the schedule.</span></div>
          <button class="link-btn small" type="button" (click)="setArrival(false)" [disabled]="busy()">No arrival day: we travel that morning</button>
        }
        @if (event().travel && noArrival()) {
          <button class="link-btn small" type="button" (click)="setArrival(true)" [disabled]="busy()">+ Add an arrival day ({{ fmt(arrivalDate(), { weekday: 'short' }) }})</button>
        }
        @if (needsWave()) {
          <div class="dp-ctl"><span>{{ fmt(day(), { weekday: 'long' }) }} wave</span>
            <div class="chips" role="group" [attr.aria-label]="'Wave for ' + fmt(day())">
              <button class="chip" type="button" [attr.aria-pressed]="info().wave === 'am'" (click)="setWave('am')" [disabled]="busy()">AM</button>
              <button class="chip" type="button" [attr.aria-pressed]="info().wave === 'pm'" (click)="setWave('pm')" [disabled]="busy()">PM</button>
              <button class="chip" type="button" [attr.aria-pressed]="!info().wave" (click)="setWave(null)" [disabled]="busy()">Not posted</button>
            </div>
          </div>
        }
        <span class="spacer"></span>
        <button class="btn sm" type="button" (click)="openItem(null)">Add to the day</button>
        @if (food) { <button class="btn sm" type="button" (click)="openForm(null)">Add meal</button> }
      </div>
      @if (confirmWave(); as c) {
        <div class="dp-confirm" role="alertdialog" aria-label="Confirm the wave change">
          <b>Change {{ fmt(day(), { weekday: 'long' }) }} to {{ c.wave ? c.wave.toUpperCase() + ' wave' : 'wave not posted' }}?</b>
          <ul>
            <li>Lines from the day plan switch to the {{ c.wave ? c.wave.toUpperCase() : 'new' }} version.</li>
            @for (k of c.kept; track k) { <li><b>Kept:</b> {{ k }}</li> }
            @for (k of c.flagged; track k) { <li><b>Kept and flagged:</b> {{ k }}</li> }
          </ul>
          <div class="row"><button class="btn sm primary" type="button" (click)="doWave(c.wave)" [disabled]="busy()">Change it</button><button class="btn sm" type="button" (click)="confirmWave.set(null)">Cancel</button></div>
        </div>
      }
    }

    @if (waiting()) {
      <div class="dp-wait"><b>{{ fmt(day(), { weekday: 'long' }) }}'s wave isn't posted yet.</b> It often depends on the day before. Here's what each one means; meal jobs open once it's set.</div>
      <div class="dp-ifs">
        @for (w of ['am', 'pm']; track w) {
          <div class="card dp-if">
            <b>If {{ w === 'am' ? 'AM' : 'PM' }} wave</b>
            <ul>
              @for (l of linesFor(templateFor(w)); track $index) {
                <li>@if (l.kind === 'meal') { {{ l.meal }} <span class="pill" [class]="'pill dp-s-' + l.style">{{ short[l.style] }}</span>@if (l.optional) { <span class="small muted">optional</span> } } @else { {{ l.text }} }</li>
              } @empty { <li class="muted">Nothing planned</li> }
            </ul>
          </div>
        }
      </div>
      @if (dayMeals().length) { <h3 class="dp-h">Already planned for {{ fmt(day(), { weekday: 'long' }) }}</h3> }
    }
    @if (next(); as n) {
      <div class="dp-next"><span class="label">Next · {{ n.in }}</span><b>{{ n.time }} · {{ n.what }}</b>@if (n.where) { <span>{{ n.where }}</span> }</div>
    }
    @if (!waiting() || dayMeals().length) {
      <div class="card dp-tl">
        @for (en of entries(); track en.key) {
          <div class="dp-it dp-row" [class.dp-meal]="en.kind === 'meal'" [class.mine]="en.kind === 'meal' && !!myPid && en.meal!.claimedBy === myPid">
            <span class="dp-t" [class.any]="!en.time">{{ en.time || (en.kind === 'meal' ? '' : 'Any time') }}</span>
            <div class="dp-body">
              @switch (en.kind) {
                @case ('own') {
                  <div class="row">@for (o of en.own!; track o.meal) { <span><b>{{ o.meal }}</b> <span class="pill" [class]="'pill dp-s-' + o.style">{{ labels[o.style] }}</span>@if (o.optional) { <span class="pill p-mute">Optional</span> }</span> }</div>
                }
                @case ('item') {
                  <div><b>{{ en.item!.what }}</b> <span class="dp-src" [class.hand]="!en.item!.fromPlan">{{ en.item!.fromPlan ? 'From the day plan' : addedBy(en.item!.by) }}</span>@if (en.item!.cal) { <span class="dp-src">📅 In the calendar</span> }</div>
                  @if (en.item!.where) { <a class="small" [href]="mapOf(en.item!.where)" target="_blank" rel="noopener">{{ en.item!.where }}</a> }
                  @if (en.item!.note) { <span class="small muted">{{ en.item!.note }}</span> }
                }
                @case ('match') {
                  <div><b>First match</b>@if (en.detail) { {{ en.detail }} } <span class="dp-src ok">From Matches</span></div>
                  @if (en.sub) { <span class="small muted">{{ en.sub }}</span> }
                }
                @case ('planmeal') {
                  <div><b>{{ en.planMeal!.meal }}</b> <span class="pill" [class]="'pill dp-s-' + en.planMeal!.style">{{ labels[en.planMeal!.style] }}</span>@if (en.planMeal!.optional) { <span class="pill p-mute">Optional</span> }</div>
                }
                @case ('meal') {
                  @let m = en.meal!;
                  <div class="row">
                    <b>{{ m.meal }}</b>
                    @if (m.style) { <span class="pill" [class]="'pill dp-s-' + m.style">{{ labels[m.style] }}</span> }
                    @if (m.optional) { <span class="pill p-mute">Optional</span> }
                    <span class="spacer"></span>
                    @if (cost(m); as c) { <span class="small muted tn">{{ c }}</span> }
                  </div>
                  @if (m.stale) { <p class="small dp-stale">No longer in the day plan, but {{ familyName(m.claimedBy) }} already has it. @if (food) { Edit or remove it if it's not needed. }</p> }
                  @if (m.plan) { <p class="small muted">{{ m.plan }}</p> }
                  @if (isJob(m.style) || m.claimedBy !== undefined) {
                    <div class="dp-job">
                      <div class="row">
                        <span>{{ jobText(m) }}</span>
                        <span class="spacer"></span>
                        @if (m.claimedBy) { <span class="pill p-ok">{{ familyName(m.claimedBy) }}</span> }
                        @else { <span class="pill p-warn">Needs a family</span> }
                      </div>
                      @if (m.orderLink && link(m); as href) {
                        <div class="row dp-order">
                          <a class="btn sm primary" [href]="href" target="_blank" rel="noopener">Add your order ↗</a>
                          @if (myPid && m.familyOrders) {
                            @switch (orderState(m)) {
                              @case ('added') { <span class="pill p-ok">✓ {{ store.playerName(myPid) }}'s order added</span><button class="link-btn small" type="button" (click)="store.myOrder(m, myPid, null)">Undo</button> }
                              @case ('skip') { <span class="pill p-mute">{{ store.playerName(myPid) }} isn't eating with the team</span><button class="link-btn small" type="button" (click)="store.myOrder(m, myPid, null)">Undo</button> }
                              @default {
                                <button class="btn sm" type="button" (click)="store.myOrder(m, myPid, 'added')">I've added it</button>
                                <button class="link-btn small" type="button" (click)="store.myOrder(m, myPid, 'skip')">{{ store.playerName(myPid) }} isn't eating with the team</button>
                              }
                            }
                          }
                        </div>
                      }
                      @if (m.familyOrders && (food || m.claimedBy === myPid)) { <span class="small muted">{{ progress(m) }}</span> }
                      @if (myPid && m.claimedBy === myPid && m.style === 'delivered') {
                        <form class="dp-link" (submit)="saveLink($event, m)">
                          <div class="two">
                            <label>Delivery service<input [id]="'dp-vendor-' + m.mid" name="vendor" [value]="m.vendor ?? ''" placeholder="ezCater, DoorDash, Grubhub…"></label>
                            <label>Group order link<input [id]="'dp-link-' + m.mid" name="link" type="url" [value]="m.orderLink ?? ''" placeholder="https://…"></label>
                          </div>
                          <div class="row">
                            <button class="btn sm primary" type="submit" [disabled]="busy()">Save link</button>
                            <span class="small muted">Start a group order, then paste its share link. Every family sees "Add your order".</span>
                          </div>
                        </form>
                      }
                      <div class="row">
                        @if (!m.claimedBy && myPid) { <button class="btn sm red" type="button" (click)="store.claimMeal(m, myPid)">We'll take it</button> }
                        @if (m.claimedBy && (m.claimedBy === myPid || food)) { <button class="link-btn small" type="button" (click)="store.releaseMeal(m)">{{ m.claimedBy === myPid ? 'Hand this job back' : 'Reopen' }}</button> }
                        @if (howTo() && (m.claimedBy === myPid || food)) { <a class="small" [href]="howTo()" target="_blank" rel="noopener">How to order team meals</a> }
                      </div>
                    </div>
                  }
                }
              }
            </div>
            <div class="dp-act">
              @if (en.kind === 'item' && canPlan && !unsaved()) { <button class="link-btn small" type="button" (click)="openItem(en.item!)">Edit</button> }
              @if (en.kind === 'meal' && food) { <button class="link-btn small" type="button" (click)="openForm(en.meal!)">Edit</button> }
              @if (en.kind === 'match') { <a class="small" [routerLink]="['/teams', store.teamId(), 'tournaments', event().eid, 'matches']">Matches ›</a> }
            </div>
          </div>
        }
        @if (pendingJobs()) {
          <div class="dp-it dp-line">
            @if (canPlan) { <button class="btn sm primary" type="button" (click)="startDay()" [disabled]="busy()">Open the meal jobs</button><span class="small muted">So families can sign up for this day's team meals.</span> }
            @else { <span class="small muted">Sign-ups open once the coach or food coordinator sets up this day.</span> }
          </div>
        }
        @if (!entries().length) { <div class="dp-it muted">Nothing planned for this day yet.</div> }
      </div>
    }

    @if (anyDay().length) {
      <h3 class="dp-h">Any day</h3>
      <div class="card dp-tl">
        @for (m of anyDay(); track m.mid) {
          <div class="dp-it row"><b>{{ m.meal }}</b>@if (m.plan) { <span class="small muted">{{ m.plan }}</span> }<span class="spacer"></span>
            @if (m.claimedBy) { <span class="pill p-ok">{{ familyName(m.claimedBy) }}</span> } @else if (myPid) { <button class="btn sm red" type="button" (click)="store.claimMeal(m, myPid)">We'll take it</button> }
            @if (food) { <button class="link-btn small" type="button" (click)="openForm(m)">Edit</button> }
          </div>
        }
      </div>
    }

    @if (food || canPlan) {
      <div class="card dp-sum">
        <div class="label">Food for this tournament</div>
        @for (s of summary(); track s.day) { <div class="row"><span>{{ fmt(s.day, { weekday: 'short' }) }} · {{ s.text }}</span><span class="spacer"></span><span class="tn" [class.muted]="s.range">{{ s.amount }}</span></div> }
        <div class="row dp-total"><b>Estimated</b><span class="spacer"></span><b class="tn">{{ total() }}</b></div>
        <span class="small muted">{{ head().players }} players answered In · {{ head().coaches }} coach{{ head().coaches === 1 ? '' : 'es' }}. Budgets come from the team's day plans.</span>
      </div>
    }

    @if (canPlan) {
      <th-sheet [heading]="editingItem() ? 'Edit ' + (editingItem()!.what) : 'Add to ' + fmt(day(), { weekday: 'long' })" [open]="itemOpen()" (closed)="itemOpen.set(false)">
        <form [formGroup]="itemForm" (ngSubmit)="saveItem()" novalidate>
          <th-messages [error]="itemError()" />
          <div class="dp-two-time">
            <label>Time<input id="dp-it-time" formControlName="time" placeholder="7:30 PM"><span class="hint">Optional</span></label>
            <label>What<input id="dp-it-what" formControlName="what" placeholder="Team meeting"></label>
          </div>
          <label>Where<input id="dp-it-where" formControlName="where" placeholder="Hotel lobby, or an address"><span class="hint">Optional. Becomes a map link.</span></label>
          <label>Note<textarea id="dp-it-note" formControlName="note" rows="2" placeholder="Bring the ball cart"></textarea></label>
          <label class="check-row"><input id="dp-it-cal" type="checkbox" formControlName="cal"> Add it to the team calendar</label>
          <span class="hint">Shows in families' subscribed calendars, like practices do. Only items with a time.</span>
          <div class="form-actions">
            <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save' }}</button>
            <button class="btn ghost" type="button" (click)="itemOpen.set(false)">Cancel</button>
            <span class="spacer"></span>
            @if (editingItem()) { <button class="btn" type="button" [class.danger]="!confirmItemDelete()" [class.confirming]="confirmItemDelete()" (click)="removeItem()">{{ confirmItemDelete() ? 'Tap again to remove' : 'Remove' }}</button> }
          </div>
        </form>
      </th-sheet>
    }

    @if (food) {
      <th-sheet [heading]="editing() ? 'Edit ' + editing()!.meal.toLowerCase() : 'Add meal'" [open]="formOpen()" (closed)="formOpen.set(false)">
        <form [formGroup]="form" (ngSubmit)="save()" novalidate>
          <th-messages [error]="error()" />
          <div class="two">
            <label>Day<select formControlName="day">@for (d of dates(); track d) { <option [value]="d">{{ fmt(d) }}</option> }<option value="">Any day</option></select></label>
            <label>Meal<select formControlName="meal">@for (k of mealNames; track k) { <option [value]="k">{{ k }}</option> }</select></label>
          </div>
          <div class="field">
            <span class="label">Meal type</span>
            <div class="chips" role="group" aria-label="Meal type">
              @for (s of styles; track s) { <button class="chip" type="button" [attr.aria-pressed]="form.controls.style.value === s" (click)="form.controls.style.setValue(s)">{{ short[s] }}</button> }
            </div>
            <span class="hint">Only this tournament. Changing it updates the budget and the job; the family doing it sees the change.</span>
          </div>
          <div class="two">
            <label>Time<input formControlName="time" placeholder="5:30 PM"></label>
            @if (!jobStyle()) { <label>Estimated cost ($)<input formControlName="cost" inputmode="decimal" placeholder="150"></label> }
            @else { <label>Headcount<input formControlName="headcount" inputmode="numeric" [placeholder]="'' + head().total"><span class="hint">Blank = {{ head().players }} players In + {{ head().coaches }} coaches</span></label> }
          </div>
          @if (form.controls.style.value === 'delivered') {
            <div class="two">
              <label>Delivery service<input formControlName="vendor" placeholder="ezCater, DoorDash…"></label>
              <label>Order by<input type="datetime-local" formControlName="orderBy"></label>
            </div>
            <label>Group order link<input type="url" formControlName="orderLink" placeholder="https://…"><span class="hint">Families tap "Add your order" to join it. The family doing the order can add it too.</span></label>
            <label>Delivery address<input formControlName="address" placeholder="Venue, Hall C entrance"></label>
            <label class="check-row"><input type="checkbox" formControlName="familyOrders"> Ask each family to add their order</label>
            <span class="hint">They get a to-do when the link is posted, or {{ store.playbook().familyLeadHours }} hours before the order deadline if it's posted earlier.</span>
          }
          <label>Notes<textarea formControlName="plan" rows="2"></textarea><span class="hint">Where from, where it's delivered, who picks up</span></label>
          <label>Who handles it
            <select formControlName="claimedBy">
              <option value="">Open — families can claim it</option>
              @for (p of store.players(); track p.pid) { <option [value]="p.pid">{{ p.first }}'s family</option> }
            </select>
          </label>
          <div class="form-actions">
            <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save meal' }}</button>
            <button class="btn ghost" type="button" (click)="formOpen.set(false)">Cancel</button>
            <span class="spacer"></span>
            @if (editing()) { <button class="btn" type="button" [class.danger]="!confirmDelete()" [class.confirming]="confirmDelete()" (click)="remove()">{{ confirmDelete() ? 'Tap again to remove' : 'Remove' }}</button> }
          </div>
        </form>
      </th-sheet>
    }`,
  styles: [`
    .dp-days{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
    .dp-day{appearance:none;flex:1 1 90px;max-width:180px;border:1px solid var(--line);background:var(--surface);border-radius:10px;padding:7px 10px;text-align:center;cursor:pointer;color:var(--ink);font:inherit;line-height:1.25}
    .dp-day span{display:block;font-size:12.5px;color:var(--ink-2)}
    .dp-day[aria-selected="true"]{background:var(--btn);border-color:var(--btn);color:var(--btn-ink)}
    .dp-day[aria-selected="true"] span{color:inherit;opacity:.85}
    .dp-controls{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:flex-end;margin-bottom:12px}
    .dp-ctl{display:flex;flex-direction:column;gap:5px;font-weight:600;font-size:13.5px}
    .dp-ctl select{height:40px;width:auto;padding-block:0}
    .dp-wait{background:var(--warn-soft);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:14px}
    .dp-ifs{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
    .dp-if{padding:12px 14px}.dp-if ul{margin:6px 0 0;padding-left:18px;color:var(--ink-2);font-size:14px}
    .dp-tl{display:flex;flex-direction:column;padding:0}
    .dp-it{padding:10px 14px;border-top:1px solid var(--line-2);display:flex;flex-direction:column;gap:6px}
    .dp-it:first-child{border-top:0}
    .dp-row{display:grid;grid-template-columns:76px minmax(0,1fr) auto;gap:10px;align-items:start}
    .dp-t{font-weight:700;font-size:13.5px;font-variant-numeric:tabular-nums;padding-top:1px}
    .dp-t.any{color:var(--ink-3);font-weight:600}
    .dp-body{display:flex;flex-direction:column;gap:6px;min-width:0}
    .dp-act{display:flex;gap:8px;align-items:center;padding-top:1px}
    .dp-src{font-size:11.5px;font-weight:700;border-radius:4px;padding:1px 6px;background:var(--sunken);color:var(--ink-2);white-space:nowrap;margin-left:4px}
    .dp-src.hand{background:var(--accent-soft);color:var(--accent-text)}
    .dp-src.ok{background:var(--ok-soft);color:var(--ok)}
    .dp-next{background:var(--btn);color:var(--btn-ink);border-radius:12px;padding:10px 14px;margin-bottom:10px;display:flex;flex-direction:column;gap:2px}
    .dp-next .label{color:inherit;opacity:.8}
    .dp-confirm{background:var(--warn-soft);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:-4px 0 12px;font-size:14px}
    .dp-confirm ul{margin:6px 0 8px;padding-left:18px}
    .dp-two-time{display:grid;grid-template-columns:130px minmax(0,1fr);gap:10px}
    @media (max-width:520px){.dp-row{grid-template-columns:62px minmax(0,1fr)}.dp-act{grid-column:2}}
    .dp-it.row,.dp-line{flex-direction:row;align-items:center;flex-wrap:wrap;gap:8px}
    .dp-meal.mine{background:var(--surface-2)}
    .dp-job{border:1px solid var(--line);background:var(--surface-2);border-radius:10px;padding:9px 11px;display:flex;flex-direction:column;gap:8px;font-size:14px}
    .dp-order{flex-wrap:wrap}
    .dp-link{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line-2);padding-top:8px}
    .dp-stale{color:var(--warn);margin:0}
    .dp-h{margin:18px 0 8px;font-size:16px}
    .dp-sum{margin-top:14px;padding:12px 14px;display:flex;flex-direction:column;gap:5px;max-width:520px}
    .dp-total{border-top:1px solid var(--line-2);padding-top:6px}
    .field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
    .dp-s-own,.dp-s-none{background:var(--sunken);color:var(--ink-2)}
    .dp-s-court{background:#EFE7F8;color:#6B3FA0}
    .dp-s-delivered{background:#E4ECF8;color:#1F4E8C}
    .dp-s-restaurant{background:#FDEBD2;color:#8A4B06}
    :host-context([data-theme="dark"]) .dp-s-court{background:#261C38;color:#C9A8EE}
    :host-context([data-theme="dark"]) .dp-s-delivered{background:#16263F;color:#9CBDEB}
    :host-context([data-theme="dark"]) .dp-s-restaurant{background:#33230F;color:#EDB477}
  `]
})
export class DayPlan {
  readonly event = input.required<TeamEvent>();
  readonly store = inject(TeamStore);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly toast = inject(ToastService);
  readonly fmt = fmt;
  readonly labels = STYLE_LABELS;
  readonly short = STYLE_SHORT;
  readonly styles = MEAL_STYLES;
  readonly isJob = isJob;
  /** The listed tournament days can be play days or the last day; the arrival day is the day before. */
  readonly dayTypes = (Object.entries(DAY_TYPE_LABELS) as [DayType, string][]).filter(([t]) => t !== 'arrival');
  readonly mealNames = [...new Set([...MEAL_SLOTS, ...MEAL_KINDS])];
  get food() { return this.store.can('meals'); }
  get canPlan() { return this.store.can('schedule') || this.store.can('meals'); }
  get myPid() { return this.store.myPid(); }

  readonly noArrival = computed(() => !!this.store.dayPlans()[this.event().eid]?.noArrival);
  readonly listed = computed(() => listedDates(this.event().date, this.event().endDate));
  /** The listed dates, plus the arrival day before a travel tournament (unless it's turned off). */
  readonly dates = computed(() => planDates(!!this.event().travel, this.event().date, this.event().endDate, this.noArrival()));
  readonly arrivalDate = computed(() => planDates(true, this.event().date)[0]);
  isArrivalDay() { return !!this.event().travel && this.day() < this.event().date; }
  readonly day = signal('');
  constructor() {
    // Start on today when the tournament is on, otherwise its first day.
    effect(() => { const d = this.dates(); untracked(() => { if (!d.includes(this.day())) this.day.set(d.find((x) => x === today()) ?? d[0]); }); });
  }
  readonly pb = computed(() => this.store.playbook());
  readonly head = computed(() => this.store.headcount(this.event().eid));
  readonly howTo = computed(() => safeUrl(this.pb().howTo));
  readonly saved = computed(() => this.store.dayPlans()[this.event().eid]?.days ?? {});

  infoOf(d: string) {
    const s = this.saved()[d];
    return { type: s?.type ?? defaultDayType(!!this.event().travel, this.listed(), d), wave: s?.wave as Wave | undefined, agenda: s?.agenda };
  }
  readonly info = computed(() => this.infoOf(this.day()));
  readonly needsWave = computed(() => !(this.event().travel && this.info().type === 'arrival'));
  readonly waiting = computed(() => this.needsWave() && !this.info().wave);
  templateFor(wave?: string, d = this.day()): DayTemplate | null {
    const k = planKey(!!this.event().travel, this.infoOf(d).type, wave as Wave | undefined);
    return k ? this.pb().plans[k] : null;
  }
  dayLabel(d: string) {
    const i = this.infoOf(d);
    const type = this.event().travel ? DAY_TYPE_LABELS[i.type] : 'Play day';
    if (this.event().travel && i.type === 'arrival') return type;
    return i.wave ? `${i.wave.toUpperCase()} wave` : (this.event().travel ? `${type} · wave TBD` : 'Wave TBD');
  }
  /** What a plan shows that isn't a job: meals on your own (or none), then the agenda lines. */
  linesFor(t: DayTemplate | null): Line[] {
    if (!t) return [];
    const meals = t.meals.map((m) => ({ kind: 'meal' as const, meal: m.meal, style: m.style, optional: m.optional }));
    return [...meals, ...templateItems(t, (i) => `t${i}`).map((a) => ({ kind: 'agenda' as const, text: a.time ? `${a.time} · ${a.what}` : a.what }))];
  }
  /** Until a day is saved its jobs aren't made yet, so the plan's own meals show instead. */
  readonly unsaved = computed(() => !this.saved()[this.day()]);
  /** The day's items: saved ones, or the playbook's until the day is set up. */
  readonly items = computed<AgendaItem[]>(() => this.unsaved()
    ? templateItems(this.templateFor(this.info().wave), (i) => `t${i}`)
    : agendaOf(this.saved()[this.day()]).filter((a) => !a.removed));
  /** The first match of the day, from the match tracker (when matches are entered). */
  readonly firstMatch = computed(() => {
    if (!this.store.has('matches')) return null;
    const doc = this.store.matches()[this.event().eid];
    const list = Object.values(doc?.matches ?? {}).filter((m) => m.date === this.day()).sort((a, b) => a.n - b.n);
    const first = list.find((m) => m.time) ?? null;
    if (!first) return null;
    const count = doc?.slots?.[this.day()] ?? list.length;
    return { time: first.time!, detail: [first.opponent ? `vs ${first.opponent}` : '', first.court ? (/court/i.test(first.court) ? first.court : `Court ${first.court}`) : ''].filter(Boolean).join(' · '), sub: count > 1 ? `${count} matches today` : '' };
  });
  /** One timeline: untimed things first ("Any time"), then everything by time. */
  readonly entries = computed<Entry[]>(() => {
    const t = this.templateFor(this.info().wave);
    const out: Entry[] = [];
    const own = (t?.meals ?? []).filter((m) => !isJob(m.style));
    if (own.length && !this.waiting()) out.push({ key: 'own', kind: 'own', time: '', sort: -1, own });
    for (const a of this.waiting() ? [] : this.items()) out.push({ key: 'i' + a.id, kind: 'item', time: a.time ?? '', sort: minutesOf(a.time) ?? -1, item: a });
    const fm = this.firstMatch();
    if (fm) out.push({ key: 'match', kind: 'match', time: fm.time, sort: minutesOf(fm.time) ?? 9999, detail: fm.detail, sub: fm.sub });
    if (this.unsaved() && !this.waiting()) for (const m of (t?.meals ?? []).filter((x) => isJob(x.style))) out.push({ key: 'pm' + m.meal, kind: 'planmeal', time: '', sort: SLOT_MINUTES[m.meal] ?? 9999, planMeal: m });
    for (const m of this.dayMeals()) out.push({ key: 'm' + m.mid, kind: 'meal', time: m.time ?? '', sort: minutesOf(m.time) ?? SLOT_MINUTES[m.meal] ?? 9999, meal: m });
    return out.sort((a, b) => a.sort - b.sort);
  });
  /** On the day itself: the next thing with a time. */
  readonly next = computed(() => {
    if (this.day() !== today()) return null;
    const d = new Date(), mins = d.getHours() * 60 + d.getMinutes();
    const n = this.entries().find((e) => e.time && e.sort >= mins && e.kind !== 'own');
    if (!n) return null;
    const left = n.sort - mins;
    const what = n.kind === 'item' ? n.item!.what : n.kind === 'match' ? 'First match' : n.meal?.meal ?? n.planMeal?.meal ?? '';
    return { time: n.time, what, where: n.item?.where ?? '', in: left < 1 ? 'now' : left < 60 ? `in ${left} min` : `in ${Math.floor(left / 60)} hr ${left % 60 ? (left % 60) + ' min' : ''}`.trim() };
  });
  addedBy(sub?: string) { const n = sub ? this.store.authorName(sub) : ''; return n ? `Added by ${n}` : 'Added by hand'; }
  mapOf(where: string) { return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([where, this.event().city].filter(Boolean).join(', '))}`; }
  readonly pendingJobs = computed(() => this.unsaved() && !this.waiting() && (this.templateFor(this.info().wave)?.meals ?? []).some((m) => isJob(m.style)));
  async startDay() { await this.apply({ type: this.info().type, wave: this.info().wave ?? null }, 'Meal jobs added for ' + fmt(this.day(), { weekday: 'long' })); }
  readonly meals = computed(() => this.store.meals().filter((m) => m.eid === this.event().eid));
  readonly dayMeals = computed(() => this.meals().filter((m) => m.day === this.day())
    .sort((a, b) => (SLOT_ORDER[a.meal] ?? 9) - (SLOT_ORDER[b.meal] ?? 9) || a.meal.localeCompare(b.meal)));
  readonly anyDay = computed(() => this.meals().filter((m) => !m.day || !this.dates().includes(m.day)));

  familyName(pid?: string | null) { return pid ? `${this.store.playerName(pid) || 'A'}'s family` : ''; }
  link(m: Meal) { return safeUrl(m.orderLink); }
  orderState(m: Meal) { return this.myPid ? m.orders?.[this.myPid]?.state ?? '' : ''; }
  headOf(m: Meal) { return m.headcount ?? this.head().total; }
  estimate(m: Meal) { return isJob(m.style) ? budgetOf(this.pb().budgets, m.style) * this.headOf(m) : m.costCents ?? 0; }
  cost(m: Meal) {
    if (isJob(m.style)) return `${this.headOf(m)} × ${money(budgetOf(this.pb().budgets, m.style))} = ${money(this.estimate(m))}`;
    return m.costCents ? money(m.costCents) : '';
  }
  jobText(m: Meal) {
    const n = this.headOf(m);
    if (m.style === 'delivered') return `Order for ${n}${m.vendor ? ` · ${m.vendor}` : ''}${m.orderBy ? ` · by ${orderByLabel(m.orderBy)}` : ''}`;
    if (m.style === 'court') return `Bring food for ${n} to the court`;
    if (m.style === 'restaurant') return `Book a table for ${n}`;
    return 'Organize or pay for this meal';
  }
  progress(m: Meal) {
    const answered = Object.values(m.orders ?? {});
    const added = answered.filter((o) => o.state === 'added').length;
    const skip = answered.filter((o) => o.state === 'skip').length;
    const start = taskStart(m, this.pb().familyLeadHours);
    const when = !m.orderLink ? 'Families get a to-do once the group order link is posted.'
      : start && start > Date.now() ? `Families get a to-do ${new Date(start).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : '';
    return `${added} of ${this.head().players} families added their order${skip ? ` · ${skip} not eating with the team` : ''}. ${when}`.trim();
  }

  readonly summary = computed(() => this.dates().map((d) => {
    const i = this.infoOf(d);
    const jobs = this.meals().filter((m) => m.day === d && isJob(m.style) && !m.stale);
    if (this.needsWaveFor(d) && !i.wave) {
      const costOf = (w: Wave) => (this.templateFor(w, d)?.meals ?? []).filter((m) => isJob(m.style)).reduce((s, m) => s + budgetOf(this.pb().budgets, m.style) * this.head().total, 0);
      const lo = Math.min(costOf('am'), costOf('pm')), hi = Math.max(costOf('am'), costOf('pm'));
      return { day: d, text: 'wave not posted', amount: lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`, range: true, lo, hi };
    }
    if (!this.saved()[d] && !jobs.length) {
      // Not set up yet (an arrival day): what the plan would cost.
      const planned = (this.templateFor(i.wave, d)?.meals ?? []).filter((m) => isJob(m.style));
      const c = planned.reduce((s, m) => s + budgetOf(this.pb().budgets, m.style) * this.head().total, 0);
      if (planned.length) return { day: d, text: planned.map((m) => `${m.meal.toLowerCase()} ${STYLE_SHORT[m.style].toLowerCase()}${m.optional ? ' (optional)' : ''}`).join(', '), amount: money(c), range: false, lo: c, hi: c };
    }
    const sum = jobs.reduce((s, m) => s + this.estimate(m), 0);
    return { day: d, text: jobs.length ? jobs.map((m) => `${m.meal.toLowerCase()} ${STYLE_SHORT[m.style!].toLowerCase()}${m.optional ? ' (optional)' : ''}`).join(', ') : 'no team meals', amount: money(sum), range: false, lo: sum, hi: sum };
  }));
  needsWaveFor(d: string) { return !(this.event().travel && this.infoOf(d).type === 'arrival'); }
  readonly total = computed(() => {
    const lo = this.summary().reduce((s, x) => s + x.lo, 0), hi = this.summary().reduce((s, x) => s + x.hi, 0);
    return lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`;
  });

  // ----- setting the day -----
  readonly busy = signal(false);
  readonly confirmWave = signal<{ wave: Wave | null; kept: string[]; flagged: string[] } | null>(null);
  /** Once a day has things added by hand or jobs a family has, a change of wave asks first and says what's kept. */
  async setWave(wave: Wave | null) {
    if ((this.info().wave ?? null) === wave) { this.confirmWave.set(null); return; }
    const kept = this.unsaved() ? [] : agendaOf(this.saved()[this.day()]).filter((a) => !a.removed && (!a.fromPlan || a.edited)).map((a) => `${a.what}${a.time ? ' · ' + a.time : ''}${a.fromPlan ? '' : ` (${this.addedBy(a.by).toLowerCase()})`}`);
    const flagged = this.dayMeals().filter((m) => m.fromPlan && m.claimedBy).map((m) => `${m.meal} · ${this.familyName(m.claimedBy)} has it`);
    if (kept.length || flagged.length) { this.confirmWave.set({ wave, kept, flagged }); return; }
    await this.doWave(wave);
  }
  async doWave(wave: Wave | null) {
    this.confirmWave.set(null);
    await this.apply({ type: this.info().type, wave }, wave ? `${fmt(this.day(), { weekday: 'long' })}: ${wave.toUpperCase()} wave. The day plan is filled in.` : 'Wave cleared');
  }

  // ----- items on the day (team meeting, leave for the venue…) -----
  readonly itemOpen = signal(false);
  readonly editingItem = signal<AgendaItem | null>(null);
  readonly itemError = signal('');
  readonly confirmItemDelete = signal(false);
  readonly itemForm = this.fb.group({ time: '', what: '', where: '', note: '', cal: false });
  openItem(a: AgendaItem | null) {
    this.editingItem.set(a);
    this.itemError.set('');
    this.confirmItemDelete.set(false);
    this.itemForm.reset({ time: a?.time ?? '', what: a?.what ?? '', where: a?.where ?? '', note: a?.note ?? '', cal: !!a?.cal });
    this.itemOpen.set(true);
  }
  async saveItem() {
    const v = this.itemForm.getRawValue();
    const body = { what: v.what.trim(), time: v.time.trim() || undefined, where: v.where.trim() || undefined, note: v.note.trim() || undefined, cal: v.cal };
    if (!body.what) { this.itemError.set('Say what it is, like "Team meeting".'); return; }
    if (body.time && minutesOf(body.time) === null) { this.itemError.set('Use a time like 7:30 PM.'); return; }
    if (body.cal && !body.time) { this.itemError.set('Add a time to put it in the team calendar.'); return; }
    this.busy.set(true);
    const a = this.editingItem();
    const ok = a ? await this.store.savePlanItem(this.event().eid, this.day(), a.id, body) : await this.store.addPlanItem(this.event().eid, this.day(), body);
    this.busy.set(false);
    if (ok) this.itemOpen.set(false);
  }
  async removeItem() {
    const a = this.editingItem();
    if (!a) return;
    if (!this.confirmItemDelete()) { this.confirmItemDelete.set(true); return; }
    if (await this.store.deletePlanItem(this.event().eid, this.day(), a.id)) this.itemOpen.set(false);
  }
  async setArrival(on: boolean) {
    this.busy.set(true);
    const ok = await this.store.setArrival(this.event().eid, on);
    this.busy.set(false);
    if (ok && on) this.day.set(this.arrivalDate());
  }
  async setType(type: DayType) { await this.apply({ type, wave: this.info().wave ?? null }, `${fmt(this.day(), { weekday: 'long' })} is now ${DAY_TYPE_LABELS[type].toLowerCase()}`); }
  private async apply(v: { type: DayType; wave: Wave | null }, done: string) {
    this.busy.set(true);
    await this.store.setPlanDay(this.event().eid, this.day(), v, done);
    this.busy.set(false);
  }

  async saveLink(ev: Event, m: Meal) {
    ev.preventDefault();
    const f = ev.target as HTMLFormElement;
    const vendor = (f.elements.namedItem('vendor') as HTMLInputElement).value.trim();
    const orderLink = (f.elements.namedItem('link') as HTMLInputElement).value.trim();
    if (orderLink && !/^https:\/\//i.test(orderLink)) { this.toast.show('Paste the full link, starting with https://.', true); return; }
    this.busy.set(true);
    await this.store.saveOrderLink(m, { vendor, orderLink });
    this.busy.set(false);
  }

  // ----- the meal editor (food coordinators) -----
  readonly formOpen = signal(false);
  readonly editing = signal<Meal | null>(null);
  readonly error = signal('');
  readonly confirmDelete = signal(false);
  readonly form = this.fb.group({
    day: '', meal: 'Lunch', style: 'own' as MealStyle, time: '', cost: '', headcount: '', vendor: '', orderBy: '', orderLink: '', address: '', familyOrders: true, plan: '', claimedBy: ''
  });
  jobStyle() { return isJob(this.form.controls.style.value); }

  openForm(m: Meal | null) {
    this.editing.set(m);
    this.error.set('');
    this.confirmDelete.set(false);
    const day = m?.day ?? this.day();
    const style = m?.style ?? (m ? 'own' : 'delivered');
    this.form.reset({
      day: day ?? '', meal: m?.meal ?? 'Lunch', style, time: m?.time ?? '', cost: m?.costCents && !isJob(m.style) ? String(m.costCents / 100) : '',
      headcount: m?.headcount != null ? String(m.headcount) : '', vendor: m?.vendor ?? (m ? '' : this.pb().vendor),
      orderBy: m?.orderBy ?? (day ? orderDeadline(day, this.pb().orderTime) : ''), orderLink: m?.orderLink ?? '', address: m?.address ?? '',
      familyOrders: m?.familyOrders ?? true, plan: m?.plan ?? '', claimedBy: m?.claimedBy ?? ''
    });
    this.formOpen.set(true);
  }

  async save() {
    const v = this.form.getRawValue();
    if (v.cost && !toCents(v.cost)) { this.error.set('Enter the cost as a number, like 150 or 12.50.'); return; }
    if (v.headcount && !/^\d{1,3}$/.test(v.headcount.trim())) { this.error.set('Enter the headcount as a number, or leave it blank to count who answered In.'); return; }
    const link = v.orderLink.trim();
    if (link && !/^https:\/\//i.test(link)) { this.error.set('The group order link needs to start with https://.'); return; }
    const old = this.editing();
    const delivered = v.style === 'delivered';
    const meal: Meal = {
      eid: this.event().eid, mid: old?.mid ?? newId('m'),
      meal: v.meal, day: v.day || undefined, time: v.time.trim() || undefined, plan: v.plan.trim() || undefined,
      style: v.style, claimedBy: v.claimedBy || null,
      ...(v.headcount.trim() ? { headcount: Number(v.headcount.trim()) } : {}),
      ...(delivered ? { vendor: v.vendor.trim() || undefined, orderBy: v.orderBy || undefined, orderLink: link || undefined, address: v.address.trim() || undefined, familyOrders: v.familyOrders } : { familyOrders: false }),
      ...(old?.fromPlan ? { fromPlan: true } : {}), ...(old?.optional ? { optional: true } : {})
    };
    meal.costCents = isJob(v.style) ? budgetOf(this.pb().budgets, v.style) * (meal.headcount ?? this.head().total) : toCents(v.cost);
    this.busy.set(true);
    const ok = await this.store.saveMeal(meal, !old);
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
