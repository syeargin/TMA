import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormArray, FormControl, FormGroup, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { HeaderService } from '../../core/header.service';
import { MeService, fullName } from '../../core/me.service';
import type { ClubDetail, ClubLink, ClubTeam } from '../../core/models';
import { DEFAULT_COLORS, colorAdvice, isHex } from '../../core/theme';
import { ThemeService } from '../../core/theme.service';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';

type LinkForm = FormGroup<{ label: FormControl<string>; url: FormControl<string> }>;

/** Ready-made pairs to start from; any color can be picked. */
const PRESETS: { name: string; primary: string; accent: string }[] = [
  { name: 'Navy & red', ...DEFAULT_COLORS },
  { name: 'Royal & gold', primary: '#1D3F9A', accent: '#F2B705' },
  { name: 'Forest & white', primary: '#14532D', accent: '#9AD3A5' },
  { name: 'Maroon & gold', primary: '#6B0F1A', accent: '#E8B33A' },
  { name: 'Black & orange', primary: '#111111', accent: '#F26B21' },
  { name: 'Purple & teal', primary: '#4B1E78', accent: '#19B3B1' },
  { name: 'Columbia & navy', primary: '#2E6DB4', accent: '#9BD3F5' }
];

/** /clubs/:clubId — a club admin's page: name and colors, Team Info links, teams, and admins. */
@Component({
  selector: 'th-club-admin',
  imports: [ReactiveFormsModule, RouterLink, Messages, DatePipe],
  templateUrl: './club-admin.html'
})
export class ClubAdminPage extends Page {
  readonly clubId = input.required<string>();
  private readonly api = inject(ApiService);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly theme = inject(ThemeService);
  private readonly header = inject(HeaderService);
  private readonly meSvc = inject(MeService);

  readonly detail = signal<ClubDetail | null>(null);
  readonly loadError = signal('');
  readonly confirming = signal<string | null>(null);
  readonly presets = PRESETS;
  readonly fullName = fullName;
  readonly mySub = computed(() => this.meSvc.me()?.sub ?? '');
  /** Site owners archive, restore and delete teams. */
  readonly owner = computed(() => !!this.meSvc.me()?.platformAdmin);
  readonly managing = signal<string | null>(null);
  readonly deleteText = signal('');
  /** Current teams first, then archived ones. */
  readonly teams = computed(() => [...(this.detail()?.teams ?? [])].sort((a, b) =>
    Number(!!a.archived) - Number(!!b.archived) || a.name.localeCompare(b.name)));

  readonly form = this.fb.group({
    name: '', short: '', primary: DEFAULT_COLORS.primary, accent: DEFAULT_COLORS.accent, notes: '',
    links: new FormArray<LinkForm>([])
  });
  readonly teamForm = this.fb.group({ teamId: '', name: '', season: '', age: '' });
  readonly adminForm = this.fb.group({ firstName: '', lastName: '', email: '' });

  private readonly values = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  readonly colors = computed(() => {
    const v = this.values();
    return { primary: isHex(v.primary) ? v.primary! : DEFAULT_COLORS.primary, accent: isHex(v.accent) ? v.accent! : DEFAULT_COLORS.accent };
  });
  readonly advice = computed(() => colorAdvice(this.colors()));
  readonly unsavedColors = computed(() => {
    const c = this.detail()?.club.colors;
    return !!c && (c.primary.toUpperCase() !== this.colors().primary.toUpperCase() || c.accent.toUpperCase() !== this.colors().accent.toUpperCase());
  });

  constructor() {
    super();
    effect(() => { const id = this.clubId(); untracked(() => void this.load(id)); });
    // Preview: the whole page takes on the colors as they're picked.
    effect(() => {
      const d = this.detail();
      if (d) this.theme.page.set({ name: this.values().name || d.club.name, colors: this.colors() });
    });
    effect(() => {
      const d = this.detail();
      this.header.title.set(d?.club.name ?? 'Club');
      this.header.sub.set('Club settings');
    });
    inject(DestroyRef).onDestroy(() => { this.theme.page.set(undefined); this.header.reset(); });
  }

  get links() { return this.form.controls.links; }

  private async load(clubId: string) {
    try {
      const d = await this.api.club(clubId);
      this.detail.set(d);
      this.fill(d);
    } catch (err) {
      this.loadError.set((err as Error).message);
    }
  }

  private fill(d: ClubDetail) {
    const c = d.club;
    this.links.clear();
    for (const l of c.links) this.links.push(this.linkForm(l));
    this.form.reset({ name: c.name, short: c.short, primary: c.colors.primary, accent: c.colors.accent, notes: c.notes });
    if (!this.teamForm.dirty) this.teamForm.reset({ teamId: `${c.clubId}-`, name: '', season: '', age: '' });
  }

  private linkForm(l?: ClubLink): LinkForm {
    return this.fb.group({ label: l?.label ?? '', url: l?.url ?? 'https://' });
  }
  addLink() { this.links.push(this.linkForm()); this.form.markAsDirty(); }
  removeLink(i: number) { this.links.removeAt(i); this.form.markAsDirty(); }

