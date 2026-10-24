import type { ExportRows } from './xlsx-fill';
export type SetupExport = { kind: 'team' | 'club'; name: string; sheets: Record<string, ExportRows>; archived?: string[] };
import type { Feature } from '@shared/features';
import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, from, switchMap, throwError } from 'rxjs';
import type { Role } from '@shared/permissions';
import { AuthService } from './auth.service';
import { APP_CONFIG } from './config';
import type { Repeat } from './series';
import type { Sheets } from './xlsx';
import type { Agenda, Club, CommsHealth, CommsPage, EmailTemplate, MessageSettings, MyNotifications, ClubDetail, ClubTeam, Handbook, ImportResult, Invite, LedgerEntry, Me, Meal, MoneyKind, Player, RefAssign, Rsvp, Settings, Task, TeamBundle, TeamEvent, Travel } from './models';

export class ApiError extends Error {
  constructor(readonly status: number, body?: { message?: string; error?: string } | null) {
    super(body?.message || `Request failed (${status}).`);
    this.name = 'ApiError';
    this.code = body?.error;
  }
  readonly code?: string;
}

/** Adds the signed-in user's access token to calls to the Teem Hub API (and only to those). */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const base = inject(APP_CONFIG).apiUrl;
  if (!base || !req.url.startsWith(base)) return next(req);
  // The unsubscribe link in an email works without signing in.
  if (req.url.slice(String(base).replace(/\/$/, '').length).startsWith('/public/')) return next(req);
  const auth = inject(AuthService);
  return from(auth.accessToken()).pipe(
    switchMap((token) => token
      ? next(req.clone({ setHeaders: { authorization: `Bearer ${token}` } }))
      : throwError(() => new ApiError(401, { message: 'Sign in to continue.' })))
  );
};

const enc = encodeURIComponent;

