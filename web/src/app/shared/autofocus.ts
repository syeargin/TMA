import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

/** Focus this field when the screen opens (sign-in style screens only; team screens stay unfocused). */
@Directive({ selector: '[thAutofocus]' })
export class Autofocus {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef);
    afterNextRender(() => el.nativeElement.focus());
  }
}
