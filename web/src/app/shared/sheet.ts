import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';

let nextId = 0;

/** A pop-up form (native <dialog>): Esc and the × close it; focus stays inside while it's open. */
@Component({
  selector: 'th-sheet',
  template: `
    <dialog #dlg class="sheet" [attr.aria-labelledby]="hid" (close)="closed.emit()">
      <div class="sheet-h">
        <h3 [id]="hid">{{ heading() }}</h3>
        <button class="icon-btn" type="button" aria-label="Close" (click)="dlg.close()">×</button>
      </div>
      <div class="inner"><ng-content /></div>
    </dialog>`
})
export class Sheet {
  readonly heading = input.required<string>();
  readonly open = input(false);
  readonly closed = output<void>();
  readonly hid = `sheet-${++nextId}`;
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const d = this.dlg().nativeElement;
      if (this.open() && !d.open) d.showModal();
      if (!this.open() && d.open) d.close();
    });
  }
}
