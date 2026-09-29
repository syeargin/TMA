import { Injectable } from '@angular/core';

export interface Flash { notice?: string; error?: string }

/** A one-time message carried to the next screen ("Password updated…", "You no longer have access…"). */
@Injectable({ providedIn: 'root' })
export class FlashService {
  private next: Flash = {};
  set(flash: Flash) { this.next = flash; }
  take(): Flash { const f = this.next; this.next = {}; return f; }
}
