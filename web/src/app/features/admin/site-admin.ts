import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { CLUB_FEATURE_KEYS, CLUB_FEATURES, clubAllows, type ClubFeature } from '@shared/features';
import { ApiService } from '../../core/api.service';
import { HeaderService } from '../../core/header.service';
import type { AdminClub, ClubHistory } from '../../core/models';
import { HelpStats } from './help-stats';
import { Health } from './health';
import { Usage } from './usage';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';

type Draft = { status: 'active' | 'inactive'; reason: string; limited: boolean; limit: number; features: Record<ClubFeature, boolean> };

type Section = 'clubs' | 'usage' | 'health' | 'help';
const SECTIONS: Section[] = ['clubs', 'usage', 'health', 'help'];

/**
 * /admin[/usage|/health|/help] — the site admin dashboard (site owners).
 * Clubs: every club with its status, teams used of its limit and its features, and a panel to change
 * them (each change goes in the club's history). Usage and Health: site usage counts. Help: help guide counts.
 */
@Component({
  selector: 'th-site-admin',
  imports: [DatePipe, Messages, RouterLink, RouterLinkActive, HelpStats, Usage, Health],
  template: `
  <nav class="tabs admin-tabs" aria-label="Site admin sections">
    <div class="tabs-in">
      <a class="tab" routerLink="/teams" title="All your teams">‹ Teams</a>
      <a class="tab" routerLink="/admin" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page">Clubs</a>
      <a class="tab" routerLink="/admin/usage" routerLinkActive="active" ariaCurrentWhenActive="page">Usage</a>
      <a class="tab" routerLink="/admin/health" routerLinkActive="active" ariaCurrentWhenActive="page">Health</a>
      <a class="tab" routerLink="/admin/help" routerLinkActive="active" ariaCurrentWhenActive="page">Help</a>
    </div>
  </nav>
  <main>
    @switch (current()) {
      @case ('usage') { <th-usage /> }
      @case ('health') { <th-health /> }
      @case ('help') { <th-help-stats /> }
      @default {
    <div class="sec-h">
      <div>
        <h2>Clubs</h2>
        <p class="muted" style="margin-top:6px">Which clubs are active, how many teams each may have, and the features each club can use.</p>
      </div>
    </div>
    <th-messages [error]="error()" [notice]="notice()" />

    @if (clubs(); as list) {
      <div class="health-tiles">
        <div class="card health-tile"><div class="small muted">Active clubs</div><div class="health-big">{{ activeCount() }} <span>of {{ list.length }}</span></div></div>
        <div class="card health-tile"><div class="small muted">Active teams</div><div class="health-big">{{ teamCount() }}</div><div class="small muted">archived teams don't count</div></div>
        <div class="card health-tile"><div class="small muted">At their team limit</div><div class="health-big">{{ fullCount() }}</div><div class="small muted">{{ fullCount() === 1 ? 'club' : 'clubs' }}</div></div>
      </div>

      <section class="card" style="margin-top:14px">
        <div class="card-h"><h3>Clubs</h3></div>
        <div class="card-b">
          <div class="table-wrap">
            <table class="imp-table admin-table">
              <thead><tr><th scope="col">Club</th><th scope="col">Status</th><th scope="col">Active teams</th><th scope="col">Features off</th><th scope="col"><span class="sr-only">Manage</span></th></tr></thead>
              <tbody>
                @for (c of list; track c.clubId) {
                  <tr [class.dim]="c.status === 'inactive'">
                    <th scope="row"><span class="swatch" aria-hidden="true" [style.background]="c.colors?.primary" [style.border-color]="c.colors?.accent"></span><a [routerLink]="['/clubs', c.clubId]">{{ c.name }}</a><div class="small muted">{{ c.clubId }} · {{ c.admins }} {{ c.admins === 1 ? 'admin' : 'admins' }}</div></th>
                    <td>@if (c.status === 'active') { <span class="pill p-ok">Active</span> } @else { <span class="pill p-bad">Inactive</span><div class="small muted">since {{ c.statusAt | date: 'MMM d' }}</div> }</td>
                    <td>
                      <b>{{ c.activeTeams }}</b>@if (c.teamLimit !== null) { <span class="muted"> of {{ c.teamLimit }}</span> } @else { <span class="muted small"> · no limit</span> }
                      @if (c.teamLimit !== null) { <div class="limit-bar" [class.full]="c.activeTeams >= c.teamLimit" aria-hidden="true"><span [style.width.%]="pct(c)"></span></div> }
                      @if (c.archivedTeams) { <div class="small muted">{{ c.archivedTeams }} archived</div> }
                    </td>
                    <td>@for (f of offOf(c); track f) { <span class="pill p-mute" style="margin:0 4px 4px 0">{{ label(f) }}</span> } @empty { <span class="muted small">Everything on</span> }</td>
                    <td><button class="link-btn small" type="button" (click)="open(c)" [attr.aria-expanded]="openId() === c.clubId">{{ openId() === c.clubId ? 'Close' : 'Manage' }}</button></td>
                  </tr>
                  @if (openId() === c.clubId) { @if (draft(); as d) {
                    <tr class="admin-panel-row"><td colspan="5">
                      <div class="admin-panel">
                        <fieldset class="comms-set">
                          <legend>Status</legend>
                          <label class="check-row"><input type="radio" name="status" [checked]="d.status === 'active'" (change)="set({ status: 'active' })"> Active</label>
                          <label class="check-row"><input type="radio" name="status" [checked]="d.status === 'inactive'" (change)="set({ status: 'inactive' })"> Inactive: every team is read-only (site owners can still make changes) and no team emails or texts go out</label>
                          @if (d.status === 'inactive' && c.status === 'active') {
                            <label for="why">Why (kept in the club's history)<input id="why" [value]="d.reason" (input)="set({ reason: $any($event.target).value })" maxlength="300" placeholder="Season over; club didn't renew"></label>
                          }
                          @if (c.status === 'inactive' && c.statusReason) { <p class="small muted">Made inactive: {{ c.statusReason }}</p> }
                        </fieldset>
                        <fieldset class="comms-set">
                          <legend>Team limit</legend>
                          <label class="check-row"><input type="checkbox" [checked]="!d.limited" (change)="set({ limited: !$any($event.target).checked })"> No limit</label>
                          @if (d.limited) {
                            <label for="lim">Most active teams at once<input id="lim" type="number" min="0" max="1000" [value]="d.limit" (change)="set({ limit: toInt($any($event.target).value) })" style="max-width:120px"></label>
                            @if (d.limit < c.activeTeams) { <p class="small comms-warn">{{ c.activeTeams }} teams are active now. None are archived for you; the club just can't add or restore teams until it's under {{ d.limit }}.</p> }
                          }
                        </fieldset>
                        <fieldset class="comms-set">
                          <legend>Features</legend>
                          @for (f of keys; track f) {
                            <label class="check-row"><input type="checkbox" [checked]="d.features[f]" (change)="setFeature(f, $any($event.target).checked)"> <span><b>{{ label(f) }}</b><span class="small muted"> · {{ help(f) }}</span></span></label>
                          }
                          <p class="small muted">Off here hides it from every team in the club, whatever the team chose. Nothing is deleted.</p>
                        </fieldset>
                        <div class="row-actions">
                          <button class="btn primary sm" type="button" (click)="save(c)" [disabled]="busy() || !dirty(c)">{{ busy() ? 'Saving…' : 'Save changes' }}</button>
                          <button class="btn sm" type="button" (click)="openId.set('')">Cancel</button>
                        </div>
                        <h4 class="sub-h" style="margin-top:14px">History</h4>
                        @for (h of history(); track h.at) {
                          <div class="small admin-history"><b>{{ h.at | date: 'MMM d, y, h:mm a' }}</b> · {{ h.by }}: {{ h.changes.join('; ') }}@if (h.reason) { <span class="muted"> ({{ h.reason }})</span> }</div>
                        } @empty { <p class="small muted">No changes yet. Every club starts active, with every feature and no team limit.</p> }
                      </div>
                    </td></tr>
                  } }
                }
              </tbody>
            </table>
          </div>
        </div>
      </section>
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    }
      }
    }
  </main>`
})
export class SiteAdmin extends Page {
  private readonly api = inject(ApiService);
  private readonly header = inject(HeaderService);
  readonly clubs = signal<AdminClub[] | null>(null);
  readonly openId = signal('');
  readonly draft = signal<Draft | null>(null);
  readonly history = signal<ClubHistory[]>([]);
  readonly keys = CLUB_FEATURE_KEYS;
  /** The :section route param (none = Clubs). */
  readonly section = input<string>('');
  readonly current = computed<Section>(() => SECTIONS.find((s) => s === this.section()) ?? 'clubs');

