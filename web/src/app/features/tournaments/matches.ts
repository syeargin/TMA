import { Component, ViewEncapsulation, computed, inject, input, signal } from '@angular/core';
import { FORMATS, FORMAT_LABELS, MAX_SLOTS, WORK_GROUP_LABELS, matchProblem, minutesOfDay, nextGroup, pointDiff, record, setsWon, suggestedResult, tournamentDays, tournamentView, workList, type Format, type Match, type Result, type WorkGroup, type WorkMatch } from '@shared/matches';
import { fmt, fmtRange } from '../../core/dates';
import type { TeamEvent } from '../../core/models';
import { fullName } from '../../core/me.service';
import { TeamStore } from '../../core/team-store';
import { RouterLink } from '@angular/router';
import { Sheet } from '../../shared/sheet';
import { ShareResults, tournamentShare, type ShareCard } from '../stats/share-results';

type Draft = { eid: string; id: string; date: string; n: number; time: string; court: string; opponent: string; format: Format; sets: { us: string; them: string }[]; result: Result | '' };
const MAX_SETS = 5;

/** A tournament's Matches section: each day's matches, the tournament summary, scores and the scorekeeper. */
@Component({
  selector: 'th-matches',
  imports: [Sheet, ShareResults, RouterLink],
  styleUrl: '../stats/matches.css',
  encapsulation: ViewEncapsulation.None,
  template: `
    @if (keeperBanner()) {
      <div class="banner info" role="status">
        <span class="grow"><b>You're the scorekeeper for this tournament.</b> Tap a match to enter its score. Coaches can change or remove scores.</span>
        @if (nextRow(); as r) { <button class="btn sm primary" type="button" (click)="open(r.date, r.n)">Enter next score</button> }
      </div>
    }
    @if (staff()) {
      <section class="card mt-keeper">
        <div class="card-b row" style="padding-top:12px">
          <span class="grow"><b>Scorekeeper</b> <span class="muted small">· coaches, coordinators and team admins can always enter scores; a scorekeeper can too, for this tournament only.</span></span>
          <span class="pill p-mute">{{ keeperName() || 'None' }}</span>
          <button class="btn sm" type="button" (click)="openKeeper()">{{ keeperName() ? 'Change' : 'Choose a parent' }}</button>
        </div>
      </section>
    }

    <section class="card">
      <div class="card-h"><h3>Tournament summary</h3>
        <span class="muted small">{{ view().totals.played }} of {{ view().totals.played + view().totals.toPlay }} matches played</span>
        <span class="spacer"></span>
        @if (view().totals.played) { <button class="btn sm" type="button" (click)="shareOpen.set(true)">Share</button> }
      </div>
      <div class="card-b">
        @if (!view().totals.played) { <p class="muted" style="margin:0 0 6px">No scores yet. Results add up here as matches are entered.</p> } @else {
        <div class="mt-tiles">
          <div class="mt-tile"><span class="label">Matches</span><span class="mt-big tn">{{ rec(view().totals) }} <span>won–lost</span></span></div>
          <div class="mt-tile"><span class="label">Sets</span><span class="mt-big tn">{{ view().totals.setsWon }}–{{ view().totals.setsLost }}</span></div>
          <div class="mt-tile"><span class="label">Points</span><span class="mt-big tn">{{ view().totals.pointsFor }}–{{ view().totals.pointsAgainst }} <span>{{ diff(view().totals) }}</span></span></div>
          <div class="mt-tile"><span class="label">Still to play</span><span class="mt-big tn">{{ view().totals.toPlay }}</span></div>
        </div>
        @if (view().days.length > 1) {
          <div class="table-wrap">
            <table>
              <thead><tr><th>Day</th><th>Matches</th><th>Sets</th><th>Points</th></tr></thead>
              <tbody>
                @for (d of view().days; track d.date) {
                  <tr><td><b>{{ day(d.date) }}</b></td><td class="tn">{{ rec(d.totals) }}</td><td class="tn">{{ d.totals.setsWon }}–{{ d.totals.setsLost }}</td><td class="tn">{{ d.totals.pointsFor }}–{{ d.totals.pointsAgainst }}</td></tr>
                }
                <tr><td><b>Total</b></td><td class="tn"><b>{{ rec(view().totals) }}</b></td><td class="tn"><b>{{ view().totals.setsWon }}–{{ view().totals.setsLost }}</b></td><td class="tn"><b>{{ view().totals.pointsFor }}–{{ view().totals.pointsAgainst }}</b></td></tr>
              </tbody>
            </table>
          </div>
        }
        }
      </div>
    </section>

    @for (d of view().days; track d.date) {
      <section class="card">
        <div class="card-h"><h3>{{ day(d.date) }}</h3>
          @if (d.totals.played) { <span class="mt-res" [class.w]="d.totals.won > d.totals.lost" [class.l]="d.totals.won < d.totals.lost" [class.t]="d.totals.won === d.totals.lost">{{ rec(d.totals) }}</span> }
          <span class="muted small">{{ d.rows.length }} {{ d.rows.length === 1 ? 'match' : 'matches' }}@if (d.totals.played) { · sets {{ d.totals.setsWon }}–{{ d.totals.setsLost }} }</span>
          <span class="spacer"></span>
          @if (canWork()) { <button class="btn sm" type="button" (click)="openAdd(d.date)">Add match</button> }
          @else if (canScore() && d.rows.length < maxSlots) { <button class="btn sm" type="button" (click)="addRow(d.date, d.rows.length)">Add match</button> }
        </div>
        <div class="card-b">
          <div class="table-wrap">
            <table class="mt-table">
              <thead><tr><th>#</th><th>Time</th><th>Court</th><th>Opponent</th><th>Set scores (us–them)</th><th>Sets</th><th>Result</th><th><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                @for (x of merged(d.date, d.rows); track x.key) {
                  @if (x.work; as w) {
                    <tr class="mt-work">
                      <td class="muted tn c-n">{{ w.matchNo || '' }}</td>
                      <td class="tn c-hide">@if (w.time) { {{ w.time }} } @else { <span class="muted">TBD</span> }</td>
                      <td class="c-hide">@if (w.court) { Ct {{ w.court }} } @else { <span class="muted">–</span> }</td>
                      <td class="c-opp"><span class="mt-kind work">We work</span> <b>{{ teamsOf(w) }}</b>
                        <div class="mt-meta muted small">{{ w.time || 'Time TBD' }}@if (w.court) { · Ct {{ w.court }} }</div></td>
                      <td colspan="3" class="c-sets"><span class="mt-grp" [class]="'mt-grp g-' + w.group">{{ groupLabel(w.group) }}</span>@if (w.auto) { <span class="muted small"> auto</span> }
                        @if (jobSummary(w); as js) { <div class="muted small">{{ js }}</div> }</td>
                      <td class="mt-act">
                        <a class="link-btn small" [routerLink]="['/teams', store.teamId(), 'tournaments', event().eid, 'ref']">Ref jobs</a>
                        @if (canWork()) { <button class="link-btn small" type="button" style="margin-left:8px" (click)="openWork(w)">Edit</button> }
                      </td>
                    </tr>
                  } @else {
                  @let r = x.row!;
                  <tr [class.mt-next]="nextRow()?.id === r.id">
                    <td class="muted tn c-n">{{ r.n }}</td>
                    <td class="tn c-hide">@if (r.match?.time) { {{ r.match!.time }} } @else { <span class="muted">TBD</span> }</td>
                    <td class="c-hide">@if (r.match?.court) { Ct {{ r.match!.court }} } @else { <span class="muted">–</span> }</td>
                    <td class="c-opp">@if (hasWork()) { <span class="mt-kind">We play</span> }@if (r.match?.opponent) { <b>{{ r.match!.opponent }}</b> } @else { <span class="muted">Opponent TBD</span> }
                      <div class="mt-meta muted small">{{ r.match?.time || 'Time TBD' }}@if (r.match?.court) { · Ct {{ r.match!.court }} }</div></td>
                    <td class="c-sets">
                      @if (r.match?.sets?.length) {
                        @for (s of r.match!.sets; track $index) { <span class="mt-set tn" [class.w]="s.us > s.them" [class.l]="s.them > s.us">{{ s.us }}–{{ s.them }}</span> }
                      } @else { <span class="muted small">{{ formatLabel(r.match?.format ?? 3) }} · not played yet</span> }
                    </td>
                    <td class="tn c-hide">@if (r.match?.sets?.length) { {{ won(r.match!) }} } @else { <span class="muted">–</span> }</td>
                    <td class="c-res">
                      @switch (r.match?.result) {
                        @case ('W') { <span class="mt-res w">Win</span> }
                        @case ('L') { <span class="mt-res l">Loss</span> }
                        @default { <span class="mt-res t">To play</span> }
                      }
                    </td>
                    <td class="mt-act">
                      @if (canScore()) {
                        <button class="link-btn small" type="button" (click)="open(d.date, r.n)">{{ r.match?.result ? 'Edit' : 'Enter score' }}</button>
                        @if (staff() && !r.match && r.n === d.rows.length && d.rows.length > 1) { <button class="link-btn small" type="button" style="margin-left:8px" (click)="removeRow(d.date, d.rows.length)">Remove</button> }
                      }
                    </td>
                  </tr>
                  }
                }
              </tbody>
            </table>
          </div>
          @if (canScore() && $first) { <p class="hint" style="margin:0">Each day starts with 3 match rows. Use “Add match” for more.</p> }
        </div>
      </section>
    }

    @if (hasWork()) {
      <section class="card">
        <div class="card-b row mt-tally" style="padding-top:12px">
          <b>Work this tournament</b>
          @for (g of tally(); track g.group) { <span><span class="mt-grp" [class]="'mt-grp g-' + g.group">{{ groupLabel(g.group) }}</span> {{ g.n }} match{{ g.n === 1 ? '' : 'es' }}</span> }
          <span class="muted small">The next one goes to {{ groupLabel(upNext()) }}. Pick a group on any match to change it.</span>
        </div>
      </section>
    }

    @if (canWork()) {
      <th-sheet [heading]="work()?.id ? 'Edit the match we work' : 'Add a match · ' + day(work()?.date ?? event().date)" [open]="!!work()" (closed)="work.set(null)">
        @if (work(); as w) {
          <form class="mt-form" (submit)="$event.preventDefault(); saveWork()" novalidate>
            @if (!w.id) {
              <div class="mt-seg" role="group" aria-label="Kind of match">
                <button type="button" [attr.aria-pressed]="w.kind === 'play'" (click)="setWork('kind', 'play')">We play</button>
                <button type="button" [attr.aria-pressed]="w.kind === 'work'" (click)="setWork('kind', 'work')">We work (ref)</button>
              </div>
            }
            @if (w.kind === 'play') {
              <p class="muted small">Adds a row for a match the team plays. Enter the opponent, time and court now, and the score when it's played.</p>
              <div class="row"><button class="btn primary" type="button" (click)="addPlay()" [disabled]="busy() || playRows(w.date) >= maxSlots">Add the match we play</button><button class="btn ghost" type="button" (click)="work.set(null)">Cancel</button></div>
            } @else {
              <fieldset class="group"><legend>Teams playing</legend>
                <div class="mt-vs">
                  <input id="mt-w-a" [value]="w.a" (input)="setWork('a', $any($event.target).value)" placeholder="Lakeside 13 Gold" [attr.list]="'mt-teams'" aria-label="First team">
                  <span class="muted">v</span>
                  <input id="mt-w-b" [value]="w.b" (input)="setWork('b', $any($event.target).value)" placeholder="Coastal 13 Red" [attr.list]="'mt-teams'" aria-label="Second team">
                </div>
                <datalist id="mt-teams">@for (t of knownTeams(); track t) { <option [value]="t"></option> }</datalist>
                <p class="hint" style="margin:4px 0 0">Pick from teams already entered, or type a name.</p>
              </fieldset>
              <div class="mt-three">
                <label>Day<select [value]="w.date" (change)="setWork('date', $any($event.target).value)">@for (dd of days(); track dd) { <option [value]="dd" [selected]="dd === w.date">{{ day(dd) }}</option> }</select></label>
                <label>Time<input id="mt-w-time" [value]="w.time" (input)="setWork('time', $any($event.target).value)" placeholder="8:00 AM"></label>
                <label>Court<input id="mt-w-court" [value]="w.court" (input)="setWork('court', $any($event.target).value)" placeholder="6"></label>
                <label>Match #<input id="mt-w-no" [value]="w.matchNo" (input)="setWork('matchNo', $any($event.target).value)" placeholder="1"></label>
              </div>
              <fieldset class="group"><legend>Who works it</legend>
                <div class="mt-seg" role="group" aria-label="Who works it">
                  <button type="button" [attr.aria-pressed]="w.group === null" (click)="setWork('group', null)">{{ groupLabel(autoGroup(w.id)) }} · auto</button>
                  @for (g of groupChoices; track g) { <button type="button" [attr.aria-pressed]="w.group === g" (click)="setWork('group', g)">{{ groupLabel(g) }}</button> }
                </div>
                <p class="hint" style="margin:4px 0 0">Auto keeps the work even: {{ tallyText() }}. Their jobs per set are filled by rotation; change them on Ref jobs.</p>
              </fieldset>
              @if (workError()) { <p class="hint warn" role="alert">{{ workError() }}</p> }
              <div class="row">
                <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving…' : w.id ? 'Save' : 'Add match' }}</button>
                <button class="btn ghost" type="button" (click)="work.set(null)">Cancel</button>
                <span class="spacer"></span>
                @if (w.id) { <button class="btn" type="button" [class.danger]="!confirmClear()" [class.confirming]="confirmClear()" (click)="removeWork()">{{ confirmClear() ? 'Tap again to remove' : 'Remove' }}</button> }
              </div>
            }
          </form>
        }
      </th-sheet>
    }

    <th-sheet [heading]="draftHeading()" [open]="!!draft()" (closed)="draft.set(null)">
      @if (draft(); as f) {
        <form class="mt-form" (submit)="$event.preventDefault(); save()" novalidate>
          <div class="g-2">
            <label>Time<input [value]="f.time" (input)="set('time', $any($event.target).value)" placeholder="8:00 AM" autocomplete="off"></label>
            <label>Court<input [value]="f.court" (input)="set('court', $any($event.target).value)" placeholder="6" autocomplete="off"></label>
          </div>
          <label>Opponent<input [value]="f.opponent" (input)="set('opponent', $any($event.target).value)" placeholder="Lakeside 13 Gold" autocomplete="off"></label>
          <fieldset class="group"><legend>Number of sets</legend>
            <div class="mt-seg" role="group" aria-label="Number of sets">
              @for (o of formats; track o) { <button type="button" [attr.aria-pressed]="f.format === o" (click)="setFormat(o)">{{ formatLabel(o) }}</button> }
            </div>
          </fieldset>
          <fieldset class="group"><legend>Set scores</legend>
            <div class="mt-setrow label"><span></span><span>Us</span><span></span><span>Them</span><span></span></div>
            @for (s of f.sets; track $index; let i = $index) {
              <div class="mt-setrow">
                <b>Set {{ i + 1 }}</b>
                <input class="mt-score tn" inputmode="numeric" maxlength="2" [attr.aria-label]="'Set ' + (i + 1) + ', our score'" [value]="s.us" (input)="setScore(i, 'us', $any($event.target).value)">
                <span class="muted">–</span>
                <input class="mt-score tn" inputmode="numeric" maxlength="2" [attr.aria-label]="'Set ' + (i + 1) + ', their score'" [value]="s.them" (input)="setScore(i, 'them', $any($event.target).value)">
                <span class="mt-won" [class.w]="setWon(s) === 'W'" [class.l]="setWon(s) === 'L'">{{ setWon(s) === 'W' ? 'Won' : setWon(s) === 'L' ? 'Lost' : '' }}</span>
              </div>
            }
            <p class="hint" style="margin:4px 0 0">{{ f.format === 2 ? 'Both sets are played.' : 'Leave later sets blank if the match ended early.' }}</p>
          </fieldset>
          <fieldset class="group"><legend>Outcome</legend>
            <div class="mt-out" role="group" aria-label="Outcome">
              <button class="w" type="button" [attr.aria-pressed]="outcome() === 'W'" (click)="set('result', 'W')">Win</button>
              <button class="l" type="button" [attr.aria-pressed]="outcome() === 'L'" (click)="set('result', 'L')">Loss</button>
            </div>
            <p class="hint" style="margin:4px 0 0">{{ outcomeHint() }}</p>
          </fieldset>
          @if (problem()) { <p class="hint warn" role="alert">{{ problem() }}</p> }
          <div class="row">
            <button class="btn primary" type="submit" [disabled]="busy() || !!problem()">{{ busy() ? 'Saving…' : 'Save match' }}</button>
            <button class="btn ghost" type="button" (click)="draft.set(null)">Cancel</button>
            <span class="spacer"></span>
            @if (existing()) { <button class="btn" type="button" [class.danger]="!confirmClear()" [class.confirming]="confirmClear()" (click)="clear()">{{ confirmClear() ? 'Tap again to clear' : 'Clear match' }}</button> }
          </div>
        </form>
      }
    </th-sheet>

    @if (staff()) {
      <th-sheet [heading]="'Scorekeeper for ' + event().title" [open]="keeperOpen()" (closed)="keeperOpen.set(false)">
        <form (submit)="$event.preventDefault(); saveKeeper()">
          <p class="muted small">Pick a parent who'll be in the stands. They can enter and fix scores for this tournament, nothing else.</p>
          <div class="stack" style="gap:8px">
            <label class="mt-opt"><input type="radio" name="keeper" [checked]="!keeperPick()" (change)="keeperPick.set('')"> <span><b>No scorekeeper</b><br><span class="muted small">Only staff enter scores</span></span></label>
            @for (p of parents(); track p.sub) {
              <label class="mt-opt"><input type="radio" name="keeper" [checked]="keeperPick() === p.sub" (change)="keeperPick.set(p.sub)"> <span><b>{{ p.name }}</b><br><span class="muted small">{{ p.family }}{{ p.going }}</span></span></label>
            } @empty { <p class="muted">No parents have joined the team yet.</p> }
          </div>
          <div class="row" style="margin-top:14px">
            <button class="btn primary" type="submit" [disabled]="busy()">Save</button>
            <button class="btn ghost" type="button" (click)="keeperOpen.set(false)">Cancel</button>
          </div>
        </form>
      </th-sheet>
    }

    <th-share-results [open]="shareOpen()" (closed)="shareOpen.set(false)" [card]="shareCard()" />
  `
})
export class Matches {
  readonly event = input.required<TeamEvent>();
  readonly store = inject(TeamStore);
  readonly formats = FORMATS;
  readonly maxSlots = MAX_SLOTS;
  readonly rec = record;
  readonly diff = pointDiff;
  readonly busy = signal(false);
  readonly draft = signal<Draft | null>(null);
  readonly confirmClear = signal(false);
  readonly keeperOpen = signal(false);
  readonly keeperPick = signal('');
  readonly shareOpen = signal(false);

