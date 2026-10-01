import { Component, DestroyRef, effect, inject, input, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { FlashService } from '../core/flash.service';
import { HeaderService } from '../core/header.service';
import { TeamStore } from '../core/team-store';
import { Router } from '@angular/router';
import { AvailabilitySheet } from '../features/schedule/availability-sheet';

/** /teams/:teamId — loads the team once for all its tabs and keeps it live. */
@Component({
  selector: 'th-team-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, AvailabilitySheet],
  providers: [TeamStore],
  template: `
    <nav class="tabs" aria-label="Team sections">
      <div class="tabs-in">
        <a class="tab" routerLink="/" title="All your teams">‹ Teams</a>
        <a class="tab" routerLink="." routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page">Home</a>
        <a class="tab" routerLink="schedule" routerLinkActive="active" ariaCurrentWhenActive="page">Schedule</a>
        <a class="tab" routerLink="tournaments" routerLinkActive="active" ariaCurrentWhenActive="page">Tournaments</a>
        <a class="tab" routerLink="fund" routerLinkActive="active" ariaCurrentWhenActive="page">Team Fund</a>
        <a class="tab" routerLink="roster" routerLinkActive="active" ariaCurrentWhenActive="page">Roster</a>
        <a class="tab" routerLink="info" routerLinkActive="active" ariaCurrentWhenActive="page">Team Info</a>
        @if (store.can('accounts')) {
          <a class="tab" routerLink="members" routerLinkActive="active" ariaCurrentWhenActive="page">Members</a>
        }
      </div>
    </nav>
    <main (focusout)="store.applyHeldIfIdle()">
      @if (store.bundle()) {
        <router-outlet />
        <th-availability-sheet />
      } @else if (store.loadError()) {
        <div class="banner"><p><b>This team didn't load.</b> {{ store.loadError() }}</p><a class="btn sm" routerLink="/">Your teams</a></div>
      } @else {
        <div class="card card-b" style="padding:20px"><div class="label">Loading team</div>
          @for (i of [1, 2, 3, 4, 5]; track i) { <div class="skel"></div> }
        </div>
      }
    </main>`
})
export class TeamShell {
  readonly teamId = input.required<string>();
  readonly store = inject(TeamStore);
  private readonly header = inject(HeaderService);
  private readonly router = inject(Router);
  private readonly flash = inject(FlashService);

  constructor() {
    effect(() => {
      const id = this.teamId();
      untracked(() => void this.store.open(id));
    });
    // Header: team name, then club · season · coaches.
    effect(() => {
      const s = this.store.settings();
      if (!s) return;
      this.header.title.set(s.teamName || this.store.teamId());
      const coaches = (s.coaches ?? []).map((c) => c.name).join(' & ');
      this.header.sub.set(['A5 Volleyball', s.season ? `${s.season} season` : '', coaches].filter(Boolean).join(' · '));
    });
    this.store.lost.pipe(takeUntilDestroyed()).subscribe(() => {
      this.flash.set({ error: 'You no longer have access to that team.' });
      void this.router.navigateByUrl('/');
    });
    inject(DestroyRef).onDestroy(() => this.header.reset());
  }
}