  readonly activeCount = computed(() => (this.clubs() ?? []).filter((c) => c.status === 'active').length);
  readonly teamCount = computed(() => (this.clubs() ?? []).reduce((n, c) => n + c.activeTeams, 0));
  readonly fullCount = computed(() => (this.clubs() ?? []).filter((c) => c.teamLimit !== null && c.activeTeams >= c.teamLimit).length);

  constructor() {
    super();
    this.header.title.set('Site admin');
    this.header.sub.set('Teem Hub');
    inject(DestroyRef).onDestroy(() => this.header.reset());
    // The clubs list loads the first time Clubs is shown.
    effect(() => { if (this.current() === 'clubs' && !untracked(this.clubs)) untracked(() => void this.load()); });
  }

  async load() {
    try { this.clubs.set((await this.api.call<{ clubs: AdminClub[] }>('GET', '/admin/clubs')).clubs); }
    catch (e) { this.error.set((e as Error).message); }
  }

  label(f: ClubFeature) { return CLUB_FEATURES[f].label; }
  help(f: ClubFeature) { return CLUB_FEATURES[f].help; }
  offOf(c: AdminClub) { return CLUB_FEATURE_KEYS.filter((f) => !clubAllows(c.features, f)); }
  pct(c: AdminClub) { return c.teamLimit ? Math.min(100, Math.round((100 * c.activeTeams) / c.teamLimit)) : 100; }
  toInt(v: string) { return Math.max(0, Math.min(1000, Math.round(Number(v) || 0))); }

