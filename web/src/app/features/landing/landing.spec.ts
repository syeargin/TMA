import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { APP_CONFIG } from '../../core/config';
import { FeedbackService } from '../../core/feedback';
import { Landing } from './landing';

describe('landing page', () => {
  let sent: Record<string, unknown>[] = [];
  function render(user: { email: string; sub: string } | null) {
    sent = [];
    TestBed.configureTestingModule({
      imports: [Landing],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { configured: true, user: signal(user), ensureUser: async () => user } },
        { provide: APP_CONFIG, useValue: {} },
        { provide: FeedbackService, useValue: { inquire: async (b: Record<string, unknown>) => { sent.push(b); return { ref: 'TH-1051' }; } } }
      ]
    });
    const f = TestBed.createComponent(Landing);
    f.detectChanges();
    return f;
  }
  const links = (el: HTMLElement) => [...el.querySelectorAll('a')].map((a) => ({ text: a.textContent!.trim(), href: a.getAttribute('href') ?? '' }));
  const type = (el: HTMLElement, id: string, v: string) => {
    const i = el.querySelector<HTMLInputElement>(`#${id}`)!;
    i.value = v;
    i.dispatchEvent(new Event('input'));
  };
  const submit = async (f: ReturnType<typeof render>) => {
    (f.nativeElement as HTMLElement).querySelector('form')!.dispatchEvent(new Event('submit'));
    await f.whenStable();
    f.detectChanges();
  };

  it('offers sign-in and "Talk to us" to visitors', () => {
    const el = render(null).nativeElement as HTMLElement;
    expect(el.querySelector('h1')!.textContent).toContain("Your team's whole season");
    expect(links(el)).toContainEqual({ text: 'Sign in to your team', href: '/signin' });
    expect(links(el)).toContainEqual({ text: 'Talk to us about your club', href: '#contact' });
    expect(links(el).filter((l) => l.text === 'Talk to us').length).toBe(2);
    expect(links(el).some((l) => l.href.startsWith('mailto:') && l.href !== 'mailto:support@teemhub.net')).toBe(false);
    expect(links(el)).toContainEqual({ text: 'Privacy', href: '/privacy' });
  });

  it('sends signed-in people to their teams', () => {
    const el = render({ email: 'pat@example.com', sub: 'u1' }).nativeElement as HTMLElement;
    expect(links(el)).toContainEqual({ text: 'Go to your teams', href: '/teams' });
    expect(el.querySelector('.lp-nav-cta')!.textContent!.trim()).toBe('Your teams');
  });

  it('checks the form next to each field, then sends a club inquiry', async () => {
    const f = render(null);
    const el = f.nativeElement as HTMLElement;
    type(el, 'tu-name', 'Pat Morgan');
    type(el, 'tu-email', 'pat@summitvbc');
    f.detectChanges();
    await submit(f);
    expect(sent.length).toBe(0);
    expect(el.textContent).toContain('Check the email: it needs a domain');
    expect(el.textContent).toContain("Enter your club or team's name.");
    type(el, 'tu-email', 'pat@summitvbc.org');
    type(el, 'tu-org', 'Summit Volleyball Club');
    el.querySelectorAll<HTMLInputElement>('input[name="tu-teams"]')[2].dispatchEvent(new Event('change'));
    type(el, 'tu-msg', 'We run 24 teams.');
    f.detectChanges();
    await submit(f);
    expect(sent).toEqual([{ role: 'club', name: 'Pat Morgan', email: 'pat@summitvbc.org', org: 'Summit Volleyball Club', sport: 'Volleyball', teams: '10-39', message: 'We run 24 teams.', source: 'contact section' }]);
    expect(el.textContent).toContain("Thanks, Pat. We'll be in touch.");
    expect(el.textContent).toContain('TH-1051');
  });

  it('points parents to their coordinator and asks for the team instead', async () => {
    const f = render(null);
    const el = f.nativeElement as HTMLElement;
    el.querySelectorAll<HTMLInputElement>('input[name="tu-role"]')[2].dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(el.textContent).toContain('Teams join Teem Hub through their coordinator or club');
    expect(el.querySelector('#tu-sport')).toBeNull();
    type(el, 'tu-name', 'Jen Carter');
    type(el, 'tu-email', 'jen@example.com');
    type(el, 'tu-org', 'Pinecrest 14 Green');
    type(el, 'tu-coordinatorEmail', 'kim@pinecrest.org');
    f.detectChanges();
    await submit(f);
    expect(sent).toEqual([{ role: 'parent', name: 'Jen Carter', email: 'jen@example.com', org: 'Pinecrest 14 Green', sport: '', coordinatorEmail: 'kim@pinecrest.org', source: 'contact section' }]);
  });

  it("doesn't promise things Teem Hub doesn't do", () => {
    const text = (render(null).nativeElement as HTMLElement).textContent!;
    expect(text).not.toMatch(/approve|birth date|address(es)? ,|every family is notified|player role|live score|business day/i);
  });
});
