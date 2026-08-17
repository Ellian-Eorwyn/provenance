#!/usr/bin/env node
// Runs every conformance fixture through the validator and checks that each
// fixture's expected codes fire (empty expect => must pass with no errors).
// Independent implementations can reuse the fixtures + expected.json without
// this runner. Exit 0 = all fixtures behaved as expected.
//
//   node tests/conformance/run-conformance.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCorpus } from "../../skill/universal-provenance/scripts/upc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, "fixtures");
if (!fs.existsSync(FX)) { console.error("no fixtures/ — run build-fixtures.mjs first"); process.exit(2); }

let pass = 0, fail = 0;
for (const name of fs.readdirSync(FX).sort()) {
  const dir = path.join(FX, name);
  const expPath = path.join(dir, "expected.json");
  if (!fs.existsSync(expPath)) continue;
  const { expect } = JSON.parse(fs.readFileSync(expPath, "utf8"));
  const report = validateCorpus(dir, {});
  const codes = new Set([...report.errors.map((e) => e.code), ...report.warnings.map((w) => w.code)]);
  let okFixture = true, reason = "";
  if (expect.length === 0) {
    if (report.status !== "passed" || report.errors.length) { okFixture = false; reason = `expected clean pass, got ${report.status} with codes [${[...codes].join(",")}]`; }
  } else {
    const missing = expect.filter((c) => !codes.has(c));
    if (missing.length) { okFixture = false; reason = `missing expected code(s) [${missing.join(",")}]; got [${[...codes].join(",")}]`; }
  }
  if (okFixture) { pass++; console.log(`  ok    ${name.padEnd(24)} ${expect.length ? "fires " + expect.join(",") : "clean " + report.level}`); }
  else { fail++; console.error(`  FAIL  ${name.padEnd(24)} ${reason}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
