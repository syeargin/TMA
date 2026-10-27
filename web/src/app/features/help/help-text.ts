import { Component, computed, input } from '@angular/core';
import { highlight } from '@shared/help-search';

/** Help text with **labels** in bold and search words highlighted. Rendered as text, never as HTML. */
@Component({
  selector: 'th-help-text',
  template: `@for (p of parts(); track $index) {@if (p.mark) {<mark [class.b]="p.bold">{{ p.text }}</mark>} @else if (p.bold) {<b>{{ p.text }}</b>} @else {{{ p.text }}}}`
})
export class HelpText {
  readonly text = input.required<string>();
  readonly marks = input<readonly string[]>([]);
  readonly parts = computed(() => highlight(this.text(), this.marks()));
}
