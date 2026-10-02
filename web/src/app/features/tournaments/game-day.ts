import { Component, computed, inject, input, output } from '@angular/core';
import type { TeamEvent } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { ToastService } from '../../core/toast.service';
import { duties, safeUrl, shortUrl } from '../../core/tournament';

interface Row { label: string; text?: string; link?: string; copy?: string; note?: string }

/** The game-day sheet: where, when, what to wear and bring. */
@Component({
  selector: 'th-game-day',
  template: `
    <div class="grid g-2">
      <section class="card">
        <div class="card-h"><h3>Game-day sheet</h3><span class="spacer"></span>
          @if (store.can('schedule')) { <button class="btn sm primary" type="button" (click)="edit.emit()">Edit</button> }
        </div>
        <div class="card-b">
          <div class="kv">
            @for (r of rows(); track r.label) {
              <div>{{ r.label }}</div>
              <div>
                @if (r.copy) {
                  <button class="link-btn tn" type="button" (click)="copy(r.copy)"><b>{{ r.copy }}</b> (copy)</button>
                } @else if (r.link) {
                  <a [href]="r.link" target="_blank" rel="noopener">{{ short(r.link) }}</a>
                } @else if (r.text) {
                  <span class="pw">{{ r.text }}</span>@if (r.note) { <span class="muted"> — {{ r.note }}</span> }
                } @else {
                  <span class="tbd">TBD</span>
                }
              </div>
            }
          </div>
        </div>
      </section>
      <div class="stack">
        <section class="card">
          <div class="card-h"><h3>What to bring</h3></div>
          <div class="card-b">
            @if (checklist().length) {
              <ul class="checklist">@for (c of checklist(); track $index) { <li>{{ c }}</li> }</ul>
            } @else { <div class="empty">No checklist yet.</div> }
          </div>
        </section>
        <section class="card">
          <div class="card-h"><h3>Tournament rules</h3></div>
          <div class="card-b small stack" style="gap:6px">
            <p>Players check in with {{ coachNames() }} before leaving the team for any reason, and always go with an exit buddy.</p>
            <p>No phones or AirPods out during play. Text the coaches for anything urgent.</p>
            <p>Leave calls to the coaches. Route feedback to the team coordinator, not the bench.</p>
          </div>
        </section>
      </div>
    </div>`
})
export class GameDay {
  readonly event = input.required<TeamEvent>();
  readonly edit = output<void>();
  readonly store = inject(TeamStore);
  private readonly toast = inject(ToastService);
  readonly short = shortUrl;

  readonly coachNames = computed(() => (this.store.settings()?.coaches ?? []).map((c) => c.name).join(' or ') || 'the coaches');
  readonly checklist = computed(() => {
    const own = this.event().checklist ?? [];
    return own.length ? own : this.store.settings()?.checklist ?? [];
  });

  readonly rows = computed<Row[]>(() => {
    const e = this.event();
    const linkOr = (v?: string): Pick<Row, 'text' | 'link'> => (safeUrl(v) ? { link: safeUrl(v) } : { text: v });
    const code = e.teamCode || this.store.settings()?.teamCode;
    return [
      { label: 'Location', text: e.location },
      { label: 'Parking', text: e.parking },
      { label: 'Waves', text: e.waves },
      { label: 'Arrival time', text: e.arrival },
      { label: 'First match', text: e.start },
      { label: 'Where to meet', text: e.meet },
      { label: 'Uniforms', text: e.uniforms },
      { label: 'Admission', ...linkOr(e.admissions) },
      { label: 'Team code', copy: code },
      { label: 'Match schedule', ...linkOr(e.scheduleLink) },
      { label: 'Ticket help', ...linkOr(e.ticketHelp) },
      ...duties(e).map((d) => d.pid === 'na'
        ? { label: d.label, text: 'Not needed' }
        : { label: d.label, text: `${this.store.playerName(d.pid)}'s family`, note: 'pick up after the last practice, return before the next one' }),
      { label: 'Food plan', text: e.foodPlan },
      { label: 'Restaurant reservations', text: e.reservations },
      { label: 'Notes', text: e.notes }
    ];
  });

  async copy(text: string) {
    try { await navigator.clipboard.writeText(text); this.toast.show('Copied'); }
    catch { this.toast.show(text); }
  }
}
