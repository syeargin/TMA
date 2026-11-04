import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { explain } from '../../core/errors';
import { FeedbackService, type FeedbackStatus, type InboxItem, type InboxStats, type OwnerSettings } from '../../core/feedback';

type Filter = FeedbackStatus | 'all';
const FILTERS: [Filter, string][] = [['new', 'New'], ['waiting', 'Answered'], ['planned', 'Planned'], ['closed', 'Closed'], ['all', 'All']];
const KIND: Record<string, [string, string]> = { question: ['Question', 'q'], problem: ['Problem', 'p'], idea: ['Idea', 'i'], team: ['Team question', 't'] };
const ROLE: Record<string, string> = { club: 'Club director or admin', team: 'Team coordinator or coach', parent: 'Parent' };
const TEAMS: Record<string, string> = { '1': '1 team', '2-9': '2–9 teams', '10-39': '10–39 teams', '40+': '40+ teams' };

/** Site admin › Feedback: questions, problems and ideas, with replies by email. */
@Component({
  selector: 'th-feedback-inbox',
  imports: [RouterLink],
  template: `
    <div class="sec-h">
      <div>
        <h2>Feedback</h2>
        <p class="muted" style="margin-top:6px">Questions, problem reports and ideas people send from the site. Replies go by email.</p>
      </div>
    </div>
    @if (error()) { <p class="msg error" role="alert">{{ error() }}</p> }
    @if (settings(); as s) {
      <div class="fb-set card">
        <label class="switch-row"><input type="checkbox" [checked]="s.teamQuestions" (change)="save({ teamQuestions: !s.teamQuestions, emailNew: s.emailNew })" />
          <span><b>Also get team questions</b><span class="small muted">Questions families send to their team's coordinators. The coordinators answer; you get a copy here and by email.</span></span></label>
        <label class="switch-row"><input type="checkbox" [checked]="s.emailNew" (change)="save({ teamQuestions: s.teamQuestions, emailNew: !s.emailNew })" />
          <span><b>Email me new items</b><span class="small muted">One email for each new question, problem or idea.</span></span></label>
      </div>
    }
    @if (stats(); as st) {
      <div class="health-tiles">
        <div class="card health-tile"><div class="small muted">New</div><div class="health-big">{{ st.new }}</div><div class="small muted">{{ st.oldestNewAt ? 'oldest ' + ago(st.oldestNewAt) : 'all caught up' }}</div></div>
        <div class="card health-tile"><div class="small muted">Problems this week</div><div class="health-big">{{ st.problemsWeek }}</div><div class="small muted">{{ st.sameError ? st.sameError + ' from the same error' : 'no repeats' }}</div></div>
        <div class="card health-tile"><div class="small muted">Ideas</div><div class="health-big">{{ st.ideas.open }}</div><div class="small muted">{{ st.ideas.planned }} planned · {{ st.ideas.closed }} closed</div></div>
        <div class="card health-tile"><div class="small muted">Replied within a day</div><div class="health-big">{{ st.repliedInADay === null ? '–' : st.repliedInADay + '%' }}</div><div class="small muted">last 30 days</div></div>
      </div>
    }
    @if (items(); as all) {
      <div class="fb-inbox">
        <section class="card fb-list" aria-label="Feedback">
          <div class="fb-filters">
            <div class="chips" role="group" aria-label="Status">
              @for (f of filters; track f[0]) {
                <button class="chip" type="button" [attr.aria-pressed]="filter() === f[0]" (click)="filter.set(f[0])">{{ f[1] }}@if (f[0] !== 'all') { ({{ count(f[0]) }})}</button>
              }
              <button class="chip fb-inq" type="button" [attr.aria-pressed]="kind() === 'inquiry'" (click)="kind.set(kind() === 'inquiry' ? '' : 'inquiry'); filter.set('all')">Inquiries ({{ inquiries() }})</button>
            </div>
            <label class="sr-only" for="fb-kind">Type</label>
            <select id="fb-kind" class="fb-kindsel" [value]="kind()" (change)="kind.set($any($event.target).value)">
              <option value="">All types</option><option value="question">Questions</option><option value="problem">Problems</option><option value="idea">Ideas</option><option value="team">Team questions</option><option value="inquiry">Inquiries</option>
            </select>
          </div>
          @for (f of shown(); track f.id) {
            <button type="button" class="fb-row" [class.sel]="f.id === openId()" (click)="select(f.id)">
              <span class="pill fb-k" [class]="'pill fb-k ' + k(f)[1]">{{ k(f)[0] }}</span>
              @if (f.inquiry; as q) {
                <span class="grow"><b>{{ q.org }}@if (q.teams) { · {{ teams[q.teams] }}}@if (q.role === 'parent') { (from a parent)}</b><span class="small muted">{{ f.name }} · {{ role[q.role] }}@if (q.sport) { · {{ q.sport }}}@if (q.coordinatorEmail) { · coordinator: {{ q.coordinatorEmail }}} · {{ f.ref }}</span></span>
              } @else {
              <span class="grow"><b>{{ first(f.message) }}</b><span class="small muted">{{ f.name }}@if (f.teamName) { · {{ f.teamName }}}@if (f.roles?.length) { · {{ f.roles!.join(', ') }}}@if (f.device) { · {{ f.device.split(' · ')[0] }}} · {{ f.ref }}</span></span>
              }
              <span class="small muted fb-when">{{ ago(f.createdAt) }}<br><span [class.fb-new]="f.status === 'new'">{{ statusLabel(f) }}</span></span>
            </button>
          } @empty {
            <p class="muted small" style="padding:14px 16px">Nothing here.</p>
          }
        </section>

        @if (current(); as f) {
          <section class="card fb-detail" aria-label="Selected item">
            <div class="row" style="gap:8px"><span class="pill fb-k" [class]="'pill fb-k ' + k(f)[1]">{{ k(f)[0] }}</span><span class="small muted">{{ f.ref }} · {{ ago(f.createdAt) }}</span>
              @if (f.similar.length) { <span class="spacer"></span><span class="small">Similar: @for (s of f.similar; track s; let last = $last) { <button class="link" type="button" (click)="select(s)">{{ refOf(s) }}</button>@if (!last) {, } }</span> }
            </div>
            @if (f.message) { <p class="fb-said">{{ f.message }}</p> }
            @if (f.hasShot) {
              @if (shot(); as src) { <a [href]="src" target="_blank" rel="noopener" class="fb-shotlink"><img [src]="src" alt="Screenshot sent with this report" /></a> }
              @else if (shotGone()) { <p class="small muted">The screenshot has been deleted (they're kept 60 days).</p> }
              @else { <button class="btn sm ghost" type="button" (click)="loadShot(f.id)">Show screenshot</button> }
            }
            <dl class="fb-kv">
              <dt>From</dt><dd>{{ f.name }} · <a [href]="'mailto:' + f.email">{{ f.email }}</a></dd>
              @if (f.inquiry; as q) {
                <dt>Who</dt><dd>{{ role[q.role] }}</dd>
                <dt>{{ q.role === 'parent' ? 'Team' : 'Club or team' }}</dt><dd>{{ q.org }}</dd>
                @if (q.sport) { <dt>Sport</dt><dd>{{ q.sport }}</dd> }
                @if (q.teams) { <dt>Teams</dt><dd>{{ teams[q.teams] }}</dd> }
                @if (q.coordinatorEmail) { <dt>Coordinator</dt><dd><a [href]="'mailto:' + q.coordinatorEmail">{{ q.coordinatorEmail }}</a></dd> }
                <dt>Came from</dt><dd>Front page · “Talk to us”@if (q.source) { in the {{ q.source }}}</dd>
              }
              @if (f.page) { <dt>Page</dt><dd>@if (f.page.path.startsWith('/')) { <a [routerLink]="f.page.path">{{ f.page.title }}</a> } @else { {{ f.page.title }} }</dd> }
              @if (f.error) { <dt>Error</dt><dd>“{{ f.error.message }}” ({{ f.error.code }}) at {{ time(f.error.at) }} · <a routerLink="/admin/health">Health</a></dd> }
              @if (f.teamName) { <dt>Team</dt><dd><a [routerLink]="['/teams', f.teamId]">{{ f.teamName }}</a>@if (f.roles?.length) { · {{ f.roles!.join(', ') }}}</dd> }
              @if (f.route === 'team') { <dt>Sent to</dt><dd>{{ f.sentTo.join(', ') || 'the team' }} (they answer it)</dd> }
              @if (f.device || f.version) { <dt>Device</dt><dd>{{ f.device }}@if (f.version) { · {{ f.version }}}</dd> }
            </dl>
            @for (r of f.replies; track r.at) {
              <div class="fb-reply"><span class="small muted">{{ r.byName }} replied · {{ ago(r.at) }}</span><p>{{ r.message }}</p></div>
            }
            <label for="fb-reply" class="fb-label">Reply by email to {{ f.email }}</label>
            <textarea id="fb-reply" rows="4" [value]="reply()" (input)="reply.set($any($event.target).value)" [placeholder]="'Hi ' + (f.name.includes('@') ? 'there' : f.name.split(' ')[0]) + ', …'"></textarea>
            <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
              <button class="btn sm primary" type="button" [disabled]="busy() || reply().trim().length < 2" (click)="send(f)">{{ busy() ? 'Sending…' : 'Send reply' }}</button>
              @if (f.status !== 'planned') { <button class="btn sm ghost" type="button" [disabled]="busy()" (click)="setStatus(f, 'planned')">Mark planned</button> }
              @if (f.status !== 'closed') { <button class="btn sm ghost" type="button" [disabled]="busy()" (click)="setStatus(f, 'closed')">Close</button> }
              @else { <button class="btn sm ghost" type="button" [disabled]="busy()" (click)="setStatus(f, 'new')">Reopen</button> }
              <span class="spacer"></span>
              <button class="btn sm ghost" type="button" (click)="copy(f)">{{ copied() ? 'Copied' : 'Copy for GitHub issue' }}</button>
            </div>
            @if (done()) { <p class="msg notice" role="status">{{ done() }}</p> }
          </section>
        } @else if (all.length) {
          <section class="card fb-detail"><p class="muted">Choose an item to read it and reply.</p></section>
        }
      </div>
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    }`
})
export class FeedbackInbox {
  private readonly svc = inject(FeedbackService);
  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap.pipe(map((q) => q.get('item') ?? '')), { initialValue: '' });
  readonly filters = FILTERS;
  readonly role = ROLE;
  readonly teams = TEAMS;
  readonly inquiries = computed(() => (this.items() ?? []).filter((f) => f.kind === 'inquiry' && f.status !== 'closed').length);
  readonly items = signal<InboxItem[] | null>(null);
  readonly stats = signal<InboxStats | null>(null);
  readonly settings = signal<OwnerSettings | null>(null);
  readonly error = signal('');
  readonly filter = signal<Filter>('new');
  readonly kind = signal('');
  readonly openId = signal('');
  readonly reply = signal('');
  readonly busy = signal(false);
  readonly done = signal('');
  readonly copied = signal(false);
  readonly shot = signal('');
  readonly shotGone = signal(false);

  readonly shown = computed(() => (this.items() ?? []).filter((f) =>
    (this.filter() === 'all' || f.status === this.filter()) &&
    (!this.kind() || (this.kind() === 'team' ? f.route === 'team' : f.route !== 'team' && f.kind === this.kind()))));
  readonly current = computed(() => (this.items() ?? []).find((f) => f.id === this.openId()) ?? null);

  constructor() {
    void this.load();
    // From the email's "Open and reply": that item, whatever its status.
    effect(() => { const id = this.query(); if (id) untracked(() => { this.filter.set('all'); this.select(id); }); });
  }

  async load() {
    try {
      const r = await this.svc.inbox();
      this.items.set(r.items); this.stats.set(r.stats); this.settings.set(r.settings);
    } catch (e) { this.error.set(explain(e)); }
  }

  k(f: InboxItem): [string, string] {
    if (f.kind === 'inquiry') return [f.inquiry?.role === 'club' ? 'Club inquiry' : 'Team inquiry', 'x'];
    return KIND[f.route === 'team' ? 'team' : f.kind];
  }
  count(s: FeedbackStatus) { return (this.items() ?? []).filter((f) => f.status === s).length; }
  statusLabel(f: InboxItem) { return f.route === 'team' && f.status === 'waiting' ? 'With the team' : FILTERS.find((x) => x[0] === f.status)?.[1] ?? f.status; }
  refOf(id: string) { return this.items()?.find((f) => f.id === id)?.ref ?? id; }
  first(s: string) { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 80 ? t.slice(0, 78) + '…' : t; }
  time(iso: string) { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  ago(iso: string) {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : m < 48 * 60 ? 'yesterday' : `${Math.round(m / 1440)} days ago`;
  }

  select(id: string) {
    this.openId.set(id); this.reply.set(''); this.done.set(''); this.copied.set(false); this.shot.set(''); this.shotGone.set(false);
  }

  async loadShot(id: string) {
    try { this.shot.set(await this.svc.screenshot(id)); } catch { this.shotGone.set(true); }
  }

  private patch(id: string, p: Partial<InboxItem>) {
    this.items.update((list) => (list ?? []).map((f) => (f.id === id ? { ...f, ...p } : f)));
  }

  async send(f: InboxItem) {
    this.busy.set(true); this.error.set('');
    try {
      const r = await this.svc.reply(f.id, this.reply().trim());
      this.patch(f.id, { replies: r.replies, status: r.status });
      this.reply.set('');
      this.done.set(`Reply sent to ${f.email}.`);
    } catch (e) { this.error.set(explain(e)); } finally { this.busy.set(false); }
  }

  async setStatus(f: InboxItem, status: FeedbackStatus) {
    this.busy.set(true); this.error.set('');
    try { await this.svc.setStatus(f.id, status); this.patch(f.id, { status }); this.done.set(status === 'closed' ? 'Closed.' : status === 'planned' ? 'Marked planned.' : 'Reopened.'); }
    catch (e) { this.error.set(explain(e)); } finally { this.busy.set(false); }
  }

  async save(s: OwnerSettings) {
    this.error.set('');
    try { this.settings.set(await this.svc.saveSettings(s)); await this.load(); } catch (e) { this.error.set(explain(e)); }
  }

  /** The report as text for a GitHub issue: no email address or name. */
  async copy(f: InboxItem) {
    const lines = [
      `**${this.k(f)[0]} ${f.ref}**`, '', f.message, '',
      f.page ? `- Page: ${f.page.title} (\`${f.page.path}\`)` : '',
      f.error ? `- Error: "${f.error.message}" (\`${f.error.code}\`) at ${f.error.at}` : '',
      f.roles?.length ? `- Role: ${f.roles.join(', ')}` : '',
      f.device ? `- Device: ${f.device}${f.version ? ` · ${f.version}` : ''}` : '',
      f.similar.length ? `- Similar reports: ${f.similar.map((s) => this.refOf(s)).join(', ')}` : ''
    ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''));
    try { await navigator.clipboard.writeText(lines.join('\n').trim()); this.copied.set(true); } catch { this.error.set("Couldn't copy. Try again."); }
  }
}
