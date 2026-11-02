import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { authInterceptor } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { APP_CONFIG } from '../core/config';
import { FeedbackState, deviceOf } from '../core/feedback';
import { MeService } from '../core/me.service';
import { FeedbackSheet } from './feedback-sheet';
import { Messages } from './messages';

const flush = () => new Promise((r) => setTimeout(r, 0));
// jsdom has no <dialog> methods.
const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
if (typeof proto.showModal !== 'function') proto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
if (typeof proto.close !== 'function') proto.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };

describe('questions & feedback', () => {
  it('describes the device without anything personal', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari 19');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36')).toBe('Android phone · Chrome 141');
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toBe('Windows · Edge 141');
  });

  describe('on the site', () => {
    let http: HttpTestingController;
    const user = signal<{ email: string } | null>({ email: 'mia@example.com' });
    beforeEach(() => {
      user.set({ email: 'mia@example.com' });
      TestBed.configureTestingModule({
        providers: [
          provideRouter([]),
          { provide: APP_CONFIG, useValue: { apiUrl: 'https://api.test', commit: 'abcdef1234' } },
          { provide: AuthService, useValue: { user, accessToken: async () => 'tok' } },
          { provide: MeService, useValue: { me: signal({ email: 'mia@example.com', teams: [{ teamId: 't13', name: 'A5 13 Tom', roles: ['parent'] }, { teamId: 'old', name: 'Old', roles: ['parent'], archived: true }] }) } },
          provideHttpClient(withInterceptors([authInterceptor])),
          provideHttpClientTesting()
        ]
      });
      http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());

    it('"Report this" on an error opens a problem report with that error in it', () => {
      const m = TestBed.createComponent(Messages);
      m.componentRef.setInput('error', "That didn't save. Try again.");
      m.detectChanges();
      (m.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.msg-report')!.click();
      const fb = TestBed.inject(FeedbackState);
      expect(fb.openAs()).toBe('problem');
      expect(fb.attachError()?.message).toBe("That didn't save. Try again.");
    });

    it('sends a question to the team, and shows who it went to', async () => {
      const f = TestBed.createComponent(FeedbackSheet);
      f.detectChanges();
      TestBed.inject(FeedbackState).open('question');
      f.detectChanges();
      const el = f.nativeElement as HTMLElement;
      expect(el.textContent).toContain("A5 13 Tom's coordinator");
      expect(el.textContent).not.toContain('Old');
      f.componentInstance.message.set('Do we bring our own volleyballs?');
      void f.componentInstance.submit();
      await flush();
      const req = http.expectOne('https://api.test/feedback');
      expect(req.request.body).toMatchObject({ kind: 'question', to: 'team', teamId: 't13', message: 'Do we bring our own volleyballs?', version: 'Build abcdef1' });
      expect(req.request.body.email).toBeUndefined();
      req.flush({ id: 'fb1', ref: 'TH-1042', route: 'team', sentTo: ['Kim Lee'], email: 'mia@example.com' });
      await flush();
      f.detectChanges();
      expect(el.textContent).toContain('Sent to Kim Lee');
      expect(el.textContent).toContain('TH-1042');
    });

    it('asks for an email when signed out, and sends to Teem Hub', async () => {
      user.set(null);
      const f = TestBed.createComponent(FeedbackSheet);
      f.detectChanges();
      TestBed.inject(FeedbackState).open('question');
      f.detectChanges();
      const el = f.nativeElement as HTMLElement;
      expect(el.textContent).not.toContain('Who should answer?');
      f.componentInstance.message.set("I can't sign in on my new phone");
      await f.componentInstance.submit();
      expect(f.componentInstance.problem()).toBe('Enter your email so we can reply.');
      f.componentInstance.email.set('jo@example.com');
      void f.componentInstance.submit();
      await flush();
      const req = http.expectOne('https://api.test/public/feedback');
      expect(req.request.body).toMatchObject({ kind: 'question', to: 'teemhub', email: 'jo@example.com' });
      req.flush({ id: 'fb2', ref: 'TH-1043', route: 'teemhub', sentTo: [], email: 'jo@example.com' });
    });
  });
});
