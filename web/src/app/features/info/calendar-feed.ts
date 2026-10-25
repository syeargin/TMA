import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  applyRules, clock, describeFilter, describeRule, OVERRIDE_LABELS, type Overridable, type ReviewItem, FEED_KIND_LABELS, FEED_KINDS,
  type FeedFilter, type FeedKind, type FeedRules, type TypeRule
} from '@shared/feed-rules';
import { ApiService } from '../../core/api.service';
import { fmt, fmtRange, today } from '../../core/dates';
import type { FeedCheck, FeedRun, FeedView } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { ToastService } from '../../core/toast.service';
import { explain } from '../../core/errors';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';

type NewRule = { when: TypeRule['when']; text: string; hours: number; kind: FeedKind };

export { clock };

/**
 * Calendar feed sync (Team info, admins and coordinators): paste the team's calendar link once,
 * check what's in it, choose which events are the team's and how they come in, and save. The link is
 * stored encrypted and only ever shown masked. Importing into the schedule is the next stage.
 */
@Component({
  selector: 'th-calendar-feed',
  imports: [FormsModule, Sheet, Messages],
  template: `
    <th-sheet heading="Calendar feed" [open]="open()" (closed)="closed.emit()">
      <div class="feed-panel">
      <p class="muted small" style="margin-top:0">Bring the team's schedule in from your club's scheduling system. Teem Hub keeps it up to date every 30 minutes, and everything your team adds (availability, attendance, tournament details, notes) stays here.</p>
      <th-messages [error]="error()" />

      @if (loading()) { <p class="muted">Loading…</p> }
      @else {
        @if (view()?.connected && !changingLink()) {
          <section class="feed-box">
            <div class="row"><b>{{ view()!.source!.presetLabel || 'Calendar' }}</b><span class="pill p-ok">Link saved</span><span class="spacer"></span>
              <button class="link-btn small" type="button" (click)="changeLink()">Change link</button></div>
            <div class="small muted feed-mask">{{ view()!.source!.masked }}</div>
            <div class="small muted">Rules version {{ view()!.version }}@if (view()!.source!.lastCheck; as lc) { · last checked {{ fmt(lc.at.slice(0, 10)) }}: {{ lc.matched }} of {{ lc.total }} events are the team's }</div>
            @if (view()!.source!.importedAt) {
              @if (view()!.source!.lastSync; as ls) {
                <div class="feed-status">
                  @if (view()!.source!.attention) { <span class="pill p-warn">Needs attention · syncing paused</span> }
                  @else if (view()!.source!.pausedSince) { <span class="pill p-warn">{{ store.has('calfeed') ? 'Catch up first' : 'Paused' }}</span> }
                  @else if (ls.ok) { <span class="pill p-ok">Healthy</span> } @else { <span class="pill p-bad">Last sync failed</span> }
                  <span class="small">Synced {{ ago(ls.at) }} · it syncs on its own every 30 minutes</span>
                </div>
                @if (!ls.ok && !view()!.source!.attention) { <p class="small feed-warn">{{ ls.error }} Nothing on the schedule changed.@if (view()!.source!.failures > 1) { It has failed {{ view()!.source!.failures }} times in a row. }</p> }
              }
              <div class="form-actions" style="margin-top:10px">
                <button class="btn sm" type="button" [disabled]="busy() || syncWait()" (click)="syncNow()">{{ syncing() ? 'Syncing…' : 'Sync now' }}</button>
                @if (syncWait()) { <span class="small muted">Sync now works again {{ syncWait() }}.</span> }
                @if (!check()) { <button class="link-btn small" type="button" [disabled]="busy()" (click)="runCheck()">Check feed and edit rules</button> }
              </div>
            } @else {
              <p class="small" style="margin:8px 0 0">Link and rules saved. Nothing is on the schedule yet.</p>
              @if (!check()) {
                <fieldset class="group feed-import">
                  <legend>Put it on the schedule</legend>
                  <label class="check"><input type="radio" name="from" [checked]="importAll() === false" (change)="importAll.set(false)"><span><b>From today</b><span class="small muted">Past dates in the calendar are left out.</span></span></label>
                  <label class="check"><input type="radio" name="from" [checked]="importAll()" (change)="importAll.set(true)"><span><b>The whole season</b><span class="small muted">Past practices show up under attendance as not taken.</span></span></label>
                  @if (handPractices() > 0) {
                    <label class="check"><input type="checkbox" name="replace" [checked]="replace()" (change)="replace.set($any($event.target).checked)">
                      <span><b>Replace the practices entered by hand</b><span class="small muted">{{ handPractices() }} practice dates from {{ replaceFrom() === todayIso ? 'today' : fmt(replaceFrom()) }} on. Families' answers and attendance move to the club calendar's practice on the same day.</span></span></label>
                    @if (replace()) { <label class="feed-date">From<input type="date" name="replaceFrom" [ngModel]="replaceFrom()" (ngModelChange)="replaceFrom.set($event || todayIso)" [min]="todayIso"></label> }
                    @if (!replace()) { <p class="small feed-warn">Keeping both shows those practices twice.</p> }
                  }
                  <div class="form-actions">
                    <button class="btn primary" type="button" [disabled]="busy()" (click)="runImport()">{{ importing() ? 'Importing…' : 'Import onto the schedule' }}</button>
                    <button class="link-btn small" type="button" [disabled]="busy()" (click)="runCheck()">Check feed and edit rules first</button>
                  </div>
                  <p class="small muted" style="margin:0">Families aren't notified about the import. After that, Teem Hub syncs every 30 minutes.</p>
                </fieldset>
              }
            }
          </section>
          @if (view()!.source!.attention; as at) {
            @if (!check()) {
              <section class="feed-box feed-attn">
                <b>The rules matched {{ at.now }} events, down from {{ at.was }}.</b>
                <p class="small" style="margin:4px 0 8px">The club may have renamed the team or moved to another system. Syncing is paused, nothing on the schedule changed, and families weren't told anything.</p>
                <div class="form-actions">
                  <button class="btn sm primary" type="button" [disabled]="busy()" (click)="runCheck()">Check feed and fix the rules</button>
                  <button class="btn sm" type="button" [disabled]="busy()" (click)="acceptDrop()">That's right, sync it</button>
                </div>
              </section>
            }
          }
          @if (view()!.source!.pausedSince && store.has('calfeed') && !check()) {
            <section class="feed-box feed-attn">
              <b>Catch up with {{ feedLabel() }}</b>
              <p class="small" style="margin:4px 0 8px">Syncing was off since {{ fmt(view()!.source!.pausedSince!.slice(0, 10)) }}. Look over what changed in the club's calendar before it starts again. Changes you made while it was off to times, places and courts stay as overrides.</p>
              @if (view()!.source!.catchUp; as cu) {
                @for (c of cu.changes; track c.eid) { <div class="li small"><span class="pill p-warn">Changed</span><div class="grow">{{ fmt(c.date) }} · {{ c.title }}: {{ c.text }}</div></div> }
                @for (a of cu.added.slice(0, 8); track $index) { <div class="li small"><span class="pill p-ok">New</span><div class="grow">{{ fmt(a.date) }} · {{ a.title }}</div></div> }
                @if (cu.addedCount > 8) { <div class="small muted">and {{ cu.addedCount - 8 }} more new events</div> }
                @if (cu.missing) { <div class="li small"><span class="pill p-bad">Not in feed</span><div class="grow">{{ cu.missing }} events aren't in the calendar now: they go to review, nothing is removed.</div></div> }
                @if (!cu.changes.length && !cu.addedCount && !cu.missing) { <p class="small muted">Nothing changed while it was off.</p> }
                <div class="form-actions">
                  <button class="btn sm primary" type="button" [disabled]="busy()" (click)="applyCatchUp()">{{ cu.changes.length + cu.addedCount ? 'Apply ' + (cu.changes.length + cu.addedCount) + ' changes and resume' : 'Resume syncing' }}</button>
                  <button class="btn sm" type="button" [disabled]="busy()" (click)="keepOff()">Keep it off</button>
                </div>
              } @else {
                <div class="form-actions"><button class="btn sm primary" type="button" [disabled]="busy()" (click)="previewCatchUp()">{{ busy() ? 'Checking…' : 'See what changed' }}</button></div>
              }
            </section>
          }
          @if (view()!.review?.length && !check()) {
            <fieldset class="group feed-review">
              <legend>Needs your review <span class="pill p-warn">{{ view()!.review!.length }}</span></legend>
              @for (r of view()!.review!; track r.kind + r.eid + ($any(r).field ?? '')) {
                <div class="li small feed-run">
                  @switch (r.kind) {
                    @case ('missing') {
                      <span class="pill p-bad">Not in feed</span>
                      <div class="grow"><b>{{ fmt(r.date) }} · {{ r.title }}@if (r.time) { · {{ r.time }} }</b>
                        <div class="muted">Gone from {{ feedLabel() }}'s calendar for {{ r.syncs }} syncs. Usually it means it was cancelled.</div>
                        <div class="form-actions"><button class="btn sm primary" type="button" [disabled]="busy()" (click)="settle(r, 'cancel')">Cancel it</button><button class="link-btn small" type="button" [disabled]="busy()" (click)="settle(r, 'keep')">Keep it</button></div></div>
                    }
                    @case ('duplicate') {
                      <span class="pill p-warn">Looks the same</span>
                      <div class="grow"><b>{{ fmt(r.date) }} · {{ r.title }}@if (r.time) { · {{ r.time }} }</b>
                        <div class="muted">A new entry in the calendar matches one that disappeared. Merge them to keep the answers and notes on the old one.</div>
                        <div class="form-actions"><button class="btn sm primary" type="button" [disabled]="busy()" (click)="settle(r, 'merge')">Merge</button><button class="link-btn small" type="button" [disabled]="busy()" (click)="settle(r, 'different')">They're different</button></div></div>
                    }
                    @case ('conflict') {
                      <span class="pill p-mute">Override</span>
                      <div class="grow"><b>{{ fmt(r.date) }} · {{ r.title }}</b>
                        <div class="muted">{{ feedLabel() }} now has {{ $any(r).feed || 'no ' + fieldLabel($any(r).field) }} for the {{ fieldLabel($any(r).field) }}; the team's override says {{ $any(r).mine || 'nothing' }}.</div>
                        <div class="form-actions"><button class="btn sm" type="button" [disabled]="busy()" (click)="settle(r, 'useFeed')">Use {{ $any(r).feed || "the calendar's" }}</button><button class="link-btn small" type="button" [disabled]="busy()" (click)="settle(r, 'keepMine')">Keep {{ $any(r).mine || 'the override' }}</button></div></div>
                    }
                  }
                </div>
              }
            </fieldset>
          }
          @if (view()!.source!.importedAt && view()!.runs?.length && !check()) {
            <fieldset class="group">
              <legend>Recent syncs</legend>
              @for (r of view()!.runs!.slice(0, 6); track r.at) {
                <div class="li small feed-run"><span class="pill" [class.p-ok]="r.ok" [class.p-bad]="!r.ok">{{ r.ok ? 'OK' : 'Failed' }}</span>
                  <div class="grow"><b>{{ when2(r.at) }}</b> · {{ runText(r) }}
                    @for (c of r.changes.slice(0, 3); track c.eid) { <div class="muted">{{ fmt(c.date) }} {{ c.title }}: {{ c.text }}</div> }
                    @if (!r.ok) { <div class="muted">{{ r.error }}</div> }
                  </div></div>
              }
            </fieldset>
          }
        } @else {
          <label>Calendar link (.ics)
            <span class="feed-link">
              <input type="url" name="url" [(ngModel)]="url" autocomplete="off" spellcheck="false" placeholder="https://… or webcal://…" (keydown.enter)="$event.preventDefault(); runCheck()">
              <button class="btn" type="button" [disabled]="busy() || !url.trim()" (click)="runCheck()">{{ busy() && !saving() ? 'Checking…' : 'Check feed' }}</button>
            </span>
            <span class="hint">In your club's scheduling site, look for Subscribe, Sync or Export calendar and copy the link. Treat it like a password: anyone with it can read the schedule. Teem Hub stores it encrypted.</span>
          </label>
          @if (view()?.connected) { <button class="link-btn small" type="button" (click)="cancelChangeLink()">Keep the saved link</button> }
        }

        @if (check(); as c) {
          @if (rules(); as r) {
          <section class="feed-found">
            <div class="row"><h4>What we found</h4><span class="pill p-ok">Feed works</span><span class="spacer"></span><span class="small muted">{{ c.calendar.name || c.host }}</span></div>
            <div class="feed-detect small"><b>Detected: {{ c.presetLabel }}</b> · @if (c.template?.used) { rules from {{ clubName() }}'s template for {{ c.presetLabel }}. } @else { rules filled in for {{ c.preset === 'generic' ? 'a standard calendar' : c.presetLabel }}. } Change anything below.</div>
            <div class="feed-stats">
              <div><span class="small muted">In the feed</span><b>{{ c.calendar.total }}</b><span class="small muted">{{ range(c) }}</span></div>
              @for (k of kinds; track k) { <div><span class="small muted">{{ kindLabel[k] }}s</span><b>{{ result()!.counts[k] }}</b></div> }
            </div>
            @for (w of c.calendar.warnings; track w) { <p class="small feed-warn">{{ w }}</p> }
          </section>

          <fieldset class="group">
            <legend>Which events are the team's</legend>
            @for (s of c.suggestions; track s.filter.mode + filterText(s.filter)) {
              <label class="check"><input type="radio" name="flt" [checked]="sameFilter(s.filter)" (change)="setFilter(s.filter)">
                <span><b>{{ describe(s.filter) }}</b><span class="small muted">{{ s.count }} events</span></span></label>
            }
            <label class="check"><input type="radio" name="flt" [checked]="r.filter.mode === 'all'" (change)="setFilter({ mode: 'all' })">
              <span><b>Everything in the feed</b><span class="small muted">{{ c.calendar.total }} events · for a calendar with only this team on it</span></span></label>
            <label class="check"><input type="radio" name="flt" [checked]="custom()" (change)="startCustom()"><span><b>Something else</b></span></label>
            @if (custom()) {
              <div class="two">
                <label>Title<select [ngModel]="customMode()" (ngModelChange)="customMode.set($event); applyCustom()" name="cmode"><option value="prefix">starts with</option><option value="contains">contains</option></select></label>
                <label>Text<input name="ctext" [ngModel]="customText()" (ngModelChange)="customText.set($event); applyCustom()"></label>
              </div>
            }
            @if (r.filter.mode === 'prefix') {
              <label class="check"><input type="checkbox" name="strip" [ngModel]="r.stripFilter" (ngModelChange)="patch({ stripFilter: $event })"><span><b>Remove that text from titles</b><span class="small muted">"{{ sampleFeedTitle() }}" shows as "{{ sampleTitle() }}"</span></span></label>
            }
            @if (result()!.leftOut.length) {
              <details class="small"><summary>Left out: {{ result()!.leftOut.length }} events</summary>
                <ul class="feed-left">@for (g of leftOutGroups(); track g.title) { <li>{{ g.title }} <span class="muted">({{ g.n }})</span></li> }</ul>
              </details>
            }
          </fieldset>

          <fieldset class="group">
            <legend>Rules <span class="small muted">· top to bottom, the first match decides the type</span></legend>
            <ol class="feed-rules">
              @for (t of r.types; track $index; let i = $index; let first = $first; let last = $last) {
                <li><span class="n">{{ i + 1 }}</span><span class="grow">{{ ruleText(t) }}<span class="small muted"> · {{ result()!.ruleCounts[i] }}</span></span>
                  <button class="link-btn small" type="button" [disabled]="first" (click)="moveRule(i, -1)" [attr.aria-label]="'Move rule ' + (i + 1) + ' up'">↑</button>
                  <button class="link-btn small" type="button" [disabled]="last" (click)="moveRule(i, 1)" [attr.aria-label]="'Move rule ' + (i + 1) + ' down'">↓</button>
                  <button class="link-btn small" type="button" (click)="removeRule(i)" [attr.aria-label]="'Remove rule ' + (i + 1)">Remove</button></li>
              }
              <li><span class="n">{{ r.types.length + 1 }}</span><span class="grow">Anything else →</span>
                <select name="fallback" [ngModel]="r.fallback" (ngModelChange)="patch({ fallback: $event })" aria-label="Type for anything else">@for (k of kinds; track k) { <option [value]="k">{{ kindLabel[k].toLowerCase() }}</option> }</select>
                <span class="small muted">{{ result()!.ruleCounts[r.types.length] }}</span></li>
            </ol>
            <div class="feed-add">
              <select name="nwhen" [(ngModel)]="newRule.when" aria-label="New rule matches">
                <option value="title">Title contains</option><option value="category">Category is</option><option value="allDay">All-day</option><option value="longer">Longer than (hours)</option>
              </select>
              @if (newRule.when === 'title' || newRule.when === 'category') { <input name="ntext" [(ngModel)]="newRule.text" aria-label="Text" placeholder="Scrimmage"> }
              @if (newRule.when === 'longer') { <input name="nhours" type="number" min="1" max="96" [(ngModel)]="newRule.hours" aria-label="Hours" style="width:80px"> }
              <span>→</span>
              <select name="nkind" [(ngModel)]="newRule.kind" aria-label="Becomes">@for (k of kinds; track k) { <option [value]="k">{{ kindLabel[k].toLowerCase() }}</option> }</select>
              <button class="btn sm" type="button" (click)="addRule()">Add rule</button>
            </div>
            <div class="two">
              <label>Court or field is written in
                <select name="courtfrom" [ngModel]="r.court.from" (ngModelChange)="patch({ court: { from: $event, label: r.court.label } })">
                  <option value="description">the description</option><option value="location">the location</option><option value="none">nowhere (no courts)</option>
                </select></label>
              <label>after the word<input name="courtlabel" [ngModel]="r.court.label" (ngModelChange)="patch({ court: { from: r.court.from, label: $event } })" [disabled]="r.court.from === 'none'" placeholder="Court"></label>
            </div>
            <label>Location
              <select name="venue" [ngModel]="r.venue" (ngModelChange)="patch({ venue: $event })">
                <option value="firstLine">First line is the venue, the rest is the address</option><option value="whole">Use the whole location as the venue</option>
              </select></label>
          </fieldset>

          <section class="group">
            <h4 style="margin:0 0 4px">How they'll look</h4>
            @for (m of examples(); track m.uid) {
              <div class="feed-ex"><span class="pill p-mute">{{ kindLabel[m.kind] }}</span>
                <div class="grow"><b>{{ m.title }}</b>@if (m.cancelled) { <span class="pill p-bad" style="margin-left:6px">Cancelled</span> }
                  <div class="small muted">{{ when(m) }}@if (m.venue) { · {{ m.venue }} }@if (m.court) { · {{ m.court }} }</div>
                  @if (m.title !== m.feedTitle) { <div class="small muted">was "{{ m.feedTitle }}"</div> }</div></div>
            } @empty { <p class="empty">No events match. Choose a different filter.</p> }
            @if (overlap() > 0) {
              <p class="small feed-warn">Your schedule already has {{ overlap() }} practices on the same dates as practices in this feed. When importing starts, you'll be offered to replace them, keeping families' answers and attendance.</p>
            }
            <p class="small muted">{{ upcoming() }} of the team's {{ result()!.matched.length }} events are from today on.</p>
          </section>

          @if (store.you().clubAdmin) {
            <label class="check"><input type="checkbox" name="tpl" [(ngModel)]="saveTemplate"><span><b>Also save these as {{ clubName() }}'s rules for {{ c.presetLabel }}</b><span class="small muted">Other teams in the club start from them (everything but which events are the team's).@if (c.template) { It replaces the club's current template. }</span></span></label>
          }
          <label>Note for the history (optional)<input name="note" [(ngModel)]="note" maxlength="200" placeholder="First setup"></label>
          <div class="form-actions">
            <button class="btn primary" type="button" [disabled]="busy() || !result()!.matched.length" (click)="save()">{{ saving() ? 'Saving…' : (view()?.connected && !changingLink() ? 'Save rules' : 'Save link and rules') }}</button>
            <button class="btn ghost" type="button" (click)="discard()">Cancel</button>
          </div>
          }
        }

        @if (view()?.connected && !check()) {
          @if (view()!.history.length) {
            <fieldset class="group">
              <legend>Rules history</legend>
              @for (h of view()!.history.slice(0, 6); track h.v) {
                <div class="li small"><div class="grow"><b>Version {{ h.v }}</b> · {{ fmt(h.at.slice(0, 10)) }} by {{ who(h.by) }}<div class="muted">{{ h.note || h.summary }}</div></div>
                  @if (h.v !== view()!.version) { <button class="link-btn small" type="button" [disabled]="busy()" (click)="restore(h.v)">Use this version</button> } @else { <span class="pill p-ok">Current</span> }</div>
              }
            </fieldset>
          }
          <section class="feed-box feed-danger">
            <div class="grow"><b>Disconnect</b><div class="small muted">Forgets the link and the rules.@if (view()!.source!.importedAt) { Imported events stay on the schedule as the team's own, with everything families entered. }</div></div>
            @if (confirmDisconnect()) {
              <button class="btn sm danger" type="button" [disabled]="busy()" (click)="disconnect()">Yes, disconnect</button>
              <button class="link-btn small" type="button" (click)="confirmDisconnect.set(false)">Keep it</button>
            } @else { <button class="btn sm" type="button" (click)="confirmDisconnect.set(true)">Disconnect</button> }
          </section>
        }
      }
      </div>
    </th-sheet>`
})
export class CalendarFeed {
  readonly open = input(false);
  readonly closed = output<void>();
  readonly store = inject(TeamStore);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  readonly kinds = FEED_KINDS;
  readonly kindLabel = FEED_KIND_LABELS;
  readonly fmt = fmt;

  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly view = signal<FeedView | null>(null);
  readonly check = signal<FeedCheck | null>(null);
  readonly rules = signal<FeedRules | null>(null);
  readonly changingLink = signal(false);
  readonly confirmDisconnect = signal(false);
  readonly custom = signal(false);
  readonly customMode = signal<'prefix' | 'contains'>('prefix');
  readonly customText = signal('');
  readonly importAll = signal(false);
  readonly replace = signal(true);
  readonly importing = signal(false);
  readonly syncing = signal(false);
  readonly todayIso = today();
  readonly replaceFrom = signal(today());
  url = '';
  note = '';
  newRule: NewRule = { when: 'title', text: '', hours: 6, kind: 'event' };
  /** The link that was checked (sent again on save). */
  private checkedUrl = '';

