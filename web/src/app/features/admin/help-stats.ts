import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { HELP_ROLE_LABELS, HELP_TOPICS, type HelpRole } from '@shared/help';
import { ApiService } from '../../core/api.service';
import type { AdminHelp } from '../../core/models';

const VIA_LABELS: Record<string, string> = { browse: 'Browsing', search: 'Search', popular: 'Most used', context: 'Help on a page', related: 'Related', link: 'A link' };

/** Site admin: which help topics people open (counts only), and how often searches find nothing. */
@Component({
  selector: 'th-help-stats',
  imports: [DatePipe, RouterLink],
  template: `
    <section class="card" style="margin-top:14px">
      <div class="card-h"><h3>Help guide</h3><span class="muted small">Counts only, since {{ data()?.since | date: 'MMM d' }}</span><span class="spacer"></span><a class="link small" routerLink="/help">Open the guide</a></div>
      <div class="card-b">
        @if (data(); as d) {
          <div class="health-tiles" style="margin-top:0">
            <div class="card health-tile"><div class="small muted">Topics opened</div><div class="health-big">{{ total() }}</div></div>
            <div class="card health-tile"><div class="small muted">Searches</div><div class="health-big">{{ d.searches }}</div></div>
            <div class="card health-tile"><div class="small muted">Found nothing</div><div class="health-big">{{ d.misses }}</div><div class="small muted">{{ missRate() }}</div></div>
          </div>
          <p class="small muted">Most used shows {{ fromCounts() }}. A role switches from the starting picks to its counts after {{ d.minViews }} views.</p>
          <div class="table-wrap">
            <table class="health-table">
              <thead><tr><th>Topic</th><th>For</th><th class="tn">Views</th><th class="tn">This month</th><th class="tn">Parents</th><th class="tn">Staff</th><th class="tn">Admins</th><th class="tn">Signed out or several</th></tr></thead>
              <tbody>
                @for (t of d.topics; track t.id) {
                  <tr>
                    <td><a [routerLink]="['/help', t.id]">{{ t.title }}</a></td>
                    <td class="small">{{ roleLabel(t.role) }}</td>
                    <td class="tn"><b>{{ t.views }}</b></td><td class="tn">{{ t.thisMonth }}</td>
                    <td class="tn">{{ t.byRole['parent'] }}</td><td class="tn">{{ t.byRole['staff'] }}</td><td class="tn">{{ t.byRole['admin'] }}</td><td class="tn">{{ t.byRole['none'] }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="small muted">How topics were opened: {{ vias() }}</p>
        } @else if (error()) {
          <p class="muted">{{ error() }}</p>
        } @else {
          <p class="muted">Loading…</p>
        }
      </div>
    </section>`
})
export class HelpStats {
  private readonly api = inject(ApiService);
  readonly data = signal<AdminHelp | null>(null);
  readonly error = signal('');
  readonly roleLabel = (r: string) => HELP_ROLE_LABELS[r as HelpRole] ?? r;
  readonly total = computed(() => (this.data()?.topics ?? []).reduce((n, t) => n + t.views, 0));
  readonly missRate = computed(() => { const d = this.data(); return d?.searches ? `${Math.round((d.misses / d.searches) * 100)}% of searches` : ''; });
  readonly vias = computed(() => Object.entries(this.data()?.via ?? {}).filter(([, n]) => n).map(([v, n]) => `${VIA_LABELS[v] ?? v} ${n}`).join(' · ') || 'nothing yet');
  readonly fromCounts = computed(() => {
    const p = this.data()?.popular ?? {};
    const on = (['parent', 'staff', 'admin'] as HelpRole[]).filter((r) => p[r]?.from === 'counts').map((r) => HELP_ROLE_LABELS[r].toLowerCase());
    return on.length ? `counts for ${on.join(', ')}, and the starting picks for the rest` : `the starting picks for every role (${HELP_TOPICS.length} topics)`;
  });

  constructor() {
    this.api.call<AdminHelp>('GET', '/admin/help').then((d) => this.data.set(d)).catch((e) => this.error.set(e?.message ?? "Help counts didn't load."));
  }
}
