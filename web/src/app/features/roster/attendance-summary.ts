import { Component, computed, inject, signal } from '@angular/core';
import { MARK_LETTERS, MARK_LABELS, type Mark, type PlayerSummary } from '@shared/attendance';
import { addDays, fmt, today } from '../../core/dates';
import type { Player } from '../../core/models';
import { TeamStore } from '../../core/team-store';

type Range = 'season' | '30d' | 'month';
const LOW = 75;

/**
 * Roster › Attendance: every player's practice attendance (coaches, coordinators, team admins).
 * Attended = present or late, over the practices the player was marked at; cancelled practices and
 * practices nobody marked don't count. Excused absences count unless the team turned that off.
 */
@Component({
  selector: 'th-attendance-summary',
  template: `
    <div class="att-head">
      <p class="muted small" style="margin:0">Coaches, coordinators and team admins see every player. Each family sees only their own player, on Home.</p>
      <span class="spacer"></span>
      <nav class="chips" aria-label="Date range">
        <button class="chip" type="button" [attr.aria-pressed]="range() === 'season'" (click)="range.set('season')">This season</button>
        <button class="chip" type="button" [attr.aria-pressed]="range() === '30d'" (click)="range.set('30d')">Last 30 days</button>
        <button class="chip" type="button" [attr.aria-pressed]="range() === 'month'" (click)="range.set('month')">{{ monthName }}</button>
        <button class="chip" type="button" (click)="download()" [disabled]="!summary().taken">Download</button>
      </nav>
    </div>

    <div class="health-tiles">
      <div class="card health-tile"><div class="small muted">Team attendance</div>
        @if (summary().teamRate !== null) { <div class="health-big">{{ summary().teamRate }}% <span>{{ summary().attended }} of {{ summary().counted }}</span></div> } @else { <div class="health-big">–</div> }
        <div class="small muted">present or late, out of practices taken</div></div>
      <div class="card health-tile"><div class="small muted">Practices taken</div><div class="health-big">{{ summary().taken }} <span>of {{ held() }} held</span></div>
        <div class="small muted">@if (cancelled()) { {{ cancelled() }} cancelled {{ cancelled() === 1 ? "doesn't" : "don't" }} count } @else { cancelled practices don't count }</div></div>
      <div class="card health-tile"><div class="small muted">Below {{ low }}%</div><div class="health-big">{{ lowCount() }} <span>{{ lowCount() === 1 ? 'player' : 'players' }}</span></div><div class="small muted">worth a word with the family</div></div>
    </div>

    @if (notTaken().length) {
      <div class="comms-banner att-missing" role="status">
        <span><b>{{ notTaken().length === 1 ? (fmt(notTaken()[0].date, { weekday: 'long', month: 'short', day: 'numeric' }) + "'s practice hasn't been taken.") : notTaken().length + " practices haven't been taken." }}</b>
        They're left out of every total until someone marks them.</span>
        <button class="link-btn small" type="button" (click)="store.attendanceFor.set(notTaken()[0])">Take {{ fmt(notTaken()[0].date, { month: 'short', day: 'numeric' }) }}</button>
      </div>
    }

    <section class="card" style="margin-top:14px">
      <div class="card-h"><h3>By player</h3><span class="small muted" style="margin-left:8px">Lowest first</span><span class="spacer"></span>
        <span class="att-legend small">@for (m of legend; track m) { <span><i class="att-d" [class]="'att-d m-' + m">{{ letter(m) }}</i>{{ label(m) }}</span> }</span>
      </div>
      <div class="card-b">
        @if (summary().taken) {
          <div class="table-wrap">
            <table class="imp-table att-table">
              <thead><tr><th scope="col">Player</th><th scope="col">Attended</th><th scope="col" class="num">Present</th><th scope="col" class="num">Late</th><th scope="col" class="num">Excused</th><th scope="col" class="num">Absent</th><th scope="col">Last 8 practices</th></tr></thead>
              <tbody>
                @for (r of rows(); track r.s.pid) {
                  <tr>
                    <th scope="row">{{ name(r.p) }}@if (r.s.rate !== null && r.s.rate < low) { <span class="pill p-warn" style="margin-left:6px">Below {{ low }}%</span> }</th>
                    <td>@if (r.s.rate !== null) { <span class="limit-bar att-bar" [class.full]="r.s.rate < low" aria-hidden="true"><span [style.width.%]="r.s.rate"></span></span><b>{{ r.s.rate }}%</b><span class="small muted"> · {{ r.s.attended }} of {{ r.s.counted }}</span> } @else { <span class="muted small">Not marked yet</span> }</td>
                    <td class="num">{{ r.s.present }}</td><td class="num">{{ r.s.late }}</td><td class="num">{{ r.s.excused }}</td><td class="num">{{ r.s.absent }}</td>
                    <td><span class="att-dots">@for (l of r.s.last; track l.key) { <i [class]="'att-d m-' + l.s" [title]="fmt(l.date, { month: 'short', day: 'numeric' }) + ': ' + label(l.s) + (l.note ? ' (' + l.note + ')' : '')">{{ letter(l.s) }}</i> }</span></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="empty">No attendance taken @if (range() !== 'season') { in this range } yet. Open a practice on the Schedule and choose Take attendance.</div>
        }
        <p class="small muted" style="margin:10px 0 0">Attended = present or late. {{ excusedCounts() ? 'Excused absences count as missed practice' : 'Excused absences are left out of the percentage' }}; a team admin or coordinator can change that in Team settings.</p>
      </div>
    </section>

    <section class="card" style="margin-top:14px">
      <div class="card-h"><h3>Practices</h3><span class="small muted" style="margin-left:8px">Newest first</span></div>
      <div class="card-b">
        @for (it of practices(); track it.key) {
          <div class="li" [class.dim]="it.cancelled">
            <div class="grow"><b>{{ fmt(it.date, { weekday: 'short', month: 'short', day: 'numeric' }) }}</b> · {{ it.title }}
              <div class="small muted">@if (it.cancelled) { Cancelled: doesn't count } @else if (marked(it.key); as n) { {{ n }} {{ n === 1 ? 'player' : 'players' }} marked } @else { Not taken }</div>
            </div>
            @if (!it.cancelled) {
              @if (!marked(it.key)) { <span class="pill p-warn">Not taken</span> }
              <button class="link-btn small" type="button" (click)="store.attendanceFor.set(it)">{{ marked(it.key) ? 'Edit' : 'Take attendance' }}</button>
            }
          </div>
        } @empty {
          <div class="empty">No practices yet @if (range() !== 'season') { in this range}.</div>
        }
        @if (morePractices()) { <button class="link-btn small" type="button" style="margin-top:8px" (click)="showAll.set(true)">Show all {{ allPractices().length }} practices</button> }
      </div>
    </section>`
})
export class AttendanceSummary {
  readonly store = inject(TeamStore);
  readonly range = signal<Range>('season');
  readonly fmt = fmt;
  readonly low = LOW;
  readonly legend: Mark[] = ['present', 'late', 'excused', 'absent'];
  readonly monthName = fmt(today(), { month: 'long' });

