import { Component, ViewEncapsulation, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HELP_ROLES, HELP_ROLE_LABELS, HELP_TOPICS, type HelpRole } from '@shared/help';
import { searchHelp } from '@shared/help-search';
import { HeaderService } from '../../core/header.service';
import { HelpService, topicById } from './help.service';
import { HelpText } from './help-text';

/** Ideas shown when a search finds nothing. */
const TRY = ['add to calendar', 'pay dues', 'cancel practice', 'invite', 'hotel'];

/** /help — every topic by role, a search box and "Most used". Works without signing in. */
@Component({
  selector: 'th-help-home',
  imports: [RouterLink, HelpText],
  styleUrl: './help.css',
  encapsulation: ViewEncapsulation.None,
  template: `
  <main class="help">
    <div class="help-hero">
      <h2>Help and how-to</h2>
      <p class="muted">Short steps for the things people do most on Teem Hub.@if (team()) { <a [routerLink]="['/teams', team()]">Back to your team</a> }</p>
      <form role="search" class="help-search" (submit)="$event.preventDefault(); settle()">
        <label class="sr-only" for="help-q">Search help</label>
        <input id="help-q" type="search" autocomplete="off" enterkeyhint="search" placeholder="Search, like “add to calendar” or “pay dues”"
               [value]="query()" (input)="type($any($event.target).value)">
      </form>
      <nav class="chips" aria-label="Show topics for">
        <button class="chip" type="button" [attr.aria-pressed]="role() === 'all'" (click)="pick('all')">Everyone</button>
        @for (r of roles; track r) {
          <button class="chip" type="button" [attr.aria-pressed]="role() === r" (click)="pick(r)">{{ labels[r] }}@if (mine().includes(r)) { <span class="you"> · you</span> }</button>
        }
      </nav>
    </div>

    @if (query().trim()) {
      <section class="card" aria-live="polite">
        <div class="card-h"><h3>{{ hits().length === 1 ? '1 topic' : hits().length + ' topics' }} for “{{ query().trim() }}”</h3>
          @if (hiddenHits()) { <button class="link-btn small" type="button" (click)="pick('all')">{{ hiddenHits() }} more for other roles</button> }
        </div>
        <div class="card-b">
          @if (hits().length) {
            <ul class="help-list">
              @for (h of hits(); track h.topic.id) {
                <li>
                  <a [routerLink]="['/help', h.topic.id]" [queryParams]="params('search')">
                    <b><th-help-text [text]="h.topic.title" [marks]="h.marks" /></b>
                    <span class="small muted"><th-help-text [text]="h.topic.summary" [marks]="h.marks" /></span>
                  </a>
                  <span class="pill p-mute">{{ labels[h.topic.role] }}</span>
                </li>
              }
            </ul>
          } @else {
            <div class="empty">Nothing matched. Try fewer words, or one of these:
              <div class="chips" style="justify-content:center;margin-top:8px">
                @for (t of tries; track t) { <button class="chip" type="button" (click)="type(t); settle()">{{ t }}</button> }
              </div>
            </div>
          }
        </div>
      </section>
    } @else {
      @if (mostUsed().length) {
        <section class="card help-most">
          <div class="card-h"><h3>Most used</h3><span class="muted small">{{ forWhom() }}</span></div>
          <div class="card-b">
            <ol class="help-list numbered">
              @for (t of mostUsed(); track t.id) {
                <li><a [routerLink]="['/help', t.id]" [queryParams]="params('popular')"><b>{{ t.title }}</b><span class="small muted">{{ t.summary }}</span></a></li>
              }
            </ol>
          </div>
        </section>
      }
      @for (g of groups(); track g.role) {
        <section class="card">
          <div class="card-h"><h3>{{ labels[g.role] }}</h3><span class="muted small">{{ g.topics.length }} topics</span></div>
          <div class="card-b">
            <ul class="help-list">
              @for (t of g.topics; track t.id) {
                <li><a [routerLink]="['/help', t.id]" [queryParams]="params('browse')"><b>{{ t.title }}</b><span class="small muted">{{ t.summary }}</span></a></li>
              }
            </ul>
          </div>
        </section>
      }
    }
    <p class="muted small help-foot">Can't find what you need? Ask your coach or team coordinator. They can see how the team is set up.</p>
  </main>`
})
export class HelpHome implements OnDestroy {
  /** From the URL: ?q= search words, ?role= filter, ?team= the team "Take me there" opens. */
  readonly q = input<string>('');
  readonly roleParam = input<string>('', { alias: 'role' });
  readonly team = input<string>('');
  readonly help = inject(HelpService);
  private readonly router = inject(Router);
  readonly roles = HELP_ROLES;
  readonly labels = HELP_ROLE_LABELS;
  readonly tries = TRY;
  readonly query = signal('');
  readonly role = signal<HelpRole | 'all'>('all');
  readonly mine = this.help.myRoles;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settled = '';

  readonly allHits = computed(() => searchHelp(this.query(), HELP_TOPICS));
  readonly hits = computed(() => this.allHits().filter((h) => this.role() === 'all' || h.topic.role === this.role()));
  readonly hiddenHits = computed(() => this.allHits().length - this.hits().length);
  readonly groups = computed(() => HELP_ROLES.filter((r) => this.role() === 'all' || r === this.role())
    .map((r) => ({ role: r, topics: HELP_TOPICS.filter((t) => t.role === r) })));
  readonly forWhom = computed(() => { const r = this.role(); return r === 'all' ? 'by everyone' : `by ${HELP_ROLE_LABELS[r].toLowerCase()}`; });
  readonly mostUsed = computed(() => (this.help.popular()?.[this.role()]?.ids ?? []).map(topicById).filter((t) => !!t));

  constructor() {
    inject(HeaderService).reset();
    void this.help.loadPopular();
    effect(() => {
      // Router input binding sets missing query params to undefined.
      const q = this.q() ?? '', r = this.roleParam() ?? '';
      untracked(() => {
        this.query.set(q);
        this.settled = q.trim();
        if (r === 'all' || (HELP_ROLES as readonly string[]).includes(r)) this.role.set(r as HelpRole | 'all');
      });
    });
    // Start on your own group once your teams load (unless the URL or your last visit chose one).
    void this.help.loadMe().then(() => { if (!this.roleParam()) this.role.set(this.help.startRole()); });
  }

  ngOnDestroy() { clearTimeout(this.timer); }

  type(v: string) {
    this.query.set(v);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.settle(), 1200);
  }

  /** The search stopped changing: keep it in the URL (so Back returns to it) and count it once. */
  settle() {
    clearTimeout(this.timer);
    const q = this.query().trim();
    if (q === this.settled) return;
    this.settled = q;
    void this.router.navigate([], { queryParams: { q: q || null }, queryParamsHandling: 'merge', replaceUrl: true });
    if (q.length >= 2) this.help.searched(this.allHits().length > 0);
  }

  pick(r: HelpRole | 'all') {
    this.role.set(r);
    this.help.saveRole(r);
  }

  params(via: string) {
    return { via, team: this.team() || null, q: via === 'search' ? this.query().trim() || null : null, role: this.role() === 'all' ? null : this.role() };
  }
}
