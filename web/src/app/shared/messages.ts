import { Component, effect, inject, input } from '@angular/core';
import { FeedbackState } from '../core/feedback';

/** A screen's error and notice. An error gets "Report this", which opens a problem report with it filled in. */
@Component({
  selector: 'th-messages',
  template: `
    @if (error()) { <p class="msg error" role="alert">{{ error() }} <button type="button" class="link msg-report" (click)="report()">Report this</button></p> }
    @if (notice()) { <p class="msg notice" role="status">{{ notice() }}</p> }`
})
export class Messages {
  readonly error = input('');
  readonly notice = input('');
  private readonly fb = inject(FeedbackState);
  constructor() {
    effect(() => { const e = this.error(); if (e) this.fb.saw(e); });
  }
  report() { this.fb.open('problem', true); }
}