  private readonly bounds = computed(() => {
    const t = today();
    if (this.range() === '30d') return { from: addDays(t, -30), to: t };
    if (this.range() === 'month') return { from: `${t.slice(0, 8)}01`, to: t };
    return { from: undefined, to: undefined };
  });
  readonly summary = computed(() => { const b = this.bounds(); return this.store.attendanceSummary(b.from, b.to); });
  readonly excusedCounts = computed(() => this.store.settings()?.attendanceExcusedCounts !== false);

  private readonly pastPractices = computed(() => {
    const b = this.bounds(), t = today();
    return this.store.items().filter((i) => i.kind === 'practice' && i.date <= t && (!b.from || i.date >= b.from));
  });
  readonly held = computed(() => this.pastPractices().filter((i) => !i.cancelled).length);
  readonly cancelled = computed(() => this.pastPractices().filter((i) => i.cancelled).length);
  /** Practices before today with nobody marked, newest first. */
  readonly notTaken = computed(() => this.pastPractices()
    .filter((i) => !i.cancelled && i.date < today() && !Object.keys(this.store.attendanceOf(i.key)?.marks ?? {}).length)
    .reverse());

  readonly showAll = signal(false);
  /** Practices up to today in the range, newest first; ten unless "Show all". */
  readonly allPractices = computed(() => [...this.pastPractices()].reverse());
  readonly practices = computed(() => (this.showAll() ? this.allPractices() : this.allPractices().slice(0, 10)));
  readonly morePractices = computed(() => !this.showAll() && this.allPractices().length > 10);
  marked(key: string): number { return Object.keys(this.store.attendanceOf(key)?.marks ?? {}).length; }

  readonly rows = computed(() => {
    const players = new Map(this.store.players().map((p) => [p.pid, p]));
    return this.summary().players
      .filter((s) => players.has(s.pid))
      .map((s) => ({ s, p: players.get(s.pid)! }))
      .sort((a, b) => (a.s.rate ?? 101) - (b.s.rate ?? 101) || this.name(a.p).localeCompare(this.name(b.p)));
  });
  readonly lowCount = computed(() => this.summary().players.filter((s) => s.rate !== null && s.rate < LOW).length);

  name(p: Player) { return `${p.jersey ? '#' + p.jersey + ' ' : ''}${p.first} ${p.last ?? ''}`.trim(); }
  letter(m: Mark) { return MARK_LETTERS[m]; }
  label(m: Mark) { return MARK_LABELS[m]; }

  /** The table as a spreadsheet-friendly CSV, for the coach's own records. */
  download() {
    const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const head = ['Player', 'Jersey', 'Attended %', 'Attended', 'Counted', 'Present', 'Late', 'Excused', 'Absent'];
    const lines = this.rows().map(({ s, p }: { s: PlayerSummary; p: Player }) =>
      [`${p.first} ${p.last ?? ''}`.trim(), p.jersey ?? '', s.rate ?? '', s.attended, s.counted, s.present, s.late, s.excused, s.absent].map(q).join(','));
    const csv = [head.map(q).join(','), ...lines].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.store.teamId()}-attendance-${this.range()}-${today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
