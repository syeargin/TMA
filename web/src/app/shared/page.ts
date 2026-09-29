import { Directive, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { explain } from '../core/errors';
import { Flash, FlashService } from '../core/flash.service';

/** Shared by screens: messages, the busy flag, and moving on with a one-time message. */
@Directive()
export abstract class Page {
  protected readonly router = inject(Router);
  protected readonly flash = inject(FlashService);
  readonly error = signal('');
  readonly notice = signal('');
  readonly busy = signal(false);

  constructor() {
    const f = this.flash.take();
    this.error.set(f.error ?? '');
    this.notice.set(f.notice ?? '');
  }

  /** Runs an action with the button disabled; failures show as a sentence at the top. */
  protected async run(fn: () => Promise<unknown>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await fn();
    } catch (err) {
      console.warn(err);
      this.error.set(explain(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected go(path: string, flash: Flash = {}) {
    this.flash.set(flash);
    return this.router.navigateByUrl(path);
  }
}
