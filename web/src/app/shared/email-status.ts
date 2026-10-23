import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { EMAIL_STATUS_LABELS, type EmailStatus } from '@shared/messages';

const PILL: Record<EmailStatus, string> = {
  queued: 'p-mute', sent: 'p-mute', delivered: 'p-ok', bounced: 'p-bad', complained: 'p-bad', failed: 'p-bad', skipped: 'p-mute'
};

/** Where an invite's email stands: "Delivered · Oct 23", or why it didn't arrive. */
@Component({
  selector: 'th-email-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (status(); as s) {
      <div class="small muted email-status"><span class="pill {{ pill() }}">Email: {{ label() }}</span>@if (when()) { <span> · {{ when() }}</span> }</div>
      @if (detail()) { <div class="small email-detail" [class.bad]="pill() === 'p-bad'">{{ detail() }}</div> }
    } @else {
      <div class="small muted email-status">Not emailed yet</div>
    }
  `
})
export class EmailStatusView {
  readonly status = input<EmailStatus | undefined>();
  readonly at = input<string | undefined>();
  readonly detail = input<string | undefined>();
  readonly label = computed(() => EMAIL_STATUS_LABELS[this.status()!] ?? this.status());
  readonly pill = computed(() => PILL[this.status()!] ?? 'p-mute');
  readonly when = computed(() => {
    const a = this.at();
    if (!a) return '';
    const d = new Date(a);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });
}
