/**
 * Map links for addresses. Nothing is looked up: the address (or, when there isn't one yet, the venue name and
 * city) becomes a search in Apple Maps or Google Maps. Apple devices open Apple Maps first; everything else Google.
 */
export type MapApp = 'apple' | 'google';
export interface MapLink { app: MapApp; name: string; url: string }

const clean = (s?: string | null) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** What to search for: the address if there is one, otherwise "venue, city" (duplicates dropped). */
export function mapQuery(address?: string | null, place?: string | null, city?: string | null): string {
  const a = clean(address);
  if (a) return a;
  const parts = [clean(place), clean(city)].filter(Boolean);
  return parts.filter((p, i) => parts.findIndex((x) => x.toLowerCase() === p.toLowerCase()) === i).join(', ');
}

export const googleMapsUrl = (q: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
export const appleMapsUrl = (q: string) => `https://maps.apple.com/?q=${encodeURIComponent(q)}`;

/** iPhone, iPad (which reports itself as a Mac) and Mac: Apple Maps. Everything else: Google Maps. */
export function preferredMapApp(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): MapApp {
  return /iPhone|iPad|iPod|Macintosh/i.test(ua) ? 'apple' : 'google';
}

/** The link to show first and the other app's link, for one search. */
export function mapLinks(q: string, app: MapApp = preferredMapApp()): { primary: MapLink; other: MapLink } {
  const apple: MapLink = { app: 'apple', name: 'Apple Maps', url: appleMapsUrl(q) };
  const google: MapLink = { app: 'google', name: 'Google Maps', url: googleMapsUrl(q) };
  return app === 'apple' ? { primary: apple, other: google } : { primary: google, other: apple };
}
