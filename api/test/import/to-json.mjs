// Reads the sample workbooks the way the site does (web/src/app/core/xlsx.ts) and saves them as JSON fixtures.
// Run from the repo root: node api/test/import/to-json.mjs
import { writeFileSync } from "node:fs";
import read from "../../../web/node_modules/read-excel-file/node/index.js";

const pad = (n) => String(n).padStart(2, "0");
// Same rules as toCell() in web/src/app/core/xlsx.ts.
function toCell(v) {
  if (v instanceof Date) {
    if (v.getUTCFullYear() < 1901) {
      const h = v.getUTCHours(), m = v.getUTCMinutes();
      return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
    }
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;
}
for (const name of ["team-sample", "team-errors", "club-sample"]) {
  const all = await read(new URL(`./${name}.xlsx`, import.meta.url).pathname);
  const sheets = {};
  for (const s of all) {
    if (/^(read me|choices)$/i.test(s.sheet)) continue;
    sheets[s.sheet] = s.data.map((row) => row.map(toCell));
  }
  writeFileSync(new URL(`./${name}.json`, import.meta.url), JSON.stringify(sheets));
  console.log(name, Object.keys(sheets).join(", "));
}
