import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CAL_TYPES, CalendarLinks, TYPE_LABEL, countByType, lastChecked, openApp, APP_LABEL, type CalApp, type CalType } from '../../core/calendar-links';
import { today } from '../../core/dates';
import { TeamStore } from '../../core/team-store';
import { Sheet } from '../../shared/sheet';

/** Apple first on Apple devices; Google first everywhere else. */
const onApple = () => /iPhone|iPad|Macintosh/.test(navigator.userAgent);

/**
 * "Add to your calendar": a calendar link for this team, which the calendar app checks on its own.
 * Opened from the Schedule page or any date's Add to calendar menu (TeamStore.subscribeFor holds the
 * kinds of event to start with). Rendered once, in the team shell.
 */
@Component({
  selector: 'th-subscribe-sheet',
  imports: [Sheet, RouterLink],
  template: `
    <th-sheet heading="Add to your calendar" [open]="!!store.subscribeFor()" (closed)="store.subscribeFor.set(null)">
      <p class="muted" style="margin:0 0 12px">It updates on its own when the schedule changes, so cancelled and moved dates show up there too.</p>
      <div class="label">Include</div>
      <div class="sub-types">
        @for (t of types; track t) {
          <label class="sub-type">
            <input type="checkbox" [checked]="picked().includes(t)" (change)="toggle(t)" />
            <b>{{ label[t] }}</b><span class="muted small">{{ counts()[t] }} {{ counts()[t] === 1 ? 'date' : 'dates' }}</span>
          </label>
        }
      </div>
      @if (!picked().length) { <p class="hint warn">Pick at least one.</p> }
      @else if (saved()) { <p class="hint" role="status">Saved. Your calendar picks this up the next time it checks.</p> }

      @if (link(); as l) {
        <p class="sub-have small">You already have this calendar@if (l.app && l.app !== 'copy' && l.app !== 'download') { in <b>{{ appLabel[l.app] }}</b>}. {{ checked() }}. Changes above apply to it. Add it again only if you removed it.</p>
      }
      <div class="sub-apps">
        @for (a of apps(); track a; let first = $first) {
          <button type="button" class="btn" [class.primary]="first" [class.ghost]="!first" [disabled]="busy() || !picked().length" (click)="add(a)">{{ first ? 'Add to ' + appLabel[a] : appLabel[a] }}</button>
          @if (first) { <span class="small muted sub-total">{{ total() }} {{ total() === 1 ? 'date' : 'dates' }} from today on</span> }
        }
      </div>
      <div class="sub-more small">
        <button type="button" class="link" [disabled]="busy() || !picked().length" (click)="copy()">{{ copied() ? 'Copied' : 'Copy link' }}</button>
        <button type="button" class="link" [disabled]="busy() || !picked().length" (click)="download()">One-time download</button>
        @if (link()) { <button type="button" class="link" [disabled]="busy()" (click)="reset()">{{ confirmReset() ? 'Tap again to reset' : 'Reset my link' }}</button> }
      </div>
      @if (error()) { <p class="msg error" role="alert">{{ error() }}</p> }
      @if (notice()) { <p class="msg notice" role="status">{{ notice() }}</p> }
      <p class="small sub-warn">Urgent changes still come by email or text: calendar apps check every hour or so, and Google can take most of a day.</p>
      <p class="small muted" style="margin:6px 0 0">Your link is private to you. Manage all your calendar links on <a routerLink="/teams">Your teams</a>.</p>
    </th-sheet>`
})
export class SubscribeSheet {
  readonly store = inject(TeamStore);
  private readonly cal = inject(CalendarLinks);
  readonly types = CAL_TYPES;
  readonly label = TYPE_LABEL;
  readonly appLabel = APP_LABEL;

  readonly picked = signal<CalType[]>([...CAL_TYPES]);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly saved = signal(false);
  readonly copied = signal(false);
  readonly confirmReset = signal(false);

