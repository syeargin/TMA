import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { DAY_NAMES, timeLabel } from '@shared/messages';
import { ApiService } from '../../core/api.service';
import type { CommsMessage, CommsPage, UpcomingSend } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';

type Draft = CommsMessage['settings'];

/** Half-hour steps from 6 AM to 9 PM. */
const TIMES = Array.from({ length: 31 }, (_, i) => {
  const m = 6 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
const ZONE_LABELS: Record<string, string> = {
  'America/New_York': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Phoenix': 'Arizona',
  'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii'
};

/** Team settings → Communications: which scheduled emails go out, when, to whom, and what's coming up. */
@Component({
  selector: 'th-communications',
  imports: [Messages, RouterLink],
  templateUrl: './communications.html'
})
export class Communications extends Page {
  readonly store = inject(TeamStore);
  private readonly api = inject(ApiService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly page = signal<CommsPage | null>(null);
  readonly tab = signal<'messages' | 'upcoming'>('messages');
  readonly drafts = signal<Record<string, Draft>>({});
  readonly timeZone = signal('America/New_York');
  readonly pauseUntil = signal('');
  readonly dirty = signal(false);
  readonly preview = signal<{ msg: string; html: SafeHtml; subject: string; note: string } | null>(null);

  readonly days = DAY_NAMES.map((label, i) => ({ value: i, label }));
  readonly times = TIMES.map((value) => ({ value, label: timeLabel(value) }));
  readonly zones = computed(() => {
    const z = this.timeZone();
    return [...new Set([...ZONES, z])].map((value) => ({ value, label: ZONE_LABELS[value] ? `${ZONE_LABELS[value]} (${value})` : value }));
  });
  readonly groups = computed(() => {
    const all = this.page()?.messages ?? [];
    const pick = (ids: string[]) => all.filter((m) => ids.includes(m.id));
    return [
      { title: 'Every week', sub: 'A summary on the day and time you choose.', messages: pick(['weekly', 'staffDigest']) },
      { title: 'Reminders', sub: 'A set number of days before a tournament, an event or a due date.', messages: pick(['packet', 'availability', 'dues']) },
      { title: 'When something happens', sub: 'Sent right away.', messages: pick(['payment', 'announcement']) }
    ].filter((g) => g.messages.length);
  });
  readonly later = computed(() => (this.page()?.catalog ?? []).filter((m) => !m.live && !m.required));
  readonly always = computed(() => (this.page()?.catalog ?? []).filter((m) => m.required).map((m) => m.label));
  readonly upcomingCount = computed(() => (this.page()?.upcoming ?? []).filter((u) => !u.skipped && !u.paused).length);

  constructor() {
    super();
    void this.load();
    // Someone else saved: reload, unless there are unsaved changes here.
    this.store.changed.pipe(takeUntilDestroyed()).subscribe((c) => { if ((c.includes('settings') || c.includes('*')) && !this.dirty()) void this.load(); });
  }

  async load() {
    try {
      const p = await this.api.comms(this.store.teamId());
      this.page.set(p);
      this.drafts.set(Object.fromEntries(p.messages.map((m) => [m.id, structuredClone(m.settings)])));
      this.timeZone.set(p.timeZone);
      this.pauseUntil.set(p.pauseUntil ?? '');
      this.dirty.set(false);
    } catch (err) { this.error.set((err as Error).message); }
  }

  draft(id: string): Draft { return this.drafts()[id]; }
  private change(id: string, fn: (d: Draft) => void) {
    const next = structuredClone(this.drafts());
    fn(next[id]);
    this.drafts.set(next);
    this.dirty.set(true);
  }
  setOn(id: string, on: boolean) { this.change(id, (d) => (d.on = on)); }
  setDay(id: string, v: string) { this.change(id, (d) => (d.day = Number(v))); }
  setTime(id: string, v: string) { this.change(id, (d) => (d.time = v)); }
  setDays(id: string, v: string) { this.change(id, (d) => (d.days = Math.min(14, Math.max(1, Math.round(Number(v) || 1))))); }
  whatOf(m: CommsMessage) { return m.config.timing.kind === 'before' ? m.config.timing.what : ''; }
  whenOf(m: CommsMessage) { return m.config.timing.kind === 'event' ? m.config.timing.when : ''; }
  setAudience(id: string, key: string, on: boolean) { this.change(id, (d) => (d.audience[key] = on)); }
  setRule(id: string, key: string, on: boolean) { this.change(id, (d) => (d.rules[key] = on)); }
  setZone(v: string) { this.timeZone.set(v); this.dirty.set(true); }
  setPause(v: string) { this.pauseUntil.set(v); this.dirty.set(true); }
  /** Times the catalog offers, plus a saved one that isn't on the half hour. */
  timesFor(id: string) {
    const t = this.draft(id)?.time;
    return t && !TIMES.includes(t) ? [{ value: t, label: timeLabel(t) }, ...this.times] : this.times;
  }

  save() {
    return this.run(async () => {
      // Only what each message uses: event messages have no day or time.
      const messages = Object.fromEntries(Object.entries(this.drafts()).map(([id, d]) => {
        const kind = this.page()?.messages.find((m) => m.id === id)?.config.timing.kind;
        const base = { on: d.on, audience: d.audience, rules: d.rules };
        return [id, kind === 'weekly' ? { ...base, day: d.day, time: d.time } : kind === 'before' ? { ...base, days: d.days, time: d.time } : base];
      }));
      await this.api.saveComms(this.store.teamId(), { messages, timeZone: this.timeZone(), pauseUntil: this.pauseUntil() || null });
      await this.load();
      this.notice.set('Saved. The Upcoming tab shows what goes out next.');
    });
  }

  cancel() { void this.load(); }

  skip(u: UpcomingSend) {
    return this.run(async () => {
      await this.api.skipSend(this.store.teamId(), u.key, !u.skipped);
      await this.load();
      this.notice.set(u.skipped ? `${u.label} on ${this.sendDay(u)} will go out again.` : `Skipped the ${u.label} on ${this.sendDay(u)}. The ones after it still go.`);
    });
  }

  async showPreview(m: CommsMessage) {
    if (this.preview()?.msg === m.id) { this.preview.set(null); return; }
    this.error.set('');
    try {
      const r = await this.api.previewComms(this.store.teamId(), m.id);
      const who = m.id === 'staffDigest' ? 'as a staff member with every included role would get it'
        : m.id === 'payment' || m.id === 'announcement' ? 'with made-up details, in your team’s name'
        : `as ${r.family || 'the first'}'s family would get it`;
      const emptyNote = m.id === 'availability' ? ` ${r.family || 'This family'} has already answered, so they wouldn’t get one.` : ' Nothing is scheduled that week, so with "Skip the week" on it wouldn’t be sent.';
      const note = `The next ${m.label.toLowerCase()} ${who}.${r.empty ? emptyNote : ''}`;
      this.preview.set({ msg: m.id, html: this.sanitizer.bypassSecurityTrustHtml(r.html), subject: r.subject, note });
    } catch (err) { this.error.set((err as Error).message); }
  }

  test(m: CommsMessage) {
    return this.run(async () => {
      const r = await this.api.testComms(this.store.teamId(), m.id);
      this.notice.set(`Sent this week’s ${m.label.toLowerCase()} to ${r.to}, as one person on the team would get it.`);
    });
  }

  sendDay(u: UpcomingSend) {
    return new Date(u.sendAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: this.page()?.timeZone });
  }
  sendTime(u: UpcomingSend) {
    return new Date(u.sendAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: this.page()?.timeZone });
  }
}
