import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { APP_LABEL, CAL_TYPES, CalendarLinks, TYPE_LABEL, lastChecked, openApp, type CalApp, type CalLink, type CalType } from '../../core/calendar-links';
import type { MyTeam } from '../../core/models';

const onApple = () => /iPhone|iPad|Macintosh/.test(navigator.userAgent);
type Pick = Record<string, CalType[]>;

/**
 * Your teams: one calendar for all your teams (when you're on two or more), and every calendar link
 * you've made, with when the calendar app last checked it, Reset and Stop.
 */
@Component({
  selector: 'th-calendar-panel',
  template: `
    @if (teams().length > 1) {
      <section class="card card-b cal-card" aria-labelledby="calall-h">
        <h3 id="calall-h" style="margin-top:0">One calendar for all your teams</h3>
        <p class="muted" style="margin:0 0 10px">Every team's dates in a single calendar that updates on its own. Each event starts with the team, like “{{ teams()[0].name || teams()[0].teamId }} · Practice”.</p>
        <div class="calall-grid">
          <div>
            @for (t of teams(); track t.teamId) {
              <div class="sub-team">
                <input type="checkbox" [id]="'calt-' + t.teamId" [checked]="(picked()[t.teamId] ?? []).length > 0" (change)="toggleTeam(t.teamId)" />
                <div class="grow">
                  <label [for]="'calt-' + t.teamId" style="color:var(--ink);font-size:15px">{{ t.name || t.teamId }}</label>
                  @if ((picked()[t.teamId] ?? []).length) {
                    <div class="sub-kinds" role="group" [attr.aria-label]="'What to include from ' + (t.name || t.teamId)">
                      @for (k of kinds; track k) {
                        <label><input type="checkbox" [checked]="picked()[t.teamId].includes(k)" (change)="toggleKind(t.teamId, k)" />{{ label[k] }}</label>
                      }
                    </div>
                  }
                </div>
              </div>
            }
          </div>
          <div class="cal-btns">
            <button type="button" class="btn primary" [disabled]="busy() || !any()" (click)="add(apps()[0])">Add to {{ appLabel[apps()[0]] }}</button>
            <div class="cal-two">
              @for (a of apps().slice(1); track a) {
                <button type="button" class="btn ghost" [disabled]="busy() || !any()" (click)="add(a)">{{ short[a] }}</button>
              }
            </div>
            <div class="small" style="display:flex;gap:6px 16px;flex-wrap:wrap;align-items:baseline">
              <button type="button" class="link" [disabled]="busy() || !any()" (click)="copy()">{{ copied() ? 'Copied' : 'Copy link' }}</button>
              @if (all()) { <span class="muted">You have this calendar: changes above apply to it.</span> }
            </div>
          </div>
        </div>
        @if (saved()) { <p class="hint" role="status">Saved. Your calendar picks this up the next time it checks.</p> }
        @if (notice()) { <p class="msg notice" role="status">{{ notice() }}</p> }
        @if (error()) { <p class="msg error" role="alert">{{ error() }}</p> }
      </section>
    }

    @if (links().length) {
      <section class="card card-b cal-links" aria-labelledby="callinks-h">
        <h3 id="callinks-h" style="margin-top:0">Your calendar links</h3>
        <p class="small muted" style="margin:0 0 4px">Each one is private to you. Reset a link if it was shared by mistake, or stop it to take the events out of that calendar.</p>
        @for (l of links(); track l.scope + (l.teamId ?? '')) {
          <div class="li-cal">
            <div class="grow">
              <b>{{ title(l) }}</b>@if (l.app) { <span class="small muted"> · {{ appLabel[l.app] }}</span> }
              <div class="small muted">{{ kindsText(l) }}</div>
              <div class="small" [class.stale]="checked(l).stale" [class.muted]="!checked(l).stale">{{ checked(l).text }}</div>
            </div>
            <div class="acts small">
              <button type="button" class="link" [disabled]="busy()" (click)="reset(l)">{{ confirming() === 'reset' + key(l) ? 'Tap again to reset' : 'Reset link' }}</button>
              <button type="button" class="link confirm" [disabled]="busy()" (click)="stop(l)">{{ confirming() === 'stop' + key(l) ? 'Tap again to stop' : 'Stop' }}</button>
            </div>
          </div>
        }
        @if (listNotice()) { <p class="msg notice" role="status">{{ listNotice() }}</p> }
        @if (listError()) { <p class="msg error" role="alert">{{ listError() }}</p> }
      </section>
    }`
})
export class CalendarPanel {
  /** Your active (not archived) teams. */
  readonly teams = input.required<MyTeam[]>();
  /** Every team you're on, for naming links. */
  readonly allTeams = input<MyTeam[]>([]);
  private readonly cal = inject(CalendarLinks);
  readonly kinds = CAL_TYPES;
  readonly label = TYPE_LABEL;
  readonly appLabel = APP_LABEL;
  readonly short: Record<string, string> = { apple: 'Apple', google: 'Google', outlook: 'Outlook.com', office: 'Outlook (work)' };

