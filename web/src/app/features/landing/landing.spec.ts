import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { APP_CONFIG } from '../../core/config';
import { Landing } from './landing';

describe('landing page', () => {
  function render(user: { email: string; sub: string } | null, contactEmail?: string) {
    TestBed.configureTestingModule({
      imports: [Landing],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { configured: true, user: signal(user), ensureUser: async () => user } },
        { provide: APP_CONFIG, useValue: { contactEmail } }
      ]
    });
    const f = TestBed.createComponent(Landing);
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  }
  const links = (el: HTMLElement) => [...el.querySelectorAll('a')].map((a) => ({ text: a.textContent!.trim(), href: a.getAttribute('href') ?? '' }));

  it('offers sign-in to visitors, and hides invite requests until a contact email is set', () => {
    const el = render(null);
    expect(el.querySelector('h1')!.textContent).toContain("Your team's whole season");
    expect(links(el)).toContainEqual({ text: 'Sign in to your team', href: '/signin' });
    expect(links(el).some((l) => l.text === 'Request an invite' || l.text === 'Contact')).toBe(false);
    expect(links(el)).toContainEqual({ text: 'Privacy', href: '/privacy' });
  });

  it('sends signed-in people to their teams, and uses the configured contact', () => {
    const el = render({ email: 'pat@example.com', sub: 'u1' }, 'pilot@example.org');
    expect(links(el)).toContainEqual({ text: 'Go to your teams', href: '/teams' });
    expect(el.querySelector('.lp-nav-cta')!.textContent!.trim()).toBe('Your teams');
    const invite = links(el).find((l) => l.text === 'Request an invite')!;
    expect(invite.href).toMatch(/^mailto:pilot@example\.org\?subject=/);
    expect(links(el)).toContainEqual({ text: 'Contact', href: 'mailto:pilot@example.org' });
  });

  it("doesn't promise things Teem Hub doesn't do", () => {
    const text = render(null).textContent!;
    expect(text).not.toMatch(/approve|birth date|address(es)? ,|every family is notified|player role/i);
  });
});
