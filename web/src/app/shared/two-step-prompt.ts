import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Shown to club admins and site owners who haven't turned on two-step sign-in yet (R2). */
@Component({
  selector: 'th-two-step-prompt',
  imports: [RouterLink],
  template: `
    <div class="banner" role="status">
      <p><b>Turn on two-step sign-in.</b> Your {{ what() }} tools are locked until you sign in with a code from an authenticator app as well as your password. It takes about two minutes.</p>
      <a class="btn primary sm" routerLink="/security">Set it up</a>
    </div>`
})
export class TwoStepPrompt {
  /** "club admin" or "site owner". */
  readonly what = input('club admin');
}