  readonly result = computed(() => {
    const c = this.check(), r = this.rules();
    return c && r ? applyRules(c.events, r) : null;
  });

  readonly leftOutGroups = computed(() => {
    const n = new Map<string, number>();
    for (const e of this.result()?.leftOut ?? []) n.set(e.title, (n.get(e.title) ?? 0) + 1);
    return [...n.entries()].map(([title, k]) => ({ title, n: k })).sort((a, b) => b.n - a.n).slice(0, 12);
  });

  /** One example of each type, upcoming first. */
  readonly examples = computed(() => {
    const m = this.result()?.matched ?? [];
    const from = today();
    return this.kinds.map((k) => m.find((x) => x.kind === k && x.date >= from) ?? m.find((x) => x.kind === k)).filter((x) => !!x);
  });

  readonly upcoming = computed(() => (this.result()?.matched ?? []).filter((m) => m.endDate >= today()).length);

  /** Practices already on the schedule on the same dates as feed practices (from today). */
  readonly overlap = computed(() => {
    const dates = new Set((this.result()?.matched ?? []).filter((m) => m.kind === 'practice' && m.date >= today()).map((m) => m.date));
    return this.store.items().filter((i) => i.kind === 'practice' && !i.cancelled && dates.has(i.date)).length;
  });

