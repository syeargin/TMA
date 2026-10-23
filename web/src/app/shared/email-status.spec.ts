import { TestBed } from '@angular/core/testing';
import { emailFromLink } from '../features/auth/auth-pages';
import { EmailStatusView } from './email-status';

describe('invite emails', () => {
  function show(status?: string, detail?: string) {
    const f = TestBed.createComponent(EmailStatusView);
    f.componentRef.setInput('status', status);
    f.componentRef.setInput('at', '2026-10-23T15:00:00Z');
    f.componentRef.setInput('detail', detail);
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  }

  it('shows where the email stands, and why it bounced', () => {
    expect(show(undefined).textContent).toContain('Not emailed yet');
    const ok = show('delivered');
    expect(ok.querySelector('.pill')!.className).toContain('p-ok');
    expect(ok.textContent).toContain('Email: Delivered');
    const bad = show('bounced', 'The address doesn’t accept mail. Check it for a typo.');
    expect(bad.querySelector('.pill')!.className).toContain('p-bad');
    expect(bad.querySelector('.email-detail.bad')!.textContent).toContain('typo');
  });

  it('fills in the address from the invite link, then takes it out of the address bar', () => {
    history.replaceState(null, '', '/signup#email=jordan%40example.com');
    expect(emailFromLink()).toBe('jordan@example.com');
    expect(window.location.hash).toBe('');
    expect(emailFromLink()).toBeNull();
    history.replaceState(null, '', '/signup#email=not-an-address');
    expect(emailFromLink()).toBeNull();
    history.replaceState(null, '', '/');
  });
});
