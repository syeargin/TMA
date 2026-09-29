import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { ApiError, ApiService, authInterceptor } from './api.service';
import { AuthService } from './auth.service';
import { APP_CONFIG } from './config';

describe('ApiService', () => {
  let http: HttpTestingController;
  let api: ApiService;
  let token: string | undefined;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    token = 'tok';
    TestBed.configureTestingModule({
      providers: [
        { provide: APP_CONFIG, useValue: { apiUrl: 'https://api.test/' } },
        { provide: AuthService, useValue: { accessToken: async () => token } },
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting()
      ]
    });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(ApiService);
  });
  afterEach(() => http.verify());

  it('sends the access token to the API and returns the body', async () => {
    const p = api.team('a5 13');
    await flush();
    const req = http.expectOne('https://api.test/teams/a5%2013');
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('authorization')).toBe('Bearer tok');
    req.flush({ teamId: 'a5 13' });
    expect(await p).toEqual({ teamId: 'a5 13' });
  });

  it('does not send the token anywhere else', async () => {
    const p = firstValueFrom(TestBed.inject(HttpClient).get('https://elsewhere.test/x'));
    const req = http.expectOne('https://elsewhere.test/x');
    expect(req.request.headers.has('authorization')).toBe(false);
    req.flush({});
    await p;
  });

  it('turns API errors into ApiError with the server message', async () => {
    const p = api.removeMember('ta', 'u1');
    await flush();
    http.expectOne('https://api.test/teams/ta/members/u1').flush({ error: 'last_admin', message: 'A team needs at least one admin.' }, { status: 409, statusText: 'Conflict' });
    const err = (await p.catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('last_admin');
    expect(err.message).toBe('A team needs at least one admin.');
  });

  it('explains network failures in plain words', async () => {
    const p = api.me();
    await flush();
    http.expectOne('https://api.test/me').error(new ProgressEvent('error'), { status: 0 });
    await expect(p).rejects.toThrow("Couldn't reach the server");
  });

  it('asks the person to sign in when there is no token', async () => {
    token = undefined;
    await expect(api.me()).rejects.toMatchObject({ status: 401, message: 'Sign in to continue.' });
  });
});
