import type { HelpPlace } from '@shared/help';

/** Which help page a team URL is: /teams/t/tournaments/e/meals → "tournament:meals". */
export function placeOf(url: string): HelpPlace | null {
  const m = /^\/teams\/[^/]+\/?([^?#]*)/.exec(url);
  if (!m) return url.startsWith('/account') ? 'account' : null;
  const [seg = '', id, section] = m[1].split('/');
  if (!seg) return 'home';
  if (seg === 'tournaments') {
    if (!id) return 'tournaments';
    return section === 'ref' || section === 'meals' || section === 'travel' ? `tournament:${section}` as HelpPlace : 'tournament';
  }
  return (['schedule', 'fund', 'roster', 'info', 'members', 'communications'] as const).find((s) => s === seg) ?? null;
}

