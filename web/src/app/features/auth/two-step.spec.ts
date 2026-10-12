import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { groupKey } from '../account/two-step';
import { SignIn } from './auth-pages';

describe('two-step sign-in', () => {
  it('shows the setup key in groups of four', () => {
    expect(groupKey('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(groupKey(' ab cdefg ')).toBe('abcd efg');
  });

  describe('sign-in', () => {
    const auth = {
      email: Object.assign(() => 'pat@example.com', { set: () => undefined }),
      logIn: vi.fn(), confirmCode: vi.fn(), resendCode: vi.fn(), startReset: vi.fn()
    };
    let page: SignIn;
    let el: HTMLElement;
    const settle = async () => { await new Promise((r) => setTimeout(r, 0)); TestBed.tick(); };

    beforeEach(() => {
      vi.clearAllMocks();
      TestBed.configureTestingModule({ imports: [SignIn], providers: [provideRouter([]), { provide: AuthService, useValue: auth }] });
      const f = TestBed.createComponent(SignIn);
      page = f.componentInstance;
      el = f.nativeElement;
      f.detectChanges();
      vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    });

    it('asks for the app code after the password when two-step is on, then signs in', async () => {
      auth.logIn.mockResolvedValue('CONFIRM_SIGN_IN_WITH_TOTP_CODE');
      auth.confirmCode.mockResolvedValue('DONE');
      page.form.setValue({ email: 'pat@example.com', password: 'Secret1234' });
      await page.submit();
      await settle();
      expect(el.textContent).toContain('Enter the 6-digit code from your authenticator app');
      page.codeForm.setValue({ code: '123 456' });
      await page.submitCode();
      expect(auth.confirmCode).toHaveBeenCalledWith('123456');
      expect(TestBed.inject(Router).navigateByUrl).toHaveBeenCalledWith('/');
    });

    it('checks the code is 6 digits and explains a wrong one', async () => {
      page.askCode.set(true);
      page.codeForm.setValue({ code: '12' });
      await page.submitCode();
      expect(page.error()).toBe('Enter the 6-digit code from your authenticator app.');
      expect(auth.confirmCode).not.toHaveBeenCalled();
      auth.confirmCode.mockRejectedValue(Object.assign(new Error('Code mismatch'), { name: 'CodeMismatchException' }));
      page.codeForm.setValue({ code: '654321' });
      await page.submitCode();
      expect(page.error()).toContain("That code isn't right");
      expect(page.askCode()).toBe(true);
    });

    it('starts over with the password when the sign-in session has expired', async () => {
      page.askCode.set(true);
      auth.confirmCode.mockRejectedValue(Object.assign(new Error('Invalid session'), { name: 'NotAuthorizedException' }));
      page.codeForm.setValue({ code: '654321' });
      await page.submitCode();
      expect(page.askCode()).toBe(false);
      expect(page.error()).toBe('That took too long. Sign in again with your password.');
    });
  });
});