  readonly picked = signal<Pick>({});
  readonly busy = signal(false);
  readonly saved = signal(false);
  readonly copied = signal(false);
  readonly notice = signal('');
  readonly error = signal('');
  readonly listNotice = signal('');
  readonly listError = signal('');
  readonly confirming = signal('');

  readonly links = computed(() => [...(this.cal.links() ?? [])].sort((a, b) => (a.scope === 'all' ? -1 : b.scope === 'all' ? 1 : this.title(a).localeCompare(this.title(b)))));
  readonly all = computed(() => this.cal.links() && this.cal.find('all'));
  readonly any = computed(() => Object.values(this.picked()).some((k) => k.length));
  readonly apps = computed<Exclude<CalApp, 'copy' | 'download'>[]>(() => (onApple() ? ['apple', 'google', 'outlook', 'office'] : ['google', 'apple', 'outlook', 'office']));
  private readonly names = computed(() => new Map([...this.allTeams(), ...this.teams()].map((t) => [t.teamId, t.name || t.teamId])));

  constructor() {
    void this.cal.load().catch(() => { /* the list stays hidden; the rest of the page works */ });
    // Everything ticked to start, or what the all-teams link already includes.
    effect(() => {
      const teams = this.teams();
      const l = this.all();
      untracked(() => {
        const start: Pick = {};
        for (const t of teams) start[t.teamId] = l?.teams ? [...(l.teams[t.teamId] ?? [])] : [...CAL_TYPES];
        this.picked.set(start);
      });
    });
  }

  key(l: CalLink) { return l.scope + (l.teamId ?? ''); }
  title(l: CalLink) { return l.scope === 'all' ? 'All your teams' : this.names().get(l.teamId!) ?? l.teamId ?? ''; }
  checked(l: CalLink) { return lastChecked(l.lastFetchAt); }
  kindsText(l: CalLink) {
    if (l.scope === 'team') return (l.types ?? []).length === 3 ? 'Everything on the schedule' : (l.types ?? []).map((k) => TYPE_LABEL[k]).join(', ');
    const n = Object.keys(l.teams ?? {}).length;
    return `${n} team${n === 1 ? '' : 's'}`;
  }

  private chosen(): Pick { return Object.fromEntries(Object.entries(this.picked()).filter(([, k]) => k.length)); }
  private changed() {
    this.saved.set(false);
    if (this.all() && this.any()) void this.run(async () => { await this.cal.saveAll(this.chosen()); this.saved.set(true); });
  }
  toggleTeam(teamId: string) {
    const on = (this.picked()[teamId] ?? []).length > 0;
    this.picked.update((p) => ({ ...p, [teamId]: on ? [] : [...CAL_TYPES] }));
    this.changed();
  }
  toggleKind(teamId: string, k: CalType) {
    const cur = this.picked()[teamId] ?? [];
    this.picked.update((p) => ({ ...p, [teamId]: cur.includes(k) ? cur.filter((x) => x !== k) : CAL_TYPES.filter((x) => x === k || cur.includes(x)) }));
    this.changed();
  }

  private async run(fn: () => Promise<void>, list = false) {
    this.busy.set(true);
    (list ? this.listError : this.error).set('');
    try { await fn(); } catch (e) { (list ? this.listError : this.error).set((e as Error).message || 'That didn’t work. Try again.'); } finally { this.busy.set(false); }
  }

  add(app: Exclude<CalApp, 'copy' | 'download'>) {
    return this.run(async () => {
      await openApp(app, async () => ({ feed: this.cal.feedUrl(await this.cal.saveAll(this.chosen(), app)), name: 'My teams (Teem Hub)' }));
      this.notice.set(app === 'apple' ? 'Your calendar app should open and ask to subscribe.' : `${APP_LABEL[app]} opened in a new tab: confirm there to add the calendar.`);
    });
  }

  copy() {
    return this.run(async () => {
      const l = this.all() ?? (await this.cal.saveAll(this.chosen(), 'copy'));
      await navigator.clipboard.writeText(this.cal.feedUrl(l));
      this.copied.set(true);
      this.notice.set('Link copied. Paste it where your calendar app asks for a calendar URL. Keep it private: anyone with it can see these schedules.');
    });
  }

  reset(l: CalLink) {
    if (this.confirming() !== 'reset' + this.key(l)) { this.confirming.set('reset' + this.key(l)); return; }
    this.confirming.set('');
    return this.run(async () => {
      await this.cal.reset(l);
      this.listNotice.set(`New link made for ${this.title(l)}. The old one stopped working, so add the calendar again from the team's Schedule${l.scope === 'all' ? ' or above' : ''}.`);
    }, true);
  }

  stop(l: CalLink) {
    if (this.confirming() !== 'stop' + this.key(l)) { this.confirming.set('stop' + this.key(l)); return; }
    this.confirming.set('');
    return this.run(async () => {
      await this.cal.stop(l);
      this.listNotice.set(`Stopped. ${this.title(l)}'s dates leave that calendar the next time it checks; you can also delete the calendar there.`);
    }, true);
  }
}
