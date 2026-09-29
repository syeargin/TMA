import { Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ROLES, can } from '@shared/permissions';
import { ApiError, ApiService } from '../../core/api.service';
import { LiveService } from '../../core/live.service';
import type { Invite, Member, TeamBundle } from '../../core/models';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';
import { RoleChecks, pickedRoles, roleChecks, roleLabel, roleList } from '../../shared/roles';

/** Collections this screen shows; changes to others (meals, ledger…) don't need a refresh here. */
const SHOWN = new Set(['*', 'members', 'invites', 'players', 'events', 'settings']);
const NO_ACCESS = 'You no longer have access to that team.';

interface MemberForm { roles: RoleChecks; pid: FormControl<string> }

@Component({
  selector: 'th-team',
  imports: [ReactiveFormsModule, RouterLink, Messages],
  templateUrl: './team.html'
})
export class Team extends Page {
  /** From the route: /teams/:teamId */
  readonly teamId = input.required<string>();

  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly team = signal<TeamBundle | null>(null);
  readonly invites = signal<Invite[]>([]);
  readonly memberForms = signal(new Map<string, MemberForm>());
  /** "member:<sub>" or "invite:<email>" awaiting a second tap. */
  readonly confirming = signal<string | null>(null);
  readonly fresh = signal(false);

  readonly roles = ROLES;
  readonly roleLabel = roleLabel;
  readonly roleList = roleList;
  readonly manage = computed(() => can(this.team()?.you.roles ?? [], 'accounts'));
  readonly title = computed(() => { const t = this.team(); return t?.team?.name || t?.settings?.teamName || t?.teamId || ''; });

  readonly inviteForm = this.fb.group({ email: '', roles: roleChecks(['parent']), pid: '' });

  constructor() {
    super();
    effect(() => {
      const id = this.teamId();
      untracked(() => void this.open(id));
    });
    this.live.changes.pipe(takeUntilDestroyed()).subscribe((c) => {
      if (c.teamId === this.team()?.teamId) void this.refresh(c.collections);
    });
    this.live.denied.pipe(takeUntilDestroyed()).subscribe((id) => {
      if (id === this.team()?.teamId) void this.go('/', { error: NO_ACCESS });
    });
    this.live.showHeld.pipe(takeUntilDestroyed()).subscribe(() => void this.refresh(['*'], true));
    inject(DestroyRef).onDestroy(() => this.live.stop());
  }

  /** First load for a team (also on switching teams). */
  private async open(teamId: string) {
    try {
      await this.load(teamId);
      this.live.watch(teamId);
    } catch (err) {
      void this.go('/', { error: (err as Error).message });
    }
  }

  private async load(teamId: string) {
    const team = await this.api.team(teamId);
    const invites = can(team.you.roles, 'accounts') ? (await this.api.invites(teamId)).invites : [];
    this.team.set(team);
    this.invites.set(invites);
    this.memberForms.set(new Map(team.members.filter((m) => m.sub).map((m) => [m.sub!, this.memberForm(m)])));
    this.inviteForm.reset({ email: '', roles: Object.fromEntries(ROLES.map((r) => [r, r === 'parent'])), pid: '' });
    this.confirming.set(null);
    this.live.held.set(false);
  }

  private memberForm(m: Member): MemberForm {
    return { roles: roleChecks(m.roles), pid: new FormControl(m.pid ?? '', { nonNullable: true }) };
  }

  /** Someone has typed, ticked a box, or is in a field: don't redraw under them. */
  isEditing(): boolean {
    const a = document.activeElement;
    if (a && this.host.nativeElement.contains(a) && a.closest('form') && a.matches('input,select,textarea')) return true;
    if (this.inviteForm.dirty) return true;
    for (const f of this.memberForms().values()) if (f.roles.dirty || f.pid.dirty) return true;
    return false;
  }

  /** A live notice arrived (or the person asked to see held changes). */
  async refresh(collections: string[], force = false) {
    const id = this.team()?.teamId;
    if (!id) return;
    if (!force && !collections.some((c) => SHOWN.has(c))) return;
    if (!force && this.isEditing()) { this.live.held.set(true); return; }
    try {
      await this.load(id);
      this.fresh.set(false);
      requestAnimationFrame(() => this.fresh.set(true));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) { void this.go('/', { error: NO_ACCESS }); return; }
      console.warn('Live refresh failed', err);
    }
  }

  /** Apply a held-back change once the person steps out of a form without leaving edits behind. */
  onFocusOut() {
    setTimeout(() => { if (this.live.held() && !this.isEditing()) void this.refresh(['*']); }, 0);
  }

  sendInvite() {
    const id = this.team()!.teamId;
    const v = this.inviteForm.getRawValue();
    const email = v.email.trim().toLowerCase();
    return this.run(async () => {
      await this.api.invite(id, { email, roles: pickedRoles(this.inviteForm.controls.roles), pid: v.pid || undefined });
      await this.load(id);
      this.notice.set(`Invited ${email}.`);
    });
  }

  saveMember(sub: string) {
    const id = this.team()!.teamId;
    const f = this.memberForms().get(sub)!;
    return this.run(async () => {
      await this.api.updateMember(id, sub, { roles: pickedRoles(f.roles), pid: f.pid.value || undefined });
      await this.load(id);
      this.notice.set('Roles saved.');
    });
  }

  removeMember(sub: string) {
    return this.confirmThen(`member:${sub}`, 'Removed from the team.', (id) => this.api.removeMember(id, sub));
  }

  cancelInvite(email: string) {
    return this.confirmThen(`invite:${email}`, 'Invite cancelled.', (id) => this.api.cancelInvite(id, email));
  }

  private confirmThen(key: string, done: string, action: (teamId: string) => Promise<unknown>) {
    if (this.confirming() !== key) { this.confirming.set(key); return; }
    const id = this.team()!.teamId;
    return this.run(async () => {
      await action(id);
      await this.load(id);
      this.notice.set(done);
    });
  }
}
