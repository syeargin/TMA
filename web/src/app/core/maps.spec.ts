import { appleMapsUrl, googleMapsUrl, mapLinks, mapQuery, preferredMapApp } from './maps';

describe('map links', () => {
  it('search for the address, or the venue and city when there is none', () => {
    expect(mapQuery('1234 Main St, Roswell, GA', 'A5 Sportsplex', 'Roswell')).toBe('1234 Main St, Roswell, GA');
    expect(mapQuery('', 'Georgia World Congress Center', 'Atlanta, GA')).toBe('Georgia World Congress Center, Atlanta, GA');
    expect(mapQuery(undefined, 'Atlanta, GA', 'Atlanta, GA')).toBe('Atlanta, GA');
    expect(mapQuery('  ', '  Test   Gym ', null)).toBe('Test Gym');
    expect(mapQuery('', '', '')).toBe('');
  });

  it('encode every character an address can hold', () => {
    const q = '100 5th Ave #2 & Annex, Rome, GA';
    expect(googleMapsUrl(q)).toBe('https://www.google.com/maps/search/?api=1&query=100%205th%20Ave%20%232%20%26%20Annex%2C%20Rome%2C%20GA');
    expect(appleMapsUrl(q)).toBe('https://maps.apple.com/?q=100%205th%20Ave%20%232%20%26%20Annex%2C%20Rome%2C%20GA');
  });

  it('open Apple Maps first on iPhone, iPad and Mac, Google Maps everywhere else', () => {
    expect(preferredMapApp('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('apple');
    expect(preferredMapApp('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('apple');
    expect(preferredMapApp('Mozilla/5.0 (Linux; Android 15; Pixel 9)')).toBe('google');
    expect(preferredMapApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('google');
    const l = mapLinks('Test Gym', 'apple');
    expect([l.primary.name, l.other.name]).toEqual(['Apple Maps', 'Google Maps']);
    expect(mapLinks('Test Gym', 'google').primary.url).toContain('google.com/maps');
  });
});
