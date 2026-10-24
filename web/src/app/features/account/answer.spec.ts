import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { Answer } from './answer';

describe('one-tap answers from email', () => {
  const about = { teamId: 't13', teamName: 'Test 13', player: 'Ella', title: 'Practice', date: 'Tue, Nov 3', time: '6:00 PM', answer: 'yes', current: '', recorded: false };
  const api = { answerFromEmail: vi.fn((_t: string, peek: boolean) => Promise.resolve({ ...about, recorded: !peek, current: peek ? '' : 'yes' })) };
  const settle = async () => { await new Promise((r) => setTimeout(r, 0)); TestBed.tick(); };

  it('shows what it will record, and records it only when tapped', async () => {
    history.replaceState(null, '', '/answer#t=abc.def');
    TestBed.configureTestingModule({ imports: [Answer], providers: [provideRouter([]), { provide: ApiService, useValue: api }] });
    const f = TestBed.createComponent(Answer);
    f.detectChanges();
    await settle();
    const el = f.nativeElement as HTMLElement;
    expect(api.answerFromEmail).toHaveBeenCalledWith('abc.def', true);
    expect(el.textContent).toContain('Tue, Nov 3 · Practice');
    const btn = el.querySelector<HTMLButtonElement>('button.btn.primary')!;
    expect(btn.textContent).toContain('Mark Ella In');
    btn.click();
    await settle();
    expect(api.answerFromEmail).toHaveBeenLastCalledWith('abc.def', false);
    expect(el.querySelector('.answer-done')!.textContent).toContain('Ella is In');
    history.replaceState(null, '', '/');
  });
});
