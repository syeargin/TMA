import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';
import { HELP_TOPICS } from '@shared/help';
import { searchHelp } from '@shared/help-search';
import { AuthService } from '../core/auth.service';
import { explain } from '../core/errors';
import { FeedbackService, FeedbackState, KIND_LABEL, deviceOf, shrink, type FeedbackKind, type Sent } from '../core/feedback';
import { MeService } from '../core/me.service';
import { Sheet } from './sheet';

/**
 * "Questions & feedback": ask a question (the team's coordinators or Teem Hub), report a problem
 * (with the page, the last error and an optional screenshot) or suggest an idea. Rendered once in
 * the app shell; FeedbackService.open() shows it from anywhere, signed in or not.
 */
@Component({
  selector: 'th-feedback-sheet',
  imports: [Sheet, RouterLink],
  template: `
    <th-sheet heading="Questions & feedback" [open]="!!fb.openAs()" (closed)="fb.close()">
      @if (sent(); as s) {
        <div class="fb-done" role="status">
          <span class="fb-tick" aria-hidden="true">✓</span>
          <b>{{ s.route === 'team' ? 'Sent to ' + names(s.sentTo) : "Thanks, it's sent" }}</b>
          <p class="small muted">Reference <b>{{ s.ref }}</b>.
            @if (s.route === 'team') { They'll reply to you by email at {{ s.email }}. }
            @else if (kind() === 'idea') { We read every idea. If we build it, you'll hear from us at {{ s.email }}. }
            @else { We'll reply by email to {{ s.email }}. }
            @if (signedIn()) { You can see it, and any reply, on <a routerLink="/account" fragment="feedback" (click)="fb.close()">your Account page</a>. }
          </p>
          <div class="row" style="justify-content:center"><button class="btn sm" type="button" (click)="fb.close()">Done</button><button class="btn sm ghost" type="button" (click)="again()">Send something else</button></div>
        </div>
      } @else {
        <form (submit)="$event.preventDefault(); submit()" novalidate>
          <div class="fb-kinds" role="radiogroup" aria-label="What would you like to do?">
            @for (k of kinds; track k) {
              <label class="fb-kind" [class.on]="kind() === k"><input type="radio" name="fbkind" [value]="k" [checked]="kind() === k" (change)="kind.set(k)" />{{ kindLabel[k] }}</label>
            }
          </div>

          @if (kind() === 'question' && teams().length) {
            <fieldset class="fb-who">
              <legend>Who should answer?</legend>
              <label class="fb-opt" [class.on]="to() === 'team'"><input type="radio" name="fbto" value="team" [checked]="to() === 'team'" (change)="to.set('team')" />
                <span><b>{{ teams().length === 1 || teamId() ? (teamName() + "'s coordinator") : "Your team's coordinator" }}</b><span class="small muted">The schedule, dues, travel, uniforms, the team itself</span></span></label>
              @if (to() === 'team' && teams().length > 1 && !pageTeam()) {
                <label class="fb-team">Which team?
                  <select [value]="teamId()" (change)="teamId.set($any($event.target).value)">
                    <option value="">Choose a team</option>
                    @for (t of teams(); track t.teamId) { <option [value]="t.teamId">{{ t.name || t.teamId }}</option> }
                  </select>
                </label>
              }
              <label class="fb-opt" [class.on]="to() === 'teemhub'"><input type="radio" name="fbto" value="teemhub" [checked]="to() === 'teemhub'" (change)="to.set('teemhub')" />
                <span><b>Teem Hub</b><span class="small muted">Signing in, a page or button, how the site works</span></span></label>
            </fieldset>
          }

          @if (!signedIn()) {
            <div class="two">
              <label>Your email<input type="email" autocomplete="email" [value]="email()" (input)="email.set($any($event.target).value)" required /></label>
              <label>Your name <span class="hint">(optional)</span><input autocomplete="name" [value]="name()" (input)="name.set($any($event.target).value)" /></label>
            </div>
            <!-- People leave this empty; bots fill it in. -->
            <div class="sr-only" aria-hidden="true"><label>Website<input tabindex="-1" autocomplete="off" [value]="website()" (input)="website.set($any($event.target).value)" /></label></div>
          }

          <label for="fb-msg" class="fb-label">{{ prompt() }}</label>
          <textarea id="fb-msg" rows="4" maxlength="4000" [placeholder]="placeholder()" [value]="message()" (input)="message.set($any($event.target).value)"></textarea>

          @if (suggestions().length) {
            <p class="fb-hint small">Might help:
              @for (t of suggestions(); track t.id; let last = $last) {
                <a [routerLink]="['/help', t.id]" [queryParams]="{ via: 'link' }" (click)="fb.close()">{{ t.title }}</a>@if (!last) { · }
              }
            </p>
          }

          @if (kind() === 'problem') {
            <div class="fb-shot">
              <span class="fb-label">A screenshot helps <span class="hint">(optional)</span></span>
              @if (shot(); as s) {
                <div class="fb-shot-on"><img [src]="s" alt="Your screenshot" /><button class="link" type="button" (click)="shot.set('')">Remove</button></div>
              } @else {
                <label class="fb-drop"><input type="file" accept="image/*" class="sr-only" (change)="pick($event)" />📎 Add a picture of the screen</label>
              }
            </div>
            <div class="fb-ctx small">
              <b>Sent with your report</b>
              <span>Page: {{ pageTitle() }}</span>
              @if (error(); as e) { <span>Error: “{{ e.message }}”@if (e.code && e.code !== 'shown') { ({{ e.code }})} at {{ time(e.at) }}</span> }
              @if (teamName() && signedIn()) { <span>Team: {{ teamName() }}@if (roles()) { · You: {{ roles() }}}</span> }
              <span>{{ device }} · {{ svc.version }}</span>
            </div>
          }

          @if (kind() === 'question' && to() === 'team' && teamId() && signedIn()) {
            <p class="small muted" style="margin:10px 0 0">Goes to the team's coordinators by email. Their reply comes to {{ email() }}.</p>
          }
          @if (problem()) { <p class="msg error" role="alert">{{ problem() }}</p> }
          <div class="row" style="justify-content:flex-end;margin-top:12px">
            <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Sending…' : sendLabel() }}</button>
          </div>
        </form>
      }
    </th-sheet>`
})
export class FeedbackSheet {
  readonly fb = inject(FeedbackState);
  readonly svc = inject(FeedbackService);
  private readonly auth = inject(AuthService);
  private readonly meSvc = inject(MeService);
  private readonly router = inject(Router);
  readonly kinds: FeedbackKind[] = ['question', 'problem', 'idea'];
  readonly kindLabel = KIND_LABEL;
  readonly device = deviceOf(navigator.userAgent);

