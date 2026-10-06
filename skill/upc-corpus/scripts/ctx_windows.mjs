#!/usr/bin/env node
/**
 * Every passage's "In context" window, exactly as the reader's site shows it.
 *
 *   node ctx_windows.mjs --corpus <dir> --out <windows.json>
 *
 * Writes {"<ext-id>": [text, start, end], …}: the window text and where the
 * passage sits in it (UTF-16 units, as a browser and Python's str both index
 * after decoding). A passage with no window (it already is its whole paragraph,
 * or its quotation did not verify) gets its own quotation: [quote, 0, len].
 * Built by the renderer's own buildSiteModel, so the model and the blind coder
 * read the sentences a reader sees, never a second slicing of the text.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

// Same search as common.py: UPC_SCRIPTS, UPC_CLI, the standard this skill ships in
// (../../universal-provenance/scripts), ~/Documents/GitHub/provenance, then ~/provenance.
const UPC_REL = "skill/universal-provenance/scripts";
const SIBLING = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "universal-provenance", "scripts");
const SCRIPTS = process.env.UPC_SCRIPTS
  || (process.env.UPC_CLI && path.dirname(process.env.UPC_CLI.split(" ").at(-1)))
  || [SIBLING, ...["Documents/GitHub/provenance", "provenance"].map((c) => path.join(os.homedir(), c, UPC_REL))]
       .find((d) => fs.existsSync(path.join(d, "upc.mjs")))
  || path.join(os.homedir(), "Documents/GitHub/provenance", UPC_REL);
const U = await import(pathToFileURL(path.join(SCRIPTS, "upc_common.mjs")).href);
const { buildSiteModel } = await import(pathToFileURL(path.join(SCRIPTS, "site.mjs")).href);

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const corpus = arg("--corpus"), out = arg("--out");
if (!corpus || !out) {
  console.log("usage: node ctx_windows.mjs --corpus <dir> --out <windows.json>");
  process.exit(2);
}
const model = buildSiteModel(U.loadCorpus(corpus), {});
const windows = {};
let withWindow = 0;
for (const p of model.passages) {
  if (!p.quote) continue;
  if (p.cx) { windows[p.id] = p.cx; withWindow++; }
  else windows[p.id] = [p.quote, 0, p.quote.length];
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
U.atomicWriteFile(path.resolve(out), JSON.stringify(windows));
console.log(JSON.stringify({ status: "ok", passages: Object.keys(windows).length, with_window: withWindow, out }));
