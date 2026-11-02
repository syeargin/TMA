import { Component, inject, signal } from '@angular/core';
import { FeedbackService, FeedbackState, KIND_NOUN, STATUS_LABEL, type MyFeedback } from '../../core/feedback';

/** Account page: questions, reports and ideas you've sent, and the replies. */
@Component({
  selector: 'th-my-feedback',
  template: `
    <section class="acct" id="feedback">
      <h3>Your questions and reports</h3>
      @if (items(); as list) {
        @if (!list.length) {
          <p class="small">Nothing sent yet. Use <b>Questions &amp; feedback</b> at the bottom of any page to ask, report a problem or suggest an idea.</p>
        } @else {
          <p class="small muted">{{ list.length }} sent · {{ answered(list) }} answered</p>
          <ul class="fb-mine">
            @for (f of list; track f.id) {
              <li>
                <details>
                  <summary>
                    <span class="grow"><b>{{ first(f.message) }}</b>
                      <span class="small muted">{{ kind[f.kind] }} · {{ f.route === 'team' ? 'to ' + (f.sentTo.join(' and ') || f.teamName) : 'to Teem Hub' }} · {{ f.ref }} · {{ day(f.createdAt) }}</span></span>
                    <span class="pill" [class.p-ok]="f.replies.length || f.status === 'closed'" [class.p-mute]="!f.replies.length && f.status !== 'closed'">{{ f.route === 'team' ? 'Sent to the team' : status[f.status] }}</span>
                  </summary>
                  <div class="fb-thread">
                    <p class="fb-said">{{ f.message }}</p>
                    @for (r of f.replies; track r.at) {
                      <div class="fb-reply"><span class="small muted">{{ r.byName }}, Teem Hub · {{ day(r.at) }}</span><p>{{ r.message }}</p></div>
                    }
                    @if (f.route === 'team') { <p class="small muted">The coordinators reply by email, so their answer is in your inbox.</p> }
                  </div>
                </details>
              </li>
            }
          </ul>
        }
      } @else if (failed()) {
        <p class="small muted">Couldn't load what you've sent. Reload to try again.</p>
      }
      <button class="btn sm" type="button" (click)="fb.open()">Ask, report or suggest</button>
    </section>`
})
export class MyFeedbackList {
  private readonly svc = inject(FeedbackService);
  readonly fb = inject(FeedbackState);
  readonly items = signal<MyFeedback[] | null>(null);
  readonly failed = signal(false);
  readonly kind = KIND_NOUN;
  readonly status = STATUS_LABEL;
  constructor() { this.svc.mine().then((x) => this.items.set(x)).catch(() => this.failed.set(true)); }
  first(s: string) { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 70 ? t.slice(0, 68) + '…' : t; }
  day(iso: string) { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  answered(list: MyFeedback[]) { return list.filter((f) => f.replies.length).length; }
}
