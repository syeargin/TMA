import { TestBed } from '@angular/core/testing';
import { ApiService } from '../../core/api.service';
import { NotificationSettings } from './notification-settings';
import { tokenFromLink } from './unsubscribe';

describe('emails from your teams', () => {
  const api = {
    myNotifications: vi.fn().mockResolvedValue({ teams: [{
      teamId: 't13', teamName: 'Test 13', roles: ['parent', 'coach'], off: ['staffDigest'],
      options: [
        { id: 'weekly', label: 'Weekly at-a-glance', help: '', teamSends: true, schedule: 'on Sundays at 6:00 PM' },
        { id: 'staffDigest', label: 'Staff digest', help: '', teamSends: false, schedule: '' }
      ]
    }] }),
    saveMyNotifications: vi.fn().mockResolvedValue({})
  };
  const settle = async () => { await new Promise((r) => setTimeout(r, 0)); TestBed.tick(); };

  it('shows what each team sends, and saves a change', async () => {
    TestBed.configureTestingModule({ imports: [NotificationSettings], providers: [{ provide: ApiService, useValue: api }] });
    const f = TestBed.createComponent(NotificationSettings);
    f.detectChanges();
    await settle();
    const el = f.nativeElement as HTMLElement;
    const boxes = [...el.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(el.textContent).toContain('on Sundays at 6:00 PM');
    expect(el.textContent).toContain("your team hasn't turned this on yet");
    boxes[0].click();
    await settle();
    expect(api.saveMyNotifications).toHaveBeenCalledWith('t13', ['staffDigest', 'weekly']);
    expect(el.textContent).toContain('Saved');
  });

  it('reads the unsubscribe code from the link', () => {
    history.replaceState(null, '', '/unsubscribe#t=eyJzIjoxfQ.abc_-1');
    expect(tokenFromLink()).toBe('eyJzIjoxfQ.abc_-1');
    history.replaceState(null, '', '/unsubscribe');
    expect(tokenFromLink()).toBe('');
    history.replaceState(null, '', '/');
  });
});