  readonly doc = computed(() => this.store.matches()[this.event().eid]);
  readonly days = computed(() => tournamentDays(this.event().date, this.event().endDate));
  readonly view = computed(() => tournamentView(this.doc(), this.days()));
  readonly staff = computed(() => !this.store.readOnly() && this.store.can('scores'));
  readonly canScore = computed(() => this.store.canScore(this.event().eid));
  readonly keeperBanner = computed(() => !this.staff() && this.canScore());
  readonly keeperName = computed(() => this.store.authorName(this.doc()?.scorekeeper));
  /** The first row without a result: "Enter next score". */
  readonly nextRow = computed(() => {
    for (const d of this.view().days) for (const r of d.rows) if (!r.match?.result) return { ...r, date: d.date };
    return null;
  });
  /** Parents on the team, for the scorekeeper list, with whether their family is going. */
  readonly parents = computed(() => this.store.members()
    .filter((m) => m.sub && m.status !== 'removed' && m.roles.includes('parent'))
    .map((m) => {
      const player = m.pid ? this.store.playerName(m.pid) : '';
      const travel = m.pid && this.event().travel ? this.store.travelOf(m.pid, this.event().eid) : null;
      return { sub: m.sub!, name: fullName(m) || m.person || m.email || 'A parent', family: player ? `${player}'s family` : 'Parent', going: this.event().travel ? (travel ? ' · going, per travel plans' : '') : '' };
    })
    .sort((a, b) => a.name.localeCompare(b.name)));

