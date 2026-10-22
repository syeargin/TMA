import { Component, inject, input, signal } from '@angular/core';
import { ApiService } from '../core/api.service';
import { explain } from '../core/errors';
import { ToastService } from '../core/toast.service';

/**
 * "Export to spreadsheet": the team's (or club's) setup written into the same template people upload,
 * so it can be edited and uploaded again, or kept as a copy. Holds every family's contact details and
 * allergies, so it's only shown to team admins (team) and club admins and site owners (club).
 */
@Component({
  selector: 'th-export-button',
  template: `
    <button class="btn sm" type="button" (click)="run()" [disabled]="busy()">{{ busy() ? 'Preparing…' : label() }}</button>
    <p class="small muted export-note">The same workbook you upload, filled in. It has families' contact details and allergies: keep it private and delete it when you're done.</p>`
})
export class ExportButton {
  readonly teamId = input<string>();
  readonly clubId = input<string>();
  readonly label = input('Download the team workbook');
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  readonly busy = signal(false);

  async run() {
    this.busy.set(true);
    try {
      const club = !!this.clubId();
      const [data, template, fill] = await Promise.all([
        club ? this.api.exportClub(this.clubId()!) : this.api.exportTeam(this.teamId()!),
        fetch(club ? '/templates/Club-Setup-Template.xlsx' : '/templates/Team-Setup-Template.xlsx').then((r) => {
          if (!r.ok) throw new Error("The template didn't load. Try again.");
          return r.arrayBuffer();
        }),
        import('../core/xlsx-fill')
      ]);
      const bytes = await fill.fillTemplate(template, data.sheets);
      const name = `${data.name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'export'}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const skipped = data.archived?.length ? ` Archived teams aren't included (${data.archived.join(', ')}).` : '';
      this.toast.show(`Downloaded ${name}.${skipped}`);
    } catch (err) {
      this.toast.show(explain(err), true);
    } finally {
      this.busy.set(false);
    }
  }
}
