/**
 * Fetches a team's calendar feed. The link is typed by a team admin, so the fetch is fenced in:
 * HTTPS only on the standard port, no addresses inside private networks (checked on every DNS answer
 * and every redirect), at most 3 redirects, 10 seconds and 2 MB. The link holds a secret token, so it
 * is never logged; only its host is.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { createGunzip, createInflate } from "node:zlib";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { FeedError } from "./ical.js";

export const FETCH_LIMITS = { bytes: 2 * 1024 * 1024, timeoutMs: 10_000, redirects: 3 };
const UA = "TeemHub-CalendarSync/1.0 (+https://teemhub.net)";

/** webcal:// links are https links; anything else that isn't https is refused. */
export function normalizeFeedUrl(raw: string): URL {
  const s = raw.trim().replace(/^webcals?:\/\//i, "https://");
  let u: URL;
  try { u = new URL(s); } catch { throw new FeedError("feed_bad_link", "That isn't a web address. Paste the whole calendar link, starting with https:// or webcal://."); }
  if (u.protocol !== "https:") throw new FeedError("feed_bad_link", "Calendar links must start with https:// or webcal://.");
  if (u.username || u.password) throw new FeedError("feed_bad_link", "Calendar links with a user name or password in them aren't supported.");
  if (u.port && u.port !== "443") throw new FeedError("feed_bad_link", "Calendar links must use the standard web port.");
  if (!u.hostname.includes(".") && !isIP(u.hostname.replace(/^\[|\]$/g, ""))) throw new FeedError("feed_bad_link", "That address isn't on the public internet.");
  u.hash = "";
  return u;
}

function v4Parts(ip: string): number[] { return ip.split(".").map(Number); }

/** Addresses a feed may never come from: private networks, this machine, link-local (cloud metadata), multicast and reserved. */
export function blockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = v4Parts(ip);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && v4Parts(ip)[2] === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (kind === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return blockedAddress(mapped[1]);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith("64:ff9b:") || s.startsWith("::ffff:") || s.startsWith("2001:db8");
  }
  return true;
}

type LookupFn = (hostname: string, options: { all?: boolean; family?: number }, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => void;

/** DNS lookup that refuses names pointing inside private networks. Checked when connecting, so a name can't change in between. */
export const safeLookup: LookupFn = (hostname, options, cb) => {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = addrs as LookupAddress[];
    if (!list.length || list.some((a) => blockedAddress(a.address))) return cb(new FeedError("feed_blocked", "That calendar link points to a private address, so Teem Hub can't read it."), "");
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
};

/** Reads a stream up to `max` bytes; more than that is refused. */
export async function readLimited(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of stream) {
    n += (chunk as Buffer).length;
    if (n > max) { stream.destroy(); throw new FeedError("feed_too_big", "That calendar is larger than 2 MB. Use a calendar link for just this team."); }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function get(u: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && blockedAddress(host)) return Promise.reject(new FeedError("feed_blocked", "That calendar link points to a private address, so Teem Hub can't read it."));
  return new Promise((resolve, reject) => {
    const req = request(u, {
      method: "GET", signal, lookup: safeLookup as never,
      headers: { "User-Agent": UA, Accept: "text/calendar, text/plain;q=0.8, */*;q=0.5", "Accept-Encoding": "gzip, deflate" }
    }, resolve);
    req.on("error", reject);
    req.end();
  });
}

export type Fetched = { body: string; host: string; finalHost: string };

export async function fetchFeed(raw: string): Promise<Fetched> {
  let u = normalizeFeedUrl(raw);
  const host = u.hostname;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_LIMITS.timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      let res: IncomingMessage;
      try { res = await get(u, ctl.signal); } catch (e) { throw asFeedError(e, ctl.signal.aborted); }
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hop >= FETCH_LIMITS.redirects) throw new FeedError("feed_unreachable", "That calendar link redirects too many times.");
        u = normalizeFeedUrl(new URL(res.headers.location, u).toString());
        continue;
      }
      if (status === 401 || status === 403 || status === 404 || status === 410) {
        res.resume();
        throw new FeedError("feed_gone", "The calendar link didn't work. It may have been replaced: copy a fresh link from your club's scheduling site.");
      }
      if (status < 200 || status >= 300) { res.resume(); throw new FeedError("feed_unreachable", `The calendar's site answered with an error (${status}). Try again in a few minutes.`); }
      const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
      const len = Number(res.headers["content-length"] ?? 0);
      if (len > FETCH_LIMITS.bytes && !enc) { res.destroy(); throw new FeedError("feed_too_big", "That calendar is larger than 2 MB. Use a calendar link for just this team."); }
      const stream: Readable = enc === "gzip" ? res.pipe(createGunzip()) : enc === "deflate" ? res.pipe(createInflate()) : res;
      let buf: Buffer;
      try { buf = await readLimited(stream, FETCH_LIMITS.bytes); } catch (e) { throw asFeedError(e, ctl.signal.aborted); }
      return { body: buf.toString("utf8"), host, finalHost: u.hostname };
    }
  } finally {
    clearTimeout(timer);
  }
}

let fetcher: (raw: string) => Promise<Fetched> = fetchFeed;
/** Tests and the local preview read made-up calendars instead of the internet (like setMfaLookup). */
export function setFeedFetcher(f: ((raw: string) => Promise<Fetched>) | null) { fetcher = f ?? fetchFeed; }
/** What routes call: fetchFeed, unless a test swapped it. */
export const loadFeed = (raw: string) => fetcher(raw);

function asFeedError(e: unknown, timedOut: boolean): FeedError {
  if (e instanceof FeedError) return e;
  if (timedOut || (e as { name?: string }).name === "AbortError") return new FeedError("feed_timeout", "The calendar's site didn't answer within 10 seconds. Try again in a few minutes.");
  const code = (e as { code?: string }).code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new FeedError("feed_unreachable", "Couldn't find that calendar's site. Check the link.");
  if (/CERT|SSL|TLS/i.test(code)) return new FeedError("feed_unreachable", "That calendar's site has a security certificate problem, so Teem Hub won't read it.");
  return new FeedError("feed_unreachable", "Couldn't reach that calendar. Try again in a few minutes.");
}

/** "https://ss-func-prod.azurewebsites.net/api/calendar/feed/e32d…ics" → "…/feed/e32d…b79593.ics": enough to recognize, not to use. */
export function maskFeedUrl(raw: string): string {
  let u: URL;
  try { u = normalizeFeedUrl(raw); } catch { return "…"; }
  const segs = u.pathname.split("/").filter(Boolean);
  const last = segs.pop() ?? "";
  const parent = segs.pop();
  const dot = last.lastIndexOf(".");
  const stem = dot > 0 ? last.slice(0, dot) : last, ext = dot > 0 ? last.slice(dot) : "";
  const shown = stem.length > 12 ? `${stem.slice(0, 4)}…${stem.slice(-6)}` : stem.length > 4 ? `${stem.slice(0, 2)}…` : stem;
  // A plain word like "feed" helps recognize the link; anything else might be the token itself (Google puts it there).
  const keepParent = !!parent && /^[a-z]{1,12}$/i.test(parent);
  return `${u.hostname}/…${keepParent ? `/${parent}` : ""}/${shown}${ext}${u.search ? "?…" : ""}`;
}