  day(d: string) { return fmt(d, { weekday: 'short', month: 'short', day: 'numeric' }); }
  formatLabel(f: number) { return FORMAT_LABELS[f as Format] ?? `${f} sets`; }
  won(m: Match) { const s = setsWon(m.sets); return `${s.won}–${s.lost}`; }

  // ----- entering a score -----
  readonly existing = computed(() => { const f = this.draft(); return !!f && !!this.doc()?.matches?.[f.id]; });
  readonly draftHeading = computed(() => { const f = this.draft(); return f ? `Match ${f.n} · ${fmt(f.date, { weekday: 'long' })}` : 'Match'; });

  open(date: string, n: number) {
    const id = `${date}-${n}`;
    const m = this.doc()?.matches?.[id];
    const format = (m?.format ?? this.lastFormat(date)) as Format;
    const sets = Array.from({ length: format }, (_, i) => ({ us: m?.sets[i] ? String(m.sets[i].us) : '', them: m?.sets[i] ? String(m.sets[i].them) : '' }));
    this.confirmClear.set(false);
    this.draft.set({ eid: this.event().eid, id, date, n, time: m?.time ?? '', court: m?.court ?? '', opponent: m?.opponent ?? '', format, sets, result: m?.result ?? '' });
  }
  /** New matches start with the format of the day's last entered one (pool play is often 2 sets). */
  private lastFormat(date: string): Format {
    const ms = Object.values(this.doc()?.matches ?? {}).filter((m) => m.date === date).sort((a, b) => b.n - a.n);
    return (ms[0]?.format ?? 3) as Format;
  }
  set<K extends 'time' | 'court' | 'opponent' | 'result'>(k: K, v: Draft[K]) { this.draft.update((f) => (f ? { ...f, [k]: v } : f)); }
  setFormat(format: Format) {
    this.draft.update((f) => f ? { ...f, format, sets: Array.from({ length: format }, (_, i) => f.sets[i] ?? { us: '', them: '' }) } : f);
  }
  setScore(i: number, side: 'us' | 'them', v: string) {
    const clean = v.replace(/\D/g, '').slice(0, 2);
    this.draft.update((f) => f ? { ...f, sets: f.sets.map((s, j) => (j === i ? { ...s, [side]: clean } : s)) } : f);
  }
  setWon(s: { us: string; them: string }): Result | '' {
    const us = Number(s.us || 0), them = Number(s.them || 0);
    return us > them ? 'W' : them > us ? 'L' : '';
  }
  private parsed = computed(() => {
    const f = this.draft();
    if (!f) return null;
    const sets = f.sets.map((s) => ({ us: Number(s.us || 0), them: Number(s.them || 0) }));
    while (sets.length && !sets.at(-1)!.us && !sets.at(-1)!.them) sets.pop();
    return { format: f.format, sets };
  });
  readonly suggested = computed(() => { const p = this.parsed(); return p ? suggestedResult(p) : ''; });
  /** What's shown picked: the one chosen, else what the sets say. */
  readonly outcome = computed(() => this.draft()?.result || this.suggested());
  readonly outcomeHint = computed(() => {
    const p = this.parsed();
    if (!p?.sets.length) return 'Enter the set scores, or just the outcome.';
    const s = setsWon(p.sets);
    if (this.suggested()) return `Filled in from the sets (${s.won}–${s.lost}). Change it if the score sheet says otherwise.`;
    return p.format === 2 && p.sets.length === 2 ? 'The sets are 1–1: pick Win or Loss.' : `Sets so far: ${s.won}–${s.lost}.`;
  });
  readonly problem = computed(() => {
    const p = this.parsed();
    if (!p) return '';
    return matchProblem({ ...p, result: this.outcome() });
  });

