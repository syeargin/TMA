import { Component, computed, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { fmtRange } from '../../core/dates';
import type { TeamEvent, Travel } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { TRAVEL_MODES, safeUrl, shortUrl } from '../../core/tournament';
import { Sheet } from '../../shared/sheet';

/** Team hotel and each family's travel plans for a travel weekend. */
@Component({
  selector: 'th-travel',
  imports: [ReactiveFormsModule, Sheet],
  template: `
    <div class="grid g-2" style="margin-bottom:16px">
      <section class="card">
        <div class="card-h"><h3>Team hotel</h3><span class="spacer"></span>
          @if (store.can('schedule')) { <button class="btn sm" type="button" (click)="openHotel()">Edit</button> }
        </div>
        <div class="card-b">
          <div class="kv">
            <div>Hotel</div><div>@if (event().hotel) { {{ event().hotel }} } @else { <span class="tbd">TBD</span> }</div>
            <div>Booking link</div><div>@if (hotelLink()) { <a [href]="hotelLink()" target="_blank" rel="noopener">{{ short(hotelLink()) }}</a> } @else if (event().hotelLink) { {{ event().hotelLink }} } @else { <span class="tbd">TBD</span> }</div>
            <div>Group / res. code</div><div>@if (event().hotelCode) { {{ event().hotelCode }} } @else { <span class="tbd">TBD</span> }</div>
            <div>Book by</div><div>@if (event().hotelBy) { {{ event().hotelBy }} } @else { <span class="tbd">TBD</span> }</div>
          </div>
        </div>
      </section>
      <section class="card">
        <div class="card-h"><h3>Plans in</h3></div>
        <div class="card-b">
          <div class="bignum tn">{{ done() }}<span class="muted" style="font-size:26px"> / {{ rows().length }}</span></div>
          <div class="meter"><i [style.width.%]="rows().length ? (100 * done()) / rows().length : 0"></i></div>
          <p class="small muted" style="margin:10px 0">Families add their hotel confirmation and flight or drive plans so the coordinator and coaches know who’s arriving when.</p>
          @if (myPid) {
            <button class="btn red sm" type="button" (click)="openTravel(myPid)">{{ store.travelOf(myPid, event().eid) ? 'Update' : 'Add' }} {{ store.playerName(myPid) }}’s travel</button>
          }
        </div>
      </section>
    </div>
    <div class="tw">
      <table>
        <thead><tr><th class="sticky-col">Family</th><th>Getting there</th><th>Hotel</th><th>Confirmation</th><th>Arrive</th><th>Depart</th><th>Notes</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          @for (r of rows(); track r.p.pid) {
            <tr [class.mine]="r.p.pid === store.you().pid">
              <td class="sticky-col"><b>{{ r.p.first }}</b></td>
              @if (r.t; as t) {
                <td>{{ t.mode }}@if (t.flight) { <div class="small muted">{{ t.flight }}</div> }</td>
                <td>{{ t.hotel }}</td><td class="tn">{{ t.conf }}</td><td>{{ t.arrive }}</td><td>{{ t.depart }}</td><td class="small">{{ t.notes }}</td>
              } @else {
                <td colspan="6"><span class="pill p-warn">Not entered</span></td>
              }
              <td>@if (r.p.pid === myPid || store.can('roster')) { <button class="link-btn small" type="button" (click)="openTravel(r.p.pid)">Edit</button> }</td>
            </tr>
          }
        </tbody>
      </table>
    </div>

    <th-sheet [heading]="travelFor() ? (store.playerName(travelFor()) + '’s travel') : 'Travel'" [open]="!!travelFor()" (closed)="travelFor.set('')">
      <form [formGroup]="travelForm" (ngSubmit)="saveTravel()" novalidate>
        <p class="muted small">{{ event().title }} · {{ range() }}@if (event().city) { · {{ event().city }} }</p>
        <div class="two">
          <label>Getting there<select formControlName="mode"><option value="">—</option>@for (m of modes; track m) { <option [value]="m">{{ m }}</option> }</select></label>
          <label>Flight / carpool details<input formControlName="flight"></label>
        </div>
        <div class="two">
          <label>Hotel<input formControlName="hotel"></label>
          <label>Confirmation #<input formControlName="conf"></label>
        </div>
        <div class="two">
          <label>Arriving<input formControlName="arrive" placeholder="Fri 4 PM"></label>
          <label>Leaving<input formControlName="depart" placeholder="Sun after last match"></label>
        </div>
        <label>Notes<textarea formControlName="notes" rows="2"></textarea><span class="hint">Room share, extra seats, anything the coordinator should know</span></label>
        <div class="form-actions">
          <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save travel plans' }}</button>
          <button class="btn ghost" type="button" (click)="travelFor.set('')">Cancel</button>
          <span class="spacer"></span>
          @if (store.travelOf(travelFor(), event().eid)) {
            <button class="btn" type="button" [class.danger]="!confirmClear()" [class.confirming]="confirmClear()" (click)="clearTravel()">{{ confirmClear() ? 'Tap again to clear' : 'Clear' }}</button>
          }
        </div>
      </form>
    </th-sheet>

    @if (store.can('schedule')) {
      <th-sheet heading="Team hotel" [open]="hotelOpen()" (closed)="hotelOpen.set(false)">
        <form [formGroup]="hotelForm" (ngSubmit)="saveHotel()" novalidate>
          <label>Hotel<input formControlName="hotel"></label>
          <label>Booking link<input formControlName="hotelLink" placeholder="https://"></label>
          <div class="two">
            <label>Group / reservation code<input formControlName="hotelCode"></label>
            <label>Book by<input formControlName="hotelBy" placeholder="Oct 15"></label>
          </div>
          <div class="form-actions">
            <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save hotel' }}</button>
            <button class="btn ghost" type="button" (click)="hotelOpen.set(false)">Cancel</button>
          </div>
        </form>
      </th-sheet>
    }`
})
export class TravelPlans {
  readonly event = input.required<TeamEvent>();
  readonly store = inject(TeamStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly modes = TRAVEL_MODES;
  readonly short = shortUrl;
  get myPid() { return this.store.myPid(); }

  readonly rows = computed(() => this.store.players().map((p) => ({ p, t: this.store.travelOf(p.pid, this.event().eid) })));
  readonly done = computed(() => this.rows().filter((r) => r.t).length);
  readonly hotelLink = computed(() => safeUrl(this.event().hotelLink));
  readonly range = computed(() => fmtRange(this.event().date, this.event().endDate));

  readonly busy = signal(false);
  readonly travelFor = signal('');
  readonly confirmClear = signal(false);
  readonly travelForm = this.fb.group({ mode: '', flight: '', hotel: '', conf: '', arrive: '', depart: '', notes: '' });
  readonly hotelOpen = signal(false);
  readonly hotelForm = this.fb.group({ hotel: '', hotelLink: '', hotelCode: '', hotelBy: '' });

  openTravel(pid: string) {
    const t = this.store.travelOf(pid, this.event().eid);
    this.travelForm.reset({
      mode: t?.mode ?? '', flight: t?.flight ?? '', hotel: t?.hotel ?? this.event().hotel ?? '', conf: t?.conf ?? '',
      arrive: t?.arrive ?? '', depart: t?.depart ?? '', notes: t?.notes ?? ''
    });
    this.confirmClear.set(false);
    this.travelFor.set(pid);
  }

  async saveTravel() {
    const v = this.travelForm.getRawValue();
    const t: Travel = {};
    for (const k of Object.keys(v) as (keyof typeof v)[]) if (v[k].trim()) t[k] = v[k].trim();
    this.busy.set(true);
    const ok = await this.store.setTravel(this.travelFor(), this.event().eid, t);
    this.busy.set(false);
    if (ok) this.travelFor.set('');
  }

  async clearTravel() {
    if (!this.confirmClear()) { this.confirmClear.set(true); return; }
    if (await this.store.setTravel(this.travelFor(), this.event().eid, null)) this.travelFor.set('');
  }

  openHotel() {
    const e = this.event();
    this.hotelForm.reset({ hotel: e.hotel ?? '', hotelLink: e.hotelLink ?? '', hotelCode: e.hotelCode ?? '', hotelBy: e.hotelBy ?? '' });
    this.hotelOpen.set(true);
  }

  async saveHotel() {
    const v = this.hotelForm.getRawValue();
    const next = { ...this.event() };
    for (const k of Object.keys(v) as (keyof typeof v)[]) next[k] = v[k].trim() || undefined;
    for (const k of ['type', 'updatedAt', 'updatedBy', 'GSI2PK', 'GSI2SK']) delete next[k];
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    this.busy.set(true);
    const ok = await this.store.saveEvent(next, false);
    this.busy.set(false);
    if (ok) this.hotelOpen.set(false);
  }
}