/** The Teem Hub REST API. Every method resolves with the response body or throws an ApiError. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = String(inject(APP_CONFIG).apiUrl ?? '').replace(/\/$/, '');

  async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    if (!this.base) throw new ApiError(0, { message: "The API isn't set up for this environment." });
    try {
      return await firstValueFrom(this.http.request<T>(method, this.base + path, { body }));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof HttpErrorResponse) {
        if (err.status === 0) throw new ApiError(0, { message: "Couldn't reach the server. Check your connection and try again." });
        throw new ApiError(err.status, typeof err.error === 'object' ? err.error : null);
      }
      throw err;
    }
  }

  me() { return this.call<Me>('GET', '/me'); }
  setMyName(firstName: string, lastName: string) { return this.call('PUT', '/me', { firstName, lastName }); }
  clubTeams() { return this.call<{ teams: ClubTeam[] }>('GET', '/teams'); }
  createTeam(t: { clubId?: string; teamId: string; name: string; season?: string; age?: string }) { return this.call('POST', '/teams', t); }
  /** Spreadsheet import. Without apply: a preview. Club imports save in parts: 'club', then each team id. */
  importTeam(teamId: string, sheets: Sheets, apply = false) { return this.call<ImportResult>('POST', `/teams/${enc(teamId)}/import`, { sheets, apply }); }
  importClub(clubId: string, sheets: Sheets, apply: false | string = false, teamId?: string) {
    return this.call<ImportResult>('POST', `/clubs/${enc(clubId)}/import`, { sheets, apply, ...(teamId ? { teamId } : {}) });
  }
  /** Site owners: archive (read-only, out of families' lists) or restore a team. */
  setArchived(teamId: string, archived: boolean) { return this.call<{ archived: boolean }>('POST', `/teams/${enc(teamId)}/${archived ? 'archive' : 'restore'}`); }
  /** Site owners: delete a team and all its data. `confirm` must repeat the team id. */
  /** Your own data (R4). */
  acceptPrivacy(version: string) { return this.call<{ version: string; at: string }>('PUT', '/me/privacy', { version }); }
  exportMyData() { return this.call<Record<string, unknown>>('GET', '/me/export'); }
  /** A team's or club's setup, as rows for the upload template (team admins; club admins and site owners). */
  exportTeam(teamId: string) { return this.call<SetupExport>('GET', `/teams/${enc(teamId)}/export`); }
  exportClub(clubId: string) { return this.call<SetupExport>('GET', `/clubs/${enc(clubId)}/export`); }
  deleteMyAccount(confirm: string) { return this.call('DELETE', '/me', { confirm }); }
  deleteTeam(teamId: string, confirm: string) { return this.call<{ teamId: string; purgeAt?: string }>('DELETE', `/teams/${enc(teamId)}`, { confirm }); }

  // ---------- clubs ----------
  clubs() { return this.call<{ platformAdmin: boolean; clubs: Club[] }>('GET', '/clubs'); }
  createClub(c: { clubId: string; name: string; short?: string; colors?: Club['colors']; adminEmails?: string[] }) { return this.call<Club>('POST', '/clubs', c); }
  club(clubId: string) { return this.call<ClubDetail>('GET', `/clubs/${enc(clubId)}`); }
  saveClub(clubId: string, c: Omit<Club, 'clubId'>) { return this.call<Club>('PUT', `/clubs/${enc(clubId)}`, c); }
  inviteClubAdmin(clubId: string, a: { email: string; firstName?: string; lastName?: string }) { return this.call('POST', `/clubs/${enc(clubId)}/admins`, a); }
  removeClubAdmin(clubId: string, sub: string) { return this.call('DELETE', `/clubs/${enc(clubId)}/admins/${enc(sub)}`); }
  /** Site owners: turn off a club admin's authenticator app (lost phone) so they can set it up again. */
  resetClubAdminMfa(clubId: string, sub: string) { return this.call('POST', `/clubs/${enc(clubId)}/admins/${enc(sub)}/reset-mfa`); }
  withdrawClubInvite(clubId: string, email: string) { return this.call('DELETE', `/clubs/${enc(clubId)}/invites/${enc(email)}`); }
  emailClubInvite(clubId: string, email: string) { return this.call('POST', `/clubs/${enc(clubId)}/invites/${enc(email)}/send`); }

  // Email templates (site owners)
  emailTemplates() { return this.call<{ messages: EmailTemplate[]; sending: boolean }>('GET', '/admin/emails'); }
  previewEmail(msg: string) { return this.call<{ subject: string; fromName: string; html: string; text: string }>('GET', `/admin/emails/${enc(msg)}/preview`); }
  testEmail(msg: string) { return this.call<{ to: string }>('POST', `/admin/emails/${enc(msg)}/test`); }

  // Communications (Messaging M2)
  comms(teamId: string) { return this.call<CommsPage>('GET', `/teams/${enc(teamId)}/comms`); }
  commsHealth(teamId: string) { return this.call<CommsHealth>('GET', `/teams/${enc(teamId)}/comms/health`); }
  saveComms(teamId: string, v: { messages?: Record<string, MessageSettings>; timeZone?: string; pauseUntil?: string | null }) { return this.call('PUT', `/teams/${enc(teamId)}/comms`, v); }
  skipSend(teamId: string, key: string, skip: boolean) { return this.call('PUT', `/teams/${enc(teamId)}/comms/skip`, { key, skip }); }
  previewComms(teamId: string, msg: string) { return this.call<{ subject: string; fromName: string; html: string; text: string; empty: boolean; sendDate: string; family: string }>('GET', `/teams/${enc(teamId)}/comms/${enc(msg)}/preview`); }
  testComms(teamId: string, msg: string) { return this.call<{ to: string }>('POST', `/teams/${enc(teamId)}/comms/${enc(msg)}/test`); }
  myNotifications() { return this.call<{ teams: MyNotifications[] }>('GET', '/me/notifications'); }
  saveMyNotifications(teamId: string, off: string[]) { return this.call('PUT', `/me/notifications/${enc(teamId)}`, { off }); }
  answerFromEmail(t: string, peek: boolean) { return this.call<{ teamId: string; teamName: string; player: string; title: string; date: string; time: string; answer: 'yes' | 'maybe' | 'no'; current: string; recorded: boolean }>('POST', '/public/answer', { t, peek }); }
  unsubscribe(t: string, undo = false) { return this.call<{ teamName: string; message: string; off: boolean }>('POST', '/public/unsubscribe', { t, undo }); }
  team(teamId: string) { return this.call<TeamBundle>('GET', `/teams/${enc(teamId)}`); }
  invites(teamId: string) { return this.call<{ invites: Invite[] }>('GET', `/teams/${enc(teamId)}/invites`); }
  invite(teamId: string, v: { email: string; firstName?: string; lastName?: string; roles: Role[]; pid?: string; sendEmail?: boolean }) { return this.call('POST', `/teams/${enc(teamId)}/invites`, v); }
  /** Emails an invite (again); revives an expired one for two weeks. */
  emailInvite(teamId: string, email: string) { return this.call<{ email: string; expires: string }>('POST', `/teams/${enc(teamId)}/invites/${enc(email)}/send`); }
  /** Emails every waiting invite that was never emailed (imports save invites without emailing them). */
  emailWaitingInvites(teamId: string) { return this.call<{ queued: number }>('POST', `/teams/${enc(teamId)}/invites/send-waiting`); }
  cancelInvite(teamId: string, email: string) { return this.call('DELETE', `/teams/${enc(teamId)}/invites/${enc(email)}`); }
  updateMember(teamId: string, sub: string, v: { roles: Role[]; pid?: string; firstName?: string; lastName?: string }) { return this.call('PUT', `/teams/${enc(teamId)}/members/${enc(sub)}`, v); }
  removeMember(teamId: string, sub: string) { return this.call('DELETE', `/teams/${enc(teamId)}/members/${enc(sub)}`); }

  saveEvent(teamId: string, e: TeamEvent) {
    const { eid, ...body } = e;
    return this.call('PUT', `/teams/${enc(teamId)}/events/${enc(eid)}`, body);
  }
  combineEvents(teamId: string, body: { eids: string[]; repeat: Repeat; skip: string[] }) {
    return this.call<{ eid: string; combined: number; answersMoved: number }>('POST', `/teams/${enc(teamId)}/events/combine`, body);
  }
  deleteEvent(teamId: string, eid: string) { return this.call('DELETE', `/teams/${enc(teamId)}/events/${enc(eid)}`); }
  /** "This and following dates": the series stops before `from`; `event` carries on from there with a new id. */
  splitEvent(teamId: string, eid: string, from: string, event: TeamEvent) {
    return this.call<{ eid: string; answersMoved: number }>('POST', `/teams/${enc(teamId)}/events/${enc(eid)}/split`, { from, event });
  }
  /** One-time move of the old weekly practice times onto the schedule as practice series. */
  convertPractices(teamId: string) { return this.call<{ converted: number; skipped: string[] }>('POST', `/teams/${enc(teamId)}/practices/convert`); }
  setPracticeCancelled(teamId: string, key: string, cancelled: boolean) {
    return this.call(cancelled ? 'PUT' : 'DELETE', `/teams/${enc(teamId)}/practices/cancelled/${enc(key)}`);
  }
  /** Availability for one player; '' clears an answer. */
  setRsvp(teamId: string, pid: string, answers: Record<string, Rsvp | ''>) {
    return this.call('PUT', `/teams/${enc(teamId)}/family/${enc(pid)}`, { rsvp: answers });
  }
  saveAnnouncement(teamId: string, aid: string, a: { text: string; pinned: boolean; email?: boolean }) {
    return this.call<{ aid: string; emailed?: number; reason?: 'off' | 'cap' | 'already' }>('PUT', `/teams/${enc(teamId)}/announcements/${enc(aid)}`, a);
  }
  deleteAnnouncement(teamId: string, aid: string) { return this.call('DELETE', `/teams/${enc(teamId)}/announcements/${enc(aid)}`); }

  saveRefJobs(teamId: string, eid: string, assign: RefAssign) { return this.call('PUT', `/teams/${enc(teamId)}/events/${enc(eid)}/refjobs`, { assign }); }
  setRefGroups(teamId: string, groups: Record<string, 'A' | 'B'>) { return this.call('PUT', `/teams/${enc(teamId)}/refgroups`, { groups }); }
  saveAgenda(teamId: string, eid: string, agenda: Agenda) { return this.call('PUT', `/teams/${enc(teamId)}/events/${enc(eid)}/agenda`, agenda); }
  saveMeal(teamId: string, m: Meal) {
    const { eid, mid, ...body } = m;
    return this.call('PUT', `/teams/${enc(teamId)}/events/${enc(eid)}/meals/${enc(mid)}`, body);
  }
  deleteMeal(teamId: string, eid: string, mid: string) { return this.call('DELETE', `/teams/${enc(teamId)}/events/${enc(eid)}/meals/${enc(mid)}`); }
  claimMeal(teamId: string, eid: string, mid: string, pid: string) { return this.call('POST', `/teams/${enc(teamId)}/events/${enc(eid)}/meals/${enc(mid)}/claim`, { pid }); }
  releaseMeal(teamId: string, eid: string, mid: string) { return this.call('DELETE', `/teams/${enc(teamId)}/events/${enc(eid)}/meals/${enc(mid)}/claim`); }
  /** One family's travel for one tournament; null clears it. */
  /** The family's own choice: may other team families see their phone numbers and emails? */
  setShareContacts(teamId: string, pid: string, share: boolean) {
    return this.call('PUT', `/teams/${enc(teamId)}/family/${enc(pid)}`, { shareContacts: share });
  }
  setTravel(teamId: string, pid: string, eid: string, travel: Travel | null) {
    return this.call('PUT', `/teams/${enc(teamId)}/family/${enc(pid)}`, { travel: { [eid]: travel } });
  }
  setUniform(teamId: string, pid: string, sizes: Record<string, string>) {
    return this.call('PUT', `/teams/${enc(teamId)}/family/${enc(pid)}`, { uniform: { sizes } });
  }

  recordPayment(teamId: string, p: { kind: MoneyKind; cat: string; pid?: string; amountCents: number; date: string; desc: string }) {
    return this.call('POST', `/teams/${enc(teamId)}/payments`, p);
  }
  withdrawPayment(teamId: string, payId: string) { return this.call('DELETE', `/teams/${enc(teamId)}/payments/${enc(payId)}`); }
  settlePayment(teamId: string, payId: string, action: 'confirm' | 'decline') {
    return this.call('POST', `/teams/${enc(teamId)}/payments/${enc(payId)}/${action}`);
  }
  saveLedger(teamId: string, l: LedgerEntry) {
    const { lid, kind, cat, pid, payee, amountCents, date, desc } = l;
    return this.call('PUT', `/teams/${enc(teamId)}/ledger/${enc(lid)}`, { kind, cat, pid: pid || undefined, payee: payee || undefined, amountCents, date, desc });
  }
  deleteLedger(teamId: string, lid: string) { return this.call('DELETE', `/teams/${enc(teamId)}/ledger/${enc(lid)}`); }

  savePlayer(teamId: string, p: Player) {
    const { pid, first, last, jersey, shirt, town, allergies, refTeam, order, parents } = p;
    return this.call('PUT', `/teams/${enc(teamId)}/players/${enc(pid)}`, { first, last, jersey, shirt, town, allergies, refTeam, order, parents: parents ?? [] });
  }
  deletePlayer(teamId: string, pid: string) { return this.call('DELETE', `/teams/${enc(teamId)}/players/${enc(pid)}`); }

  saveHandbook(teamId: string, h: Handbook) { return this.call('PUT', `/teams/${enc(teamId)}/handbook`, { sections: h.sections }); }
  saveTask(teamId: string, t: Task) {
    const { kid, title, desc, owner, status, order } = t;
    return this.call('PUT', `/teams/${enc(teamId)}/tasks/${enc(kid)}`, { title, desc, owner, status, order });
  }
  deleteTask(teamId: string, kid: string) { return this.call('DELETE', `/teams/${enc(teamId)}/tasks/${enc(kid)}`); }
  /** Team settings. Practices and cancellations are left out, so the API keeps what coaches saved. */
  saveSettings(teamId: string, s: Settings) {
    const { teamName, season, age, coaches, teamCode, dues, budget, checklist, uniformItems, practiceColors } = s;
    return this.call('PUT', `/teams/${enc(teamId)}/settings`, { teamName, season, age, coaches, teamCode, dues, budget, checklist, uniformItems, practiceColors });
  }
  /** Switch optional features on (true) or off (false). */
  saveFeatures(teamId: string, features: Partial<Record<Feature, boolean>>) {
    return this.call<{ features: Partial<Record<Feature, boolean>> }>('PUT', `/teams/${enc(teamId)}/features`, { features });
  }
}
