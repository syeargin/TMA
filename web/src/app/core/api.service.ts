import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, from, switchMap, throwError } from 'rxjs';
import type { Role } from '@shared/permissions';
import { AuthService } from './auth.service';
import { APP_CONFIG } from './config';
import type { ClubTeam, Invite, Me, Practice, Rsvp, TeamBundle, TeamEvent } from './models';

export class ApiError extends Error {
  constructor(readonly status: number, body?: { message?: string; error?: string } | null) {
    super(body?.message || `Request failed (${status}).`);
    this.name = 'ApiError';
    this.code = body?.error;
  }
  readonly code?: string;
}

/** Adds the signed-in user's access token to calls to the Team Hub API (and only to those). */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const base = inject(APP_CONFIG).apiUrl;
  if (!base || !req.url.startsWith(base)) return next(req);
  const auth = inject(AuthService);
  return from(auth.accessToken()).pipe(
    switchMap((token) => token
      ? next(req.clone({ setHeaders: { authorization: `Bearer ${token}` } }))
      : throwError(() => new ApiError(401, { message: 'Sign in to continue.' })))
  );
};

const enc = encodeURIComponent;

/** The Team Hub REST API. Every method resolves with the response body or throws an ApiError. */
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
  clubTeams() { return this.call<{ teams: ClubTeam[] }>('GET', '/teams'); }
  createTeam(t: { teamId: string; name: string; season?: string; age?: string }) { return this.call('POST', '/teams', t); }
  team(teamId: string) { return this.call<TeamBundle>('GET', `/teams/${enc(teamId)}`); }
  invites(teamId: string) { return this.call<{ invites: Invite[] }>('GET', `/teams/${enc(teamId)}/invites`); }
  invite(teamId: string, v: { email: string; roles: Role[]; pid?: string }) { return this.call('POST', `/teams/${enc(teamId)}/invites`, v); }
  cancelInvite(teamId: string, email: string) { return this.call('DELETE', `/teams/${enc(teamId)}/invites/${enc(email)}`); }
  updateMember(teamId: string, sub: string, v: { roles: Role[]; pid?: string }) { return this.call('PUT', `/teams/${enc(teamId)}/members/${enc(sub)}`, v); }
  removeMember(teamId: string, sub: string) { return this.call('DELETE', `/teams/${enc(teamId)}/members/${enc(sub)}`); }

  saveEvent(teamId: string, e: TeamEvent) {
    const { eid, ...body } = e;
    return this.call('PUT', `/teams/${enc(teamId)}/events/${enc(eid)}`, body);
  }
  deleteEvent(teamId: string, eid: string) { return this.call('DELETE', `/teams/${enc(teamId)}/events/${enc(eid)}`); }
  savePractices(teamId: string, practices: Practice[]) { return this.call('PUT', `/teams/${enc(teamId)}/practices`, { practices }); }
  setPracticeCancelled(teamId: string, key: string, cancelled: boolean) {
    return this.call(cancelled ? 'PUT' : 'DELETE', `/teams/${enc(teamId)}/practices/cancelled/${enc(key)}`);
  }
  /** Availability for one player; '' clears an answer. */
  setRsvp(teamId: string, pid: string, answers: Record<string, Rsvp | ''>) {
    return this.call('PUT', `/teams/${enc(teamId)}/family/${enc(pid)}`, { rsvp: answers });
  }
  saveAnnouncement(teamId: string, aid: string, a: { text: string; pinned: boolean }) {
    return this.call('PUT', `/teams/${enc(teamId)}/announcements/${enc(aid)}`, a);
  }
  deleteAnnouncement(teamId: string, aid: string) { return this.call('DELETE', `/teams/${enc(teamId)}/announcements/${enc(aid)}`); }
}