  async save() {
    const f = this.draft(), p = this.parsed();
    if (!f || !p || this.problem()) return;
    this.busy.set(true);
    const ok = await this.store.saveMatch(f.eid, f.id, { time: f.time.trim(), court: f.court.trim(), opponent: f.opponent.trim(), format: f.format, sets: p.sets, result: this.outcome() });
    this.busy.set(false);
    if (ok) this.draft.set(null);
  }
  async clear() {
    const f = this.draft();
    if (!f) return;
    if (!this.confirmClear()) { this.confirmClear.set(true); return; }
    if (await this.store.clearMatch(f.eid, f.id)) this.draft.set(null);
  }

  // ----- matches the team works (refs) -----
  readonly groupChoices: WorkGroup[] = ['A', 'B', 'all'];
  readonly canWork = computed(() => !this.store.readOnly() && (this.store.can('scores') || this.store.can('refjobs')));
  readonly works = computed(() => workList(this.doc()));
  readonly hasWork = computed(() => this.works().length > 0);
  readonly hasB = computed(() => this.store.players().some((p) => p.refTeam === 'B'));
  groupLabel(g: WorkGroup) { return WORK_GROUP_LABELS[g]; }
  autoGroup(except?: string) { return nextGroup(this.doc(), this.hasB(), except); }
  readonly upNext = computed(() => this.autoGroup());
  readonly tally = computed(() => (['A', 'B', 'all'] as WorkGroup[]).map((group) => ({ group, n: this.works().filter((w) => w.group === group).length })).filter((g) => g.n || g.group !== 'all'));
  tallyText() { return this.tally().map((g) => `${this.groupLabel(g.group)} has ${g.n} so far`).join(', '); }
  teamsOf(w: WorkMatch) { return w.teams.filter(Boolean).join(' v '); }
  jobSummary(w: WorkMatch) {
    const first = Object.entries(w.jobs ?? {}).map(([pid, j]) => (j.s1 && j.s1 !== 'Off' ? `${j.s1} ${this.store.playerName(pid)}` : '')).filter(Boolean);
    return first.length ? `Set 1: ${first.join(' · ')}` : '';
  }
  /** Teams already typed on this tournament (opponents and work matches), for the team pickers. */
  readonly knownTeams = computed(() => [...new Set([...Object.values(this.doc()?.matches ?? {}).map((m) => m.opponent ?? ''), ...this.works().flatMap((w) => w.teams)].map((t) => t.trim()).filter(Boolean))].sort());
  /** One day's rows, playing and working, in time order (rows without a time keep their place). */
  merged(date: string, rows: { n: number; id: string; match: Match | null }[]) {
    const key = (t: string | undefined, i: number) => minutesOfDay(t) ?? 10000 + i;
    const out = [
      ...rows.map((r, i) => ({ key: r.id, k: key(r.match?.time, i), row: r, work: null as WorkMatch | null })),
      ...this.works().filter((w) => w.date === date).map((w, i) => ({ key: w.id, k: key(w.time, i + 0.5), row: null, work: w }))
    ];
    return out.sort((a, b) => a.k - b.k);
  }
  playRows(date: string) { return this.view().days.find((d) => d.date === date)?.rows.length ?? 0; }

