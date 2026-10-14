import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { MeService } from '../../core/me.service';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';

/** /consent — shown once per notice version to people who haven't accepted it yet (R4). */
@Component({
  selector: 'th-consent',
  imports: [RouterLink, Messages],
  template: `
    <h2>Before you continue</h2>
    <th-messages [error]="error()" [notice]="notice()" />
    <p>Please read how Team Hub handles your family's information.</p>
    <ul class="small" style="margin:10px 0 14px;padding-left:18px;display:grid;gap:4px">
      <li>Your team sees the schedule, roster names and who's coming. Allergies, travel plans, sizes and each family's dues are kept to your family and the staff who need them.</li>
      <li>Other families see your phone and email only if you choose to share them.</li>
      <li>Archived teams are deleted after 90 days. You can download your data or delete your account at any time.</li>
      <li>Questions and requests go to your team coordinator.</li>
    </ul>
    <p><a routerLink="/privacy" target="_blank" rel="noopener">Read the full privacy notice</a></p>
    <label class="agree">
      <input type="checkbox" [checked]="agreed()" (change)="agreed.set($any($event.target).checked)">
      <span>I've read the privacy notice</span>
    </label>
    <button class="btn primary" type="button" [disabled]="!agreed() || busy()" (click)="accept()">{{ busy() ? 'Saving…' : 'Continue' }}</button>`
})
export class Consent extends Page {
  private readonly api = inject(ApiService);
  private readonly meSvc = inject(MeService);
  private readonly route = inject(ActivatedRoute);
  readonly agreed = signal(false);

  accept() {
    return this.run(async () => {
      const me = await this.meSvc.load();
      const version = me.privacy?.version ?? '';
      await this.api.acceptPrivacy(version);
      this.meSvc.me.update((m) => (m ? { ...m, privacy: { version, accepted: true } } : m));
      const next = this.route.snapshot.queryParamMap.get('next') ?? '/teams';
      await this.router.navigateByUrl(next.startsWith('/') && !next.startsWith('//') ? next : '/teams');
    });
  }
}
