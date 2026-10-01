import { Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { MeService } from '../../core/me.service';
import type { ClubTeam } from '../../core/models';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';
import { roleLabel } from '../../shared/roles';

@Component({
  selector: 'th-home',
  imports: [ReactiveFormsModule, RouterLink, Messages],
  templateUrl: './home.html'
})
export class Home extends Page {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly user = this.auth.user;
  private readonly meSvc = inject(MeService);
  readonly me = this.meSvc.me;
  readonly editingName = signal(false);
  readonly nameForm = this.fb.group({ firstName: '', lastName: '' });
  readonly clubTeams = signal<ClubTeam[] | null>(null);
  readonly clubTeamsError = signal('');
  readonly roleLabel = roleLabel;
  readonly createForm = this.fb.group({ teamId: '', name: '', season: '', age: '' });

  constructor() {
    super();
    void this.load();
  }

  private async load() {
    try {
      const me = await this.meSvc.load(true);
      this.nameForm.reset({ firstName: me.firstName ?? '', lastName: me.lastName ?? '' });
      if (me.acceptedInvites && !this.notice()) {
        this.notice.set(`You've been added to ${me.acceptedInvites} team${me.acceptedInvites > 1 ? 's' : ''}.`);
      }
      if (me.clubAdmin) {
        try { this.clubTeams.set((await this.api.clubTeams()).teams); }
        catch (err) { this.clubTeamsError.set((err as Error).message); }
      }
    } catch (err) {
      this.me.set({ teams: [] });
      this.error.set((err as Error).message);
    }
  }

  saveName() {
    const v = this.nameForm.getRawValue();
    if (!v.firstName.trim()) { this.error.set('Enter your first name.'); return; }
    return this.run(async () => {
      await this.meSvc.setName(v.firstName, v.lastName);
      this.editingName.set(false);
      this.notice.set('Name saved. Your teams will see it.');
    });
  }

  createTeam() {
    const v = this.createForm.getRawValue();
    const teamId = v.teamId.trim().toLowerCase();
    return this.run(async () => {
      await this.api.createTeam({ teamId, name: v.name, season: v.season || undefined, age: v.age || undefined });
      return this.go(`/teams/${encodeURIComponent(teamId)}`, { notice: 'Team created.' });
    });
  }

  signOut() {
    return this.run(async () => {
      await this.auth.logOut();
      this.meSvc.clear();
      return this.go('/signin', { notice: "You've signed out." });
    });
  }
}
