import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MARK_LABELS, MARKS, suggestedMark, type Mark, type PlayerMark } from '@shared/attendance';
import { fmt } from '../../core/dates';
import { TeamStore } from '../../core/team-store';
import { Sheet } from '../../shared/sheet';

type Draft = Record<string, { s?: Mark; note: string }>;

/**
 * Taking attendance for one practice (coaches, coordinators, team admins). Marks start from what's
 * saved, or else from the family's availability answer (In → Present, Out → Excused); a player left
 * unmarked doesn't count for that practice.
 */
@Component({
  selector: 'th-attendance-sheet',
  imports: [Sheet],
  template: `
    <th-sheet heading="Attendance" [open]="!!store.attendanceFor()" (closed)="store.attendanceFor.set(null)">
      @if (store.attendanceFor(); as it) {
        <p class="muted small" style="margin:0 0 8px">{{ when() }}</p>
        <div class="att-bar small" role="status">
          <span><b>{{ tally().present }}</b> present</span><span><b>{{ tally().late }}</b> late</span>
          <span><b>{{ tally().excused }}</b> excused</span><span><b>{{ tally().absent }}</b> absent</span>
          @if (tally().none) { <span><b>{{ tally().none }}</b> not marked</span> }
          <span class="spacer"></span>
          @if (tally().none) { <button class="btn sm" type="button" (click)="restPresent()">Rest present</button> }
        </div>
        <p class="small muted" style="margin:8px 0">Filled in from what families answered. Tap to change.</p>
        <ul class="list att-list">
          @for (p of store.players(); track p.pid) {
            @if (draft()[p.pid]; as d) {
            <li class="att-row" [class.unmarked]="!d.s">
              <div class="att-name"><b>@if (p.jersey) {#{{ p.jersey }} }{{ p.first }} {{ p.last }}</b>
                @switch (store.rsvp(p.pid, it.key)) {
                  @case ('yes') { <span class="pill p-ok">Said In</span> }
                  @case ('no') { <span class="pill p-bad">Said Out</span> }
                  @case ('maybe') { <span class="pill p-warn">Said Maybe</span> }
                  @default { <span class="pill p-mute">No answer</span> }
                }
              </div>
              <div class="att-seg" role="group" [attr.aria-label]="p.first + ' ' + (p.last ?? '')">
                @for (m of marks; track m) {
                  <button type="button" [class]="'m-' + m" [attr.aria-pressed]="d.s === m" (click)="set(p.pid, m)">{{ labels[m] }}</button>
                }
              </div>
              @if (d.s && d.s !== 'present') {
                <label class="att-note small">Note <input [value]="d.note" maxlength="120" (input)="note(p.pid, $any($event.target).value)" placeholder="Optional"></label>
              }
            </li>
            }
          } @empty {
            <li class="empty">No players on the roster yet.</li>
          }
        </ul>
        <div class="att-save">
          <button class="btn primary" type="button" (click)="save()" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Save attendance' }}</button>
          @if (tally().none) { <span class="small muted">Players left unmarked don't count for this practice.</span> }
        </div>
      }
    </th-sheet>`
})
export class AttendanceSheet {
  readonly store = inject(TeamStore);
  readonly marks = MARKS;
  readonly labels = MARK_LABELS;
  readonly draft = signal<Draft>({});
  readonly busy = signal(false);

  readonly when = computed(() => {
    const it = this.store.attendanceFor();
    return it ? `${fmt(it.date, { weekday: 'long', month: 'long', day: 'numeric' })}${it.time ? ' · ' + it.time : ''}${it.location ? ' · ' + it.location : ''}` : '';
  });
  readonly tally = computed(() => {
    const out = { present: 0, late: 0, excused: 0, absent: 0, none: 0 };
    for (const d of Object.values(this.draft())) { if (d.s) out[d.s]++; else out.none++; }
    return out;
  });

  constructor() {
    // Filled when the sheet opens; a live reload while it's open doesn't wipe the marks being made.
    effect(() => {
      const it = this.store.attendanceFor();
      if (!it) return;
      untracked(() => {
        const saved = this.store.attendanceOf(it.key)?.marks ?? {};
        const d: Draft = {};
        for (const p of this.store.players()) {
          const m = saved[p.pid];
          d[p.pid] = m ? { s: m.s, note: m.note ?? '' } : { s: suggestedMark(this.store.rsvp(p.pid, it.key) || undefined), note: '' };
        }
        this.draft.set(d);
      });
    });
  }

  set(pid: string, s: Mark) { this.draft.update((d) => ({ ...d, [pid]: { ...d[pid], s: d[pid]?.s === s ? undefined : s } })); }
  note(pid: string, v: string) { this.draft.update((d) => ({ ...d, [pid]: { ...d[pid], note: v } })); }
  restPresent() { this.draft.update((d) => Object.fromEntries(Object.entries(d).map(([pid, x]) => [pid, x.s ? x : { ...x, s: 'present' as Mark }]))); }

  async save() {
    const it = this.store.attendanceFor();
    if (!it) return;
    const saved = this.store.attendanceOf(it.key)?.marks ?? {};
    const marks: Record<string, PlayerMark | null> = {};
    for (const [pid, d] of Object.entries(this.draft())) {
      if (d.s) marks[pid] = { s: d.s, ...(d.s !== 'present' && d.note.trim() ? { note: d.note.trim().slice(0, 120) } : {}) };
      else if (saved[pid]) marks[pid] = null;
    }
    if (!Object.keys(marks).length) { this.store.attendanceFor.set(null); return; }
    this.busy.set(true);
    const ok = await this.store.saveAttendance(it.key, marks);
    this.busy.set(false);
    if (ok) this.store.attendanceFor.set(null);
  }
}
