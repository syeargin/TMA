import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { REF_JOBS as WORK_JOBS, WORK_GROUP_LABELS, onDuty, workList, type WorkGroup, type WorkMatch } from '@shared/matches';
import { fmt } from '../../core/dates';
import type { Player, RefAssign, RefSet, TeamEvent } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { REF_JOBS, REF_SETS, fillByRotation, refGroup } from '../../core/tournament';
import { Sheet } from '../../shared/sheet';

/**
 * Who covers which job in each set when the team works a court. With matches the team works on the
 * Matches tab, there's one card per working match for the group on duty; tournaments from before keep
 * their single set of jobs.
 */
@Component({
  selector: 'th-ref-jobs',
  imports: [Sheet, FormsModule, RouterLink],
  template: `
    <div class="row" style="margin-bottom:12px">
      <p class="muted intro">When the team works a court, each player covers one job per set: keeping the book, flipping the score, tracking the libero, or calling lines.</p>
      @if (refEdit) { <button class="btn sm ghost" type="button" (click)="openGroups()">Edit A/B groups</button> }
    </div>

    @if (works().length) {
      <div class="stack" style="gap:12px">
        @for (w of works(); track w.id) {
          <section class="card" [id]="'work-' + w.id">
            <div class="card-h">
              <h3>{{ fmt(w.date, { weekday: 'short' }) }}@if (w.time) { {{ w.time }} }@if (w.court) { · Court {{ w.court }} }</h3>
              <span class="muted small">@if (w.matchNo) { Match {{ w.matchNo }} · }{{ w.teams.filter(nonEmpty).join(' v ') }}</span>
              <span class="spacer"></span>
              @if (edit) {
                <label class="sr-only" [for]="'grp-' + w.id">Who works it</label>
                <select class="cell" [id]="'grp-' + w.id" [ngModel]="w.group" (ngModelChange)="setGroup(w, $event)">
                  @for (g of groupChoices; track g) { <option [value]="g">{{ groupLabel(g) }}</option> }
                </select>
                <button class="btn sm" type="button" (click)="rotate(w)">Rotate again</button>
              } @else { <span class="pill p-mute">{{ groupLabel(w.group) }}</span> }
            </div>
            <div class="card-b">
              @if (duty(w).length) {
                <div class="tw">
                  <table>
                    <thead><tr><th class="sticky-col">Player</th><th>Set 1</th><th>Set 2</th><th>Set 3</th></tr></thead>
                    <tbody>
                      @for (p of duty(w); track p.pid) {
                        <tr [class.mine]="p.pid === store.you().pid">
                          <td class="sticky-col"><b>{{ p.first }}</b>@if (p.jersey) { <span class="muted tn"> #{{ p.jersey }}</span> }</td>
                          @for (s of sets; track s) {
                            <td>
                              @if (edit) {
                                <select class="cell" [attr.aria-label]="p.first + ' set ' + s.slice(1)" [ngModel]="w.jobs?.[p.pid]?.[s] ?? ''" (ngModelChange)="setJob(w, p.pid, s, $event)">
                                  <option value="">—</option>
                                  @for (j of workJobs; track j) { <option [value]="j">{{ j }}</option> }
                                </select>
                              } @else if (w.jobs?.[p.pid]?.[s]) { {{ w.jobs![p.pid][s] }} } @else { <span class="tbd">—</span> }
                            </td>
                          }
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              } @else { <div class="empty">Nobody is in {{ groupLabel(w.group) }}. Use Edit A/B groups, or pick Whole team.</div> }
            </div>
          </section>
        }
      </div>
    } @else {
      <p class="small muted">Add the matches the team works on the <a [routerLink]="['/teams', store.teamId(), 'tournaments', event().eid, 'matches']">Matches</a> tab, and each one gets its own ref jobs for the group on duty.</p>
    }

    @if (!works().length || hasLegacy()) {
      @if (hasLegacy() && works().length) { <h3 style="margin:18px 0 8px;font-size:16px">Earlier ref jobs (not tied to a match)</h3> }
      @if (refEdit) {
        <div class="row" style="margin-bottom:10px">
          <button class="btn sm" type="button" (click)="fill()">Fill by rotation</button>
          <button class="btn sm" type="button" [class.ghost]="!confirmClear()" [class.confirming]="confirmClear()" (click)="clear()">{{ confirmClear() ? 'Tap again to clear' : 'Clear' }}</button>
        </div>
      }
      <div class="grid g-2">
        @for (g of groups(); track g.name) {
          <section class="card">
            <div class="card-h"><h3>Team {{ g.name }}</h3><span class="muted small">{{ names(g.players) }}</span></div>
            <div class="card-b">
              @if (g.players.length) {
                <div class="tw">
                  <table>
                    <thead><tr><th class="sticky-col">Player</th><th>Set 1</th><th>Set 2</th><th>Set 3</th></tr></thead>
                    <tbody>
                      @for (p of g.players; track p.pid) {
                        <tr [class.mine]="p.pid === store.you().pid">
                          <td class="sticky-col"><b>{{ p.first }}</b>@if (p.jersey) { <span class="muted tn"> #{{ p.jersey }}</span> }</td>
                          @for (s of sets; track s) {
                            <td>
                              @if (refEdit) {
                                <select class="cell" [attr.aria-label]="p.first + ' set ' + s.slice(1)" [ngModel]="job(p.pid, s)" (ngModelChange)="set(p.pid, s, $event)">
                                  <option value="">—</option>
                                  @for (j of jobs; track j) { <option [value]="j">{{ j }}</option> }
                                </select>
                              } @else if (job(p.pid, s)) { {{ job(p.pid, s) }} } @else { <span class="tbd">—</span> }
                            </td>
                          }
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              } @else { <div class="empty">No players in this group.</div> }
            </div>
          </section>
        }
      </div>
    }

    @if (refEdit) {
      <th-sheet heading="Ref job groups" [open]="groupsOpen()" (closed)="groupsOpen.set(false)">
        <form (submit)="$event.preventDefault(); saveGroups()">
          <p class="muted small">Split the team into two groups that work courts separately.</p>
          @for (p of store.players(); track p.pid) {
            <label class="row" style="flex-direction:row;justify-content:space-between">
              <span>{{ p.first }} {{ p.last }}</span>
              <select class="cell" [name]="p.pid" [attr.aria-label]="p.first + '’s group'" [(ngModel)]="draft[p.pid]"><option value="A">A</option><option value="B">B</option></select>
            </label>
          }
          <div class="form-actions"><button class="btn primary" type="submit">Save groups</button><button class="btn ghost" type="button" (click)="groupsOpen.set(false)">Cancel</button></div>
        </form>
      </th-sheet>
    }`
})
export class RefJobs {
  readonly event = input.required<TeamEvent>();
  readonly store = inject(TeamStore);
  readonly fmt = fmt;
  readonly sets = REF_SETS;
  readonly jobs = REF_JOBS;
  readonly workJobs = WORK_JOBS;
  readonly groupChoices: WorkGroup[] = ['A', 'B', 'all'];
  /** Work matches' jobs: whoever adds them (staff) or assigns ref jobs. */
  get edit() { return this.store.can('refjobs') || this.store.can('scores'); }
  /** Groups and the older single set of jobs: whoever assigns ref jobs. */
  get refEdit() { return this.store.can('refjobs'); }
  readonly confirmClear = signal(false);
  readonly groupsOpen = signal(false);
  draft: Record<string, 'A' | 'B'> = {};
  nonEmpty = (t: string) => !!t;

