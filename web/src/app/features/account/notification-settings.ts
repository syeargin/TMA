import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service';
import type { MyNotifications } from '../../core/models';

/** Account page: which of each team's emails this person gets (Messaging M2). */
@Component({
  selector: 'th-notification-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="acct" id="notifications">
      <h3>Emails from your teams</h3>
      <p class="small">Invites and notices about your account always come. Everything else you can turn off, team by team.</p>
      @if (error()) { <p class="small" style="color:var(--bad)">{{ error() }}</p> }
      @for (t of teams(); track t.teamId) {
        <fieldset class="comms-set notif-team">
          <legend>{{ t.teamName }}</legend>
          @for (o of t.options; track o.id) {
            <label class="check-row">
              <input type="checkbox" [checked]="!t.off.includes(o.id)" (change)="toggle(t, o.id, $any($event.target).checked)" [disabled]="saving() === t.teamId">
              <span>{{ o.label }}@if (o.teamSends) { <span class="muted small"> · {{ o.schedule }}</span> } @else { <span class="muted small"> · your team hasn't turned this on yet</span> }</span>
            </label>
          }
          @if (saved() === t.teamId) { <span class="small" style="color:var(--ok)">Saved</span> }
        </fieldset>
      } @empty {
        @if (loaded()) { <p class="small muted">You're not on a team yet.</p> }
      }
    </section>`
})
export class NotificationSettings {
  private readonly api = inject(ApiService);
  readonly teams = signal<MyNotifications[]>([]);
  readonly loaded = signal(false);
  readonly saving = signal<string | null>(null);
  readonly saved = signal<string | null>(null);
  readonly error = signal('');

  constructor() {
    void this.api.myNotifications().then((r) => { this.teams.set(r.teams); this.loaded.set(true); }).catch((e) => this.error.set((e as Error).message));
  }

  async toggle(t: MyNotifications, id: string, on: boolean) {
    const off = on ? t.off.filter((x) => x !== id) : [...new Set([...t.off, id])];
    this.saving.set(t.teamId); this.error.set(''); this.saved.set(null);
    try {
      await this.api.saveMyNotifications(t.teamId, off);
      this.teams.set(this.teams().map((x) => (x.teamId === t.teamId ? { ...x, off } : x)));
      this.saved.set(t.teamId);
    } catch (e) { this.error.set((e as Error).message); }
    finally { this.saving.set(null); }
  }
}
