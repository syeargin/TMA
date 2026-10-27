/**
 * Search for the help guide. Small on purpose: 18 topics fit in memory, so it runs in the browser as
 * people type. Words match the start of words in a topic (so "cal" finds "calendar"), and common other
 * words map to the site's own ("rsvp" finds the In / Maybe / Out topic).
 */
import type { HelpTopic } from "./help.js";

/** Words people use → words the topics use. */
export const SYNONYMS: Record<string, string[]> = {
  rsvp: ["answer", "availability"], attending: ["answer"], coming: ["answer"], absent: ["out", "attendance"],
  venmo: ["payment"], zelle: ["payment"], paypal: ["payment"], pay: ["payment", "dues"], paid: ["payment", "dues"], money: ["payment", "dues", "fund"], fees: ["dues"], treasurer: ["finance"],
  hotel: ["travel"], lodging: ["travel"], room: ["travel"], carpool: ["travel"],
  food: ["meal"], snack: ["meal"], snacks: ["meal"], lunch: ["meal"], dinner: ["meal"],
  ical: ["calendar"], ics: ["calendar"], iphone: ["calendar"], gcal: ["calendar"], outlook: ["calendar"],
  unsubscribe: ["emails"], notifications: ["emails"], notification: ["emails"], spam: ["emails"],
  referee: ["ref"], refs: ["ref"], scorebook: ["ref"], linesman: ["ref"],
  delete: ["cancel"], remove: ["cancel"], reschedule: ["change"], move: ["change"],
  recurring: ["repeat"], weekly: ["repeat", "weekly"], roll: ["attendance"],
  signup: ["sign"], register: ["join", "sign"], login: ["sign"], password: ["sign"],
  message: ["announcement"], news: ["announcement"], broadcast: ["announcement"],
  excel: ["spreadsheet"], csv: ["spreadsheet"], xlsx: ["spreadsheet"], parents: ["invite", "families"]
};

const STOP = new Set(["a", "an", "and", "the", "to", "of", "for", "my", "i", "how", "do", "can", "is", "in", "on", "it", "what", "where", "with", "me", "our", "we", "you", "your"]);

/** Lower case, no accents or curly quotes, words only. */
export const words = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean);

/** The search words for a query, with the words each one also matches. */
export function terms(query: string): { word: string; also: string[] }[] {
  const ws = words(query);
  const keep = ws.filter((w) => !STOP.has(w));
  return (keep.length ? keep : ws).map((w) => ({ word: w, also: SYNONYMS[w] ?? [] }));
}

const plain = (s: string) => s.replace(/\*\*/g, "");
const WEIGHT = { title: 6, keywords: 4, summary: 2, steps: 1 } as const;

export type HelpHit = { topic: HelpTopic; score: number; /** Words that matched, to highlight. */ marks: string[] };

/**
 * Topics matching every search word (or one of its other words), best first. A word counts once per
 * field, weighted by where it matched; matching a title's whole word scores more than its start.
 */
export function searchHelp(query: string, topics: readonly HelpTopic[]): HelpHit[] {
  const ts = terms(query);
  if (!ts.length) return [];
  const hits: HelpHit[] = [];
  topics.forEach((t, order) => {
    const fields = {
      title: words(t.title), keywords: t.keywords.flatMap(words), summary: words(t.summary),
      steps: words(plain([...t.steps, ...(t.tips ?? [])].join(" ")))
    };
    let score = 0;
    const marks = new Set<string>();
    for (const term of ts) {
      let best = 0;
      for (const [f, list] of Object.entries(fields) as [keyof typeof WEIGHT, string[]][]) {
        for (const w of [term.word, ...term.also]) {
          const syn = w !== term.word;
          const exact = list.includes(w);
          const prefix = w.length >= 2 && list.some((x) => x.startsWith(w));
          if (!exact && !prefix) continue;
          const s = WEIGHT[f] * (exact ? 1.5 : 1) * (syn ? 0.8 : 1);
          if (s > best) best = s;
          marks.add(w);
        }
      }
      if (!best) return; // every word has to match something
      score += best;
    }
    hits.push({ topic: t, score: score - order / 1000, marks: [...marks] });
  });
  return hits.sort((a, b) => b.score - a.score);
}

/**
 * Splits text into plain and highlighted parts for the words that matched (start of a word), and
 * **bold** labels. The site renders the parts as text, never as HTML.
 */
export function highlight(text: string, marks: readonly string[]): { text: string; mark?: boolean; bold?: boolean }[] {
  const out: { text: string; mark?: boolean; bold?: boolean }[] = [];
  const parts = text.split(/\*\*(.+?)\*\*/g);
  const ms = [...marks].filter(Boolean).sort((a, b) => b.length - a.length).map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = ms.length ? new RegExp(`(?<![A-Za-z0-9])(${ms.join("|")})`, "gi") : null;
  parts.forEach((part, i) => {
    if (!part) return;
    const bold = i % 2 === 1 || undefined;
    if (!re) { out.push({ text: part, bold }); return; }
    let last = 0;
    for (const m of part.matchAll(re)) {
      if (m.index! > last) out.push({ text: part.slice(last, m.index), bold });
      out.push({ text: m[0], mark: true, bold });
      last = m.index! + m[0].length;
    }
    if (last < part.length) out.push({ text: part.slice(last), bold });
  });
  return out;
}
