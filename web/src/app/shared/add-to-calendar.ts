import { Component, ElementRef, computed, inject, input, viewChild } from '@angular/core';
import { CalEvent, googleUrl, ics, icsFileName, outlookUrl, toCalEvent } from '../core/calendar';
import { today } from '../core/dates';
import type { ScheduleItem } from '../core/schedule';

/** "Add to calendar" menu: Apple (.ics), Google / Android, Outlook.com and Outlook for work or school. */
@Component({
  selector: 'th-add-to-calendar',
  template: `
    @if (cal(); as e) {
      <details class="cal" #menu (keydown.escape)="close()">
        <summary class="link-btn small" [attr.aria-label]="'Add ' + e.title + ' to your calendar'">📅 Add to calendar</summary>
        <div class="cal-menu" role="menu">
          <button type="button" role="menuitem" (click)="apple(e)">Apple (iPhone, Mac)</button>
          <a role="menuitem" [href]="google()" target="_blank" rel="noopener" (click)="close()">Google / Android</a>
          <a role="menuitem" [href]="outlook('live')" target="_blank" rel="noopener" (click)="close()">Outlook.com</a>
          <a role="menuitem" [href]="outlook('office')" target="_blank" rel="noopener" (click)="close()">Outlook (work or school)</a>
          <button type="button" role="menuitem" class="sub" (click)="apple(e)">Download .ics (Outlook desktop)</button>
        </div>
      </details>
    }`
})
export class AddToCalendar {
  readonly item = input.required<ScheduleItem>();
  /** Path of the page this item lives on, for the link back in the calendar entry. */
  readonly path = input('');
  private readonly menu = viewChild<ElementRef<HTMLDetailsElement>>('menu');

  readonly cal = computed<CalEvent | null>(() => {
    const it = this.item();
    if (it.cancelled || it.end < today()) return null;
    return toCalEvent(it, location.origin + (this.path() || location.pathname));
  });
  readonly google = computed(() => (this.cal() ? googleUrl(this.cal()!) : ''));
  outlook(which: 'live' | 'office') { return this.cal() ? outlookUrl(this.cal()!, which) : ''; }

  apple(e: CalEvent) {
    const url = URL.createObjectURL(new Blob([ics(e)], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = icsFileName(e);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this.close();
  }
  close() { this.menu()?.nativeElement.removeAttribute('open'); }
}
