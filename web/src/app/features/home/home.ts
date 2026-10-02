import { Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { MeService } from '../../core/me.service';
import type { Club, MyClub, MyTeam } from '../../core/models';
import { DEFAULT_COLORS } from '../../core/theme';
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
  readonly roleLabel = roleLabel;
  /** Site owners: every club. */
  readonly allClubs = signal<Club[] | null>(null);
  readonly clubForm = this.fb.group({ clubId: '', name: '', short: '', adminEmail: '', primary: DEFAULT_COLORS.primary, accent: DEFAULT_COLORS.accent });

  readonly adminClubs = computed(() => (this.me()?.clubs ?? []).filter((c) => c.admin));
  /** Your teams, under their club when you're in more than one club. */
  readonly groups = computed(() => {
    const me = this.me();
    if (!me) return [];
    const clubs = new Map((me.clubs ?? []).map((c) => [c.clubId, c]));
    const out: { club: MyClub | null; teams: MyTeam[] }[] = [];
    for (const t of me.teams) {
      const club = (t.clubId && clubs.get(t.clubId)) || null;
      let g = out.find((x) => x.club?.clubId === club?.clubId);
      if (!g) out.push((g = { club, teams: [] }));
      g.teams.push(t);
    }
    return out.sort((a, b) => (a.club?.name ?? '').localeCompare(b.club?.name ?? ''));
  });
  readonly showClubNames = computed(() => this.groups().length > 1);

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
      if (me.platformAdmin) await this.loadClubs();
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

  private async loadClubs() {
    try { this.allClubs.set((await this.api.clubs()).clubs); }
    catch (err) { this.error.set((err as Error).message); }
  }

  /** Site owners: add a club and invite its first admin. */
  createClub() {
    const v = this.clubForm.getRawValue();
    const clubId = v.clubId.trim().toLowerCase();
    if (!clubId || !v.name.trim()) { this.error.set('Enter a club id and name.'); return; }
    return this.run(async () => {
      await this.api.createClub({
        clubId, name: v.name.trim(), short: v.short.trim() || undefined,
        colors: { primary: v.primary, accent: v.accent },
        adminEmails: v.adminEmail.trim() ? [v.adminEmail.trim()] : []
      });
      this.clubForm.reset({ clubId: '', name: '', short: '', adminEmail: '', primary: DEFAULT_COLORS.primary, accent: DEFAULT_COLORS.accent });
      this.notice.set(v.adminEmail.trim()
        ? `Club added. ${v.adminEmail.trim()} can now create an account and will be its admin.`
        : 'Club added. Open it to invite its admins.');
      await this.loadClubs();
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
