import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import { APP_CONFIG } from './config';

/**
 * Questions & feedback (api: routes/feedback.ts). One panel for the whole site (shared/feedback-sheet),
 * opened from Help, the footer, an error's "Report this", or the Account page.
 */
export type FeedbackKind = 'question' | 'problem' | 'idea';
export type FeedbackStatus = 'new' | 'waiting' | 'planned' | 'closed';
export type LastError = { code: string; message: string; at: string; path: string };

export interface MyFeedback {
  id: string; ref: string; kind: FeedbackKind; route: 'team' | 'teemhub'; status: FeedbackStatus; message: string;
  teamName: string | null; sentTo: string[]; createdAt: string; replies: { at: string; byName: string; message: string }[];
}
export interface InboxItem extends Omit<MyFeedback, 'replies' | 'teamName'> {
  email: string; name: string; teamId?: string; teamName?: string; clubId?: string; roles?: string[];
  page?: { path: string; title: string }; error?: { code: string; message: string; at: string };
  device?: string; version?: string; hasShot: boolean; updatedAt: string; firstReplyAt?: string;
  replies: { at: string; by: string; byName: string; message: string }[]; similar: string[];
}
export interface InboxStats {
  new: number; oldestNewAt: string | null; problemsWeek: number; sameError: number;
  ideas: { open: number; planned: number; closed: number }; repliedInADay: number | null;
}
export interface OwnerSettings { teamQuestions: boolean; emailNew: boolean }
export type SendBody = {
  kind: FeedbackKind; to?: 'team' | 'teemhub'; teamId?: string; message: string;
  page?: { path: string; title: string }; error?: { code: string; message: string; at: string };
  device?: string; version?: string; screenshot?: string; email?: string; name?: string; website?: string;
};
export type Sent = { id: string; ref: string; route: 'team' | 'teemhub'; sentTo: string[]; email: string };

export const KIND_LABEL: Record<FeedbackKind, string> = { question: 'Ask a question', problem: 'Report a problem', idea: 'Suggest an idea' };
export const KIND_NOUN: Record<FeedbackKind, string> = { question: 'Question', problem: 'Problem', idea: 'Idea' };
export const STATUS_LABEL: Record<FeedbackStatus, string> = { new: 'Sent', waiting: 'Answered', planned: 'Planned', closed: 'Done' };

/** "iPhone · Safari 19", from the browser's own description. Nothing that identifies the person. */
export function deviceOf(ua: string): string {
  const device = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Computer';
  const b = /Edg\/(\d+)/.exec(ua) ? ['Edge', /Edg\/(\d+)/.exec(ua)![1]]
    : /(?:CriOS|Chrome)\/(\d+)/.exec(ua) && !/OPR\//.test(ua) ? ['Chrome', /(?:CriOS|Chrome)\/(\d+)/.exec(ua)![1]]
    : /(?:FxiOS|Firefox)\/(\d+)/.exec(ua) ? ['Firefox', /(?:FxiOS|Firefox)\/(\d+)/.exec(ua)![1]]
    : /Version\/(\d+).*Safari/.exec(ua) ? ['Safari', /Version\/(\d+)/.exec(ua)![1]] : null;
  return b ? `${device} · ${b[0]} ${b[1]}` : device;
}

/** A picture made smaller (at most 1600 px, JPEG) until it fits the upload limit. */
export async function shrink(file: Blob, maxChars = 340_000): Promise<string> {
  // Read as a data: URL (the site's content policy allows data: pictures, not blob: ones).
  const src = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error("That file couldn't be read.")); r.readAsDataURL(file); });
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file isn't a picture we can read.")); i.src = src; });
  for (const [side, quality] of [[1600, 0.8], [1400, 0.7], [1200, 0.6], [1000, 0.55], [800, 0.5]] as const) {
    const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', quality);
    if (data.length <= maxChars) return data;
  }
  throw new Error('That picture is too big. Try a smaller screenshot.');
}

/**
 * Whether the panel is open, and the last error someone saw. No dependencies, so the error
 * messages (shared/messages, the toast) can use it anywhere, tests included.
 */
@Injectable({ providedIn: 'root' })
export class FeedbackState {
  /** The panel is open, on this tab. */
  readonly openAs = signal<FeedbackKind | null>(null);
  /** The error to attach to a problem report. */
  readonly attachError = signal<LastError | null>(null);
  /** The last error someone saw, for problem reports. */
  readonly lastError = signal<LastError | null>(null);

  /** Opens the panel. A problem report takes the last error from this page (or "Report this" on one). */
  open(kind: FeedbackKind = 'question', withError = false) {
    const e = this.lastError();
    const recent = !!e && e.path === location.pathname && Date.now() - Date.parse(e.at) < 15 * 60_000;
    this.attachError.set(withError || (kind === 'problem' && recent) ? e : null);
    this.openAs.set(null);
    this.openAs.set(kind);
  }
  close() { this.openAs.set(null); }

  /** Remembers an error the person saw. */
  saw(message: string, code = '') {
    if (!message) return;
    this.lastError.set({ message: message.slice(0, 300), code: (code || 'shown').slice(0, 60), at: new Date().toISOString(), path: location.pathname });
  }
}

@Injectable({ providedIn: 'root' })
export class FeedbackService {
  private readonly api = inject(ApiService);
  private readonly cfg = inject(APP_CONFIG);

  get version() { return this.cfg.commit ? `Build ${this.cfg.commit.slice(0, 7)}` : (this.cfg.env || 'local'); }

  send(body: SendBody, signedIn: boolean) {
    return this.api.call<Sent>('POST', signedIn ? '/feedback' : '/public/feedback', body);
  }
  mine() { return this.api.call<{ items: MyFeedback[] }>('GET', '/me/feedback').then((r) => r.items); }

  // Site owners
  inbox() { return this.api.call<{ items: InboxItem[]; stats: InboxStats; settings: OwnerSettings }>('GET', '/admin/feedback'); }
  screenshot(id: string) { return this.api.call<{ screenshot: string }>('GET', `/admin/feedback/${encodeURIComponent(id)}/screenshot`).then((r) => r.screenshot); }
  setStatus(id: string, status: FeedbackStatus) { return this.api.call('PUT', `/admin/feedback/${encodeURIComponent(id)}`, { status }); }
  reply(id: string, message: string) { return this.api.call<{ replies: InboxItem['replies']; status: FeedbackStatus }>('POST', `/admin/feedback/${encodeURIComponent(id)}/reply`, { message }); }
  saveSettings(s: OwnerSettings) { return this.api.call<OwnerSettings>('PUT', '/admin/feedback/settings', s); }
}
