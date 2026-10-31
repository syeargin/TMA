import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { fmt } from '../../core/dates';
import type { TeamStatus, UsageReport } from './usage-types';

type Period = UsageReport['period'];
const STATUS: Record<TeamStatus, { label: string; cls: string }> = {
  notStarted: { label: 'Not started', cls: 'p-bad' }, quiet: { label: 'Quiet', cls: 'p-warn' },
  steady: { label: 'Steady', cls: 'p-info' }, busy: { label: 'Busy', cls: 'p-ok' }
};
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SLOTS = ['12–3a', '3–6a', '6–9a', '9–12', '12–3p', '3–6p', '6–9p', '9p–12'];

/** Rounds a chart's top up to a tidy number, so the gridlines land on round values. */
export function niceMax(v: number): number {
  if (v <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
  return 10 * step;
}

/** Site admin › Usage: are teams using Teem Hub, and which parts earn their keep. */
@Component({
  selector: 'th-usage',
  imports: [RouterLink],
  styleUrl: './usage.css',
  template: `
    <div class="sec-h">
      <div>
        <h3 class="us-title">Usage</h3>
        <p class="muted small" style="margin:4px 0 0">Are teams using Teem Hub, and which parts earn their keep? Counts only: never who looked at what.</p>
      </div>
      <span class="spacer"></span>
      @if ((data()?.clubs?.length ?? 0) > 1) {
        <label class="sr-only" for="us-club">Club</label>
        <select id="us-club" class="us-select" [value]="club()" (change)="setClub($any($event.target).value)">
          <option value="all">All clubs ({{ data()!.clubs.length }})</option>
          @for (c of data()!.clubs; track c.clubId) { <option [value]="c.clubId">{{ c.name }}</option> }
        </select>
      }
      <div class="chips" role="group" aria-label="Period">
        @for (p of periods; track p[0]) { <button class="chip" type="button" [attr.aria-pressed]="period() === p[0]" (click)="setPeriod(p[0])">{{ p[1] }}</button> }
      </div>
    </div>

    @if (error()) { <p class="hint warn" role="alert">{{ error() }}</p> }
    @if (data(); as d) {
      <div class="us-tiles" [class.us-loading]="loading()">
        <div class="card us-tile"><div class="us-lbl">Active last 7 days</div><div class="us-big tn">{{ d.tiles.active7 }}</div><div class="small muted">of {{ d.tiles.members }} members · {{ d.tiles.active7Family }} family, {{ d.tiles.active7Staff }} staff</div></div>
        <div class="card us-tile"><div class="us-lbl">Teams in use</div><div class="us-big tn">{{ d.tiles.teamsInUse }} <span>of {{ d.tiles.teams }}</span></div><div class="small muted">someone opened it in the last 7 days</div></div>
        <div class="card us-tile"><div class="us-lbl">Families joined</div><div class="us-big tn">{{ pctText(d.tiles.joined, d.tiles.roster) }}</div><div class="small muted">{{ d.tiles.joined }} of {{ d.tiles.roster }} players</div></div>
        <div class="card us-tile"><div class="us-lbl">Practices answered</div><div class="us-big tn">{{ d.tiles.answeredPct === null ? '–' : d.tiles.answeredPct + '%' }}</div><div class="small muted">answers for practices in the last 30 days</div></div>
        <div class="card us-tile"><div class="us-lbl">Needs a look</div><div class="us-big tn" [class.warn-text]="d.tiles.needsLook > 0">{{ d.tiles.needsLook }}</div><div class="small muted">teams not started or gone quiet</div></div>
      </div>

      <div class="us-grid">
        <section class="card" aria-labelledby="us-week">
          <div class="card-h"><h3 id="us-week">People active each week</h3><span class="small muted">opened their team at least once</span>
            <span class="spacer"></span><span class="us-key small"><i class="k-fam"></i>Family <i class="k-staff"></i>Staff</span></div>
          <div class="card-b">
            <svg class="us-chart" viewBox="0 0 640 230" role="img" [attr.aria-label]="weeklyLabel()">
              @for (g of weekly().grid; track g.v) {
                <line class="grid" x1="36" x2="636" [attr.y1]="g.y" [attr.y2]="g.y" />
                <text class="axis" x="30" [attr.y]="g.y + 4" text-anchor="end">{{ g.v }}</text>
              }
              @for (b of weekly().bars; track b.week) {
                <rect class="fam" [attr.x]="b.x" [attr.y]="b.yf" [attr.width]="b.w" [attr.height]="b.hf" />
                <rect class="staff" [attr.x]="b.x" [attr.y]="b.ys" [attr.width]="b.w" [attr.height]="b.hs" />
                @if (b.last && b.total) { <text class="val" [attr.x]="b.x + b.w / 2" [attr.y]="b.ys - 6" text-anchor="middle">{{ b.total }}</text> }
                @if (b.label) { <text class="axis" [attr.x]="b.x + b.w / 2" y="222" text-anchor="middle">{{ b.label }}</text> }
              }
            </svg>
            <p class="small muted" style="margin:6px 0 0">Weeks start on Sunday. Someone on two teams counts on each.</p>
          </div>
        </section>
        <section class="card" aria-labelledby="us-when">
          <div class="card-h"><h3 id="us-when">When people use it</h3><span class="small muted">pages opened, Eastern time</span></div>
          <div class="card-b">
            <div class="us-heat" role="img" [attr.aria-label]="heatLabel()">
              <span></span>@for (s of slots; track s) { <span class="small muted us-hc">{{ s }}</span> }
              @for (row of heat(); track row.day) {
                <span class="small" style="font-weight:600">{{ row.day }}</span>
                @for (c of row.cells; track $index) { <i class="lv{{ c.lv }}" [attr.title]="row.day + ' ' + slots[$index] + ': ' + c.n"></i> }
              }
            </div>
            <div class="us-key small muted" style="margin-top:10px">Fewer <i class="lv1"></i><i class="lv3"></i><i class="lv5"></i> More</div>
            @if (quietest(); as q) { <p class="small" style="margin:8px 0 0"><b>Quietest:</b> {{ q }}. A good time to release changes.</p> }
          </div>
        </section>
      </div>

      <div class="us-grid">
        <section class="card" aria-labelledby="us-fun">
          <div class="card-h"><h3 id="us-fun">Getting families on</h3><span class="small muted">players on every team, today</span></div>
          <div class="card-b">
            @for (s of funnel(); track s.label) {
              <div class="us-fun">
                <div><b>{{ s.label }}</b><div class="small muted">{{ s.sub }}</div></div>
                <div class="us-fbar"><i [style.width.%]="s.pct"></i></div>
                <div class="tn" style="text-align:right"><b>{{ s.n }}</b> <span class="small muted">{{ s.pct }}%</span></div>
              </div>
            }
            @if (d.waitingInvites.n) {
              <p class="us-note small"><b>{{ d.waitingInvites.n }} {{ d.waitingInvites.n === 1 ? 'invite' : 'invites' }} waiting over a week</b>@if (d.waitingInvites.worst; as w) {, {{ w.n }} on {{ w.name }}}. A team admin can send them again from Members.</p>
            }
          </div>
        </section>
        <section class="card" aria-labelledby="us-arr">
          <div class="card-h"><h3 id="us-arr">How people get here</h3><span class="small muted">visits, {{ periodText() }}</span></div>
          <div class="card-b">
            @for (s of sources(); track s.id) {
              <div class="us-row"><span>{{ s.label }}</span><span class="us-bar"><i [style.width.%]="s.pct"></i></span><span class="tn us-num">{{ s.pct }}%</span></div>
            } @empty { <p class="muted small">No visits counted yet.</p> }
            @if (devices(); as dv) {
              <div class="us-lbl" style="margin-top:14px">Device</div>
              <div class="us-dev" role="img" [attr.aria-label]="dv.label">
                @for (x of dv.parts; track x.id) { @if (x.pct) { <span [class]="'d-' + x.id" [style.width.%]="x.pct">{{ x.pct >= 12 ? x.name + ' ' + x.pct + '%' : '' }}</span> } }
              </div>
              <p class="small muted" style="margin:6px 0 0">{{ dv.label }}</p>
            }
          </div>
        </section>
      </div>

      <section class="card" aria-labelledby="us-teams">
        <div class="card-h"><h3 id="us-teams">Teams</h3><span class="small muted">needs a look first, then busiest</span></div>
        <div class="card-b">
          <div class="table-wrap">
            <table class="us-table">
              <thead><tr><th scope="col">Team</th><th scope="col">Families joined</th><th scope="col" class="num">Active 7 days</th><th scope="col" class="num">Practices answered</th><th scope="col" class="num">Pages opened</th><th scope="col">Last opened</th><th scope="col">Status</th></tr></thead>
              <tbody>
                @for (t of d.teams; track t.teamId) {
                  <tr>
                    <th scope="row"><a [routerLink]="['/teams', t.teamId]">{{ t.name }}</a>@if (d.clubs.length > 1 && club() === 'all') { <span class="small muted"> · {{ t.clubName }}</span> }@if (t.why) { <div class="small muted" style="font-weight:400">{{ t.why }}</div> }</th>
                    <td><span class="us-mini"><i [style.width.%]="pct(t.joined, t.roster)" [class.low]="pct(t.joined, t.roster) < 80"></i></span> <span class="tn">{{ t.joined }} of {{ t.roster }}</span></td>
                    <td class="num tn">{{ t.active7 }} <span class="small muted">of {{ t.members }}</span></td>
                    <td class="num tn">{{ t.answeredPct === null ? '–' : t.answeredPct + '%' }}</td>
                    <td class="num tn">{{ t.opens }}</td>
                    <td class="small muted">{{ ago(t.lastSeen) }}</td>
                    <td><span class="pill {{ status(t.status).cls }}">{{ status(t.status).label }}</span></td>
                  </tr>
                } @empty { <tr><td colspan="7" class="muted">No active teams.</td></tr> }
              </tbody>
            </table>
          </div>
          <p class="small muted" style="margin:6px 0 0"><span class="pill p-ok">Busy</span> 3 in 4 members opened it this week · <span class="pill p-warn">Quiet</span> under half in 14 days · <span class="pill p-bad">Not started</span> under half the families joined. Pages opened: {{ periodText() }}.</p>
        </div>
      </section>

      <div class="us-grid">
        <section class="card" aria-labelledby="us-feat">
          <div class="card-h"><h3 id="us-feat">Features in use</h3><span class="small muted">teams that opened it, of teams that have it on · {{ periodText() }}</span></div>
          <div class="card-b">
            @for (f of features(); track f.label) {
              <div class="us-row us-row4"><b>{{ f.label }}</b><span class="us-bar"><i [style.width.%]="f.pct" [class.low]="f.pct < 50"></i></span><span class="tn us-num">{{ f.teams }} of {{ f.of }}</span><span class="small muted tn">{{ f.opens }} {{ f.opens === 1 ? 'open' : 'opens' }}</span></div>
            }
            <p class="small muted" style="margin:8px 0 0">Amber: fewer than half the teams that have it opened it.</p>
          </div>
        </section>
        <section class="card" aria-labelledby="us-act">
          <div class="card-h"><h3 id="us-act">What people did</h3><span class="small muted">{{ periodText() }}, against the {{ prevText() }}</span></div>
          <div class="card-b">
            <table class="us-table" style="min-width:0">
              <thead><tr><th scope="col">Action</th><th scope="col" class="num">Count</th><th scope="col" class="num">Change</th></tr></thead>
              <tbody>
                @for (a of d.actions; track a.id) {
                  <tr><td>{{ a.label }}</td><td class="num tn"><b>{{ a.n }}</b></td><td class="num tn"><span [class]="change(a.n, a.prev).cls">{{ change(a.n, a.prev).text }}</span></td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section class="card us-about" aria-labelledby="us-about">
        <div class="card-h"><h3 id="us-about">About these numbers</h3></div>
        <div class="card-b us-about-b">
          <p><b>Counted on our own servers.</b> No Google Analytics or other trackers, and no cookies for counting. Families' information never leaves Teem Hub.</p>
          <p><b>Totals, not trails.</b> Each page adds 1 to a daily count by club, team and page. Nobody can see which pages a person opened. To count people, we keep the last day each member opened each team.</p>
          <p><b>Kept 13 months.</b> Enough to compare this season with last; older counts are deleted. Only site owners see this page.</p>
        </div>
      </section>
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    }`
})
export class Usage {
  private readonly api = inject(ApiService);
  readonly periods: [Period, string][] = [['7d', '7 days'], ['30d', '30 days'], ['season', 'Season']];
  readonly slots = SLOTS;
  readonly period = signal<Period>('30d');
  readonly club = signal('all');
  readonly data = signal<UsageReport | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');

  constructor() { void this.load(); }

  setPeriod(p: Period) { if (p !== this.period()) { this.period.set(p); void this.load(); } }
  setClub(c: string) { this.club.set(c); void this.load(); }

  async load() {
    this.loading.set(true);
    try {
      this.data.set(await this.api.call<UsageReport>('GET', `/admin/usage?period=${this.period()}&club=${encodeURIComponent(this.club())}`));
      this.error.set('');
    } catch (e) { this.error.set((e as Error).message || "Usage didn't load."); }
    finally { this.loading.set(false); }
  }

  readonly periodText = computed(() => ({ '7d': 'last 7 days', '30d': 'last 30 days', season: 'this season' })[this.period()]);
  readonly prevText = computed(() => ({ '7d': '7 days before', '30d': '30 days before', season: 'same time last season' })[this.period()]);

  readonly weekly = computed(() => {
    const w = this.data()?.weekly ?? [];
    const max = niceMax(Math.max(0, ...w.map((x) => x.family + x.staff)));
    const top = 14, bottom = 196, h = bottom - top, left = 40, width = 596;
    const bw = width / Math.max(w.length, 1);
    const y = (v: number) => bottom - (v / max) * h;
    const bars = w.map((x, i) => {
      const hf = (x.family / max) * h, hs = (x.staff / max) * h;
      return {
        week: x.week, x: left + i * bw + bw * 0.18, w: bw * 0.64, yf: bottom - hf, hf, ys: bottom - hf - hs, hs, total: x.family + x.staff,
        last: i === w.length - 1, label: i % 2 === 0 || i === w.length - 1 ? fmt(x.week, { month: 'short', day: 'numeric' }) : ''
      };
    });
    return { bars, grid: [0, max / 4, max / 2, (3 * max) / 4, max].map((v) => ({ v: Math.round(v), y: y(v) })) };
  });
  readonly weeklyLabel = computed(() => {
    const w = this.data()?.weekly ?? [];
    if (!w.length) return 'People active each week';
    const a = w[0], b = w[w.length - 1];
    return `People active each week, last ${w.length} weeks: from ${a.family + a.staff} to ${b.family + b.staff} this week (${b.family} family, ${b.staff} staff).`;
  });

  readonly heat = computed(() => {
    const h = this.data()?.heat ?? [];
    const max = Math.max(0, ...h.flat());
    return h.map((row, i) => ({ day: DAYS[i], cells: row.map((n) => ({ n, lv: !n || !max ? 0 : Math.max(1, Math.ceil((n / max) * 5)) })) }));
  });
  readonly heatLabel = computed(() => {
    const cells = this.heat().flatMap((r) => r.cells.map((c, j) => ({ day: r.day, slot: SLOTS[j], n: c.n }))).sort((a, b) => b.n - a.n);
    return cells[0]?.n ? `Busiest: ${cells.slice(0, 3).map((c) => `${c.day} ${c.slot}`).join(', ')}.` : 'No pages counted yet.';
  });
  /** The quietest daytime stretch on weekdays (6 AM to 9 PM), to suggest when to release. */
  readonly quietest = computed(() => {
    const h = this.data()?.heat ?? [];
    if (!h.flat().some(Boolean)) return '';
    let best = { slot: 3, n: Infinity };
    for (let s = 2; s <= 6; s++) { const n = h.slice(0, 5).reduce((a, row) => a + row[s], 0); if (n < best.n) best = { slot: s, n }; }
    return `weekdays ${SLOTS[best.slot]}`;
  });

  readonly funnel = computed(() => {
    const f = this.data()?.funnel;
    if (!f) return [];
    const p = (n: number) => (f.roster ? Math.round((n / f.roster) * 100) : 0);
    return [
      { label: 'Players', sub: 'on every roster', n: f.roster },
      { label: 'Invited', sub: 'a family invite sent or accepted', n: f.invited },
      { label: 'Joined', sub: 'a parent signed in', n: f.joined },
      { label: 'Answered once', sub: 'In, Maybe or Out at least once', n: f.answeredOnce },
      { label: 'Active 30 days', sub: 'a parent opened the team', n: f.active30 }
    ].map((s) => ({ ...s, pct: p(s.n) }));
  });

  readonly sources = computed(() => {
    const s = this.data()?.sources ?? [];
    const total = s.reduce((a, x) => a + x.n, 0);
    return total ? s.map((x) => ({ ...x, pct: Math.round((x.n / total) * 100) })).sort((a, b) => b.n - a.n) : [];
  });
  readonly devices = computed(() => {
    const d = this.data()?.devices ?? [];
    const total = d.reduce((a, x) => a + x.n, 0);
    if (!total) return null;
    const names = { phone: 'Phone', tablet: 'Tablet', computer: 'Computer' };
    const parts = d.map((x) => ({ id: x.id, name: names[x.id], pct: Math.round((x.n / total) * 100) }));
    return { parts, label: parts.map((x) => `${x.name}s ${x.pct}%`).join(', ') };
  });
  readonly features = computed(() => (this.data()?.features ?? []).map((f) => ({ ...f, pct: f.of ? Math.round((f.teams / f.of) * 100) : 0 })));

  pct(a: number, b: number) { return b ? Math.round((a / b) * 100) : 0; }
  pctText(a: number, b: number) { return b ? `${Math.round((a / b) * 100)}%` : '–'; }
  status(s: TeamStatus) { return STATUS[s]; }
  change(n: number, prev: number): { text: string; cls: string } {
    if (!prev) return n ? { text: 'new', cls: 'pill p-info' } : { text: '–', cls: 'muted' };
    const c = Math.round(((n - prev) / prev) * 100);
    return { text: `${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c)}%`, cls: c > 0 ? 'up' : c < 0 ? 'down' : 'muted' };
  }
  ago(day: string) {
    const today = this.data()?.today ?? '';
    if (!day) return 'Never';
    const d = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 864e5);
    return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : `${d} days ago`;
  }
}
