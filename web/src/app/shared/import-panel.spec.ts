import { TestBed } from '@angular/core/testing';
import { ApiService } from '../core/api.service';
import type { ImportResult } from '../core/models';
import { ImportPanel } from './import-panel';

describe('import preview: who gets invited (R30)', () => {
  it('lists every address, flagged ones highlighted, without repeating them in the warnings', () => {
    TestBed.configureTestingModule({ imports: [ImportPanel], providers: [{ provide: ApiService, useValue: {} }] });
    const f = TestBed.createComponent(ImportPanel);
    f.componentRef.setInput('teamId', 't1');
    const preview: ImportResult = {
      kind: 'team', applied: false, order: ['t1'],
      teams: [{
        teamId: 't1', name: 'Test 13', status: 'update', players: { add: 0, update: 2, kept: 0 }, events: { add: 0, update: 0 }, practices: null, lists: [],
        invites: { staff: 1, parents: 1, alreadyOnTeam: 1, flagged: 1 },
        inviteList: [
          { email: 'ana@gmial.com', name: 'Ana Hale', roles: ['parent'], player: 'June Hale', status: 'new', flags: ['Check the spelling: did you mean ana@gmail.com?'] },
          { email: 'coach@example.com', name: 'Dana Fox', roles: ['coach'], player: '', status: 'new', flags: [] },
          { email: 'kim@example.com', name: 'Kim Ruiz', roles: ['parent'], player: 'Ivy Ruiz', status: 'member', flags: [] }
        ]
      }],
      problems: [
        { sheet: 'Roster', row: 3, level: 'warning', message: 'ana@gmial.com: Check the spelling: did you mean ana@gmail.com?' },
        { sheet: 'Schedule', row: 4, level: 'warning', message: 'No end time.' }
      ]
    } as ImportResult;
    f.componentInstance.fileName.set('team.xlsx');
    f.componentInstance.preview.set(preview);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const box = el.querySelector('details.invites-check') as HTMLDetailsElement;
    expect(box.open).toBe(true);
    expect(box.querySelector('summary')!.textContent).toContain('2 addresses');
    expect(box.querySelector('summary')!.textContent).toContain('1 to check');
    const items = [...box.querySelectorAll('li')];
    expect(items.map((li) => li.querySelector('.inv-email')!.textContent)).toEqual(['ana@gmial.com', 'coach@example.com', 'kim@example.com']);
    expect(items[0].classList).toContain('flagged');
    expect(items[0].textContent).toContain('did you mean ana@gmail.com');
    expect(items[0].textContent).toContain('June Hale');
    expect(items[2].textContent).toContain('already on the team');
    const warn = el.querySelector('details.problems.warn')!.textContent!;
    expect(warn).toContain('No end time.');
    expect(warn).not.toContain('gmial');
  });
});
