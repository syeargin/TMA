/** What's attached to an event (GET /teams/{t}/events/{eid}/attached), for the warning before it's removed. */
export type Attached = { answers: number; meals: number; matches: number; workMatches: number; refJobs: boolean; dayPlan: boolean; agenda: boolean; attendance: number };

const n = (k: number, one: string, many = one + 's') => `${k} ${k === 1 ? one : many}`;

/** "12 answers, 2 meal jobs and the day plan"; "" when nothing is attached. */
export function attachedText(a: Attached | null | undefined): string {
  if (!a) return '';
  const parts = [
    a.answers && n(a.answers, 'answer'),
    a.attendance && n(a.attendance, 'attendance sheet'),
    a.meals && n(a.meals, 'meal job'),
    a.matches && n(a.matches, 'match', 'matches'),
    a.workMatches && n(a.workMatches, 'match to work', 'matches to work'),
    a.refJobs && 'the ref jobs',
    a.dayPlan && 'the day plan',
    a.agenda && 'the agenda'
  ].filter(Boolean) as string[];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? '';
}
