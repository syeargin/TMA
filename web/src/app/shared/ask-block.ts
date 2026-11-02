import { Component, inject, input } from '@angular/core';
import { FeedbackState, type FeedbackKind } from '../core/feedback';

/** "Didn't find it?" under help: ask, report or suggest (shared/feedback-sheet). */
@Component({
  selector: 'th-ask-block',
  template: `
    <section class="ask-block" aria-labelledby="ask-h">
      <h4 id="ask-h">{{ heading() }}</h4>
      <div class="ask-opts">
        @for (o of opts; track o.kind) {
          <button type="button" class="ask-opt" aria-haspopup="dialog" (click)="open(o.kind)"><span class="ask-ic" [class]="'ask-ic ' + o.kind" aria-hidden="true">{{ o.icon }}</span>{{ o.label }}</button>
        }
      </div>
    </section>`
})
export class AskBlock {
  readonly heading = input("Didn't find it?");
  /** Something to do first, like closing the help sheet. */
  readonly before = input<(() => void) | null>(null);
  private readonly fb = inject(FeedbackState);
  readonly opts: { kind: FeedbackKind; label: string; icon: string }[] = [
    { kind: 'question', label: 'Ask a question', icon: '?' },
    { kind: 'problem', label: 'Report a problem', icon: '!' },
    { kind: 'idea', label: 'Suggest an idea', icon: '✦' }
  ];
  open(kind: FeedbackKind) { this.before()?.(); this.fb.open(kind); }
}
