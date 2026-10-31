import { Component, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service';
import { niceMax } from './usage';
import type { HealthReport } from './usage-types';

type Period = HealthReport['period'];

/** Site admin › Health: is anything broken or slow? Green means nobody needs to look. */
@Component({
  selector: 'th-health',
  styleUrl: './usage.css',
  template: `
    <div class="sec-h">
      <div>
        <h3 class="us-title">Health</h3>
        <p class="muted small" style="margin:4px 0 0">Is anything broken or slow? Green means nobody needs to look.</p>
      </div>
      <span class="spacer"></span>
      <div class="chips" role="group" aria-label="Period">
        @for (p of periods; track p[0]) { <button class="chip" type="button" [attr.aria-pressed]="period() === p[0]" (click)="setPeriod(p[0])">{{ p[1] }}</button> }
      </div>
    </div>

    @if (error()) { <p class="hint warn" role="alert">{{ error() }}</p> }
    @if (data(); as d) {
      <div class="us-tiles" [class.us-loading]="loading()">
        <div class="card us-tile"><div class="us-lbl">Requests that failed</div>
          <div class="us-big tn" [class.ok-text]="d.requests.failedPct !== null && d.requests.failedPct < 1" [class.bad-text]="(d.requests.failedPct ?? 0) >= 1">{{ d.requests.failedPct === null ? '–' : d.requests.failedPct + '%' }}</div>
          <div class="small muted">goal under 1% · {{ d.requests.failed }} of {{ d.requests.total }}</div></div>
        <div class="card us-tile"><div class="us-lbl">Pages open in</div>
          <div class="us-big tn" [class.ok-text]="d.pages.phoneP95 !== null && d.pages.phoneP95 <= 2000" [class.warn-text]="(d.pages.phoneP95 ?? 0) > 2000">{{ secs(d.pages.phoneP95) }}</div>
          <div class="small muted">95% of pages on phones · {{ d.pages.loads }} opened</div></div>
        <div class="card us-tile"><div class="us-lbl">Emails delivered</div>
          <div class="us-big tn" [class.ok-text]="(d.mail.deliveredPct ?? 0) >= 97" [class.warn-text]="d.mail.deliveredPct !== null && d.mail.deliveredPct < 97">{{ d.mail.deliveredPct === null ? '–' : d.mail.deliveredPct + '%' }}</div>
          <div class="small muted">{{ d.mail.sent }} sent · {{ d.mail.bounced }} bounced, {{ d.mail.complained }} {{ d.mail.complained === 1 ? 'complaint' : 'complaints' }}</div></div>
        <div class="card us-tile"><div class="us-lbl">Calendar syncs</div>
          @if (d.feeds.failing.length) {
            <div class="us-big tn warn-text">{{ d.feeds.failing.length }} failing</div><div class="small muted">{{ feedNames() }}</div>
          } @else { <div class="us-big ok-text">All good</div><div class="small muted">no team's calendar link is failing</div> }</div>
        <div class="card us-tile"><div class="us-lbl">Open right now</div><div class="us-big tn">{{ d.liveNow }}</div><div class="small muted">team pages open, getting live updates</div></div>
      </div>

      <section class="card" aria-labelledby="hl-req">
        <div class="card-h"><h3 id="hl-req">Requests {{ d.period === '30d' ? 'per day' : 'per hour' }}</h3><span class="small muted">red bars are requests that failed</span></div>
        <div class="card-b">
          <svg class="us-chart" viewBox="0 0 1000 220" role="img" [attr.aria-label]="chartLabel()" preserveAspectRatio="none" style="height:220px">
            @for (g of chart().grid; track g.v) {
              <line class="grid" x1="44" x2="1000" [attr.y1]="g.y" [attr.y2]="g.y" vector-effect="non-scaling-stroke" />
            }
            @for (t of chart().ticks; track t.x) { <line class="grid" [attr.x1]="t.x" [attr.x2]="t.x" y1="10" y2="190" vector-effect="non-scaling-stroke" /> }
            <path class="area" [attr.d]="chart().area" />
            <path class="line" [attr.d]="chart().line" vector-effect="non-scaling-stroke" />
            @for (e of chart().errs; track e.x) { <rect class="err" [attr.x]="e.x - 2" [attr.y]="e.y" width="4" [attr.height]="e.h" /> }
          </svg>
          <div class="hl-axis small muted">
            <span>{{ chart().grid.at(-1)?.v }} {{ d.period === '30d' ? 'a day' : 'an hour' }}</span>
            @for (t of chart().ticks; track t.x) { <span [style.left.%]="t.x / 10">{{ t.label }}</span> }
          </div>
        </div>
      </section>

      <div class="us-grid">
        <section class="card" aria-labelledby="hl-err">
          <div class="card-h"><h3 id="hl-err">Errors by page</h3></div>
          <div class="card-b">
            @if (d.errors.length) {
              <table class="us-table" style="min-width:0">
                <thead><tr><th scope="col">Where</th><th scope="col" class="num">Errors</th><th scope="col">Last</th></tr></thead>
                <tbody>
                  @for (e of d.errors; track e.where + e.area) {
                    <tr><td><b>{{ e.area }}</b><div class="small muted">{{ e.where === 'server' ? 'On our servers' : "In people's browsers" }}</div></td><td class="num tn">{{ e.n }}</td><td class="small muted">{{ when(e.lastAt) }}</td></tr>
                  }
                </tbody>
              </table>
            } @else { <p class="ok-text" style="margin:0"><b>No errors.</b> <span class="muted small">Nothing failed on our servers or in people's browsers.</span></p> }
          </div>
        </section>
        <section class="card" aria-labelledby="hl-slow">
          <div class="card-h"><h3 id="hl-slow">Slowest pages</h3><span class="small muted">95% open within</span></div>
          <div class="card-b">
            @for (s of d.slowest; track s.area) {
              <div class="us-row"><span>{{ s.label }}</span><span class="us-bar"><i [style.width.%]="slowPct(s.p95)" [class.low]="s.p95 > 2000"></i></span><span class="tn us-num">{{ secs(s.p95) }}</span></div>
            } @empty { <p class="muted small">Not enough pages opened yet.</p> }
            <p class="small muted" style="margin:8px 0 0">Goal: every page open within 2 seconds on a phone.</p>
          </div>
        </section>
      </div>

      <section class="card" aria-labelledby="hl-rel">
        <div class="card-h"><h3 id="hl-rel">Recent releases</h3><span class="small muted">first opened, and requests that failed in the hour after</span></div>
        <div class="card-b">
          @if (d.releases.length) {
            <div class="table-wrap">
              <table class="us-table">
                <thead><tr><th scope="col">First opened</th><th scope="col">Release</th><th scope="col" class="num">Failed in the hour after</th></tr></thead>
                <tbody>
                  @for (r of d.releases; track r.commit) {
                    <tr><td>{{ when(r.at) }}</td><td class="tn">{{ r.commit.slice(0, 7) }}</td><td class="num">@if (r.errorsAfter) { <span class="pill p-bad">{{ r.errorsAfter }}</span> } @else { <span class="tn">0</span> }</td></tr>
                  }
                </tbody>
              </table>
            </div>
          } @else { <p class="muted small" style="margin:0">Releases show here once people open them.</p> }
        </div>
      </section>
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    }`
})
export class Health {
  private readonly api = inject(ApiService);
  readonly periods: [Period, string][] = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];
  readonly period = signal<Period>('7d');
  readonly data = signal<HealthReport | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');

  constructor() { void this.load(); }

  setPeriod(p: Period) { if (p !== this.period()) { this.period.set(p); void this.load(); } }

  async load() {
    this.loading.set(true);
    try {
      this.data.set(await this.api.call<HealthReport>('GET', `/admin/health?period=${this.period()}`));
      this.error.set('');
    } catch (e) { this.error.set((e as Error).message || "Health didn't load."); }
    finally { this.loading.set(false); }
  }

  readonly feedNames = computed(() => (this.data()?.feeds.failing ?? []).map((f) => f.name).join(', ') + ': the calendar link stopped working');

  readonly chart = computed(() => {
    const pts = this.data()?.points ?? [];
    const max = niceMax(Math.max(0, ...pts.map((p) => p.n)));
    const left = 44, right = 1000, top = 10, bottom = 190;
    const x = (i: number) => left + (pts.length > 1 ? (i / (pts.length - 1)) * (right - left) : 0);
    const y = (v: number) => bottom - (v / max) * (bottom - top);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.n).toFixed(1)}`).join(' ');
    const area = pts.length ? `${line} L${x(pts.length - 1).toFixed(1)},${bottom} L${left},${bottom} Z` : '';
    const errs = pts.map((p, i) => ({ x: x(i), y: y(Math.max(p.err, max / 40)), h: bottom - y(Math.max(p.err, max / 40)), err: p.err })).filter((e) => e.err > 0);
    // A label at each midnight (each Monday for 30 days).
    const daily = this.data()?.period === '30d';
    const ticks = pts.map((p, i) => ({ p, i })).filter(({ p, i }) => daily ? new Date(`${p.at}T12:00:00Z`).getUTCDay() === 1 : p.at.endsWith('T00') && i > 0)
      .map(({ p, i }) => ({ x: x(i), label: new Date(`${p.at.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', daily ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { weekday: 'short', timeZone: 'UTC' }) }));
    return { line, area, errs, ticks, grid: [0, max / 2, max].map((v) => ({ v: Math.round(v), y: y(v) })) };
  });
  readonly chartLabel = computed(() => {
    const d = this.data();
    if (!d) return 'Requests';
    const peak = [...d.points].sort((a, b) => b.n - a.n)[0];
    return `${d.requests.total} requests, ${d.requests.failed} failed.${peak?.n ? ` Busiest: ${peak.n} at ${peak.at.replace('T', ' ')}:00.` : ''}`;
  });

  secs(ms: number | null) { return ms === null ? '–' : ms >= 10000 ? 'over 10 s' : `${+(ms / 1000).toFixed(2)} s`; }
  slowPct(ms: number) { return Math.min(100, Math.round((ms / 5000) * 100)); }
  when(iso: string) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
}
