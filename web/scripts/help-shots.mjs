#!/usr/bin/env node
// Screenshots for the help guide (web/public/help-img/*.webp), taken from the local preview with its
// sample team, so they never show anyone's real data. Run after building the site:
//   (in api/)  npx vite-node scripts/preview-server.ts      moto must be running on :8000
//   (in web/)  node scripts/help-shots.mjs [topic-id …]
// Signs in with fake tokens (the preview server reads the user from them without checking).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Playwright isn't one of the site's dependencies: use the one installed on the machine (npm i -g playwright).
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.PREVIEW_URL ?? "http://127.0.0.1:4300";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../public/help-img");
const T = "/teams/test-13";
const CLIENT = "previewclient";
const USERS = {
  mom: { sub: "u-mom", email: "mom@example.com", name: ["Mia", "Stone"] },
  kim: { sub: "u-kim", email: "kim@example.com", name: ["Kim", "Lee"] },
  owner: { sub: "u-owner", email: "owner@example.com", name: ["Sam", "Owner"] }
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (u, use) => `${b64({ alg: "none", typ: "JWT" })}.${b64({
  sub: u.sub, email: u.email, username: u.sub, "cognito:username": u.sub, token_use: use, client_id: CLIENT, aud: CLIENT,
  iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_preview", exp: Math.floor(Date.now() / 1000) + 86400, iat: Math.floor(Date.now() / 1000)
})}.x`;

const dialog = "dialog[open]";
const click = (name) => async (p) => { await p.getByRole("button", { name, exact: false }).first().click(); await p.waitForTimeout(400); };
/** Each shot: who, where, what to do first, and what to capture (a selector; `top` crops it to that height). */
const SHOTS = {
  "join-team": { user: "mom", url: "/teams", clip: "main.narrow section.card" },
  "answer-availability": { user: "mom", url: `${T}/schedule`, clip: "main", top: 560 },
  "add-to-calendar": { user: "mom", url: `${T}/schedule`, before: async (p) => { await p.locator("details.cal summary").first().click(); await p.waitForTimeout(300); }, clip: "main", top: 620 },
  "game-day-sheet": { user: "mom", url: `${T}/tournaments/e1`, clip: "main", top: 760 },
  "travel-plans": { user: "mom", url: `${T}/tournaments/e1/travel`, clip: "main", top: 760 },
  "meal-signup": { user: "mom", url: `${T}/tournaments/e1/meals`, clip: "main", top: 700 },
  "record-payment": { user: "mom", url: `${T}/fund`, clip: "main", top: 700 },
  "change-emails": { user: "mom", url: "/account", clip: "th-notification-settings", top: 760 },
  "add-practice": { user: "kim", url: `${T}/schedule`, before: click("Add practice"), after: async (p) => { await p.locator(`${dialog} select[formcontrolname=every]`).selectOption({ label: "Every week" }); await p.waitForTimeout(200); }, clip: dialog, top: 900 },
  "change-series": { user: "kim", url: `${T}/schedule`, before: async (p) => { await p.locator("details.edit-menu summary").first().click(); await p.waitForTimeout(300); }, clip: "main", top: 620 },
  "take-attendance": { user: "kim", url: `${T}/schedule`, before: click("Take attendance"), clip: dialog, top: 760 },
  "see-answers": { user: "kim", url: `${T}/schedule`, before: async (p) => { await p.locator("button.counts").first().click(); await p.waitForTimeout(400); }, clip: dialog, top: 760 },
  "post-announcement": { user: "kim", url: T, before: async (p) => { await p.getByRole("button", { name: "Post", exact: true }).first().click(); await p.waitForTimeout(400); }, clip: dialog },
  "ref-jobs": { user: "kim", url: `${T}/tournaments/e1/ref`, before: click("Fill by rotation"), clip: "main", top: 760 },
  "invite-families": { user: "owner", url: `${T}/members`, before: async (p) => { await p.getByRole("heading", { name: "Invite someone" }).scrollIntoViewIfNeeded(); }, clip: "section.card:has(h2:text('Invite someone'))", also: "section.card:has(h2:text('Pending invites'))" },
  "team-features": { user: "owner", url: `${T}/info`, before: click("Team settings"), clip: dialog, top: 760 },
  "communications": { user: "owner", url: `${T}/communications`, clip: "main", top: 760 },
  "confirm-payment": { user: "owner", url: `${T}/fund`, clip: "main", top: 760 }
};

/** PNG → WebP, using the browser's own encoder (no image tools to install). */
async function toWebp(browser, png) {
  const page = await browser.newPage();
  const url = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/webp", 0.8);
  }, png.toString("base64"));
  await page.close();
  return Buffer.from(url.split(",")[1], "base64");
}

async function signIn(ctx, u) {
  const keys = {
    [`CognitoIdentityServiceProvider.${CLIENT}.LastAuthUser`]: u.sub,
    [`CognitoIdentityServiceProvider.${CLIENT}.${u.sub}.accessToken`]: jwt(u, "access"),
    [`CognitoIdentityServiceProvider.${CLIENT}.${u.sub}.idToken`]: jwt(u, "id"),
    [`CognitoIdentityServiceProvider.${CLIENT}.${u.sub}.refreshToken`]: "refresh",
    [`CognitoIdentityServiceProvider.${CLIENT}.${u.sub}.clockDrift`]: "0"
  };
  await ctx.addInitScript((k) => { for (const [a, b] of Object.entries(k)) localStorage.setItem(a, b); }, keys);
  await ctx.route("https://cognito-idp.us-east-1.amazonaws.com/**", (route) => route.fulfill({
    status: 200, contentType: "application/x-amz-json-1.1",
    body: JSON.stringify({ Username: u.sub, UserAttributes: [{ Name: "sub", Value: u.sub }, { Name: "email", Value: u.email }, { Name: "email_verified", Value: "true" }, { Name: "given_name", Value: u.name[0] }, { Name: "family_name", Value: u.name[1] }], PreferredMfaSetting: "NOMFA", UserMFASettingList: [] })
  }));
}

const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let failed = 0;
for (const [id, s] of Object.entries(SHOTS)) {
  if (only.length && !only.includes(id)) continue;
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1000 }, deviceScaleFactor: 1.5, colorScheme: "light", timezoneId: "America/New_York" });
  await signIn(ctx, USERS[s.user]);
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + s.url, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    // No toasts or "Live" status in the pictures.
    await page.addStyleTag({ content: ".toast,.live{display:none!important}" });
    if (s.before) await s.before(page);
    if (s.after) await s.after(page);
    const el = page.locator(s.clip).first();
    await el.waitFor({ state: "visible", timeout: 5000 });
    const box = await el.boundingBox();
    let clip = { x: box.x, y: box.y, width: box.width, height: s.top ? Math.min(box.height, s.top) : box.height };
    if (s.also) {
      const b2 = await page.locator(s.also).first().boundingBox();
      if (b2) clip = { ...clip, height: Math.min(b2.y + b2.height - clip.y, 900) };
    }
    // A dialog sits in the viewport; anything else may need the page taller than the window.
    const png = await page.screenshot({ type: "png", clip, fullPage: !s.clip.startsWith("dialog") });
    writeFileSync(join(OUT, `${id}.webp`), await toWebp(browser, png));
    console.log(`✓ ${id}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${id}: ${e.message.split("\n")[0]}`);
  }
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
