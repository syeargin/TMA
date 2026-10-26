import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';
import { HELP_ROLE_LABELS, HELP_TOPICS, helpRolesFor, type HelpPlace, type HelpRole } from '@shared/help';
import { TeamStore } from '../../core/team-store';
import { Sheet } from '../../shared/sheet';
import { HelpSheetState } from './help-sheet-state';
import { placeOf } from './help-place';

/**
 * Help for the page you're on (the Help button on a team's tabs): its topics, for your roles and this
 * team's features. The team shell loads this on the first tap, so the topics aren't in every page's
 * first download.
 */
@Component({
  selector: 'th-help-sheet',
  imports: [Sheet, RouterLink],
  template: `
    <th-sheet heading="Help for this page" [open]="open()" (closed)="open.set(false)">
      <form role="search" class="help-search" (submit)="$event.preventDefault(); search(q.value)">
        <label class="sr-only" for="help-sheet-q">Search help</label>
        <input #q id="help-sheet-q" type="search" autocomplete="off" enterkeyhint="search" placeholder="Search all help">
      </form>
      @if (topics().length) {
        <ul class="help-list">
          @for (t of topics(); track t.id) {
            <li><a [routerLink]="['/help', t.id]" [queryParams]="{ via: 'context', team: store.teamId() }" (click)="open.set(false)">
              <b>{{ t.title }}</b><span class="small muted">{{ t.summary }}</span></a>
              @if (!mine().includes(t.role)) { <span class="pill p-mute">{{ labels[t.role] }}</span> }
            </li>
          }
        </ul>
      } @else {
        <p class="muted">No topics for this page yet.</p>
      }
      <p><a class="link" routerLink="/help" [queryParams]="{ team: store.teamId() }" (click)="open.set(false)">See every help topic</a></p>
    </th-sheet>`
})
export class HelpSheet {
  readonly store = inject(TeamStore);
  private readonly router = inject(Router);
  readonly open = inject(HelpSheetState).open;
  readonly labels = HELP_ROLE_LABELS;
  private readonly url = toSignal(this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map(() => this.router.url)), { initialValue: this.router.url });
  readonly place = computed<HelpPlace | null>(() => placeOf(this.url()));
  readonly mine = computed<HelpRole[]>(() => helpRolesFor(this.store.you().roles));

  /** This page's topics the team has the features for: yours first, then the rest. */
  readonly topics = computed(() => {
    const place = this.place();
    if (!place) return [];
    const mine = this.mine();
    return HELP_TOPICS
      // A tournament's section also shows the tournament's own topics (game-day sheet, calendar), after its own.
      .filter((t) => (t.places.includes(place) || (place.startsWith('tournament:') && t.places.includes('tournament'))) && (!t.feature || this.store.has(t.feature)))
      .map((t, i) => ({ t, rank: (mine.includes(t.role) ? 0 : 100) + (t.places.includes(place) ? t.places.indexOf(place) * 10 : 50) + i / 100 }))
      .sort((a, b) => a.rank - b.rank).map((x) => x.t);
  });

  search(q: string) {
    this.open.set(false);
    void this.router.navigate(['/help'], { queryParams: { q: q.trim() || null, team: this.store.teamId() } });
  }
}
