import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { ApiService } from '../../core/api.service';
import type { CommsHealth, CommsPage } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { Communications } from './communications';

describe('Communications: delivery health', () => {
  const page: CommsPage = { timeZone: 'America/New_York', pauseUntil: null, messages: [], upcoming: [], catalog: [] };
  const health: CommsHealth = {
    since: '2026-09-24', sent: 418, delivered: 412, bounced: 6, complained: 0, families: 18, familiesOpening: 16, turnedOff: 1, opensSince: '2026-10-01', count: 3,
    attention: [
      { kind: 'bounced', email: 'd.torres@gmial.com', who: 'Dana Torres', invite: true, bounces: 6, since: '2026-10-04T12:00:00Z', suggest: 'gmail.com', detail: '' },
      { kind: 'unreachable', family: 'Kim family', pid: 'p3', why: 'Turned off team email, so they only see changes when they open Teem Hub.' },
      { kind: 'notOpening', families: [{ family: 'Parker family', pid: 'p1', emails: 5, lastOpen: '' }] }
    ],
    messages: [
      { id: 'availability', label: 'Availability reminder', sent: 21, delivered: 21, opened: 18, bounced: 0, complained: 0, next: 17, nextLabel: 'answered', off: 0 },
      { id: 'invite', label: 'Team invites', sent: 3, delivered: 2, opened: 2, bounced: 1, complained: 0, next: 0, nextLabel: '', off: null }
    ]
  };
  const settle = async () => { await new Promise((r) => setTimeout(r, 0)); TestBed.tick(); };

  it('shows the tiles, what needs attention and each message’s numbers', async () => {
    TestBed.configureTestingModule({
      imports: [Communications],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { comms: () => Promise.resolve(page), commsHealth: () => Promise.resolve(health) } },
        { provide: TeamStore, useValue: { teamId: signal('t13'), changed: new Subject<string[]>() } }
      ]
    });
    const f = TestBed.createComponent(Communications);
    f.detectChanges();
    await settle();
    const el = f.nativeElement as HTMLElement;
    const tab = [...el.querySelectorAll<HTMLButtonElement>('nav .chip')].find((b) => b.textContent!.includes('Delivery health'))!;
    expect(tab.textContent!.replace(/\s+/g, ' ').trim()).toBe('Delivery health · 3');
    tab.click();
    await settle();
    const text = el.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('412 of 418');
    expect(text).toContain('16 of 18');
    expect(text).toContain('6 emails bounced since Oct 4. Did you mean gmail.com?');
    expect(text).toContain('Kim family');
    expect(text).toContain('1 family hasn’t opened team email in 4 weeks');
    expect(text).not.toContain('Parker family');
    el.querySelector<HTMLButtonElement>('.health-item .link-btn')!.click();
    await settle();
    expect(el.textContent).toContain('Parker family: 5 emails since the start');
    const rows = [...el.querySelectorAll('.health-table tbody tr')].map((r) => [...r.children].map((c) => c.textContent!.replace(/\s+/g, ' ').trim()));
    expect(rows).toEqual([
      ['Availability reminder', '21', '21', '86%', '17 answered', '0'],
      ['Team invites', '3', '2 · 1 bounced', '100%', '–', 'Always sent']
    ]);
  });
});
