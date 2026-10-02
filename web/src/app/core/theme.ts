/**
 * Club colors → the site's color tokens, for light and dark mode.
 *
 * A club picks two colors. Whatever they pick, text has to stay readable, so each token is the club's
 * color nudged darker (or lighter, in dark mode) only as far as it takes to reach a readable contrast:
 *  - primary: the header (always dark, white text on it) and buttons, links and highlights.
 *  - accent: the stripe under the header and small highlights, as picked. Text in the accent color
 *    (--accent-text) and badges with text on them (--accent-strong + --accent-ink) are adjusted separately.
 */
export interface ClubColors { primary: string; accent: string }

export const DEFAULT_COLORS: ClubColors = { primary: '#15294D', accent: '#C8323E' };

type RGB = [number, number, number];

export const isHex = (s: string | undefined): s is string => !!s && /^#[0-9a-f]{6}$/i.test(s.trim());

export function rgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}
export function hex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** Mix a toward b by t (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as RGB);
}
export function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
/** Move c toward `to` in small steps until it has at least `ratio` contrast with `against`. */
export function pushUntil(c: string, to: string, against: string, ratio: number): string {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const m = mix(c, to, t);
    if (contrast(m, against) >= ratio) return m;
  }
  return to;
}
const BLACK = '#000000', WHITE = '#FFFFFF';
/** Black or near-black/white text, whichever reads better on c. */
export const inkOn = (c: string, dark = '#101B2E', light = WHITE) => (contrast(c, dark) >= contrast(c, light) ? dark : light);
/** A background close to c that `ink` text reads well on (for badges and buttons in the accent color). */
function strong(c: string, darkInk: string): { bg: string; ink: string } {
  const ink = inkOn(c, darkInk);
  return { bg: pushUntil(c, ink === WHITE ? BLACK : WHITE, ink, 4.6), ink };
}

// Neutral surfaces the tokens are checked against (match styles.css).
const LIGHT = { surface: '#FFFFFF', bg: '#EDF0F5' };
const DARK = { surface: '#111A2B', bg: '#0A111E' };

export type Tokens = Record<string, string>;

export function palette(colors: ClubColors): { light: Tokens; dark: Tokens } {
  const P = isHex(colors.primary) ? colors.primary.toUpperCase() : DEFAULT_COLORS.primary;
  const A = isHex(colors.accent) ? colors.accent.toUpperCase() : DEFAULT_COLORS.accent;

  // ----- light -----
  const hdr = pushUntil(P, BLACK, WHITE, 9);
  const navy = pushUntil(P, BLACK, LIGHT.surface, 5);
  const accentSoft = mix(A, WHITE, 0.86);
  const aStrong = strong(A, '#101B2E');
  const light: Tokens = {
    '--hdr': hdr,
    '--hdr-2': mix(hdr, BLACK, 0.3),
    '--hdr-ink': '#F4F6FA',
    '--hdr-mute': pushUntil(mix(hdr, WHITE, 0.62), WHITE, hdr, 4.6),
    '--navy': navy,
    '--btn': navy,
    '--btn-ink': WHITE,
    '--btn-soft': mix(P, WHITE, 0.88),
    '--accent': A,
    '--accent-strong': aStrong.bg,
    '--accent-ink': aStrong.ink,
    '--accent-soft': accentSoft,
    '--accent-text': pushUntil(A, BLACK, accentSoft, 4.6)
  };

  // ----- dark -----
  const dHdr = pushUntil(mix(P, DARK.bg, 0.35), BLACK, WHITE, 12);
  const dBtn = pushUntil(P, WHITE, DARK.surface, 7);
  const dAccent = pushUntil(A, WHITE, DARK.surface, 4);
  const dAccentSoft = mix(A, DARK.surface, 0.8);
  const dStrong = strong(dAccent, DARK.bg);
  const dark: Tokens = {
    '--hdr': dHdr,
    '--hdr-2': mix(dHdr, BLACK, 0.3),
    '--hdr-ink': '#F1F4F9',
    '--hdr-mute': pushUntil(mix(dHdr, WHITE, 0.55), WHITE, dHdr, 4.6),
    '--navy': dBtn,
    '--btn': dBtn,
    '--btn-ink': DARK.bg,
    '--btn-soft': mix(P, DARK.surface, 0.78),
    '--accent': dAccent,
    '--accent-strong': dStrong.bg,
    '--accent-ink': dStrong.ink,
    '--accent-soft': dAccentSoft,
    '--accent-text': pushUntil(A, WHITE, dAccentSoft, 4.6)
  };
  return { light, dark };
}

const block = (t: Tokens) => Object.entries(t).map(([k, v]) => `${k}:${v}`).join(';');

/** The CSS that overrides styles.css's color tokens for one club. */
export function themeCss(colors: ClubColors): string {
  const { light, dark } = palette(colors);
  return `:root{${block(light)}}` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${block(dark)}}}` +
    `:root[data-theme="dark"]{${block(dark)}}`;
}

/** Plain-language warnings for the color picker. */
export function colorAdvice(colors: ClubColors): string[] {
  const out: string[] = [];
  if (contrast(colors.primary, WHITE) < 4.5) out.push('The main color is light, so the header and buttons use a darker shade of it to keep white text readable.');
  if (contrast(colors.primary, colors.accent) < 1.3) out.push('The two colors are very close. A contrasting accent makes the stripe under the header stand out.');
  return out;
}
