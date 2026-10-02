import { DEFAULT_COLORS, colorAdvice, contrast, palette, themeCss } from './theme';

const WHITE = '#FFFFFF';
const LIGHT_SURFACE = '#FFFFFF', DARK_SURFACE = '#111A2B';

// A spread of real club colors, including awkward light ones.
const SAMPLES = ['#15294D', '#C8323E', '#FFCC33', '#FFFFFF', '#000000', '#F2B705', '#9BD3F5', '#19B3B1', '#7A0019', '#00FF00', '#FF69B4', '#808080', '#E8E8E8', '#123456'];

describe('club palette', () => {
  for (const primary of SAMPLES) {
    for (const accent of SAMPLES) {
      it(`stays readable for ${primary} / ${accent}`, () => {
        const { light, dark } = palette({ primary, accent });
        // Header text and muted header text.
        expect(contrast(light['--hdr'], light['--hdr-ink'])).toBeGreaterThanOrEqual(7);
        expect(contrast(light['--hdr'], light['--hdr-mute'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark['--hdr'], dark['--hdr-ink'])).toBeGreaterThanOrEqual(7);
        expect(contrast(dark['--hdr'], dark['--hdr-mute'])).toBeGreaterThanOrEqual(4.5);
        // Buttons and links.
        expect(contrast(light['--btn'], light['--btn-ink'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(light['--navy'], LIGHT_SURFACE)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark['--btn'], dark['--btn-ink'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark['--navy'], DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
        // Accent: text on accent, and accent-colored text on its soft background.
        expect(contrast(light['--accent-strong'], light['--accent-ink'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(light['--accent-text'], light['--accent-soft'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark['--accent-strong'], dark['--accent-ink'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark['--accent-text'], dark['--accent-soft'])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('keeps a club’s own dark colors as they are', () => {
    const { light } = palette(DEFAULT_COLORS);
    expect(light['--hdr']).toBe('#15294D');
    expect(light['--btn']).toBe('#15294D');
    expect(light['--accent']).toBe('#C8323E');
  });

  it('a light main color gets a darker header and buttons, and says so', () => {
    const { light } = palette({ primary: '#FFCC33', accent: '#15294D' });
    expect(contrast(light['--hdr'], WHITE)).toBeGreaterThanOrEqual(9);
    expect(colorAdvice({ primary: '#FFCC33', accent: '#15294D' })[0]).toMatch(/darker shade/);
    expect(colorAdvice(DEFAULT_COLORS)).toEqual([]);
  });

  it('writes light and dark rules', () => {
    const css = themeCss({ primary: '#004225', accent: '#FFFFFF' });
    expect(css).toMatch(/^:root\{--hdr:#/);
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){');
    expect(css).toContain(':root[data-theme="dark"]{');
  });
  it('ignores bad input', () => {
    expect(palette({ primary: 'red', accent: '' }).light['--accent']).toBe('#C8323E');
  });
});