  /** Practice dates entered by hand (not from the calendar) from the replace date on. */
  readonly handPractices = computed(() => this.store.items().filter((i) => i.kind === 'practice' && !i.event?.src && !i.cancelled && i.date >= this.replaceFrom()).length);

  /** "in 3 minutes" while Sync now has to wait. */
  readonly syncWait = computed(() => {
    const at = this.view()?.source?.nextManualAt;
    const ms = at ? Date.parse(at) - this.now() : 0;
    return ms > 0 ? `in ${Math.ceil(ms / 60000)} minute${Math.ceil(ms / 60000) === 1 ? '' : 's'}` : '';
  });
  private readonly now = signal(Date.now());

  readonly sampleFeedTitle = computed(() => this.result()?.matched[0]?.feedTitle ?? '');
  readonly sampleTitle = computed(() => this.result()?.matched[0]?.title ?? '');

  constructor() {
    effect(() => {
      if (this.open()) untracked(() => void this.load());
      else untracked(() => this.reset());
    });
  }

  private reset() {
    this.check.set(null); this.rules.set(null); this.error.set(''); this.changingLink.set(false);
    this.confirmDisconnect.set(false); this.custom.set(false); this.url = ''; this.note = ''; this.checkedUrl = ''; this.replaceFrom.set(today());
  }

