// Practice attendance, shared by the API and the site. Staff mark each player at (or after) a
// practice: Present, Late, Excused or Absent. Availability (In, Maybe, Out) is what families answer
// ahead of time; it only fills in the starting marks.

export const MARKS = ["present", "late", "excused", "absent"] as const;
export type Mark = (typeof MARKS)[number];
export const MARK_LABELS: Record<Mark, string> = { present: "Present", late: "Late", excused: "Excused", absent: "Absent" };
/** One letter for the small squares, so marks never depend on color alone. */
export const MARK_LETTERS: Record<Mark, string> = { present: "P", late: "L", excused: "E", absent: "A" };

export type PlayerMark = { s: Mark; note?: string };
/** One practice date's attendance (TEAM#t / ATT#<practice key>). */
export type AttendanceRecord = { key: string; date: string; marks: Record<string, PlayerMark>; takenBy?: string; takenAt?: string; updatedBy?: string; updatedAt?: string };

/** The starting mark from the family's availability answer: In → Present, Out → Excused, else none. */
export function suggestedMark(rsvp: string | undefined): Mark | undefined {
  if (rsvp === "yes") return "present";
  if (rsvp === "no") return "excused";
  return undefined;
}

export type PlayerSummary = {
  pid: string; present: number; late: number; excused: number; absent: number;
  /** Practices this player was marked at. */
  marked: number;
  /** Present or late. */
  attended: number;
  /** What the percentage divides by: every marked practice, or without excused ones when the team chose that. */
  counted: number;
  /** 0–100, rounded; null when nothing counts yet. */
  rate: number | null;
  /** The newest marks last, at most `recent` of them. */
  last: { key: string; date: string; s: Mark; note?: string }[];
};

export type Summary = {
  /** Practice dates with at least one mark, cancelled ones left out. */
  taken: number;
  players: PlayerSummary[];
  /** The whole team: attended over counted, 0–100; null when nothing counts. */
  teamRate: number | null;
  attended: number; counted: number;
};

/**
 * Totals per player over the given records. `practices` are the practice keys that still count
 * (cancelled dates left out); records for other keys are ignored. `from`/`to` limit by date.
 */
export function summarize(records: AttendanceRecord[], pids: string[], opts: { practices: Set<string>; excusedCount?: boolean; from?: string; to?: string; recent?: number }): Summary {
  const excusedCount = opts.excusedCount !== false;
  const recent = opts.recent ?? 8;
  const kept = records
    .filter((r) => opts.practices.has(r.key) && Object.keys(r.marks ?? {}).length && (!opts.from || r.date >= opts.from) && (!opts.to || r.date <= opts.to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  let attended = 0, counted = 0;
  const players = pids.map((pid) => {
    const s: PlayerSummary = { pid, present: 0, late: 0, excused: 0, absent: 0, marked: 0, attended: 0, counted: 0, rate: null, last: [] };
    for (const r of kept) {
      const m = r.marks[pid];
      if (!m || !MARKS.includes(m.s)) continue;
      s[m.s]++;
      s.marked++;
      s.last.push({ key: r.key, date: r.date, s: m.s, ...(m.note ? { note: m.note } : {}) });
    }
    s.attended = s.present + s.late;
    s.counted = excusedCount ? s.marked : s.marked - s.excused;
    s.rate = s.counted ? Math.round((100 * s.attended) / s.counted) : null;
    s.last = s.last.slice(-recent);
    attended += s.attended;
    counted += s.counted;
    return s;
  });
  return { taken: kept.length, players, attended, counted, teamRate: counted ? Math.round((100 * attended) / counted) : null };
}
