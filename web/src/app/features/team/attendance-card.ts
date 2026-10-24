import { Component, computed, inject } from '@angular/core';
import { MARK_LABELS, MARK_LETTERS, type Mark } from '@shared/attendance';
import { fmt } from '../../core/dates';
import { TeamStore } from '../../core/team-store';

/**
 * Home: a family's own player's practice attendance (the Practice attendance feature). The bundle
 * only carries this family's marks, so nothing here can show another player.
 */
@Component({
  selector: 'th-attendance-card',
  template: `
    @if (mine(); as s) {
      <section class="card att-card" aria-labelledby="att-card-h">
        <div class="card-b">
          <div class="att-card-top">
            <svg width="72" height="72" viewBox="0 0 76 76" role="img" [attr.aria-label]="'Attended ' + s.rate + ' percent of practices'">
              <circle cx="38" cy="38" r="32" fill="none" stroke="var(--line-2)" stroke-width="9"></circle>
              <circle cx="38" cy="38" r="32" fill="none" [attr.stroke]="(s.rate ?? 0) < 75 ? 'var(--warn)' : 'var(--ok)'" stroke-width="9" stroke-linecap="round"
                [attr.stroke-dasharray]="dash(s.rate ?? 0)" transform="rotate(-90 38 38)"></circle>
              <text x="38" y="44" text-anchor="middle" class="att-ring-t">{{ s.rate }}%</text>
            </svg>
            <div>
              <h2 id="att-card-h" class="att-card-h">{{ first() }}'s practice attendance</h2>
              <div class="small muted">At {{ s.attended }} of {{ s.counted }} practices{{ excusedOut() && s.excused ? ', not counting ' + s.excused + ' excused' : '' }}.</div>
            </div>
          </div>
          <div class="att-stats">
            @for (m of order; track m) { <div><b>{{ s[m] }}</b><span class="small"><i [class]="'att-d m-' + m" aria-hidden="true">{{ letter(m) }}</i>{{ label(m) }}</span></div> }
          </div>
          @if (missed().length) {
            <h3 class="att-sub">Missed or late</h3>
            @for (l of missed(); track l.key) {
              <div class="li att-miss"><i [class]="'att-d m-' + l.s" aria-hidden="true">{{ letter(l.s) }}</i>
                <div class="grow"><b>{{ fmt(l.date, { weekday: 'short', month: 'short', day: 'numeric' }) }}</b><div class="small muted">{{ label(l.s) }}@if (l.note) { · “{{ l.note }}” }</div></div></div>
            }
          }
          <p class="small muted" style="margin:10px 0 0">Answering In, Maybe or Out on the schedule ahead of time helps the coaches plan; an Out is marked excused. Something wrong here? Ask a coach.</p>
        </div>
      </section>
    }`
})
export class AttendanceCard {
  readonly store = inject(TeamStore);
  readonly fmt = fmt;
  readonly order: Mark[] = ['present', 'late', 'excused', 'absent'];
  private readonly pid = computed(() => (this.store.has('attendance') ? this.store.myPid() : ''));
  readonly mine = computed(() => {
    const pid = this.pid();
    if (!pid) return null;
    const s = this.store.attendanceSummary().players.find((x) => x.pid === pid);
    return s && s.marked ? s : null;
  });
  readonly first = computed(() => this.store.playerName(this.pid()) || 'Your player');
  readonly excusedOut = computed(() => this.store.settings()?.attendanceExcusedCounts === false);
  /** The season's misses and late arrivals, newest first (at most 6). */
  readonly missed = computed(() => {
    const pid = this.pid();
    const all = this.store.attendanceSummary().players.find((x) => x.pid === pid);
    return all ? [...all.last].reverse().filter((l) => l.s !== 'present').slice(0, 6) : [];
  });
  dash(rate: number) { const c = 2 * Math.PI * 32; return `${(c * rate) / 100} ${c}`; }
  letter(m: Mark) { return MARK_LETTERS[m]; }
  label(m: Mark) { return MARK_LABELS[m]; }
}