  async load() {
    this.loading.set(true);
    this.now.set(Date.now());
    try { this.view.set(await this.api.feed(this.store.teamId())); }
    catch (e) { this.error.set(explain(e)); }
    finally { this.loading.set(false); }
  }

  changeLink() { this.changingLink.set(true); this.check.set(null); this.rules.set(null); }
  cancelChangeLink() { this.changingLink.set(false); this.check.set(null); this.rules.set(null); this.url = ''; }

  async runCheck() {
    const typed = this.url.trim();
    if (!typed && !(this.view()?.connected && !this.changingLink())) return;
    this.busy.set(true); this.error.set('');
    try {
      const c = await this.api.checkFeed(this.store.teamId(), typed || undefined);
      this.checkedUrl = typed;
      this.check.set(c);
      this.rules.set(structuredClone(c.rules));
      this.custom.set(c.rules.filter.mode !== 'all' && !c.suggestions.some((s) => this.sameFilterOf(s.filter, c.rules.filter)));
      if (this.custom() && c.rules.filter.mode !== 'all') { this.customMode.set(c.rules.filter.mode); this.customText.set(c.rules.filter.text); }
    } catch (e) { this.error.set(explain(e)); }
    finally { this.busy.set(false); }
  }

  patch(p: Partial<FeedRules>) { const r = this.rules(); if (r) this.rules.set({ ...r, ...p }); }

