#!/usr/bin/env node
// R6: checks the built site (web/dist) against the Content-Security-Policy in template.yaml, so a
// change that the CSP would block fails CI instead of breaking the live site.
//   node scripts/check-csp.mjs            (after `npm run build` in web/)
// Also used by the local preview server (csp() below), so it serves the same policy.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The CSP from template.yaml (SiteHeaders), with ${...} references filled in from `vars`. */
export function csp(vars = {}) {
  const lines = readFileSync(join(root, "template.yaml"), "utf8").split("\n");
  // ContentSecurityPolicy: !Sub, then "- >-" and the policy as a folded block.
  const key = lines.findIndex((l) => /ContentSecurityPolicy: !Sub\s*$/.test(l));
  if (key < 0 || !/^\s*- >-\s*$/.test(lines[key + 1] ?? "")) throw new Error("template.yaml has no SiteHeaders ContentSecurityPolicy");
  const start = key + 1;
  const indent = lines[start].search(/\S/);
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break;
    if (l.trim()) body.push(l.trim());
  }
  const vals = {
    "AWS::Region": "us-east-1", "CspReportFunctionUrl.FunctionUrl": "https://csp-report.invalid/",
    ApiOrigins: "https://*.execute-api.us-east-1.amazonaws.com wss://*.execute-api.us-east-1.amazonaws.com", ...vars
  };
  return body.join(" ").replace(/\$\{([^}]+)\}/g, (_, k) => {
    if (!(k in vals)) throw new Error(`no value for \${${k}}`);
    return vals[k];
  });
}

export function directives(policy) {
  const out = new Map();
  for (const part of policy.split(";")) {
    const [name, ...v] = part.trim().split(/\s+/);
    if (name) out.set(name, v);
  }
  return out;
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function check() {
  const problems = [];
  const d = directives(csp());
  const want = (name, value) => {
    const got = (d.get(name) ?? []).join(" ");
    if (got !== value) problems.push(`template.yaml CSP: ${name} should be "${value}", is "${got}"`);
  };
  want("script-src", "'self'");
  want("object-src", "'none'");
  want("frame-ancestors", "'none'");
  want("base-uri", "'self'");
  if ([...d.values()].flat().some((v) => v === "'unsafe-eval'")) problems.push("template.yaml CSP allows 'unsafe-eval'");

  const dist = join(root, "web", "dist");
  const html = readFileSync(join(dist, "index.html"), "utf8");
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc=/.test(m[1]) && m[2].trim()) problems.push(`index.html has an inline script: ${m[2].trim().slice(0, 80)}…`);
  }
  for (const m of html.matchAll(/\son[a-z]+\s*=/gi)) problems.push(`index.html has an inline event handler (${m[0].trim()})`);
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)/gi)) problems.push(`index.html loads from another site: ${m[1]}`);

  for (const f of walk(dist)) {
    const rel = relative(dist, f);
    if (f.endsWith(".css")) {
      const css = readFileSync(f, "utf8");
      for (const m of css.matchAll(/(?:@import\s+(?:url\()?|url\()\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi)) problems.push(`${rel} loads from another site: ${m[1]}`);
    }
    if (f.endsWith(".js") || f.endsWith(".css") || f.endsWith(".html")) {
      const text = readFileSync(f, "utf8");
      if (/fonts\.(googleapis|gstatic)\.com/.test(text)) problems.push(`${rel} still refers to Google Fonts`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = check();
  if (problems.length) {
    console.error(`CSP check failed (see README, "Security headers and CSP"):\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`CSP check ok: ${csp().length} characters, site has no inline scripts or outside resources`);
}
