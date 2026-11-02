import { Injectable, inject, signal } from '@angular/core';
import { FeedbackState } from './feedback';

/** Short confirmations at the bottom of the screen ("Saved", "Practice cancelled"). */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly message = signal('');
  readonly bad = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly fb = inject(FeedbackState);

  show(message: string, bad = false) {
    this.message.set(message);
    this.bad.set(bad);
    if (bad) this.fb.saw(message);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.message.set(''), bad ? 8000 : 2600);
  }
}
