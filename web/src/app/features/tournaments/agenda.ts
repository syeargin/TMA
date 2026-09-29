import { Component, computed, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import type { Agenda as AgendaDoc, TeamEvent } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The weekend plan for a travel tournament: meet-ups, team meals, warm-ups and curfew. */
@Component({
  selector: 'th-agenda',
  imports: [ReactiveFormsModule, Sheet, Messages],
  template: `
    <div class="row" style="margin-bottom:12px">
      <p class="muted intro">{{ agenda().note || 'The weekend plan: meet-ups, team meals, warm-ups and curfew.' }}</p>
      @if (edit) { <button class="btn sm primary" type="button" (click)="openAdd()">Add item</button> }
    </div>
    @for (d of agenda().days; track d.label; let di = $index) {
      <section class="card" style="margin-bottom:12px">
        <div class="card-h"><h3>{{ d.label }}</h3></div>
        <div class="card-b">
          <div class="tw">
            <table>
              <thead><tr><th>When / what</th><th>Where</th><th>Who</th>@if (edit) { <th><span class="sr-only">Actions</span></th> }</tr></thead>
              <tbody>
                @for (x of d.items; track $index; let ii = $index) {
                  <tr>
                    <td><b>{{ x.what }}</b></td>
                    <td class="small"><span class="pw">{{ x.where }}</span></td>
                    <td class="small">{{ x.who }}</td>
                    @if (edit) { <td><button class="link-btn small" type="button" (click)="remove(di, ii)">Remove</button></td> }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      </section>
    } @empty {
      <div class="empty">No agenda yet.</div>
    }

    @if (edit) {
      <th-sheet heading="Add agenda item" [open]="addOpen()" (closed)="addOpen.set(false)">
        <form [formGroup]="form" (ngSubmit)="add()" novalidate>
          <th-messages [error]="error()" />
          <label>Day<input formControlName="day" list="agenda-days" placeholder="Saturday – April 17">
            @if (agenda().days.length) { <span class="hint">Pick an existing day or type a new one.</span> }</label>
          <datalist id="agenda-days">@for (d of agenda().days; track d.label) { <option [value]="d.label"></option> }</datalist>
          <label>When / what<input formControlName="what" placeholder="9:00 AM Meet in hotel lobby"></label>
          <label>Where<textarea formControlName="where" rows="2"></textarea></label>
          <label>Who’s responsible<input formControlName="who"></label>
          <div class="form-actions">
            <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Add to agenda' }}</button>
            <button class="btn ghost" type="button" (click)="addOpen.set(false)">Cancel</button>
          </div>
        </form>
      </th-sheet>
    }`
})
export class Agenda {
  readonly event = input.required<TeamEvent>();
  readonly store = inject(TeamStore);
  private readonly fb = inject(NonNullableFormBuilder);
  get edit() { return this.store.can('schedule') || this.store.can('meals'); }

  readonly agenda = computed<AgendaDoc>(() => {
    const a = this.store.agenda()[this.event().eid];
    return { note: a?.note, days: a?.days ?? [] };
  });
  readonly addOpen = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly form = this.fb.group({ day: '', what: '', where: '', who: '' });

  openAdd() {
    this.form.reset({ day: this.agenda().days.at(-1)?.label ?? '', what: '', where: '', who: '' });
    this.error.set('');
    this.addOpen.set(true);
  }

  async add() {
    const v = this.form.getRawValue();
    if (!v.day.trim() || !v.what.trim()) { this.error.set('Add a day and what’s happening.'); return; }
    const doc: AgendaDoc = structuredClone(this.agenda());
    let day = doc.days.find((d) => norm(d.label) === norm(v.day));
    if (!day) { day = { label: v.day.trim(), items: [] }; doc.days.push(day); }
    day.items.push({ what: v.what.trim(), ...(v.where.trim() ? { where: v.where.trim() } : {}), ...(v.who.trim() ? { who: v.who.trim() } : {}) });
    this.busy.set(true);
    const ok = await this.store.saveAgenda(this.event().eid, this.clean(doc), 'Added to the agenda');
    this.busy.set(false);
    if (ok) this.addOpen.set(false);
  }

  remove(di: number, ii: number) {
    const doc: AgendaDoc = structuredClone(this.agenda());
    doc.days[di].items.splice(ii, 1);
    if (!doc.days[di].items.length) doc.days.splice(di, 1);
    void this.store.saveAgenda(this.event().eid, this.clean(doc), 'Removed');
  }

  private clean(doc: AgendaDoc): AgendaDoc { return doc.note ? doc : { days: doc.days }; }
}
