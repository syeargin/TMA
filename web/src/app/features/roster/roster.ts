import { Component, computed, inject, input, signal } from '@angular/core';
import { FormArray, FormControl, FormGroup, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { newId } from '../../core/dates';
import type { Parent, Player } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { ToastService } from '../../core/toast.service';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';

type ParentGroup = FormGroup<{ name: FormControl<string>; cell: FormControl<string>; email: FormControl<string> }>;
const parentGroup = (p?: Parent): ParentGroup => new FormGroup({
  name: new FormControl(p?.name ?? '', { nonNullable: true }),
  cell: new FormControl(p?.cell ?? '', { nonNullable: true }),
  email: new FormControl(p?.email ?? '', { nonNullable: true })
});

/** Players and parents (Roster) and the team uniform order (Uniforms). */
@Component({
  selector: 'th-roster',
  imports: [ReactiveFormsModule, RouterLink, Sheet, Messages],
  templateUrl: './roster.html'
})
export class Roster {
  /** From the route: /roster or /roster/uniforms */
  readonly section = input<string>('');
  readonly store = inject(TeamStore);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly toast = inject(ToastService);

  get manage() { return this.store.can('roster'); }
  get myPid() { return this.store.myPid(); }
  readonly uniforms = computed(() => this.section() === 'uniforms');
  readonly emails = computed(() => this.store.players().flatMap((p) => (p.parents ?? []).map((x) => x.email).filter((e): e is string => !!e)));
  readonly linked = computed(() => new Set(this.store.members().map((m) => m.pid).filter(Boolean)));
  hasAllergy(p: Player) { return !!p.allergies && !/^\s*(none|n\/a|no)\s*$/i.test(p.allergies); }

  async copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); this.toast.show(`${what} copied`); }
    catch { this.toast.show(text); }
  }

  // ----- player form -----
  readonly playerOpen = signal(false);
  readonly editing = signal<Player | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly confirmDelete = signal(false);
  readonly parents = new FormArray<ParentGroup>([]);
  readonly playerForm = this.fb.group({
    first: '', last: '', jersey: '', shirt: '', refTeam: 'A' as 'A' | 'B', town: '', allergies: '', parents: this.parents
  });

  openPlayer(p: Player | null) {
    this.editing.set(p);
    this.parents.clear();
    const ps = p?.parents ?? [];
    for (let i = 0; i < Math.max(2, ps.length); i++) this.parents.push(parentGroup(ps[i]));
    this.playerForm.patchValue({
      first: p?.first ?? '', last: p?.last ?? '', jersey: p?.jersey ?? '', shirt: p?.shirt ?? '', refTeam: p?.refTeam ?? 'A',
      town: p?.town ?? '', allergies: p?.allergies ?? 'None'
    });
    this.playerForm.markAsPristine();
    this.error.set('');
    this.confirmDelete.set(false);
    this.playerOpen.set(true);
  }

  async savePlayer() {
    const v = this.playerForm.getRawValue();
    if (!v.first.trim()) { this.error.set('Add the player’s first name.'); return; }
    const t = (s: string) => s.trim() || undefined;
    const e = this.editing();
    const player: Player = {
      pid: e?.pid ?? newId('p'), order: e?.order,
      first: v.first.trim(), last: t(v.last), jersey: t(v.jersey), shirt: t(v.shirt), refTeam: v.refTeam, town: t(v.town), allergies: t(v.allergies),
      parents: v.parents.filter((x) => x.name.trim()).map((x) => ({ name: x.name.trim(), ...(x.cell.trim() ? { cell: x.cell.trim() } : {}), ...(x.email.trim() ? { email: x.email.trim() } : {}) }))
    };
    this.busy.set(true);
    const ok = await this.store.savePlayer(player, !e);
    this.busy.set(false);
    if (ok) this.playerOpen.set(false);
  }

  async removePlayer() {
    const e = this.editing();
    if (!e) return;
    if (!this.confirmDelete()) { this.confirmDelete.set(true); return; }
    this.busy.set(true);
    const ok = await this.store.deletePlayer(e.pid);
    this.busy.set(false);
    if (ok) this.playerOpen.set(false);
  }

  // ----- uniforms -----
  readonly items = computed(() => this.store.settings()?.uniformItems ?? []);
  readonly sizesDone = computed(() => this.store.players().filter((p) => Object.values(this.store.uniformOf(p.pid)).some(Boolean)).length);
  shortItem(i: string) { return i.replace(/\s*\(W\/Last NAME\)/i, '').replace(/^(Women's|Adult|BSN Mens|Adidas Mens|Adidas)\s+/i, ''); }
  readonly sizesFor = signal('');
  readonly sizes = new FormArray<FormControl<string>>([]);
  readonly sizesGroup = new FormGroup({ sizes: this.sizes });
  readonly newParent = () => parentGroup();

  openSizes(pid: string) {
    const s = this.store.uniformOf(pid);
    this.sizes.clear();
    this.items().forEach((_, i) => this.sizes.push(new FormControl(s[String(i)] ?? '', { nonNullable: true })));
    this.sizesFor.set(pid);
  }

  async saveSizes() {
    const out: Record<string, string> = {};
    this.sizes.getRawValue().forEach((v, i) => { if (v.trim()) out[String(i)] = v.trim().slice(0, 10); });
    this.busy.set(true);
    const ok = await this.store.setUniform(this.sizesFor(), out);
    this.busy.set(false);
    if (ok) this.sizesFor.set('');
  }
}
