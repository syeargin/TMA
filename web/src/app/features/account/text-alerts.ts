import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SMS } from '@shared/privacy';
import { ApiService } from '../../core/api.service';

type SmsState = { live: boolean; allowed: boolean; status: 'off' | 'pending' | 'on' | 'stopped'; phone?: string; agreedAt?: string; consent: { text: string; version: string } };

/**
 * Account page: text alerts opt-in (Messaging M4). US carriers review this screen when they approve
 * the toll-free number, so the wording comes from @shared/privacy SMS, the box starts unticked, and
 * the terms and privacy notice are one tap away. Until texting is live, only site owners see it.
 */
@Component({
  selector: 'th-text-alerts',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state(); as s) { @if (s.allowed) {
    <section class="acct" id="text-alerts">
      @if (!s.live) { <p class="small comms-warn">Only site owners see this until text alerts launch. Nothing is texted yet.</p> }
      <h3>Text alerts</h3>
      <p class="small">Get a text when a practice is cancelled or moved, on game-day mornings, for your family's duties, and for urgent team news.</p>
      @if (s.status === 'off' || editing()) {
        <form class="sms-form" (submit)="$event.preventDefault(); save()">
          <label for="sms-phone">Mobile number
            <input id="sms-phone" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="(555) 555-0123" [value]="phone()" (input)="phone.set($any($event.target).value)" required>
          </label>
          <label class="agree sms-agree" for="sms-agree">
            <input id="sms-agree" type="checkbox" [checked]="agreed()" (change)="agreed.set($any($event.target).checked)">
            <span>{{ consent }} See the <a routerLink="/terms" fragment="text-alerts" target="_blank" rel="noopener">terms</a> and <a routerLink="/privacy" target="_blank" rel="noopener">privacy notice</a>.</span>
          </label>
          @if (error()) { <p class="small" style="color:var(--bad)" role="alert">{{ error() }}</p> }
          <div class="row-actions">
            <button class="btn primary sm" type="submit" [disabled]="busy() || !agreed() || !phone().trim()">{{ busy() ? 'Saving…' : 'Turn on text alerts' }}</button>
            @if (editing()) { <button class="btn sm" type="button" (click)="editing.set(false)">Cancel</button> }
          </div>
        </form>
      } @else {
        <p class="small"><b>{{ s.status === 'pending' ? 'Saved' : 'On' }}</b> for {{ s.phone }}@if (s.agreedAt) {, agreed {{ day(s.agreedAt) }}}.
          @if (s.status === 'pending') { @if (s.live) { We're texting you to confirm. } @else { Texts start when text alerts launch; we'll text once to confirm. } }</p>
        <p class="small muted">Reply STOP to any text to stop them, or turn them off here.</p>
        <div class="row-actions">
          <button class="btn sm" type="button" (click)="phone.set(''); agreed.set(false); editing.set(true)">Change number</button>
          <button class="btn sm danger-ghost" type="button" (click)="off()" [disabled]="busy()">Turn off text alerts</button>
        </div>
      }
    </section>
    } }`
})
export class TextAlerts {
  private readonly api = inject(ApiService);
  readonly state = signal<SmsState | null>(null);
  readonly phone = signal('');
  readonly agreed = signal(false);
  readonly editing = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly consent = SMS.consent;

  constructor() {
    void this.api.call<SmsState>('GET', '/me/sms').then((s) => this.state.set(s)).catch(() => undefined);
  }

  day(iso: string) { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }

  async save() {
    this.busy.set(true); this.error.set('');
    try {
      const r = await this.api.call<Partial<SmsState>>('PUT', '/me/sms', { phone: this.phone(), agree: this.agreed(), consentVersion: SMS.consentVersion });
      this.state.update((s) => (s ? { ...s, ...r } : s));
      this.editing.set(false);
    } catch (e) { this.error.set((e as Error).message); }
    finally { this.busy.set(false); }
  }

  async off() {
    this.busy.set(true); this.error.set('');
    try {
      await this.api.call('DELETE', '/me/sms');
      this.state.update((s) => (s ? { ...s, status: 'off', phone: undefined, agreedAt: undefined } : s));
      this.phone.set(''); this.agreed.set(false);
    } catch (e) { this.error.set((e as Error).message); }
    finally { this.busy.set(false); }
  }
}