  async open(c: AdminClub) {
    if (this.openId() === c.clubId) { this.openId.set(''); return; }
    this.openId.set(c.clubId);
    this.draft.set({
      status: c.status, reason: '', limited: c.teamLimit !== null, limit: c.teamLimit ?? Math.max(c.activeTeams, 1),
      features: Object.fromEntries(CLUB_FEATURE_KEYS.map((f) => [f, clubAllows(c.features, f)])) as Record<ClubFeature, boolean>
    });
    this.history.set([]);
    try { this.history.set((await this.api.call<{ history: ClubHistory[] }>('GET', `/admin/clubs/${encodeURIComponent(c.clubId)}/history`)).history); }
    catch { /* the panel still works without it */ }
  }

  set(p: Partial<Draft>) { this.draft.update((d) => (d ? { ...d, ...p } : d)); }
  setFeature(f: ClubFeature, on: boolean) { this.draft.update((d) => (d ? { ...d, features: { ...d.features, [f]: on } } : d)); }

  /** Only what changed from the club as saved. */
  private changes(c: AdminClub): Record<string, unknown> {
    const d = this.draft();
    if (!d) return {};
    const out: Record<string, unknown> = {};
    if (d.status !== c.status) { out['status'] = d.status; if (d.reason.trim()) out['reason'] = d.reason.trim(); }
    const limit = d.limited ? d.limit : null;
    if (limit !== c.teamLimit) out['teamLimit'] = limit;
    const features = Object.fromEntries(CLUB_FEATURE_KEYS.filter((f) => d.features[f] !== clubAllows(c.features, f)).map((f) => [f, d.features[f]]));
    if (Object.keys(features).length) out['features'] = features;
    return out;
  }
  dirty(c: AdminClub) { return Object.keys(this.changes(c)).length > 0; }

  save(c: AdminClub) {
    const body = this.changes(c);
    if (body['status'] === 'inactive' && !body['reason']) { this.error.set('Say why the club is being made inactive. It goes in the club’s history.'); return; }
    return this.run(async () => {
      const updated = await this.api.call<AdminClub & { changed: boolean }>('PUT', `/admin/clubs/${encodeURIComponent(c.clubId)}`, body);
      this.clubs.update((list) => (list ?? []).map((x) => (x.clubId === c.clubId ? { ...x, ...updated } : x)));
      this.openId.set('');
      this.notice.set(`Saved ${c.name}.`);
    });
  }
}
