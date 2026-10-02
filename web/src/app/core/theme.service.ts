import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { MeService } from './me.service';
import { ClubColors, DEFAULT_COLORS, isHex, themeCss } from './theme';

export interface ClubLook { name: string; short?: string; colors: ClubColors }

const KEY = 'th.club-look';
function remembered(): ClubLook | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ClubLook | null;
    return v && isHex(v.colors?.primary) && isHex(v.colors?.accent) ? v : null;
  } catch { return null; }
}

/**
 * Applies a club's colors to the whole site. Team and club pages set the club they show; elsewhere
 * the site uses your club if you're in just one, otherwise the standard colors. The last club shown is
 * remembered on this device so the sign-in page and the first paint already look right.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly meSvc = inject(MeService);
  /** Set by a team or club page; undefined = no page preference. */
  readonly page = signal<ClubLook | null | undefined>(undefined);
  private readonly last = signal<ClubLook | null>(remembered());

  /** Your club when you belong to exactly one. */
  readonly home = computed<ClubLook | null | undefined>(() => {
    const me = this.meSvc.me();
    if (!me) return undefined;
    const clubs = me.clubs ?? [];
    return clubs.length === 1 ? clubs[0] : null;
  });
  readonly look = computed<ClubLook | null>(() => {
    const p = this.page();
    if (p !== undefined) return p;
    const h = this.home();
    return h === undefined ? this.last() : h;
  });

  constructor() {
    effect(() => this.apply(this.look()));
  }

  private apply(look: ClubLook | null) {
    let el = this.doc.getElementById('club-theme') as HTMLStyleElement | null;
    const colors = look?.colors;
    const standard = !colors || (colors.primary.toUpperCase() === DEFAULT_COLORS.primary && colors.accent.toUpperCase() === DEFAULT_COLORS.accent);
    if (standard) { el?.remove(); }
    else {
      if (!el) {
        el = this.doc.createElement('style');
        el.id = 'club-theme';
        this.doc.head.appendChild(el);
      }
      el.textContent = themeCss(colors);
    }
    const meta = this.doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', standard ? DEFAULT_COLORS.primary : getComputedStyle(this.doc.documentElement).getPropertyValue('--hdr').trim());
    if (look !== this.last()) {
      try { if (look) localStorage.setItem(KEY, JSON.stringify(look)); else localStorage.removeItem(KEY); } catch { /* private mode */ }
    }
  }
}
