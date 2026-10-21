import { Injectable, signal } from '@angular/core';

/** What the header shows: the team name and season line on team pages. Empty sub = the club's name. */
@Injectable({ providedIn: 'root' })
export class HeaderService {
  readonly title = signal('Teem Hub');
  readonly sub = signal('');
  reset() { this.title.set('Teem Hub'); this.sub.set(''); }
}