  describe(f: FeedFilter) { return describeFilter(f); }
  filterText(f: FeedFilter) { return f.mode === 'all' ? '' : f.text; }
  private sameFilterOf(a: FeedFilter, b: FeedFilter) { return a.mode === b.mode && this.filterText(a).toLowerCase() === this.filterText(b).toLowerCase(); }
  sameFilter(f: FeedFilter) { const r = this.rules(); return !this.custom() && !!r && this.sameFilterOf(f, r.filter); }
  setFilter(f: FeedFilter) { this.custom.set(false); this.patch({ filter: f }); }
  startCustom() {
    const r = this.rules();
    this.custom.set(true);
    if (r && r.filter.mode !== 'all') { this.customMode.set(r.filter.mode); this.customText.set(r.filter.text); }
    this.applyCustom();
  }
  applyCustom() {
    const text = this.customText().trim();
    this.patch({ filter: text ? { mode: this.customMode(), text } : { mode: 'all' } });
  }

  ruleText(t: TypeRule) { return describeRule(t); }
  who(sub: string) { return sub === this.store.you().sub ? 'you' : this.store.authorName(sub) || 'an admin'; }
  moveRule(i: number, by: -1 | 1) {
    const r = this.rules(); if (!r) return;
    const types = [...r.types]; const j = i + by;
    if (j < 0 || j >= types.length) return;
    [types[i], types[j]] = [types[j], types[i]];
    this.patch({ types });
  }
  removeRule(i: number) { const r = this.rules(); if (r) this.patch({ types: r.types.filter((_, k) => k !== i) }); }
  addRule() {
    const r = this.rules(); if (!r) return;
    const n = this.newRule;
    let rule: TypeRule;
    if (n.when === 'title' || n.when === 'category') {
      if (!n.text.trim()) { this.error.set('Type the text the rule looks for.'); return; }
      rule = { when: n.when, text: n.text.trim(), kind: n.kind };
    } else if (n.when === 'longer') rule = { when: 'longer', hours: Math.min(96, Math.max(1, Number(n.hours) || 6)), kind: n.kind };
    else rule = { when: 'allDay', kind: n.kind };
    if (r.types.length >= 12) { this.error.set('That’s the most rules a feed can have (12).'); return; }
    this.error.set('');
    this.patch({ types: [...r.types, rule] });
    this.newRule = { ...n, text: '' };
  }

