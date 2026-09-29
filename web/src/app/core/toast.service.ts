import { Injectable, signal } from '@angular/core';

/** Short confirmations at the bottom of the screen ("Saved", "Practice cancelled"). */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly message = signal('');
  readonly bad = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;

  show(message: string, bad = false) {
    this.message.set(message);
    this.bad.set(bad);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.message.set(''), bad ? 5000 : 2600);
  }
}
