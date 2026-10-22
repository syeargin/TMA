/**
 * Spotting mistyped email addresses in a spreadsheet import (R30), so a typo doesn't invite a stranger.
 * Only warnings: the admin can still apply the import, after reading the flagged addresses.
 */

/** Domains most families use. A domain one or two letters away from one of these is probably a typo. */
const COMMON_DOMAINS = [
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com", "live.com", "msn.com",
  "me.com", "mac.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "charter.net",
  "cox.net", "protonmail.com", "proton.me", "ymail.com"
];
/** Real domains that look like typos of the ones above. */
const ALSO_REAL = new Set(["mail.com", "gmx.com", "hotmail.co.uk", "yahoo.co.uk", "live.ca", "me.com", "mac.com", "msn.com", "aol.com", "att.net", "cox.net"]);
const BAD_ENDINGS: Record<string, string> = { ".con": ".com", ".cm": ".com", ".cmo": ".com", ".ocm": ".com", ".comm": ".com", ".co": ".com", ".nte": ".net", ".ne": ".net" };

/** Edit distance (insert, delete, substitute, swap neighbours), stopping early past `max`. */
export function distance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = [], prev: number[] = [], cur: number[] = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2.splice(0, prev2.length, ...prev);
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length];
}

/** "Did you mean …?" for an address whose domain looks mistyped, or null. */
export function domainTypo(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (COMMON_DOMAINS.includes(domain) || ALSO_REAL.has(domain)) return null;
  for (const [bad, good] of Object.entries(BAD_ENDINGS)) {
    if (domain.endsWith(bad)) {
      const fixed = domain.slice(0, -bad.length) + good;
      if (COMMON_DOMAINS.includes(fixed)) return `${local}@${fixed}`;
    }
  }
  let best: { d: string; dist: number } | null = null;
  for (const d of COMMON_DOMAINS) {
    const dist = distance(domain, d, 2);
    if (dist <= 2 && (!best || dist < best.dist)) best = { d, dist };
  }
  return best ? `${local}@${best.d}` : null;
}

/** Addresses in `others` within two typos of `email` (but not the same address). */
export function lookAlikes(email: string, others: Iterable<string>): string[] {
  const out: string[] = [];
  for (const o of others) if (o !== email && distance(email, o, 2) <= 2) out.push(o);
  return out;
}
