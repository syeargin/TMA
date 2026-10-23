import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ROLES } from '@shared/permissions';
import { roleFeature } from '@shared/features';
import { ApiService } from '../../core/api.service';
import { MeService, fullName } from '../../core/me.service';
import type { Invite, Member } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { EmailStatusView } from '../../shared/email-status';
import { ExportButton } from '../../shared/export-button';
import { ImportPanel } from '../../shared/import-panel';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';
import { RoleChecks, pickedRoles, roleChecks, roleLabel, roleList } from '../../shared/roles';

type MemberForm = FormGroup<{ roles: RoleChecks; pid: FormControl<string>; firstName: FormControl<string>; lastName: FormControl<string> }>;

/** Team admins: who's on the team, their roles and family, and pending invites. */
@Component({
  selector: 'th-members',
  imports: [ReactiveFormsModule, Messages, ImportPanel, ExportButton, EmailStatusView],
  templateUrl: './members.html'
})
export class Members extends Page {
  readonly store = inject(TeamStore);
  private readonly api = inject(ApiService);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly meSvc = inject(MeService);

  readonly invites = signal<Invite[]>([]);
  readonly memberForms = signal(new Map<string, MemberForm>());
  readonly confirming = signal<string | null>(null);
  readonly roles = ROLES;
  /** Finance and Food only show while their feature is on, unless this person already has the role. */
  roleShown(r: string, has: readonly string[] = []) {
    const f = roleFeature(r);
    return !f || this.store.has(f) || has.includes(r);
  }
  readonly roleLabel = roleLabel;
  readonly roleList = roleList;
  readonly inviteForm = this.fb.group({ firstName: '', lastName: '', email: '', roles: roleChecks(['parent']), pid: '', sendEmail: true });
  /** Invites saved but never emailed, like the ones a spreadsheet import makes. */
  readonly unsent = computed(() => this.invites().filter((i) => !i.emailStatus && !i.expired));
  readonly fullName = fullName;

  constructor() {
    super();
    // Rebuild the per-member forms whenever the team reloads (live refreshes wait while one is being edited).
    effect(() => {
      const members = this.store.members();
      untracked(() => this.memberForms.set(new Map(members.filter((m) => m.sub).map((m) => [m.sub!, this.memberForm(m)]))));
    });
    void this.loadInvites();
    this.store.changed.pipe(takeUntilDestroyed()).subscribe((c) => { if (c.includes('invites') || c.includes('*')) void this.loadInvites(); });
    const unregister = this.store.registerEditor(() => this.isEditing());
    inject(DestroyRef).onDestroy(unregister);
  }

  private memberForm(m: Member): MemberForm {
    const c = (v?: string) => new FormControl(v ?? '', { nonNullable: true });
    return new FormGroup({ roles: roleChecks(m.roles), pid: c(m.pid), firstName: c(m.firstName), lastName: c(m.lastName) });
  }

  playerLabel(pid?: string) { const n = this.store.playerName(pid); return n ? `${n} (${pid})` : pid ?? ''; }

  private isEditing(): boolean {
    if (this.inviteForm.dirty) return true;
    for (const f of this.memberForms().values()) if (f.dirty) return true;
    return false;
  }

  private async loadInvites() {
    try { this.invites.set((await this.api.invites(this.store.teamId())).invites); }
    catch (err) { this.error.set((err as Error).message); }
  }

  private async reload() {
    await this.store.load();
    await this.loadInvites();
    this.inviteForm.reset({ firstName: '', lastName: '', email: '', roles: Object.fromEntries(ROLES.map((r) => [r, r === 'parent'])), pid: '', sendEmail: true });
    this.confirming.set(null);
  }

  async afterImport(message: string) {
    await this.reload();
    this.notice.set(message);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  sendInvite() {
    const v = this.inviteForm.getRawValue();
    const email = v.email.trim().toLowerCase();
    return this.run(async () => {
      await this.api.invite(this.store.teamId(), { email, firstName: v.firstName.trim() || undefined, lastName: v.lastName.trim() || undefined, roles: pickedRoles(this.inviteForm.controls.roles), pid: v.pid || undefined, sendEmail: v.sendEmail });
      await this.reload();
      this.notice.set(v.sendEmail ? `Invited ${email}. The invite email is on its way.` : `Invited ${email}. No email was sent; use "Email invite" when you're ready.`);
    });
  }

  saveMember(sub: string) {
    const f = this.memberForms().get(sub)!;
    return this.run(async () => {
      await this.api.updateMember(this.store.teamId(), sub, { roles: pickedRoles(f.controls.roles), pid: f.controls.pid.value || undefined, firstName: f.controls.firstName.value.trim(), lastName: f.controls.lastName.value.trim() });
      await this.reload();
      if (sub === this.store.you().sub) await this.meSvc.load(true).catch(() => undefined);
      this.notice.set('Roles saved.');
    });
  }

  removeMember(sub: string) { return this.confirmThen(`member:${sub}`, 'Removed from the team.', () => this.api.removeMember(this.store.teamId(), sub)); }
  /** Emails the invite (again). An expired one (R30) gets at least two more weeks. */
  emailInvite(i: Invite) {
    return this.run(async () => {
      const r = await this.api.emailInvite(this.store.teamId(), i.email);
      const until = new Date(r.expires).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
      this.notice.set(`Emailed the invite to ${i.email}. It works until ${until}.`);
      await this.loadInvites();
    });
  }

  emailWaiting() {
    return this.run(async () => {
      const { queued } = await this.api.emailWaitingInvites(this.store.teamId());
      this.notice.set(queued ? `Emailing ${queued} invite${queued === 1 ? '' : 's'}. Each one shows when it's delivered.` : 'Every waiting invite has already been emailed.');
      await this.loadInvites();
    });
  }

  /** Mail to a bounced address, or to someone who marked it as spam, isn't sent again. */
  canEmail(i: Invite) { return i.emailStatus !== 'bounced' && i.emailStatus !== 'complained'; }

  expires(i: Invite) {
    if (!i.ttl) return '';
    return new Date(i.ttl * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  cancelInvite(email: string) { return this.confirmThen(`invite:${email}`, 'Invite cancelled.', () => this.api.cancelInvite(this.store.teamId(), email)); }

  private confirmThen(key: string, done: string, action: () => Promise<unknown>) {
    if (this.confirming() !== key) { this.confirming.set(key); return; }
    return this.run(async () => { await action(); await this.reload(); this.notice.set(done); });
  }
}
