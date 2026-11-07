import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { SignUp } from './auth-pages';

describe('sign-up', () => {
  const auth = {
    email: Object.assign(() => '', { set: () => undefined }),
    createAccount: vi.fn(), resendCode: vi.fn()
  };
  let page: SignUp;

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ imports: [SignUp], providers: [provideRouter([]), { provide: AuthService, useValue: auth }] });
    const f = TestBed.createComponent(SignUp);
    page = f.componentInstance;
    f.detectChanges();
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  });
  const fill = () => page.form.setValue({ email: 'vo@example.com', password: 'Secret12345', confirm: 'Secret12345', agree: true });
  const exists = () => Object.assign(new Error('exists'), { name: 'UsernameExistsException' });

  it("sends a new code when an earlier sign-up was never finished, instead of a dead end", async () => {
    auth.createAccount.mockRejectedValue(exists());
    auth.resendCode.mockResolvedValue({});
    fill();
    await page.submit();
    expect(auth.resendCode).toHaveBeenCalledWith('vo@example.com');
    expect(TestBed.inject(Router).navigateByUrl).toHaveBeenCalled();
    expect(String((TestBed.inject(Router).navigateByUrl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toContain('/verify');
  });

  it('says the account exists when it was finished (no new code to send)', async () => {
    auth.createAccount.mockRejectedValue(exists());
    auth.resendCode.mockRejectedValue(Object.assign(new Error('User is already confirmed.'), { name: 'InvalidParameterException' }));
    fill();
    await page.submit();
    expect(page.error()).toContain('An account with this email already exists');
  });
});
