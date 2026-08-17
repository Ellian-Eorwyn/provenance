#!/usr/bin/env node
// Thin back-compat wrapper. The validator lives in upc.mjs (spec/08 registry).
//   node validate.mjs <corpus-dir> [--strict]
import { validateCorpus } from "./upc.mjs";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const strict = args.includes("--strict");
const quiet = args.includes("--quiet");
if (!dir) {
  process.stderr.write("usage: node validate.mjs <corpus-dir> [--strict]\n");
  process.exit(2);
}
const report = validateCorpus(dir, { strict });
process.stdout.write(JSON.stringify(report, null, quiet ? 0 : 2) + "\n");
process.exit(report.status === "failed" ? 1 : 0);
