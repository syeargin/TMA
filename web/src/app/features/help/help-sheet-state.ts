import { Injectable, signal } from '@angular/core';

/** Whether the help sheet on a team's tabs is open. Kept apart from the sheet so the sheet can load on first use. */
@Injectable({ providedIn: 'root' })
export class HelpSheetState {
  readonly open = signal(false);
}
