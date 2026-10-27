/**
 * Tournament match tracker and season stats, shared by the API (checks) and the site (totals, the
 * Stats tab, the shared results). Stored per tournament as TEAM#t / EVENT#eid#MATCHES:
 *   { matches: { "<date>-<n>": Match }, slots: { "<date>": n }, scorekeeper: "<member sub>" }
 * Each tournament day shows `slots[date]` rows (3 unless staff changed it), "Match 1" to "Match n".
 * A row is a match once something is entered in it; totals count only matches with a result.
 */

export const DEFAULT_SLOTS = 3;
export const MAX_SLOTS = 12;
/** 2 = two sets, always both played (pool play); 3 and 5 = best of. */
export const FORMATS = [2, 3, 5] as const;
export type Format = (typeof FORMATS)[number];
export const FORMAT_LABELS: Record<Format, string> = { 2: "2 sets", 3: "Best of 3", 5: "Best of 5" };
export type Result = "W" | "L";

export type SetScore = { us: number; them: number };
export type Match = {
  date: string; n: number;
  time?: string; court?: string; opponent?: string;
  format: Format;
  sets: SetScore[];
  /** Win or loss. The site fills it in from the sets; staff can change it. */
  result?: Result | "";
  updatedAt?: string; updatedBy?: string;
};
export type MatchDoc = { matches?: Record<string, Match>; slots?: Record<string, number>; scorekeeper?: string };

export const matchId = (date: string, n: number) => `${date}-${n}`;
export const MATCH_ID = /^(\d{4}-\d{2}-\d{2})-(\d{1,2})$/;

/** The days of a tournament, first to last (at most 7). */
export function tournamentDays(date: string, endDate?: string): string[] {
  const out: string[] = [];
  let d = date;
  const last = endDate && endDate >= date ? endDate : date;
  while (d <= last && out.length < 7) {
    out.push(d);
    d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  }
  return out;
}

/** Sets won and lost, from the sets that have a score. */
export function setsWon(sets: readonly SetScore[]): { won: number; lost: number } {
  let won = 0, lost = 0;
  for (const s of sets) {
    if (!played(s)) continue;
    if (s.us > s.them) won++;
    else if (s.them > s.us) lost++;
  }
  return { won, lost };
}
const played = (s: SetScore) => s.us > 0 || s.them > 0;

/**
 * The result the sets say, or "" when they don't settle it: best of 3 or 5 needs a team to reach a
 * majority, and 2 sets needs both won or both lost (a 1–1 split is left to staff to call).
 */
export function suggestedResult(m: Pick<Match, "format" | "sets">): Result | "" {
  const { won, lost } = setsWon(m.sets);
  if (m.format === 2) return won === 2 ? "W" : lost === 2 ? "L" : "";
  const need = Math.ceil(m.format / 2);
  return won >= need ? "W" : lost >= need ? "L" : "";
}

/** A problem with a match as entered, or "" when it's fine. */
export function matchProblem(m: Pick<Match, "format" | "sets" | "result">): string {
  if (m.sets.length > m.format) return `${FORMAT_LABELS[m.format]} has at most ${m.format} sets.`;
  for (const [i, s] of m.sets.entries()) {
    if (!Number.isInteger(s.us) || !Number.isInteger(s.them) || s.us < 0 || s.them < 0 || s.us > 99 || s.them > 99) return `Set ${i + 1}: scores are whole numbers from 0 to 99.`;
    if (played(s) && s.us === s.them) return `Set ${i + 1} can't end tied.`;
  }
  const { won, lost } = setsWon(m.sets);
  if (m.format !== 2 && Math.max(won, lost) > Math.ceil(m.format / 2)) return "There's a set after the match was already won.";
  const s = suggestedResult(m);
  if (m.result && s && m.result !== s) return `The sets say ${s === "W" ? "win" : "loss"}. Check the scores.`;
  return "";
}

export type Totals = {
  played: number; won: number; lost: number;
  setsWon: number; setsLost: number; pointsFor: number; pointsAgainst: number;
  /** Rows on the tracker with no result yet. */
  toPlay: number;
};
const zero = (): Totals => ({ played: 0, won: 0, lost: 0, setsWon: 0, setsLost: 0, pointsFor: 0, pointsAgainst: 0, toPlay: 0 });