  readonly link = computed(() => this.cal.links() && this.cal.find('team', this.store.teamId()));
  readonly checked = computed(() => lastChecked(this.link()?.lastFetchAt ?? null).text);
  readonly counts = computed(() => countByType(this.store.items(), today()));
  readonly total = computed(() => this.picked().reduce((n, t) => n + this.counts()[t], 0));
  readonly apps = computed<Exclude<CalApp, 'copy' | 'download'>[]>(() => (onApple() ? ['apple', 'google', 'outlook', 'office'] : ['google', 'apple', 'outlook', 'office']));
  private readonly name = computed(() => `${this.store.settings()?.teamName ?? 'Team'} (Teem Hub)`);

  constructor() {
    // Each time it opens: start from what was asked for, or from the link's own kinds when there is one.
    effect(() => {
      const want = this.store.subscribeFor();
      if (!want) return;
      untracked(() => {
        this.error.set(''); this.notice.set(''); this.saved.set(false); this.copied.set(false); this.confirmReset.set(false);
        this.picked.set(want.length ? [...want] : [...CAL_TYPES]);
        void this.cal.load().then(() => {
          const l = this.link();
          if (l?.types && want.length === CAL_TYPES.length) this.picked.set([...l.types]);
          else if (l?.types && want.some((t) => !l.types!.includes(t))) this.picked.set(CAL_TYPES.filter((t) => want.includes(t) || l.types!.includes(t)));
        }).catch(() => { /* the panel still works: saving loads it again */ });
      });
    });
  }

  toggle(t: CalType) {
    const next = this.picked().includes(t) ? this.picked().filter((x) => x !== t) : CAL_TYPES.filter((x) => x === t || this.picked().includes(x));
    this.picked.set(next);
    this.saved.set(false);
    // An existing link changes right away: same link, different dates.
    if (this.link() && next.length) void this.run(async () => { await this.cal.saveTeam(this.store.teamId(), next); this.saved.set(true); });
  }

  private async ensure(app?: CalApp) {
    const l = await this.cal.saveTeam(this.store.teamId(), this.picked(), app);
    return { feed: this.cal.feedUrl(l), name: this.name(), link: l };
  }

  private async run(fn: () => Promise<void>) {
    this.busy.set(true); this.error.set('');
    try { await fn(); } catch (e) { this.error.set((e as Error).message || 'That didn’t work. Try again.'); } finally { this.busy.set(false); }
  }

  add(app: Exclude<CalApp, 'copy' | 'download'>) {
    return this.run(async () => {
      await openApp(app, () => this.ensure(app));
      this.notice.set(app === 'apple' ? 'Your calendar app should open and ask to subscribe.' : `${APP_LABEL[app]} opened in a new tab: confirm there to add the calendar.`);
    });
  }

  copy() {
    return this.run(async () => {
      // Copying needs the tap, so an existing link copies straight away.
      const l = this.link();
      const feed = l && this.same(l.types) ? this.cal.feedUrl(l) : (await this.ensure('copy')).feed;
      await navigator.clipboard.writeText(feed);
      this.copied.set(true);
      this.notice.set('Link copied. Paste it where your calendar app asks for a calendar URL. Keep it private: anyone with it can see the schedule.');
    });
  }

  download() {
    return this.run(async () => {
      const { link } = await this.ensure(this.link()?.app ? undefined : 'download');
      await this.cal.download(link, this.name());
      this.notice.set('Downloaded. A downloaded file is a copy and won’t update; subscribe above to keep it current.');
    });
  }

  reset() {
    const l = this.link();
    if (!l) return;
    if (!this.confirmReset()) { this.confirmReset.set(true); return; }
    this.confirmReset.set(false);
    return this.run(async () => {
      await this.cal.reset(l);
      this.notice.set('New link made. The old one stopped working: add the calendar again with one of the buttons above.');
    });
  }

  private same(types: CalType[] | undefined) { return !!types && types.length === this.picked().length && types.every((t) => this.picked().includes(t)); }
}
