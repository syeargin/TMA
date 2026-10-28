import { Component, ElementRef, computed, effect, input, output, signal, viewChild } from '@angular/core';
import { pointDiff, record, setText, type Result, type SetScore, type Totals } from '@shared/matches';
import { Sheet } from '../../shared/sheet';

/**
 * Sharing results: a picture (drawn here in the browser, 1080×1350) and the same results as text.
 * Only finished matches, and never player names, times, courts or places, so a shared picture can't
 * tell a stranger where the team will be.
 */
export type ShareRow = { label: string; detail: string; badge: string; tone: 'w' | 'l' | 'n' };
export type ShareCard = { kicker: string; title: string; when: string; headline: string; sub: string; rows: ShareRow[]; text: string; colors?: { primary: string; accent: string } };

const W = 1080, H = 1350, MAX_ROWS = 9;
/** The Teem Hub band along the bottom of every picture: navy, a red top edge, the white logo. */
const BAND = 150, NAVY = '#15294D', RED = '#C8323E';
export const BRAND_HOST = 'teemhub.net';
export const CREDIT = `— Shared from Teem Hub · ${BRAND_HOST}`;

let logo: Promise<HTMLImageElement | null> | null = null;
/** The white logo as a PNG (same origin, so the canvas can still be saved; PNG because some browsers mark a canvas unsaveable after drawing SVG). */
function whiteLogo(): Promise<HTMLImageElement | null> {
  logo ??= new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = '/brand/email-logo-white.png'; });
  return logo;
}

/** One tournament's finished matches. */
export function tournamentShare(o: { team: string; club?: string; title: string; when: string; totals: Totals; matches: { opponent?: string; sets: SetScore[]; result: Result }[]; colors?: { primary: string; accent: string } }): ShareCard {
  const rows = o.matches.map((m) => ({ label: m.opponent?.trim() || 'Opponent', detail: setText(m.sets), badge: m.result, tone: m.result === 'W' ? 'w' as const : 'l' as const }));
  const sub = `sets ${o.totals.setsWon}–${o.totals.setsLost} · points ${pointDiff(o.totals)}`;
  const text = [`${o.team} at ${o.title} (${o.when}): ${record(o.totals)}, ${sub}`, ...rows.map((r) => `${r.badge} ${r.detail} vs ${r.label}`), CREDIT].join('\n');
  return { kicker: [o.club, o.team].filter(Boolean).join(' · '), title: o.title, when: o.when, headline: record(o.totals), sub, rows, text, colors: o.colors };
}

/** The season: one row per tournament with a result. */
export function seasonShare(o: { team: string; club?: string; label: string; totals: Totals; tournaments: { title: string; totals: Totals }[]; colors?: { primary: string; accent: string } }): ShareCard {
  const rows = o.tournaments.map((t) => ({ label: t.title, detail: `sets ${t.totals.setsWon}–${t.totals.setsLost} · ${pointDiff(t.totals)}`, badge: record(t.totals), tone: t.totals.won > t.totals.lost ? 'w' as const : t.totals.won < t.totals.lost ? 'l' as const : 'n' as const }));
  const sub = `sets ${o.totals.setsWon}–${o.totals.setsLost} · points ${pointDiff(o.totals)}`;
  const text = [`${o.team}, ${o.label}: ${record(o.totals)}, ${sub}`, ...rows.map((r) => `${r.label}: ${r.badge} (${r.detail})`), CREDIT].join('\n');
  return { kicker: [o.club, o.team].filter(Boolean).join(' · '), title: o.label, when: `${o.tournaments.length} tournament${o.tournaments.length === 1 ? '' : 's'}`, headline: record(o.totals), sub, rows, text, colors: o.colors };
}