function add(t: Totals, m: Match) {
  if (!m.result) { t.toPlay++; return; }
  t.played++;
  if (m.result === "W") t.won++; else t.lost++;
  const s = setsWon(m.sets);
  t.setsWon += s.won; t.setsLost += s.lost;
  for (const x of m.sets) { t.pointsFor += x.us; t.pointsAgainst += x.them; }
}

/** Slots shown for a day: what staff set, never fewer than the matches entered on it. */
export function slotsFor(doc: MatchDoc | undefined, date: string): number {
  const entered = Object.values(doc?.matches ?? {}).filter((m) => m.date === date).reduce((n, m) => Math.max(n, m.n), 0);
  return Math.max(doc?.slots?.[date] ?? DEFAULT_SLOTS, entered);
}

/** One tournament's rows by day (entered matches, and empty slots as null) with each day's totals. */
export function tournamentView(doc: MatchDoc | undefined, days: readonly string[]) {
  const total = zero();
  const out = days.map((date) => {
    const t = zero();
    const rows: { n: number; id: string; match: Match | null }[] = [];
    for (let n = 1; n <= slotsFor(doc, date); n++) {
      const match = doc?.matches?.[matchId(date, n)] ?? null;
      rows.push({ n, id: matchId(date, n), match });
      if (match) add(t, match); else t.toPlay++;
    }
    for (const k of Object.keys(t) as (keyof Totals)[]) total[k] += t[k];
    return { date, rows, totals: t };
  });
  return { days: out, totals: total };
}

/** Every match with a result, oldest first, with the tournament it was in. */
export type SeasonMatch = Match & { eid: string; title: string };

export function seasonMatches(tournaments: readonly { eid: string; title: string }[], docs: Record<string, MatchDoc | undefined>): SeasonMatch[] {
  const out: SeasonMatch[] = [];
  for (const t of tournaments) for (const m of Object.values(docs[t.eid]?.matches ?? {})) if (m.result) out.push({ ...m, eid: t.eid, title: t.title });
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.n - b.n);
}

/** The Stats tab: totals, last results, each set number's record and opponents met more than once. */
export function seasonStats(matches: readonly SeasonMatch[]) {
  const totals = zero();
  for (const m of matches) add(totals, m);
  const bySet: { won: number; lost: number }[] = [];
  for (const m of matches) {
    m.sets.forEach((s, i) => {
      if (!played(s)) return;
      bySet[i] ??= { won: 0, lost: 0 };
      if (s.us > s.them) bySet[i].won++; else bySet[i].lost++;
    });
  }
  const opp = new Map<string, { name: string; won: number; lost: number; setsWon: number; setsLost: number }>();
  for (const m of matches) {
    const name = (m.opponent ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase().replace(/\s+/g, " ");
    const o = opp.get(key) ?? { name, won: 0, lost: 0, setsWon: 0, setsLost: 0 };
    if (m.result === "W") o.won++; else o.lost++;
    const s = setsWon(m.sets);
    o.setsWon += s.won; o.setsLost += s.lost;
    opp.set(key, o);
  }
  const last = matches.slice(-10).map((m) => m.result as Result);
  return {
    totals,
    last,
    latest: matches.at(-1) ?? null,
    bySet: bySet.map((s, i) => ({ set: i + 1, ...s })),
    opponents: [...opp.values()].filter((o) => o.won + o.lost > 1).sort((a, b) => b.won + b.lost - (a.won + a.lost) || a.name.localeCompare(b.name))
  };
}

const sign = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");
export const pointDiff = (t: Pick<Totals, "pointsFor" | "pointsAgainst">) => sign(t.pointsFor - t.pointsAgainst);
export const record = (t: Pick<Totals, "won" | "lost">) => `${t.won}–${t.lost}`;
export const setText = (sets: readonly SetScore[]) => sets.filter(played).map((s) => `${s.us}–${s.them}`).join(", ");