  range(c: FeedCheck) { return c.calendar.from ? fmtRange(c.calendar.from, c.calendar.to) : ''; }
  when(m: { date: string; endDate: string; time?: string; endTime?: string; allDay: boolean }) {
    if (m.allDay) return fmtRange(m.date, m.endDate !== m.date ? m.endDate : undefined);
    return `${fmt(m.date)} · ${clock(m.time)}${m.endTime ? `–${clock(m.endTime)}` : ''}`;
  }

  async save() {
    const r = this.rules(); if (!r) return;
    this.busy.set(true); this.saving.set(true); this.error.set('');
    try {
      const v = await this.api.saveFeed(this.store.teamId(), { ...(this.checkedUrl ? { url: this.checkedUrl } : {}), rules: r, ...(this.note.trim() ? { note: this.note.trim() } : {}) });
      this.view.set(v);
      const preset = this.check()?.preset;
      if (this.saveTemplate && preset && this.store.clubId()) await this.api.saveFeedTemplate(this.store.clubId(), preset, r);
      this.toast.show(this.saveTemplate ? `Calendar feed saved, and the club's ${this.check()?.presetLabel} template` : 'Calendar feed saved');
      this.reset();
    } catch (e) { this.error.set(explain(e)); }
    finally { this.busy.set(false); this.saving.set(false); }
  }

