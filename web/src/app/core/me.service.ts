import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import type { Me } from './models';

export const fullName = (p?: { firstName?: string; lastName?: string } | null) =>
  [p?.firstName, p?.lastName].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');

/** The signed-in person's /me (teams, club admin, name), loaded once and shared. */
@Injectable({ providedIn: 'root' })
export class MeService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  readonly me = signal<Me | null>(null);
  readonly name = computed(() => fullName(this.me()));
  /** Name if set, otherwise email. */
  readonly label = computed(() => this.name() || this.me()?.email || this.auth.user()?.email || '');
  private loading: Promise<Me> | null = null;

  load(force = false): Promise<Me> {
    if (!force && this.me()) return Promise.resolve(this.me()!);
    if (!force && this.loading) return this.loading;
    this.loading = this.api.me().then((m) => { this.me.set(m); return m; }).finally(() => (this.loading = null));
    return this.loading;
  }

  async setName(firstName: string, lastName: string) {
    await this.api.setMyName(firstName.trim(), lastName.trim());
    this.me.update((m) => (m ? { ...m, firstName: firstName.trim(), lastName: lastName.trim() } : m));
  }

  clear() { this.me.set(null); }
}
