import { Injectable, signal } from '@angular/core';

/** What the header shows: the team name and season line on team pages, the club otherwise. */
@Injectable({ providedIn: 'root' })
export class HeaderService {
  readonly title = signal('Team Hub');
  readonly sub = signal('A5 Volleyball');
  reset() { this.title.set('Team Hub'); this.sub.set('A5 Volleyball'); }
}