  readonly work = signal<{ id: string; kind: 'play' | 'work'; date: string; a: string; b: string; time: string; court: string; matchNo: string; group: WorkGroup | null } | null>(null);
  readonly workError = signal('');
  openAdd(date: string) { this.confirmClear.set(false); this.workError.set(''); this.work.set({ id: '', kind: 'work', date, a: '', b: '', time: '', court: '', matchNo: '', group: null }); }
  openWork(w: WorkMatch) {
    this.confirmClear.set(false); this.workError.set('');
    this.work.set({ id: w.id, kind: 'work', date: w.date, a: w.teams[0], b: w.teams[1], time: w.time ?? '', court: w.court ?? '', matchNo: w.matchNo ?? '', group: w.auto ? null : w.group });
  }
  setWork(k: string, v: string | null) { this.work.update((w) => (w ? { ...w, [k]: v } : w)); }
  async addPlay() {
    const w = this.work();
    if (!w) return;
    const n = this.playRows(w.date);
    this.busy.set(true);
    const ok = await this.store.setMatchSlots(this.event().eid, w.date, n + 1, '');
    this.busy.set(false);
    if (!ok) return;
    this.work.set(null);
    this.open(w.date, n + 1);
  }
  async saveWork() {
    const w = this.work();
    if (!w) return;
    if (!w.a.trim() && !w.b.trim()) { this.workError.set('Enter the teams playing (at least one).'); return; }
    if (w.time.trim() && minutesOfDay(w.time) === null) { this.workError.set('Use a time like 8:00 AM.'); return; }
    this.busy.set(true);
    const ok = await this.store.saveWork(this.event().eid, w.id || 'new', {
      date: w.date, teams: [w.a.trim(), w.b.trim()], time: w.time.trim() || undefined, court: w.court.trim() || undefined, matchNo: w.matchNo.trim() || undefined, group: w.group
    }, w.id ? 'Saved' : 'Match added. Ref jobs are filled in.');
    this.busy.set(false);
    if (ok) this.work.set(null);
  }
  async removeWork() {
    const w = this.work();
    if (!w?.id) return;
    if (!this.confirmClear()) { this.confirmClear.set(true); return; }
    if (await this.store.deleteWork(this.event().eid, w.id)) this.work.set(null);
  }

  // ----- rows -----
  addRow(date: string, rows: number) { void this.store.setMatchSlots(this.event().eid, date, rows + 1, 'Match added'); }
  removeRow(date: string, rows: number) { void this.store.setMatchSlots(this.event().eid, date, rows - 1, 'Match removed'); }

  // ----- scorekeeper -----
  openKeeper() { this.keeperPick.set(this.doc()?.scorekeeper ?? ''); this.keeperOpen.set(true); }
  async saveKeeper() {
    this.busy.set(true);
    const ok = await this.store.setScorekeeper(this.event().eid, this.keeperPick() || null);
    this.busy.set(false);
    if (ok) this.keeperOpen.set(false);
  }

  // ----- sharing -----
  readonly shareCard = computed<ShareCard>(() => {
    const e = this.event();
    const finished = this.view().days.flatMap((d) => d.rows.map((r) => r.match).filter((m): m is Match => !!m?.result));
    return tournamentShare({
      team: this.store.teamName(), club: this.store.club()?.name, title: e.title, when: fmtRange(e.date, e.endDate),
      totals: this.view().totals, matches: finished.map((m) => ({ opponent: m.opponent, sets: m.sets, result: m.result as Result })), colors: this.store.club()?.colors
    });
  });
}
