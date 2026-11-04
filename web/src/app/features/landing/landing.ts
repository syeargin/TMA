import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { explain } from '../../core/errors';
import { FeedbackService, type Inquiry } from '../../core/feedback';
import { HeaderService } from '../../core/header.service';

type Role = Inquiry['role'];
type Teams = NonNullable<Inquiry['teams']>;
type Field = 'name' | 'email' | 'org' | 'coordinatorEmail';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * "/" — the public landing page for everyone: families, staff and clubs thinking about Teem Hub.
 * Clubs and teams reach us through "Talk to us" (#contact), which lands in Site admin › Feedback as an
 * inquiry (POST /public/inquiry). Signed-in people see "Your teams" where others see "Sign in".
 * The app header is hidden here (the page has its own navigation); see app.ts.
 * The screens are drawn in HTML with made-up teams, so they stay in step with the app's design.
 */
@Component({
  selector: 'th-landing',
  imports: [RouterLink],
  templateUrl: './landing.html',
  styleUrl: './landing.css'
})
export class Landing {
  private readonly auth = inject(AuthService);
  private readonly feedback = inject(FeedbackService);
  readonly signedIn = computed(() => !!this.auth.user());

  readonly roles: [Role, string][] = [['club', 'Club director or admin'], ['team', 'Team coordinator or coach'], ['parent', 'Parent']];
  readonly teamCounts: [Teams, string][] = [['1', '1'], ['2-9', '2–9'], ['10-39', '10–39'], ['40+', '40+']];
  readonly sports = ['Volleyball', 'Soccer', 'Basketball', 'Baseball or softball', 'Lacrosse', 'Hockey', 'Something else'];

  readonly role = signal<Role>('club');
  readonly name = signal('');
  readonly email = signal('');
  readonly org = signal('');
  readonly sport = signal('Volleyball');
  readonly teams = signal<Teams | ''>('');
  readonly coordinatorEmail = signal('');
  readonly message = signal('');
  /** Bots fill this in; people never see it. */
  readonly website = signal('');
  /** Which "Talk to us" brought them here (shown in the inbox as "Came from"). */
  private source = '';

  readonly tried = signal(false);
  readonly busy = signal(false);
  readonly failed = signal('');
  readonly sent = signal<{ ref: string; name: string; email: string } | null>(null);
  readonly shared = signal('');

  readonly errors = computed(() => {
    const e: Partial<Record<Field, string>> = {};
    if (!this.name().trim()) e.name = 'Enter your name.';
    const mail = this.email().trim();
    if (!mail) e.email = 'Enter your email so we can reply.';
    else if (!EMAIL.test(mail)) e.email = 'Check the email: it needs a domain, like yourclub.org.';
    if (this.org().trim().length < 2) e.org = this.role() === 'parent' ? 'Enter your team and club.' : "Enter your club or team's name.";
    const coord = this.coordinatorEmail().trim();
    if (this.role() === 'parent' && coord && !EMAIL.test(coord)) e.coordinatorEmail = "Check the coordinator's email, or leave it empty.";
    return e;
  });
  err(f: Field) { return this.tried() ? this.errors()[f] ?? '' : ''; }

  constructor() {
    inject(HeaderService).reset();
    // Find out quietly whether someone is signed in; this page never redirects.
    if (this.auth.configured) void this.auth.ensureUser().catch(() => null);
  }

  /** In-page links: scroll without changing the route (the app uses path-based routing). */
  jump(ev: Event, id: string, source?: string) {
    if (source) this.source = source;
    const el = document.getElementById(id);
    if (!el) return;
    ev.preventDefault();
    el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    history.replaceState(null, '', `#${id}`);
  }

  val(ev: Event) { return (ev.target as HTMLInputElement).value; }

  async send(ev: Event) {
    ev.preventDefault();
    this.tried.set(true);
    this.failed.set('');
    const errs = this.errors();
    if (Object.keys(errs).length) {
      const first = (['name', 'email', 'org', 'coordinatorEmail'] as Field[]).find((f) => errs[f]);
      document.getElementById(`tu-${first}`)?.focus();
      return;
    }
    const parent = this.role() === 'parent';
    this.busy.set(true);
    try {
      const r = await this.feedback.inquire({
        role: this.role(), name: this.name().trim(), email: this.email().trim(), org: this.org().trim(),
        sport: parent ? '' : this.sport(),
        ...(!parent && this.teams() ? { teams: this.teams() as Teams } : {}),
        ...(parent && this.coordinatorEmail().trim() ? { coordinatorEmail: this.coordinatorEmail().trim() } : {}),
        ...(!parent && this.message().trim() ? { message: this.message().trim() } : {}),
        source: this.source || 'contact section',
        ...(this.website() ? { website: this.website() } : {})
      });
      this.sent.set({ ref: r.ref, name: this.name().trim().split(/\s+/)[0], email: this.email().trim() });
    } catch (e) {
      this.failed.set(explain(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Parents: hand this page to the coordinator. */
  async share() {
    const url = `${location.origin}/#contact`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Teem Hub', url }); return; }
      await navigator.clipboard.writeText(url);
      this.shared.set('Link copied. Paste it to your coordinator.');
    } catch {
      this.shared.set(`Send your coordinator this link: ${url}`);
    }
  }
}
