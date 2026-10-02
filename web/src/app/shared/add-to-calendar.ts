import { Component, ElementRef, computed, input, viewChild } from '@angular/core';
import { CalEvent, googleUrl, ics, icsFileName, outlookUrl, toCalEvent, toSeriesCalEvent } from '../core/calendar';
import { today } from '../core/dates';
import type { ScheduleItem } from '../core/schedule';
import { describe } from '../core/series';

/**
 * "Add to calendar" menu: Apple (.ics), Google / Android, Outlook.com, Outlook for work or school.
 * For a repeating item it also offers the whole series (Outlook web links can't carry a repeat, so
 * Outlook gets the series as an .ics file).
 */
@Component({
  selector: 'th-add-to-calendar',
  template: `
    @if (cal(); as e) {
      <details class="cal" #menu (keydown.escape)="close()">
        <summary class="link-btn small" [attr.aria-label]="'Add ' + e.title + ' to your calendar'">📅 Add to calendar</summary>
        <div class="cal-menu" role="menu">
          @if (series(); as s) { <div class="cal-h">This date</div> }
          <button type="button" role="menuitem" (click)="download(e)">Apple (iPhone, Mac)</button>
          <a role="menuitem" [href]="google(e)" target="_blank" rel="noopener" (click)="close()">Google / Android</a>
          <a role="menuitem" [href]="outlook(e, 'live')" target="_blank" rel="noopener" (click)="close()">Outlook.com</a>
          <a role="menuitem" [href]="outlook(e, 'office')" target="_blank" rel="noopener" (click)="close()">Outlook (work or school)</a>
          @if (series(); as s) {
            <div class="cal-h">Every date in the series<span>{{ repeatText() }}</span></div>
            <button type="button" role="menuitem" (click)="download(s)">Apple (iPhone, Mac) — series</button>
            <a role="menuitem" [href]="google(s)" target="_blank" rel="noopener" (click)="close()">Google / Android — series</a>
            <button type="button" role="menuitem" (click)="download(s)">Outlook — series (.ics file)</button>
          } @else {
            <button type="button" role="menuitem" class="sub" (click)="download(e)">Download .ics (Outlook desktop)</button>
          }
        </div>
      </details>
    }`
})
export class AddToCalendar {
  readonly item = input.required<ScheduleItem>();
  /** Path of the page this item lives on, for the link back in the calendar entry. */
  readonly path = input('');
  private readonly menu = viewChild<ElementRef<HTMLDetailsElement>>('menu');

  private readonly link = computed(() => location.origin + (this.path() || location.pathname));
  readonly cal = computed<CalEvent | null>(() => {
    const it = this.item();
    if (it.cancelled || it.end < today()) return null;
    return toCalEvent(it, this.link());
  });
  readonly series = computed(() => toSeriesCalEvent(this.item(), this.link()));
  readonly repeatText = computed(() => (this.item().series ? describe(this.item().series!) : ''));
  google(e: CalEvent) { return googleUrl(e); }
  outlook(e: CalEvent, which: 'live' | 'office') { return outlookUrl(e, which); }

  download(e: CalEvent) {
    const url = URL.createObjectURL(new Blob([ics(e)], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = e.rrule ? icsFileName(e).replace(/\.ics$/, '-series.ics') : icsFileName(e);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this.close();
  }
  close() { this.menu()?.nativeElement.removeAttribute('open'); }
}