  readonly feedLabel = computed(() => this.store.club()?.short || 'the club');
  readonly clubName = computed(() => this.store.club()?.name || 'the club');
  saveTemplate = false;
  fieldLabel(f: Overridable) { return OVERRIDE_LABELS[f]; }

  private async act(fn: () => Promise<{ feed: FeedView }>, done: string, refresh = true) {
    this.busy.set(true); this.error.set('');
    try {
      const r = await fn();
      this.view.set(r.feed);
      if (done) this.toast.show(done);
      if (refresh) await this.store.refresh(['events'], true);
    } catch (e) { this.error.set(explain(e)); }
    finally { this.busy.set(false); }
  }
  settle(r: ReviewItem, action: 'cancel' | 'keep' | 'merge' | 'different' | 'useFeed' | 'keepMine') {
    const done = { cancel: `${r.title} on ${fmt(r.date)} is cancelled`, keep: 'Kept on the schedule', merge: 'Merged', different: 'Kept as two events', useFeed: "Using the calendar's value", keepMine: 'Kept the override' }[action];
    return this.act(() => this.api.reviewFeed(this.store.teamId(), { action, eid: r.eid, ...(r.kind === 'conflict' ? { field: r.field } : {}) }), done);
  }
  previewCatchUp() { return this.act(() => this.api.catchUpFeed(this.store.teamId()), '', false); }
  applyCatchUp() { return this.act(() => this.api.applyCatchUp(this.store.teamId()), 'Caught up. Syncing every 30 minutes again.'); }
  acceptDrop() { return this.act(() => this.api.acceptFeedDrop(this.store.teamId()), 'Synced with the new count'); }
  async keepOff() {
    await this.store.setFeature('calfeed', false);
    this.closed.emit();
  }