  readonly works = computed(() => workList(this.store.matches()[this.event().eid]));
  duty(w: WorkMatch) { return onDuty(this.store.players(), w.group); }
  groupLabel(g: WorkGroup) { return WORK_GROUP_LABELS[g]; }
  setGroup(w: WorkMatch, group: WorkGroup) {
    void this.store.saveWork(this.event().eid, w.id, { date: w.date, teams: w.teams, time: w.time, court: w.court, matchNo: w.matchNo, group }, `${this.groupLabel(group)} works it. Jobs filled by rotation.`);
  }
  setJob(w: WorkMatch, pid: string, s: RefSet, v: string) {
    const jobs: RefAssign = structuredClone(w.jobs ?? {});
    jobs[pid] = { ...(jobs[pid] ?? {}), [s]: v || undefined };
    if (!v) delete jobs[pid][s];
    void this.store.saveWorkJobs(this.event().eid, w.id, { jobs });
  }
  rotate(w: WorkMatch) { void this.store.saveWorkJobs(this.event().eid, w.id, { rotate: true }, 'Jobs rotated'); }

  // ----- the single set of jobs tournaments had before work matches -----
  readonly assign = computed<RefAssign>(() => this.store.refjobs()[this.event().eid]?.assign ?? {});
  readonly hasLegacy = computed(() => Object.keys(this.assign()).length > 0);
  readonly groups = computed(() => (['A', 'B'] as const).map((name) => ({ name, players: this.store.players().filter((p) => refGroup(p) === name) })));
  names(ps: Player[]) { return ps.map((p) => p.first).join(', '); }
  job(pid: string, s: RefSet) { return this.assign()[pid]?.[s] ?? ''; }
  set(pid: string, s: RefSet, v: string) {
    const next: RefAssign = structuredClone(this.assign());
    next[pid] = { ...(next[pid] ?? {}), [s]: v || undefined };
    if (!v) delete next[pid][s];
    void this.store.saveRefJobs(this.event().eid, next);
  }
  fill() { void this.store.saveRefJobs(this.event().eid, fillByRotation(this.store.players()), 'Ref jobs filled by rotation'); }
  clear() {
    if (!this.confirmClear()) { this.confirmClear.set(true); return; }
    this.confirmClear.set(false);
    void this.store.saveRefJobs(this.event().eid, {}, 'Ref jobs cleared');
  }
  openGroups() {
    this.draft = Object.fromEntries(this.store.players().map((p) => [p.pid, refGroup(p)]));
    this.groupsOpen.set(true);
  }
  async saveGroups() {
    const changed = Object.fromEntries(this.store.players().filter((p) => this.draft[p.pid] !== refGroup(p)).map((p) => [p.pid, this.draft[p.pid]]));
    if (Object.keys(changed).length && !(await this.store.setRefGroups(changed))) return;
    this.groupsOpen.set(false);
  }
}
