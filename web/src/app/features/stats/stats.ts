import { Component, ViewEncapsulation, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { pointDiff, record, seasonMatches, seasonStats, setText, tournamentDays, tournamentView, type Totals } from '@shared/matches';
import { addDays, fmt, fmtRange, today } from '../../core/dates';
import { TeamStore } from '../../core/team-store';
import { ShareResults, seasonShare } from './share-results';

type Range = 'season' | '30d';

/** /teams/:id/stats: the season's record from every match entered on the tournaments' Matches tabs. */
@Component({
  selector: 'th-stats',
  imports: [RouterLink, ShareResults],
  styleUrl: './matches.css',
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="sec-h">
      <div>
        <h2>Stats</h2>
        <p class="muted" style="margin-top:6px">Every match the coaches and scorekeepers entered this season.</p>
      </div>
      <span class="spacer"></span>
      <div class="chips" role="group" aria-label="Show">
        <button class="chip" type="button" [attr.aria-pressed]="range() === 'season'" (click)="range.set('season')">Whole season</button>
        <button class="chip" type="button" [attr.aria-pressed]="range() === '30d'" (click)="range.set('30d')">Last 30 days</button>
      </div>
      @if (stats().totals.played) { <button class="btn sm" type="button" (click)="shareOpen.set(true)">Share season</button> }
    </div>

    @if (!stats().totals.played) {
      <div class="empty">
        @if (range() === '30d' && anyAtAll()) { No matches in the last 30 days. }
        @else { No match results yet. Scores entered on a tournament's <b>Matches</b> tab show up here. }
        @if (nextTournament(); as t) { <div style="margin-top:8px"><a [routerLink]="['/teams', store.teamId(), 'tournaments', t.eid, 'matches']">Open {{ t.title }} matches</a></div> }
      </div>
    } @else {
      <section class="card" aria-labelledby="st-season">
        <div class="card-h"><h3 id="st-season">{{ range() === 'season' ? 'Season record' : 'Last 30 days' }}</h3><span class="muted small">{{ seasonLabel() }}</span></div>
        <div class="card-b">
          <div class="mt-tiles">
            <div class="mt-tile"><span class="label">Matches</span><span class="mt-big tn">{{ rec(stats().totals) }} <span>{{ pct(stats().totals.won, stats().totals.lost) }}</span></span></div>
            <div class="mt-tile"><span class="label">Sets</span><span class="mt-big tn">{{ stats().totals.setsWon }}–{{ stats().totals.setsLost }} <span>{{ pct(stats().totals.setsWon, stats().totals.setsLost) }}</span></span></div>
            <div class="mt-tile"><span class="label">Points</span><span class="mt-big tn">{{ diff(stats().totals) }} <span>{{ stats().totals.pointsFor }}–{{ stats().totals.pointsAgainst }}</span></span></div>
            <div class="mt-tile"><span class="label">Tournaments</span><span class="mt-big tn">{{ byTournament().length }}@if (inProgress()) { <span>{{ inProgress() }} in progress</span> }</span></div>
          </div>
          <div class="row" style="gap:10px">
            <span class="label">Last {{ stats().last.length }} · {{ lastRecord() }}</span>
            <div class="st-form" [attr.aria-label]="'Last ' + stats().last.length + ' matches, oldest first: ' + stats().last.join(' ')">
              @for (r of stats().last; track $index) { <span [class.w]="r === 'W'" [class.l]="r === 'L'" aria-hidden="true">{{ r }}</span> }
            </div>
            @if (stats().latest; as m) { <span class="muted small">Latest: {{ m.result }} {{ sets(m.sets) }}{{ m.opponent ? ' vs ' + m.opponent : '' }}, {{ day(m.date) }}</span> }
          </div>
        </div>
      </section>

      <section class="card" aria-labelledby="st-t">
        <div class="card-h"><h3 id="st-t">By tournament</h3></div>
        <div class="card-b">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Tournament</th><th>Dates</th><th>Matches</th><th>Win share</th><th>Sets</th><th>Points</th></tr></thead>
              <tbody>
                @for (t of byTournament(); track t.eid) {
                  <tr>
                    <td><a [routerLink]="['/teams', store.teamId(), 'tournaments', t.eid, 'matches']"><b>{{ t.title }}</b></a>@if (t.totals.toPlay && t.current) { <div class="small muted">In progress · {{ t.totals.toPlay }} to play</div> }</td>
                    <td class="tn">{{ t.when }}</td>
                    <td><span class="st-rec tn" [class.up]="t.totals.won > t.totals.lost" [class.even]="t.totals.won === t.totals.lost" [class.down]="t.totals.won < t.totals.lost">{{ rec(t.totals) }}</span></td>
                    <td><div class="st-bar" role="img" [attr.aria-label]="share(t.totals) + '% of matches won'"><i [style.width.%]="share(t.totals)"></i></div></td>
                    <td class="tn">{{ t.totals.setsWon }}–{{ t.totals.setsLost }}</td>
                    <td class="tn">{{ diff(t.totals) }}</td>
                  </tr>
                }
                <tr><td><b>{{ range() === 'season' ? 'Season' : 'Total' }}</b></td><td></td><td class="tn"><b>{{ rec(stats().totals) }}</b></td><td></td><td class="tn"><b>{{ stats().totals.setsWon }}–{{ stats().totals.setsLost }}</b></td><td class="tn"><b>{{ diff(stats().totals) }}</b></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <div class="st-grid">
        <section class="card" aria-labelledby="st-sets">
          <div class="card-h"><h3 id="st-sets">Sets</h3><span class="muted small">How the team does in each set of a match</span></div>
          <div class="card-b">
            <table>
              <thead><tr><th>Set</th><th>Won–lost</th><th><span class="sr-only">Share won</span></th></tr></thead>
              <tbody>
                @for (s of stats().bySet; track s.set) {
                  <tr><td><b>{{ s.set === 3 ? 'Set 3 (often deciding)' : 'Set ' + s.set }}</b></td><td class="tn">{{ s.won }}–{{ s.lost }}</td><td><div class="st-bar" role="img" [attr.aria-label]="pctNum(s.won, s.lost) + '% won'"><i [style.width.%]="pctNum(s.won, s.lost)"></i></div></td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
        <section class="card" aria-labelledby="st-opp">
          <div class="card-h"><h3 id="st-opp">Opponents met more than once</h3></div>
          <div class="card-b">
            @if (stats().opponents.length) {
              <table>
                <thead><tr><th>Opponent</th><th>Matches</th><th>Sets</th></tr></thead>
                <tbody>
                  @for (o of stats().opponents; track o.name) {
                    <tr><td><b>{{ o.name }}</b></td><td><span class="st-rec tn" [class.up]="o.won > o.lost" [class.even]="o.won === o.lost" [class.down]="o.won < o.lost">{{ o.won }}–{{ o.lost }}</span></td><td class="tn">{{ o.setsWon }}–{{ o.setsLost }}</td></tr>
                  }
                </tbody>
              </table>
            } @else { <p class="muted small" style="margin:0">No opponent played twice yet.</p> }
          </div>
        </section>
      </div>
    }

    <th-share-results [open]="shareOpen()" (closed)="shareOpen.set(false)" [card]="shareCard()" />
  `
})
export class Stats {
  readonly store = inject(TeamStore);
  readonly range = signal<Range>('season');
  readonly shareOpen = signal(false);
  readonly rec = record;
  readonly diff = pointDiff;
  readonly sets = setText;

  /** Finished matches in range, oldest first. */
  private readonly all = computed(() => seasonMatches(this.store.tournaments(), this.store.matches()));
  readonly anyAtAll = computed(() => this.all().length > 0);
  private readonly inRange = computed(() => { const from = addDays(today(), -30); return this.range() === 'season' ? this.all() : this.all().filter((m) => m.date >= from); });
  readonly stats = computed(() => seasonStats(this.inRange()));
  readonly lastRecord = computed(() => { const l = this.stats().last; return `${l.filter((r) => r === 'W').length}–${l.filter((r) => r === 'L').length}`; });

  /** Tournaments with at least one result in range, newest first. */
  readonly byTournament = computed(() => {
    const ids = new Set(this.inRange().map((m) => m.eid));
    const from = addDays(today(), -30);
    return this.store.tournaments().filter((e) => ids.has(e.eid)).map((e) => {
      const view = tournamentView(this.store.matches()[e.eid], tournamentDays(e.date, e.endDate));
      let totals: Totals = view.totals;
      if (this.range() === '30d') {
        const t = seasonStats(this.inRange().filter((m) => m.eid === e.eid && m.date >= from)).totals;
        totals = { ...t, toPlay: view.totals.toPlay };
      }
      return { eid: e.eid, title: e.title, when: fmtRange(e.date, e.endDate), totals, current: (e.endDate || e.date) >= today() };
    }).reverse();
  });
  readonly inProgress = computed(() => this.byTournament().filter((t) => t.current && t.totals.toPlay).length);
  readonly nextTournament = computed(() => this.store.tournaments().find((e) => (e.endDate || e.date) >= today()) ?? null);
  readonly seasonLabel = computed(() => { const s = this.store.settings()?.season; return s ? `${s} season` : ''; });

  pct(a: number, b: number) { return a + b ? `${Math.round((a / (a + b)) * 100)}%` : ''; }
  pctNum(a: number, b: number) { return a + b ? Math.round((a / (a + b)) * 100) : 0; }
  share(t: Totals) { return this.pctNum(t.won, t.lost); }
  day(d: string) { return fmt(d, { weekday: 'short', month: 'short', day: 'numeric' }); }

  readonly shareCard = computed(() => seasonShare({
    team: this.store.teamName(), club: this.store.club()?.name,
    label: this.range() === 'season' ? (this.store.settings()?.season ? `${this.store.settings()!.season} season` : 'This season') : 'Last 30 days',
    totals: this.stats().totals,
    tournaments: [...this.byTournament()].reverse().map((t) => ({ title: t.title, totals: t.totals })),
    colors: this.store.club()?.colors
  }));
}
