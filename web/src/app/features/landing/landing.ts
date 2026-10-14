import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { APP_CONFIG } from '../../core/config';
import { HeaderService } from '../../core/header.service';

/**
 * "/" — the public landing page for everyone: families, staff and clubs thinking about Team Hub.
 * Signed-in people see "Your teams" where others see "Sign in". The app header is hidden here
 * (the page has its own navigation); see app.ts.
 */
@Component({
  selector: 'th-landing',
  imports: [RouterLink],
  templateUrl: './landing.html',
  styleUrl: './landing.css'
})
export class Landing {
  private readonly auth = inject(AuthService);
  private readonly cfg = inject(APP_CONFIG);
  readonly signedIn = computed(() => !!this.auth.user());
  /** Where "Request an invite" and "Contact" go (config.json contactEmail). Hidden until set. */
  readonly contact = this.cfg.contactEmail?.trim() || '';
  readonly inviteMail = this.contact
    ? `mailto:${this.contact}?subject=${encodeURIComponent('Team Hub pilot invite')}&body=${encodeURIComponent('Club and team:\nYour role:\nRoughly how many families:\n')}`
    : '';

  constructor() {
    inject(HeaderService).reset();
    // Find out quietly whether someone is signed in; this page never redirects.
    if (this.auth.configured) void this.auth.ensureUser().catch(() => null);
  }

  /** In-page links: scroll without changing the route (the app uses path-based routing). */
  jump(ev: Event, id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    ev.preventDefault();
    el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    history.replaceState(null, '', `#${id}`);
  }
}
