import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { FEATURE_KEYS, isOn, roleFeature } from '@shared/features';
import { ApiService } from './api.service';
import { LiveService } from './live.service';
import type { TeamBundle } from './models';
import { TeamStore } from './team-store';

describe('optional team features', () => {
  function store(roles: string[], features: Record<string, boolean> = {}, clubControls?: Record<string, unknown>) {
    TestBed.configureTestingModule({
      providers: [
        TeamStore,
        { provide: ApiService, useValue: {} },
        { provide: LiveService, useValue: { changes: new Subject(), showHeld: new Subject(), denied: new Subject(), stop: () => undefined, watch: () => undefined } }
      ]
    });
    const s = TestBed.inject(TeamStore);
    s.bundle.set({ teamId: 't1', you: { sub: 'u1', roles, pid: 'p1' }, settings: { teamName: 'T', features }, players: [], events: [], meals: [], refjobs: {}, agenda: {}, family: {}, ledger: [], payments: [], announcements: [], tasks: [], members: [], clubControls } as unknown as TeamBundle);
    return s;
  }

  it('everything is on unless switched off', () => {
    expect(FEATURE_KEYS.every((f) => isOn(undefined, f) && isOn({}, f))).toBe(true);
    expect(isOn({ fund: false }, 'fund')).toBe(false);
    expect(roleFeature('finance')).toBe('fund');
    expect(roleFeature('food')).toBe('meals');
    expect(roleFeature('coach')).toBeNull();
  });

  it('with nothing switched off, roles work as before', () => {
    const on = store(['admin']);
    expect(on.has('fund')).toBe(true);
    expect(on.can('finance')).toBe(true);
  });

  it("a switched-off feature takes its permissions with it, and leaves the rest alone", () => {
    const off = store(['admin'], { fund: false, meals: false, tasks: false, handbook: false, refjobs: false });
    for (const p of ['finance', 'ledger', 'fundView', 'reimb', 'meals', 'tasks', 'handbook', 'refjobs'] as const) expect(off.can(p)).toBe(false);
    for (const p of ['schedule', 'roster', 'settings', 'accounts', 'announce', 'allergies'] as const) expect(off.can(p)).toBe(true);
    expect(off.has('travel')).toBe(true);
  });

  it('an inactive club makes the team read-only, like an archived one', () => {
    const s = store(['admin'], {}, { status: 'inactive', features: {}, teamLimit: null });
    expect(s.readOnly()).toBe(true);
    expect(s.can('schedule')).toBe(false);
    expect(s.can('announce')).toBe(false);
  });

  it('a feature the club leaves out is off, and the club says so', () => {
    const s = store(['admin'], {}, { status: 'active', features: { travel: false, texts: false }, teamLimit: null });
    expect(s.clubAllows('travel')).toBe(false);
    expect(s.clubAllows('texts')).toBe(false);
    expect(s.clubAllows('fund')).toBe(true);
    expect(s.readOnly()).toBe(false);
  });
});
