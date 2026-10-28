/**
 * The shared email frame: a Teem Hub header (navy, the white logo) with a strip in the team's (or
 * club's) color, body, footer with the full-color logo. Table layout with
 * inline styles, so Gmail, Outlook and Apple Mail all show it the same way. Every template goes
 * through here, so the footer and its required lines change in one place.
 */

export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const HEX = /^#[0-9a-fA-F]{6}$/;
const color = (c: string | undefined, fallback: string) => (c && HEX.test(c) ? c : fallback);

export const FONT = "Barlow, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const INK = "#101B2E";
export const MUTED = "#47546C";
const LINE = "#E6EAF1";
const NAVY = "#15294D";

/** Where the logo images are served from: the site (PNGs, because Gmail and Outlook don't show SVG). */
const siteBase = () => String(process.env.SITE_URL || "https://teemhub.net").replace(/\/$/, "");
export const logoUrls = () => ({ white: `${siteBase()}/brand/email-logo-white.png`, color: `${siteBase()}/brand/email-logo-color.png` });

export type Frame = {
  /** Short line shown next to the subject in the inbox. */
  preheader: string;
  /** Next to the logo in the header: the team or club, or "Your account". */
  context: string;
  colors?: { primary?: string; accent?: string };
  /** Already-escaped body HTML. */
  body: string;
  /** Already-escaped footer lines. */
  footer: string[];
};

export function frame(f: Frame): string {
  const primary = color(f.colors?.primary, "#15294D");
  const accent = color(f.colors?.accent, "#C8323E");
  const logos = logoUrls();
  const footer = f.footer.map((l) => `<p style="margin:0 0 6px;font-family:${FONT};font-size:12.5px;line-height:1.5;color:${MUTED}">${l}</p>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Teem Hub</title></head>
<body style="margin:0;padding:0;background:#EDF0F5">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(f.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EDF0F5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid #D5DBE5;border-radius:12px;border-collapse:separate;overflow:hidden">
<tr><td style="background:${NAVY};border-bottom:3px solid #C8323E;padding:16px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle"><img src="${esc(logos.white)}" width="120" height="42" alt="Teem Hub" style="display:block;border:0;outline:none;font-family:${FONT};font-weight:800;font-size:22px;color:#F4F6FA"></td>
<td align="right" style="vertical-align:middle;font-family:${FONT};font-weight:600;font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;color:#C3CDDF">${esc(f.context)}</td>
</tr></table>
</td></tr>
<tr><td style="background:${primary};height:6px;line-height:6px;font-size:0;border-bottom:1px solid ${accent}">&nbsp;</td></tr>
<tr><td style="padding:28px 28px 30px;font-family:${FONT};font-size:15px;line-height:1.55;color:${INK}">${f.body}</td></tr>
<tr><td style="padding:18px 28px 22px;background:#F6F8FB;border-top:1px solid ${LINE}"><img src="${esc(logos.color)}" width="100" height="35" alt="Teem Hub" style="display:block;border:0;margin:0 0 10px;font-family:${FONT};font-weight:800;font-size:15px;color:${NAVY}">${footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export const h1 = (text: string) =>
  `<h1 style="margin:0 0 10px;font-family:${FONT};font-weight:800;font-size:26px;line-height:1.15;text-transform:uppercase;color:${INK}">${esc(text)}</h1>`;

export const p = (html: string, muted = false) =>
  `<p style="margin:0 0 14px;font-family:${FONT};font-size:${muted ? "14px" : "15px"};line-height:1.55;color:${muted ? MUTED : INK}">${html}</p>`;

export const button = (href: string, label: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 16px"><tr><td style="background:#15294D;border-radius:8px">` +
  `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none">${esc(label)}</a></td></tr></table>`;

export const box = (html: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px"><tr><td style="background:#F6F8FB;border:1px solid ${LINE};border-radius:10px;padding:14px 16px;font-family:${FONT};font-size:14px;line-height:1.55;color:${INK}">${html}</td></tr></table>`;

export const list = (items: string[]) =>
  `<ul style="margin:0;padding-left:20px">${items.map((i) => `<li style="margin:0 0 4px">${i}</li>`).join("")}</ul>`;

/** The plain-text part: the same words, no markup. */
export const textPart = (lines: (string | false | undefined)[]) => lines.filter((l) => l !== false && l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