  usePreset(p: { primary: string; accent: string }) { this.form.patchValue({ primary: p.primary, accent: p.accent }); this.form.markAsDirty(); }
  /** Typing in the hex box: accept "#abc123" or "abc123". */
  typedHex(which: 'primary' | 'accent', raw: string) {
    const v = raw.trim().startsWith('#') ? raw.trim() : '#' + raw.trim();
    if (isHex(v)) this.form.controls[which].setValue(v.toUpperCase());
  }

  save() {
    const v = this.form.getRawValue();
    if (!v.name.trim()) { this.error.set("Enter the club's name."); return; }
    const links = v.links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })).filter((l) => l.label || (l.url && l.url !== 'https://'));
    const bad = links.find((l) => !l.label || !/^https?:\/\/\S+\.\S+/i.test(l.url));
    if (bad) { this.error.set(`Each link needs a name and a web address starting with https:// ("${bad.label || bad.url}").`); return; }
    return this.run(async () => {
      const club = await this.api.saveClub(this.clubId(), { name: v.name.trim(), short: v.short.trim(), colors: this.colors(), links, notes: v.notes.trim() });
      const d = this.detail()!;
      this.detail.set({ ...d, club: { ...club, clubId: d.club.clubId } });
      this.fill(this.detail()!);
      void this.meSvc.load(true).catch(() => {});
      this.notice.set('Club saved. Every team in the club now shows these colors and links.');
    });
  }

  resetColors() { this.form.patchValue({ ...(this.detail()?.club.colors ?? DEFAULT_COLORS) }); }

  createTeam() {
    const v = this.teamForm.getRawValue();
    const teamId = v.teamId.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(teamId) || !v.name.trim()) { this.error.set('Enter a team id (lowercase letters, numbers and dashes) and a team name.'); return; }
    return this.run(async () => {
      await this.api.createTeam({ clubId: this.clubId(), teamId, name: v.name.trim(), season: v.season.trim() || undefined, age: v.age.trim() || undefined });
      return this.go(`/teams/${encodeURIComponent(teamId)}`, { notice: 'Team created.' });
    });
  }

  manage(teamId: string) {
    this.managing.set(this.managing() === teamId ? null : teamId);
    this.deleteText.set('');
    this.confirming.set(null);
  }

  setArchived(t: ClubTeam, archived: boolean) {
    const done = archived ? `${t.name} is archived. Its families can still look back at it, read-only.` : `${t.name} is restored and can be changed again.`;
    const action = () => this.api.setArchived(t.teamId, archived);
    // Archiving asks for a second tap; restoring is harmless.
    if (!archived) this.confirming.set(`restore:${t.teamId}`);
    return this.confirmThen(`${archived ? 'archive' : 'restore'}:${t.teamId}`, done, action, async () => {
      this.managing.set(null);
      this.notice.set(done);
      await this.refresh();
    });
  }

  deleteTeam(t: ClubTeam) {
    if (this.deleteText().trim() !== t.teamId) { this.error.set(`Type ${t.teamId} to confirm.`); return; }
    return this.run(async () => {
      await this.api.deleteTeam(t.teamId, this.deleteText().trim());
      this.managing.set(null);
      this.deleteText.set('');
      this.notice.set(`${t.name} and all its data are deleted.`);
      await this.refresh();
      void this.meSvc.load(true).catch(() => {});
    });
  }

  inviteAdmin() {
    const v = this.adminForm.getRawValue();
    if (!v.email.trim()) { this.error.set('Enter their email address.'); return; }
    return this.run(async () => {
      await this.api.inviteClubAdmin(this.clubId(), { email: v.email.trim(), firstName: v.firstName.trim() || undefined, lastName: v.lastName.trim() || undefined });
      this.adminForm.reset({ firstName: '', lastName: '', email: '' });
      this.notice.set(`Invited ${v.email.trim()}. They become an admin when they next sign in, or when they create an account with that email.`);
      await this.refresh();
    });
  }

  removeAdmin(sub: string) {
    const self = sub === this.mySub();
    return this.confirmThen(`admin:${sub}`, 'Admin removed.', () => this.api.removeClubAdmin(this.clubId(), sub), self
      ? async () => { await this.meSvc.load(true).catch(() => {}); await this.go('/', { notice: `You're no longer an admin of ${this.detail()?.club.name ?? 'the club'}.` }); }
      : undefined);
  }
  withdraw(email: string) { return this.confirmThen(`invite:${email}`, 'Invite withdrawn.', () => this.api.withdrawClubInvite(this.clubId(), email)); }

  private confirmThen(key: string, done: string, action: () => Promise<unknown>, after?: () => Promise<unknown>) {
    if (this.confirming() !== key) { this.confirming.set(key); return; }
    this.confirming.set(null);
    return this.run(async () => {
      await action();
      if (after) { await after(); return; }
      this.notice.set(done);
      await this.refresh();
    });
  }

  private async refresh() {
    const d = await this.api.club(this.clubId());
    const cur = this.detail();
    // Keep unsaved edits to the club form; only teams and admins change here.
    this.detail.set(cur ? { ...d, club: cur.club } : d);
  }
}
