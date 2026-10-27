import { Injectable, computed, inject, signal } from '@angular/core';
import { HELP_TOPICS, STARTER_PICKS, helpRolesFor, type HelpRole, type HelpTopic } from '@shared/help';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { MeService } from '../../core/me.service';

export { placeOf } from './help-place';

export type HelpVia = 'browse' | 'search' | 'popular' | 'context' | 'related' | 'link';
export type Popular = Record<HelpRole | 'all', { ids: string[]; from: 'counts' | 'starter' }>;

const SEEN_KEY = 'th.help.seen';
const ROLE_KEY = 'th.help.role';
/** At most this many search counts per visit, so one person typing can't skew them. */
const MAX_SEARCHES = 10;

const read = (store: () => Storage, key: string) => { try { return store().getItem(key); } catch { return null; } };
const write = (store: () => Storage, key: string, v: string) => { try { store().setItem(key, v); } catch { /* private mode: fine */ } };

export const topicById = (id: string) => HELP_TOPICS.find((t) => t.id === id) ?? null;

/** "Take me there" for a topic: a team page needs a team, so without one it goes to Your teams. */
export function goLink(t: HelpTopic, teamId: string, signedIn: boolean): { url: string; label: string } | null {
  if (!t.go) return null;
  if (t.go.path.startsWith('/')) {
    if (t.go.path === '/signup' && signedIn) return { url: '/teams', label: 'Open your teams' };
    return { url: t.go.path, label: t.go.label };
  }
  if (!signedIn) return { url: '/signin', label: 'Sign in to open it' };
  if (!teamId) return { url: '/teams', label: 'Choose a team' };
  return { url: `/teams/${encodeURIComponent(teamId)}${t.go.path ? `/${t.go.path}` : ''}`, label: t.go.label };
}

/** The help guide's shared state: your roles (for the role filter) and the counts it sends. */
@Injectable({ providedIn: 'root' })
export class HelpService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly me = inject(MeService);
  private readonly seen = new Set<string>((read(() => sessionStorage, SEEN_KEY) ?? '').split(',').filter(Boolean));
  private searches = 0;
  private popularLoad: Promise<Popular> | null = null;
  readonly popular = signal<Popular | null>(null);

  /** The guide's groups you're in, across your teams. Empty when signed out. */
  readonly myRoles = computed<HelpRole[]>(() => helpRolesFor((this.me.me()?.teams ?? []).filter((t) => !t.archived).flatMap((t) => t.roles)));

  /** The role filter to start with: the one you picked last, else yours if you're in just one group. */
  startRole(): HelpRole | 'all' {
    const saved = read(() => localStorage, ROLE_KEY);
    if (saved === 'parent' || saved === 'staff' || saved === 'admin' || saved === 'all') return saved;
    const mine = this.myRoles();
    return mine.length === 1 ? mine[0] : 'all';
  }
  saveRole(r: HelpRole | 'all') { write(() => localStorage, ROLE_KEY, r); }

  /** Loads your teams when you're signed in, so the role filter can start on your group. */
  async loadMe(): Promise<void> {
    if (!(await this.auth.ensureUser().catch(() => null))) return;
    await this.me.load().catch(() => undefined);
  }

  /** Which group a view counts for: the filter if it's set, else yours if there's one. */
  private countRole(filter: HelpRole | 'all'): HelpRole | 'none' {
    if (filter !== 'all') return filter;
    const mine = this.myRoles();
    return mine.length === 1 ? mine[0] : 'none';
  }

  /** Counts one view of a topic, once per visit. */
  viewed(id: string, via: HelpVia, filter: HelpRole | 'all') {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    write(() => sessionStorage, SEEN_KEY, [...this.seen].join(','));
    void this.api.helpEvent({ kind: 'view', topic: id, role: this.countRole(filter), via });
  }

  /** Counts a finished search: only whether it found anything, never the words. */
  searched(found: boolean) {
    if (++this.searches > MAX_SEARCHES) return;
    void this.api.helpEvent({ kind: 'search', found });
  }

  loadPopular(): Promise<Popular> {
    this.popularLoad ??= this.api.helpPopular()
      .then((r) => r.popular as Popular)
      .catch(() => Object.fromEntries(Object.entries(STARTER_PICKS).map(([k, ids]) => [k, { ids, from: 'starter' as const }])) as Popular)
      .then((p) => { this.popular.set(p); return p; });
    return this.popularLoad;
  }
}
