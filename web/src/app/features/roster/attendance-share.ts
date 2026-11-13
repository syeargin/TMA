import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { MeService } from '../../core/me.service';
import { fmtRange, today } from '../../core/dates';
import { TeamStore } from '../../core/team-store';
import { Sheet } from '../../shared/sheet';
import { fileBase, reportColors, reportPdf, reportPicture, reportXlsx, teamTotals, type Report } from './attendance-report';

export type ReportFormat = 'pdf' | 'picture' | 'xlsx';
const MIME: Record<ReportFormat, string> = { pdf: 'application/pdf', picture: 'image/png', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const EXT: Record<ReportFormat, string> = { pdf: 'pdf', picture: 'png', xlsx: 'xlsx' };

/**
 * Share report / Export to Excel on Roster › Attendance: a branded PDF, a picture, or an Excel workbook of
 * the range picked on the page. Coaches, team admins and site owners.
 */
@Component({
  selector: 'th-attendance-share',
  imports: [Sheet],
  template: `
    <th-sheet [heading]="format() === 'xlsx' ? 'Export to Excel' : 'Share attendance with the club'" [open]="open()" (closed)="closed.emit()">
      <form class="as-form" (submit)="$event.preventDefault(); download()">
        <fieldset class="group"><legend>Format</legend>
          <div class="stack" style="gap:8px">
            <label class="as-opt" [class.on]="format() === 'pdf'"><input type="radio" name="as-format" [checked]="format() === 'pdf'" (change)="format.set('pdf')"><span><b>PDF report</b><span class="small muted">Summary page, then every player's dates. Best for emailing the club director.</span></span></label>
            <label class="as-opt" [class.on]="format() === 'picture'"><input type="radio" name="as-format" [checked]="format() === 'picture'" (change)="format.set('picture')"><span><b>Picture</b><span class="small muted">One branded image with the summary and each player's rate. First names and initials only. Best for a text or group chat.</span></span></label>
            <label class="as-opt" [class.on]="format() === 'xlsx'"><input type="radio" name="as-format" [checked]="format() === 'xlsx'" (change)="format.set('xlsx')"><span><b>Excel spreadsheet</b><span class="small muted">Summary, By date and Every mark sheets, ready to sort, filter or combine.</span></span></label>
          </div>
        </fieldset>
        <p class="small"><b>Dates:</b> {{ rangeLabel() }} · {{ dates() }} <span class="muted">(change it with the buttons above the table)</span></p>
        @if (format() !== 'picture') {
          <fieldset class="group"><legend>Include</legend>
            @if (format() === 'pdf') { <label class="check-row"><input id="as-details" type="checkbox" [checked]="details()" (change)="details.set($any($event.target).checked)"> Each player's dates</label> }
            <label class="check-row"><input id="as-notes" type="checkbox" [checked]="notes()" (change)="notes.set($any($event.target).checked)"> Coaches' notes</label>
            <span class="hint">Notes like "Arrived 6:20". Off unless the club needs them.</span>
          </fieldset>
        }
        @if (error()) { <p class="hint warn" role="alert">{{ error() }}</p> }
        <div class="form-actions">
          @if (canShareFiles() && format() !== 'xlsx') { <button class="btn primary" type="button" (click)="share()" [disabled]="busy()">{{ busy() ? 'Making it…' : 'Share…' }}</button> }
          <button class="btn" [class.primary]="!canShareFiles() || format() === 'xlsx'" type="submit" [disabled]="busy()">{{ busy() ? 'Making it…' : format() === 'xlsx' ? 'Download .xlsx' : 'Download' }}</button>
        </div>
        @if (canShareFiles() && format() !== 'xlsx') { <p class="hint">"Share…" opens your device's share options: Mail, Messages, AirDrop.</p> }
      </form>
    </th-sheet>`,
  styles: [`
    .as-form{display:flex;flex-direction:column;gap:12px}
    .as-opt{display:flex;flex-direction:row;gap:10px;align-items:flex-start;border:1.5px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer;font-weight:400}
    .as-opt.on{border-color:var(--btn);background:var(--surface-2)}
    .as-opt input{margin-top:3px}
    .as-opt > span{display:flex;flex-direction:column;gap:2px}
  `]
})
export class AttendanceShare {
  readonly open = input(false);
  readonly start = input<ReportFormat>('pdf');
  /** The page's range: from and to (YYYY-MM-DD; no from = the whole season), and its name. */
  readonly from = input<string | undefined>(undefined);
  readonly to = input<string | undefined>(undefined);
  readonly rangeLabel = input('Season to date');
  readonly closed = output<void>();
  readonly store = inject(TeamStore);
  private readonly me = inject(MeService);
  readonly format = signal<ReportFormat>('pdf');
  readonly details = signal(true);
  readonly notes = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly canShareFiles = computed(() => typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function');

  constructor() {
    effect(() => { if (this.open()) { this.format.set(this.start()); this.error.set(''); } });
  }

  /** Practices in the range that were taken (someone marked them), oldest first. */
  private readonly practices = computed(() => {
    const t = today(), f = this.from(), to = this.to() ?? t;
    return this.store.items()
      .filter((i) => i.kind === 'practice' && !i.cancelled && i.date <= to && (!f || i.date >= f) && Object.keys(this.store.attendanceOf(i.key)?.marks ?? {}).length)
      .map((i) => ({ key: i.key, date: i.date, title: i.title, time: i.time || undefined }));
  });
  readonly dates = computed(() => {
    const p = this.practices();
    return p.length ? fmtRange(p[0].date, p[p.length - 1].date) + `, ${p[p.length - 1].date.slice(0, 4)}` : 'no practices taken yet';
  });

  report(): Report {
    const summary = this.store.attendanceSummary(this.from(), this.to());
    const held = this.store.items().filter((i) => i.kind === 'practice' && !i.cancelled && i.date <= (this.to() ?? today()) && (!this.from() || i.date >= this.from()!)).length;
    const players = new Map(this.store.players().map((p) => [p.pid, p]));
    const club = this.store.club();
    return {
      club: club?.name ?? '', clubShort: club?.short ?? club?.name ?? '', team: this.store.teamName(), season: this.store.settings()?.season ?? '',
      colors: reportColors(club?.colors), dates: this.dates(), rangeLabel: this.rangeLabel(),
      practices: this.practices(),
      players: summary.players.filter((s) => players.has(s.pid)).map((s) => {
        const p = players.get(s.pid)!;
        return {
          pid: s.pid, s, jersey: p.jersey ?? '', name: `${p.first} ${p.last ?? ''}`.trim(), short: `${p.first}${p.last ? ' ' + p.last[0] + '.' : ''}`,
          marks: Object.fromEntries(this.practices().map((pr) => [pr.key, this.store.attendanceOf(pr.key)?.marks?.[s.pid]]).filter(([, m]) => !!m))
        };
      }).sort((a, b) => a.name.localeCompare(b.name)),
      totals: teamTotals(summary, held),
      excusedCounts: this.store.settings()?.attendanceExcusedCounts !== false,
      preparedBy: this.me.label() || 'Teem Hub', made: today(),
      notes: this.notes(), details: this.details()
    };
  }

  private async make(): Promise<File | null> {
    this.error.set('');
    if (!this.practices().length) { this.error.set('No attendance taken in this range yet.'); return null; }
    this.busy.set(true);
    try {
      const r = this.report();
      const f = this.format();
      const blob = f === 'pdf' ? await reportPdf(r) : f === 'picture' ? await reportPicture(r) : await reportXlsx(r);
      return new File([blob], `${fileBase(r)}.${EXT[f]}`, { type: MIME[f] });
    } catch {
      this.error.set("The file couldn't be made on this device. Try again, or try another format.");
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  async share() {
    const file = await this.make();
    if (!file) return;
    if (!navigator.canShare?.({ files: [file] })) { this.save(file); return; }
    try { await navigator.share({ files: [file], title: `${this.store.teamName()} attendance` }); }
    catch (e) { if ((e as { name?: string })?.name !== 'AbortError') this.save(file); }
  }

  async download() {
    const file = await this.make();
    if (file) this.save(file);
  }

  private save(file: File) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