const lum = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Draws the card. Waits for the site's fonts so the picture matches the page. */
export async function drawCard(card: ShareCard, host: string): Promise<Blob> {
  const fam = { display: '"Big Shoulders Display", "Arial Narrow", sans-serif', cond: '"Barlow Condensed", "Arial Narrow", sans-serif', body: 'Barlow, system-ui, sans-serif' };
  try { await Promise.all(['800 40px "Big Shoulders Display"', '700 40px "Barlow Condensed"', '600 40px Barlow'].map((f) => document.fonts.load(f))); } catch { /* falls back */ }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const bg = card.colors?.primary && /^#[0-9a-f]{6}$/i.test(card.colors.primary) ? card.colors.primary : '#15294D';
  const light = lum(bg) > 0.45;
  const ink = light ? '#101B2E' : '#FFFFFF';
  const soft = light ? 'rgba(16,27,46,.7)' : 'rgba(255,255,255,.78)';
  const line = light ? 'rgba(16,27,46,.18)' : 'rgba(255,255,255,.2)';
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const P = 80;
  const fit = (text: string, font: (px: number) => string, max: number, start: number) => {
    let px = start;
    g.font = font(px);
    while (g.measureText(text).width > max && px > 20) { px -= 2; g.font = font(px); }
    return px;
  };
  g.textBaseline = 'alphabetic';
  g.fillStyle = soft; g.font = `600 34px ${fam.cond}`;
  g.fillText(card.kicker.toUpperCase(), P, 130);
  g.fillStyle = ink;
  fit(card.title.toUpperCase(), (px) => `800 ${px}px ${fam.display}`, W - 2 * P, 120);
  g.fillText(card.title.toUpperCase(), P, 250);
  g.fillStyle = soft; g.font = `600 36px ${fam.body}`;
  g.fillText(card.when, P, 310);
  g.fillStyle = ink; g.font = `700 190px ${fam.cond}`;
  g.fillText(card.headline, P - 6, 500);
  const hw = g.measureText(card.headline).width;
  g.fillStyle = soft; g.font = `600 36px ${fam.body}`;
  g.fillText(card.sub, P + hw + 30, 470);

  const rows = card.rows.slice(0, MAX_ROWS);
  let y = 590;
  const rowH = card.rows.length > MAX_ROWS ? 64 : Math.min(96, (H - BAND - 70 - y) / Math.max(rows.length, 1));
  for (const r of rows) {
    g.strokeStyle = line; g.lineWidth = 2;
    g.beginPath(); g.moveTo(P, y); g.lineTo(W - P, y); g.stroke();
    const badgeW = r.badge.length > 1 ? 130 : 84;
    // badge
    const bx = W - P - badgeW, by = y + (rowH - 52) / 2;
    g.fillStyle = r.tone === 'w' ? (light ? '#17744A' : '#FFFFFF') : r.tone === 'l' ? (light ? '#B42318' : '#F2B8B3') : (light ? '#E3E8F0' : 'rgba(255,255,255,.25)');
    g.beginPath(); g.roundRect(bx, by, badgeW, 52, 26); g.fill();
    g.fillStyle = r.tone === 'w' ? (light ? '#FFFFFF' : bg) : r.tone === 'l' ? (light ? '#FFFFFF' : '#5E120C') : ink;
    g.font = `700 32px ${fam.cond}`; g.textAlign = 'center';
    g.fillText(r.badge, bx + badgeW / 2, by + 38);
    g.textAlign = 'left';
    g.fillStyle = ink;
    fit(r.label, (px) => `700 ${px}px ${fam.body}`, bx - P - 300, 38);
    g.fillText(r.label, P, y + rowH / 2 + 13);
    g.fillStyle = soft; g.font = `600 30px ${fam.body}`; g.textAlign = 'right';
    g.fillText(r.detail, bx - 24, y + rowH / 2 + 11);
    g.textAlign = 'left';
    y += rowH;
  }
  if (card.rows.length > MAX_ROWS) { g.fillStyle = soft; g.font = `600 30px ${fam.body}`; g.fillText(`+ ${card.rows.length - MAX_ROWS} more`, P, y + 44); }
  // Teem Hub band
  g.fillStyle = NAVY; g.fillRect(0, H - BAND, W, BAND);
  g.fillStyle = RED; g.fillRect(0, H - BAND, W, 8);
  const img = await whiteLogo();
  if (img) g.drawImage(img, P - 10, H - BAND + 30, 260, 91);
  else { g.fillStyle = '#FFFFFF'; g.font = `800 52px ${fam.display}`; g.fillText('TEEM HUB', P, H - 50); }
  g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `600 32px ${fam.body}`; g.textAlign = 'right';
  g.fillText(host, W - P, H - BAND / 2 + 16);
  g.textAlign = 'left';
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/png'));
}

const fileName = (card: ShareCard) => `${card.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'results'}-teem-hub.png`;

/** The Share sheet: a preview of the picture, the phone's share options, and copy or download. */
@Component({
  selector: 'th-share-results',
  imports: [Sheet],
  template: `
    <th-sheet heading="Share results" [open]="open()" (closed)="closed.emit()">
      <div class="share-prev">
        @if (url(); as u) { <img [src]="u" alt="Results picture: {{ card().title }}, {{ card().headline }}" width="270" height="338"> } @else { <div class="share-wait muted small">Making the picture…</div> }
      </div>
      <p class="muted small" style="text-align:center;margin:8px 0 12px">Finished matches only. No player names, times or courts.</p>
      <div class="stack" style="gap:8px">
        @if (canShare()) { <button class="btn primary share-act" type="button" (click)="share()" [disabled]="!blob()">Share picture and text…</button> }
        <button class="btn share-act" type="button" (click)="copy()">{{ copied() ? 'Copied' : 'Copy results as text' }}</button>
        <button class="btn share-act" type="button" (click)="download()" [disabled]="!blob()">Download picture</button>
      </div>
      @if (canShare()) { <p class="hint" style="margin-top:10px">“Share…” opens your device's share options, like Messages, WhatsApp, Instagram or email.</p> }
      @if (error()) { <p class="hint warn" role="alert">{{ error() }}</p> }
    </th-sheet>`
})
export class ShareResults {
  readonly open = input(false);
  readonly card = input.required<ShareCard>();
  readonly closed = output<void>();
  readonly blob = signal<Blob | null>(null);
  readonly url = signal('');
  readonly copied = signal(false);
  readonly error = signal('');
  readonly canShare = computed(() => typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  private readonly host = BRAND_HOST;

  constructor() {
    effect(() => {
      if (!this.open()) return;
      const card = this.card();
      this.copied.set(false); this.error.set('');
      // A data: URL, not blob:, because the site's CSP allows images from 'self' and data: only.
      drawCard(card, this.host).then(async (b) => {
        this.blob.set(b);
        this.url.set(await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(b); }));
      }).catch(() => this.error.set("The picture couldn't be made on this device. Copy the text instead."));
    });
  }

  async share() {
    const b = this.blob(), card = this.card();
    if (!b) return;
    const file = new File([b], fileName(card), { type: 'image/png' });
    const withFile = navigator.canShare?.({ files: [file] }) ?? false;
    try {
      await navigator.share(withFile ? { files: [file], text: card.text, title: card.title } : { text: card.text, title: card.title });
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') this.error.set("Sharing didn't work here. Copy the text or download the picture instead.");
    }
  }

  async copy() {
    try { await navigator.clipboard.writeText(this.card().text); this.copied.set(true); }
    catch { this.error.set("Couldn't copy on this device."); }
  }

  download() {
    const u = this.url();
    if (!u) return;
    const a = document.createElement('a');
    a.href = u; a.download = fileName(this.card());
    a.click();
  }
}
