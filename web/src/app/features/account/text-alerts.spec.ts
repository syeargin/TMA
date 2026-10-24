import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SMS } from '@shared/privacy';
import { ApiService } from '../../core/api.service';
import { Terms } from '../privacy/terms';
import { TextAlerts } from './text-alerts';

describe('text alerts opt-in', () => {
  const settle = async () => { await new Promise((r) => setTimeout(r, 0)); TestBed.tick(); };
  function mount(state: Record<string, unknown>) {
    const call = vi.fn((method: string) => Promise.resolve(method === 'GET' ? { consent: { text: SMS.consent, version: SMS.consentVersion }, ...state } : { status: 'pending', phone: '(614) 555-0123', agreedAt: '2026-10-24T14:00:00Z', live: false }));
    TestBed.configureTestingModule({ imports: [TextAlerts], providers: [provideRouter([]), { provide: ApiService, useValue: { call } }] });
    const f = TestBed.createComponent(TextAlerts);
    f.detectChanges();
    return { f, call, el: f.nativeElement as HTMLElement };
  }

  it('is hidden from people who can’t use it yet', async () => {
    const { el } = mount({ live: false, allowed: false, status: 'off' });
    await settle();
    expect(el.querySelector('#text-alerts')).toBeNull();
  });

  it('starts unticked, shows the carrier wording, and saves only once agreed', async () => {
    const { el, call } = mount({ live: false, allowed: true, status: 'off' });
    await settle();
    const box = el.querySelector<HTMLInputElement>('#sms-agree')!;
    const btn = el.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(box.checked).toBe(false);
    expect(el.textContent).toContain('Message and data rates may apply. Reply STOP to stop, HELP for help.');
    expect(el.textContent).toContain('Only site owners see this');
    const phone = el.querySelector<HTMLInputElement>('#sms-phone')!;
    phone.value = '614 555 0123'; phone.dispatchEvent(new Event('input'));
    await settle();
    expect(btn.disabled).toBe(true);
    box.click();
    await settle();
    expect(btn.disabled).toBe(false);
    btn.click();
    await settle();
    expect(call).toHaveBeenLastCalledWith('PUT', '/me/sms', { phone: '614 555 0123', agree: true, consentVersion: SMS.consentVersion });
    expect(el.textContent!.replace(/\s+/g, ' ')).toContain('Saved for (614) 555-0123, agreed Oct 24, 2026. Texts start when text alerts launch');
  });

  it('the terms spell out the text program for carriers', async () => {
    TestBed.configureTestingModule({ imports: [Terms], providers: [provideRouter([])] });
    const f = TestBed.createComponent(Terms);
    f.detectChanges();
    const t = (f.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
    for (const s of ['Teem Hub Inc.', 'Message and data rates may apply', 'reply STOP', 'reply HELP', 'support@teemhub.net', 'never shared with third parties or affiliates for marketing', 'Carriers aren\'t responsible']) expect(t).toContain(s);
  });
});
