import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { ApiService } from '../../core/api.service';
import type { EmailTemplate } from '../../core/models';
import { Messages } from '../../shared/messages';

/**
 * Site owners: the emails Teem Hub sends, a preview with made-up data, and "Send me a test" to their
 * own address, to check a template in a real inbox before families get it (Messaging M1).
 */
@Component({
  selector: 'th-email-templates',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Messages],
  template: `
    <details class="addclub email-templates" (toggle)="opened($event)">
      <summary class="link">Emails Teem Hub sends</summary>
      <th-messages [error]="error()" [notice]="notice()" />
      @if (!sending()) { <p class="small muted">Email isn't set up for this environment, so tests are recorded as skipped and nothing is sent.</p> }
      <div class="email-list">
        @for (m of live(); track m.id) {
          <div class="li">
            <div class="grow"><b>{{ m.label }}</b>@if (m.required) { <span class="pill p-mute">Always sent</span> }<div class="small muted">{{ m.help }}</div></div>
            <button class="link-btn small" type="button" (click)="preview(m.id)" [attr.aria-expanded]="showing() === m.id">{{ showing() === m.id ? 'Hide' : 'Preview' }}</button>
            <button class="link-btn small" type="button" (click)="test(m)" [disabled]="busy()">Send me a test</button>
          </div>
          @if (showing() === m.id && html()) {
            <div class="small muted"><b>{{ subject() }}</b> · from “{{ fromName() }}”</div>
            <iframe class="email-preview" sandbox="" [srcdoc]="html()" [title]="'Preview of the ' + m.label + ' email'"></iframe>
          }
        }
      </div>
      @if (planned()) { <p class="small muted">{{ planned() }} more are planned: the weekly email, reminders and text alerts.</p> }
    </details>
  `
})
export class EmailTemplates {
  private readonly api = inject(ApiService);
  private readonly sanitizer = inject(DomSanitizer);
  readonly all = signal<EmailTemplate[]>([]);
  readonly sending = signal(true);
  readonly live = computed(() => this.all().filter((m) => m.live));
  readonly planned = computed(() => this.all().filter((m) => !m.live).length);
  readonly showing = signal<string | null>(null);
  readonly html = signal<SafeHtml | null>(null);
  readonly subject = signal('');
  readonly fromName = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  private loaded = false;

  async opened(e: Event) {
    if (!(e.target as HTMLDetailsElement).open || this.loaded) return;
    this.loaded = true;
    try {
      const r = await this.api.emailTemplates();
      this.all.set(r.messages);
      this.sending.set(r.sending);
    } catch (err) { this.loaded = false; this.error.set((err as Error).message); }
  }

  async preview(id: string) {
    if (this.showing() === id) { this.showing.set(null); return; }
    this.error.set('');
    try {
      const r = await this.api.previewEmail(id);
      // Our own server's rendering of made-up data, shown in a sandboxed frame with no scripts.
      this.html.set(this.sanitizer.bypassSecurityTrustHtml(r.html));
      this.subject.set(r.subject);
      this.fromName.set(r.fromName);
      this.showing.set(id);
    } catch (err) { this.error.set((err as Error).message); }
  }

  async test(m: EmailTemplate) {
    this.busy.set(true);
    this.error.set(''); this.notice.set('');
    try {
      const r = await this.api.testEmail(m.id);
      this.notice.set(`Sent a test of “${m.label}” to ${r.to}. It uses made-up names.`);
    } catch (err) { this.error.set((err as Error).message); }
    finally { this.busy.set(false); }
  }
}
