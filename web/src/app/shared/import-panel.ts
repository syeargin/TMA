import { Component, computed, inject, input, output, signal } from '@angular/core';
import { ApiService } from '../core/api.service';
import { explain } from '../core/errors';
import type { ImportProblem, ImportResult, ImportTeamSummary } from '../core/models';
import { readWorkbook, workbookKind, type Sheets } from '../core/xlsx';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * Upload a Team setup or Club setup workbook: preview what it will do and every problem by tab and row,
 * then save. On a club page (clubId) it takes either workbook; a team workbook there needs a Team ID.
 * On a team page (teamId) it takes the team workbook for that team.
 */
@Component({
  selector: 'th-import-panel',
  templateUrl: './import-panel.html'
})
export class ImportPanel {
  readonly clubId = input<string>();
  readonly teamId = input<string>();
  /** Fired after a successful import, with a sentence to show. */
  readonly imported = output<string>();
  private readonly api = inject(ApiService);

  readonly fileName = signal('');
  readonly sheets = signal<Sheets | null>(null);
  readonly kind = signal<'team' | 'club' | null>(null);
  /** Team workbook on a club page: which team (new or existing). */
  readonly newTeamId = signal('');
  readonly preview = signal<ImportResult | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly progress = signal<{ done: number; total: number; label: string } | null>(null);

  readonly errors = computed(() => (this.preview()?.problems ?? []).filter((p) => p.level === 'error'));
  readonly warnings = computed(() => (this.preview()?.problems ?? []).filter((p) => p.level === 'warning'));
  readonly needsTeamId = computed(() => !this.teamId() && this.kind() === 'team');
  readonly canImport = computed(() => !!this.preview() && !this.errors().length && !!this.preview()?.teams?.length && !this.busy());
  readonly importLabel = computed(() => {
    const n = this.preview()?.teams?.length ?? 0;
    return this.kind() === 'club' ? `Import the club and ${plural(n, 'team')}` : 'Import the team';
  });

  async pick(ev: Event) {
    const el = ev.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    this.reset();
    this.fileName.set(file.name);
    this.busy.set(true);
    try {
      const sheets = await readWorkbook(file);
      const kind = workbookKind(sheets);
      if (!kind) throw new Error("That workbook isn't one of the templates: it needs the tabs from the Team setup or Club setup template.");
      if (this.teamId() && kind === 'club') throw new Error("That's the Club setup workbook. Upload it on the club's page; here, use the Team setup workbook.");
      this.sheets.set(sheets);
      this.kind.set(kind);
      if (kind === 'team' && !this.teamId()) {
        const name = String(sheets['Team']?.[1]?.[0] ?? '');
        this.newTeamId.set(this.clubId() && name && name !== 'A5 13 Tom' ? slug(`${this.clubId()}-${name.replace(new RegExp(`^${this.clubId()}\\b`, 'i'), '')}`) : '');
        this.busy.set(false);
        if (!this.newTeamId()) return; // ask for the Team ID first
      }
      this.busy.set(false);
      await this.runPreview();
    } catch (err) {
      this.error.set(explain(err));
    } finally {
      this.busy.set(false);
    }
  }

  async runPreview() {
    const sheets = this.sheets();
    if (!sheets) return;
    if (this.needsTeamId() && !/^[a-z0-9][a-z0-9-]{1,39}$/.test(this.newTeamId())) {
      this.error.set('Enter a Team ID: lowercase letters, numbers and dashes, like test-15-open.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      this.preview.set(this.teamId()
        ? await this.api.importTeam(this.teamId()!, sheets)
        : await this.api.importClub(this.clubId()!, sheets, false, this.kind() === 'team' ? this.newTeamId() : undefined));
    } catch (err) {
      this.error.set(explain(err));
    } finally {
      this.busy.set(false);
    }
  }

  async apply() {
    const p = this.preview(), sheets = this.sheets();
    if (!p || !sheets || !this.canImport()) return;
    this.busy.set(true);
    this.error.set('');
    const done: string[] = [];
    try {
      if (this.teamId()) {
        this.progress.set({ done: 0, total: 1, label: 'Saving the team…' });
        await this.api.importTeam(this.teamId()!, sheets, true);
        done.push(this.teamId()!);
      } else {
        const clubId = this.clubId()!;
        const parts = [...(this.kind() === 'club' ? ['club'] : []), ...(p.order ?? [])];
        const names = new Map((p.teams ?? []).map((t) => [t.teamId, t.name]));
        for (const [i, part] of parts.entries()) {
          this.progress.set({ done: i, total: parts.length, label: part === 'club' ? 'Saving club settings…' : `Saving ${names.get(part) ?? part}…` });
          await this.api.importClub(clubId, sheets, part, this.kind() === 'team' ? this.newTeamId() : undefined);
          if (part !== 'club') done.push(part);
        }
      }
      this.progress.set(null);
      const n = done.length;
      const msg = this.kind() === 'club'
        ? `Imported the club and ${plural(n, 'team')}. Invited people get access when they sign in or create an account with their email.`
        : 'Imported the team. Invited people get access when they sign in or create an account with their email.';
      this.reset();
      this.imported.emit(msg);
    } catch (err) {
      this.progress.set(null);
      const saved = done.length ? ` ${plural(done.length, 'team')} saved before it stopped (${done.join(', ')}); uploading the same file again finishes the rest without duplicates.` : '';
      this.error.set(explain(err) + saved);
    } finally {
      this.busy.set(false);
    }
  }

  reset() {
    this.fileName.set('');
    this.sheets.set(null);
    this.kind.set(null);
    this.preview.set(null);
    this.error.set('');
    this.progress.set(null);
  }

  where(p: ImportProblem) { return p.row ? `${p.sheet}, row ${p.row}` : p.sheet; }
  playersText(t: ImportTeamSummary) {
    const parts = [t.players.add && `${t.players.add} new`, t.players.update && `${t.players.update} updated`].filter(Boolean);
    return parts.join(', ') || '—';
  }
  eventsText(t: ImportTeamSummary) {
    const parts = [t.events.add && `${t.events.add} new`, t.events.update && `${t.events.update} updated`].filter(Boolean);
    return parts.join(', ') || '—';
  }
  invitesText(t: ImportTeamSummary) {
    const n = t.invites.staff + t.invites.parents;
    return n ? `${n} (${t.invites.staff} staff, ${t.invites.parents} parents)` : '—';
  }
  readonly plural = plural;
}