  readonly kind = signal<FeedbackKind>('question');
  readonly to = signal<'team' | 'teemhub'>('team');
  readonly teamId = signal('');
  readonly message = signal('');
  readonly email = signal('');
  readonly name = signal('');
  readonly website = signal('');
  readonly shot = signal('');
  readonly busy = signal(false);
  readonly problem = signal('');
  readonly sent = signal<Sent | null>(null);

  private readonly url = toSignal(this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map(() => this.router.url)), { initialValue: this.router.url });
  readonly signedIn = computed(() => !!this.auth.user());
  /** Your teams (not archived). */
  readonly teams = computed(() => this.signedIn() ? (this.meSvc.me()?.teams ?? []).filter((t) => !t.archived) : []);
  /** The team whose page this is, if you're on it. */
  readonly pageTeam = computed(() => {
    const id = /^\/teams\/([^/?#]+)/.exec(this.url())?.[1];
    return id ? this.teams().find((t) => t.teamId === decodeURIComponent(id)) ?? null : null;
  });
  readonly team = computed(() => this.teams().find((t) => t.teamId === this.teamId()) ?? null);
  readonly teamName = computed(() => this.team()?.name || this.team()?.teamId || '');
  readonly roles = computed(() => (this.team()?.roles ?? []).map((r) => r[0].toUpperCase() + r.slice(1)).join(', '));
  readonly error = computed(() => this.fb.attachError());
  readonly pageTitle = computed(() => { void this.url(); return document.title.replace(/\s*[·|]\s*Teem Hub$/, '') || 'Teem Hub'; });

  readonly prompt = computed(() => ({ question: 'Your question', problem: 'What happened?', idea: 'Your idea' })[this.kind()]);
  readonly placeholder = computed(() => ({ question: 'Ask anything, like "Do we bring our own volleyballs?"', problem: 'What were you trying to do, and what happened instead?', idea: 'What would make Teem Hub better for you or your team?' })[this.kind()]);
  readonly sendLabel = computed(() => ({ question: 'Send question', problem: 'Send report', idea: 'Send idea' })[this.kind()]);
  /** Help topics that match what they're typing (questions and problems). */
  readonly suggestions = computed(() => this.kind() === 'idea' || this.message().trim().length < 8 ? [] : searchHelp(this.message(), HELP_TOPICS).slice(0, 2).map((h) => h.topic));

  constructor() {
    // Each time it opens: start fresh, on the chosen tab, for the team you're looking at.
    effect(() => {
      const k = this.fb.openAs();
      if (!k) return;
      untracked(() => {
        this.kind.set(k); this.message.set(''); this.shot.set(''); this.problem.set(''); this.sent.set(null); this.website.set('');
        const t = this.pageTeam() ?? (this.teams().length === 1 ? this.teams()[0] : null);
        this.teamId.set(t?.teamId ?? '');
        this.to.set(this.teams().length ? 'team' : 'teemhub');
        this.email.set(this.signedIn() ? (this.meSvc.me()?.email || this.auth.user()?.email || '') : '');
      });
    });
  }

  names(list: string[]) { return list.length ? list.join(' and ') : 'the team'; }
  time(iso: string) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }

  async pick(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.problem.set('');
    try { this.shot.set(await shrink(file)); } catch (err) { this.problem.set((err as Error).message); }
  }

  again() { this.fb.open(this.kind()); }

  async submit() {
    const message = this.message().trim();
    const question = this.kind() === 'question';
    const toTeam = question && this.to() === 'team' && this.teams().length > 0;
    if (message.length < 5) { this.problem.set('Write a little more so we can help.'); return; }
    if (toTeam && !this.teamId()) { this.problem.set('Choose the team to ask.'); return; }
    if (!this.signedIn() && !/^\S+@\S+\.\S+$/.test(this.email().trim())) { this.problem.set('Enter your email so we can reply.'); return; }
    this.busy.set(true); this.problem.set('');
    try {
      const e = this.error();
      const sent = await this.svc.send({
        kind: this.kind(), message,
        ...(question ? { to: toTeam ? 'team' as const : 'teemhub' as const } : {}),
        ...(this.teamId() ? { teamId: this.teamId() } : {}),
        page: { path: location.pathname.slice(0, 300), title: this.pageTitle().slice(0, 120) },
        ...(this.kind() === 'problem' && e ? { error: { code: e.code, message: e.message, at: e.at } } : {}),
        device: this.device, version: this.svc.version,
        ...(this.kind() === 'problem' && this.shot() ? { screenshot: this.shot() } : {}),
        ...(this.signedIn() ? {} : { email: this.email().trim(), name: this.name().trim() || undefined, website: this.website() || undefined })
      }, this.signedIn());
      this.sent.set(sent);
      this.fb.attachError.set(null);
    } catch (err) {
      this.problem.set(explain(err));
    } finally {
      this.busy.set(false);
    }
  }
}