  discard() { this.check.set(null); this.rules.set(null); this.error.set(''); if (!this.view()?.connected) this.closed.emit(); }

  ago(at: string) {
    const m = Math.round((Date.now() - Date.parse(at)) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} minute${m === 1 ? '' : 's'} ago` : m < 1440 ? `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'} ago` : `on ${fmt(at.slice(0, 10))}`;
  }
  when2(at: string) { return `${fmt(at.slice(0, 10))} ${new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`; }
  runText(r: FeedRun) {
    if (!r.ok) return 'nothing changed';
    const parts = [r.added && `${r.added} added`, r.changed && `${r.changed} changed`, r.missing && `${r.missing} not in the calendar`].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'no changes';
  }

  async runImport() {
    this.busy.set(true); this.importing.set(true); this.error.set('');
    try {
      const from = this.importAll() ? '2000-01-01' : today();
      const replaceFrom = this.handPractices() > 0 && this.replace() ? this.replaceFrom() : null;
      const r = await this.api.importFeed(this.store.teamId(), from, replaceFrom);
      this.view.set(r.feed);
      const moved = r.replaced ? r.replaced.answersMoved + r.replaced.attendanceMoved : 0;
      this.toast.show(`${r.run.added} events added to the schedule${moved ? `; ${moved} answers and attendance records moved over` : ''}`);
      await this.store.refresh(['events'], true);
    } catch (e) { this.error.set(explain(e)); }
    finally { this.busy.set(false); this.importing.set(false); }
  }

  async syncNow() {
    this.busy.set(true); this.syncing.set(true); this.error.set('');
    try {
      const r = await this.api.syncFeed(this.store.teamId());
      this.view.set(r.feed); this.now.set(Date.now());
      this.toast.show(r.run.ok ? `Synced: ${this.runText(r.run)}` : `Sync failed: ${r.run.error}`, !r.run.ok);
      if (r.run.added || r.run.changed) await this.store.refresh(['events'], true);
    } catch (e) { this.error.set(explain(e)); }
    finally { this.busy.set(false); this.syncing.set(false); }
  }

  async restore(v: number) {
    this.busy.set(true); this.error.set('');
    try { this.view.set(await this.api.restoreFeedRules(this.store.teamId(), v)); this.toast.show(`Back to rules version ${v}`); }
    catch (e) { this.error.set(explain(e)); }
    finally { this.busy.set(false); }
  }

  async disconnect() {
    this.busy.set(true); this.error.set('');
    try { this.view.set(await this.api.disconnectFeed(this.store.teamId())); this.toast.show('Calendar feed disconnected'); this.reset(); }
    catch (e) { this.error.set(explain(e)); }
    finally { this.busy.set(false); }
  }
}
