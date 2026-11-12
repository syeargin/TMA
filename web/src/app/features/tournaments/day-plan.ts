import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import {
  DAY_TYPE_LABELS, MEAL_SLOTS, MEAL_STYLES, STYLE_LABELS, STYLE_SHORT, budgetOf, defaultDayType, isJob, orderDeadline,
  planKey, type DayTemplate, type DayType, type MealStyle, type Wave
} from '@shared/dayplans';
import { fmt, newId, today } from '../../core/dates';
import type { Meal, TeamEvent } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { ToastService } from '../../core/toast.service';
import { MEAL_KINDS, money, orderByLabel, safeUrl, taskStart, toCents, tournamentDays } from '../../core/tournament';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';

const SLOT_ORDER: Record<string, number> = { Breakfast: 0, Lunch: 1, 'Between matches': 2, Dinner: 3 };
type Line = { kind: 'meal'; meal: string; style: MealStyle; optional?: boolean } | { kind: 'agenda'; text: string };

/**
 * A tournament's day plan: each day's agenda and team meals in one timeline (shared/dayplans.ts).
 * Coaches, coordinators and food coordinators set each day's wave once it's posted, which fills the day in
 * from the team's playbook. Families take a meal job, or add their own order to a group order.
 */
@Component({
  selector: 'th-day-plan',
  imports: [ReactiveFormsModule, Sheet, Messages],
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
        @if (event().travel) {
          <label class="dp-ctl">Day
            <select [value]="info().type" (change)="setType($any($event.target).value)" [disabled]="busy()">
              @for (t of dayTypes; track t[0]) { <option [value]="t[0]" [selected]="t[0] === info().type">{{ t[1] }}</option> }
            </select>
          </label>
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
        @if (food) { <button class="btn sm" type="button" (click)="openForm(null)">Add meal</button> }
      </div>
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
    @if (!waiting() || dayMeals().length) {
      <div class="card dp-tl">
        @for (l of waiting() ? [] : lines(); track $index) {
          <div class="dp-it dp-line">
            @if (l.kind === 'meal') { <b>{{ l.meal }}</b> <span class="pill" [class]="'pill dp-s-' + l.style">{{ labels[l.style] }}</span> }
            @else { <span>{{ l.text }}</span> }
          </div>
        }
        @for (m of dayMeals(); track m.mid) {
          <div class="dp-it dp-meal" [class.mine]="m.claimedBy && m.claimedBy === myPid">
            <div class="row">
              <b>{{ m.meal }}</b>
              @if (m.style) { <span class="pill" [class]="'pill dp-s-' + m.style">{{ labels[m.style] }}</span> }
              @if (m.optional) { <span class="pill p-mute">Optional</span> }
              @if (m.time) { <span class="small muted">{{ m.time }}</span> }
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
                @if (m.familyOrders && (food || m.claimedBy === myPid)) {
                  <span class="small muted">{{ progress(m) }}</span>
                }

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
                  @if (food) { <button class="link-btn small" type="button" (click)="openForm(m)">Edit</button> }
                  @if (howTo() && (m.claimedBy === myPid || food)) { <a class="small" [href]="howTo()" target="_blank" rel="noopener">How to order team meals</a> }
                </div>
              </div>
            }
          </div>
        }
        @if (!lines().length && !dayMeals().length) { <div class="dp-it muted">Nothing planned for this day yet.</div> }
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
  readonly dayTypes = Object.entries(DAY_TYPE_LABELS) as [DayType, string][];
  readonly mealNames = [...new Set([...MEAL_SLOTS, ...MEAL_KINDS])];
  get food() { return this.store.can('meals'); }
  get canPlan() { return this.store.can('schedule') || this.store.can('meals'); }
  get myPid() { return this.store.myPid(); }

  readonly dates = computed(() => tournamentDays(this.event().date, this.event().endDate));
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
    return { type: s?.type ?? defaultDayType(!!this.event().travel, this.dates(), d), wave: s?.wave as Wave | undefined, agenda: s?.agenda };
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
  linesFor(t: DayTemplate | null, agenda?: string[], withJobs = true): Line[] {
    if (!t) return (agenda ?? []).map((text) => ({ kind: 'agenda', text }));
    const meals = t.meals.filter((m) => withJobs || !isJob(m.style)).map((m) => ({ kind: 'meal' as const, meal: m.meal, style: m.style, optional: m.optional }));
    return [...meals, ...(agenda ?? t.agenda).map((text) => ({ kind: 'agenda' as const, text }))];
  }
  readonly lines = computed(() => this.linesFor(this.templateFor(this.info().wave), this.info().agenda, false));
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
  async setWave(wave: Wave | null) {
    if ((this.info().wave ?? null) === wave) return;
    await this.apply({ type: this.info().type, wave }, wave ? `${fmt(this.day(), { weekday: 'long' })}: ${wave.toUpperCase()} wave. The day plan is filled in.` : 'Wave cleared');
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
