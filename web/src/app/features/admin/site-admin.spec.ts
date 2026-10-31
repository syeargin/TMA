import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiService } from '../../core/api.service';
import type { AdminClub } from '../../core/models';
import { SiteAdmin } from './site-admin';

describe('site admin dashboard', () => {
  const clubs: AdminClub[] = [
    { clubId: 'a5', name: 'A5 Volleyball', short: 'A5', status: 'active', statusReason: '', statusAt: '', teamLimit: 8, activeTeams: 8, archivedTeams: 2, admins: 2, features: { texts: false }, teams: [] },
    { clubId: 'ev', name: 'Eastside VBC', short: '', status: 'inactive', statusReason: 'Did not renew', statusAt: '2026-10-01T12:00:00Z', teamLimit: null, activeTeams: 3, archivedTeams: 0, admins: 1, features: {}, teams: [] }
  ];
  const settle = async () => { await new Promise((r) => setTimeout(r, 0)); TestBed.tick(); };

  const HELP = {
    since: '2026-08-01', months: 3, searches: 40, misses: 10, minViews: 50, via: { browse: 5, search: 3, popular: 0 },
    topics: [{ id: 'answer-availability', title: 'Answer In, Maybe or Out', role: 'parent', views: 8, thisMonth: 2, byRole: { parent: 6, staff: 1, admin: 0, none: 1 } }],
    popular: { all: { ids: [], from: 'starter' }, parent: { ids: [], from: 'counts' }, staff: { ids: [], from: 'starter' }, admin: { ids: [], from: 'starter' } }
  };

  function mount(section = '') {
    const call = vi.fn((method: string, path: string, body?: Record<string, unknown>) => {
      if (method === 'GET' && path === '/admin/clubs') return Promise.resolve({ clubs });
      if (method === 'GET' && path === '/admin/help') return Promise.resolve(HELP);
      if (method === 'GET') return Promise.resolve({ history: [{ at: '2026-10-20T15:00:00Z', by: 'Sam Owner', changes: ['Team limit set to 8'], reason: '' }] });
      return Promise.resolve({ ...clubs[0], ...(body?.['features'] ? { features: {} } : {}), changed: true });
    });
    TestBed.configureTestingModule({ imports: [SiteAdmin], providers: [provideRouter([]), { provide: ApiService, useValue: { call } }] });
    const f = TestBed.createComponent(SiteAdmin);
    if (section) f.componentRef.setInput('section', section);
    f.detectChanges();
    return { f, call, el: f.nativeElement as HTMLElement };
  }

  it('lists each club with its status, teams of its limit and features off', async () => {
    const { el } = mount();
    await settle();
    const rows = [...el.querySelectorAll('.admin-table tbody tr')].map((r) => r.textContent!.replace(/\s+/g, ' ').trim());
    expect(rows[0]).toContain('A5 Volleyball');
    expect(rows[0]).toContain('8 of 8');
    expect(rows[0]).toContain('Text alerts');
    expect(rows[1]).toContain('Inactive');
    expect(rows[1]).toContain('no limit');
    expect(el.textContent).toContain('At their team limit');
  });

  it('saves only what changed, and asks why before making a club inactive', async () => {
    const { el, call, f } = mount();
    await settle();
    el.querySelector<HTMLButtonElement>('.admin-table .link-btn')!.click();
    await settle();
    expect(el.textContent).toContain('Team limit set to 8');
    const texts = [...el.querySelectorAll<HTMLLabelElement>('.admin-panel label.check-row')].find((l) => l.textContent!.includes('Text alerts'))!;
    texts.querySelector('input')!.click();
    await settle();
    [...el.querySelectorAll<HTMLButtonElement>('.admin-panel button')].find((b) => b.textContent!.includes('Save changes'))!.click();
    await settle();
    expect(call).toHaveBeenLastCalledWith('PUT', '/admin/clubs/a5', { features: { texts: true } });

    el.querySelector<HTMLButtonElement>('.admin-table .link-btn')!.click();
    await settle();
    [...el.querySelectorAll<HTMLInputElement>('.admin-panel input[type=radio]')][1].click();
    await settle();
    [...el.querySelectorAll<HTMLButtonElement>('.admin-panel button')].find((b) => b.textContent!.includes('Save changes'))!.click();
    await settle();
    f.detectChanges();
    expect(el.textContent).toContain('Say why the club is being made inactive');
    expect(call).not.toHaveBeenLastCalledWith('PUT', '/admin/clubs/a5', { status: 'inactive' });
  });

  it('shows the help guide counts on the Help tab', async () => {
    const { f, el, call } = mount('help');
    await settle(); await settle(); f.detectChanges();
    expect(call).toHaveBeenCalledWith('GET', '/admin/help');
    const card = [...el.querySelectorAll('section.card')].find((s) => s.textContent?.includes('Help guide'))!;
    expect(card.textContent).toContain('Answer In, Maybe or Out');
    expect(card.textContent).toContain('25% of searches');
    expect(card.textContent).toContain('counts for parents, and the starting picks for the rest');
    expect(card.textContent).toContain('Browsing 5 · Search 3');
  });
});
