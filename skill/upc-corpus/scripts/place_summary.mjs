#!/usr/bin/env node
/**
 * Put a written summary on the library's home page, through the quotation gate.
 *
 *   node place_summary.mjs --corpus <dir> --prose home-summary.md --spec home-summary.json [--plan] [--replace]
 *
 * `--prose` is the summary as written: paragraphs or bullets, `###` headings,
 * bare `[ext-…]` markers after the claims they support, at most a couple of
 * `"…" [ext-…]` quotations, and `[theme:<codebook>/<code>]` / `[view:<name>]`
 * links. `--spec` holds type, title, question, claims and provenance.produced_by.
 *
 * What this does so that nobody has to remember it:
 *   - resolves every theme to its *current* overview, and records those overviews
 *     in derived_from.synthesis_ids (overview ids change when an overview is
 *     re-run; the links in the prose do not);
 *   - builds the reference list from the corpus — title and id of every paper a
 *     cited passage comes from — because the gate requires every such id in the
 *     text, and typed titles drift;
 *   - checks the writing rules before anything is written (see LINT below);
 *   - adds it with `upc add synthesis`, which re-checks every quotation.
 * `--replace` removes a previously placed summary once the new one is in, and
 * journals the removal. Without it, an existing summary stops the run.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
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
const { addSynthesisCmd } = await import(pathToFileURL(path.join(SCRIPTS, "upc.mjs")).href);

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const has = (k) => process.argv.includes(k);
const corpus = arg("--corpus"), proseFile = arg("--prose"), specFile = arg("--spec");
if (!corpus || !proseFile || !specFile) {
  console.log("usage: node place_summary.mjs --corpus <dir> --prose <file.md> --spec <file.json> [--plan] [--replace]");
  process.exit(2);
}

const prose = fs.readFileSync(proseFile, "utf8").replace(/\r\n/g, "\n").trimEnd() + "\n";
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
const loaded = U.loadCorpus(corpus);
const model = buildSiteModel(loaded, {});
const extById = new Map(loaded.extractions.map((e) => [e.obj.extraction_id, e.obj]));
const srcById = new Map(loaded.sources.map((s) => [s.obj.source_id, s.obj]));

// ---- LINT: the writing rules, checked rather than remembered -------------------
const problems = [];
const body = prose.replace(/^#\s+.*\n/, "");                     // a leading title line is allowed
const quoted = U.parseQuoteMarkers(body);
const cited = [...new Set([...body.matchAll(/ext-[0-9a-f]{12}/g)].map((m) => m[0]))];
for (const id of cited) if (!extById.has(id)) problems.push(`${id} is not a passage in this corpus`);
for (const q of quoted) {
  const e = extById.get(q.extId);
  if (e && q.quote !== e.direct_quote) problems.push(`the quotation marked ${q.extId} is not that passage's exact text`);
}
if (quoted.length > 2) problems.push(`${quoted.length} quotations; keep it to one or two`);
const bare = body.replace(/"[^"\n]+"\s?\[ext-[0-9a-f]{12}\]/g, "");
if (/"/.test(bare)) problems.push('a straight double quote outside a "…" [ext-…] quotation — it would look checked and is not');
if (/[“”]/.test(body)) problems.push("curly quotation marks in the prose — they would look like quotations and are never checked");
if (/\b\d[\d,]*\s+(papers|passages|sources|studies|articles|overviews)\b/i.test(body))
  problems.push("a typed count of papers or passages — use a [theme:…] link, whose numbers stay live");
if (/\*\*/.test(body)) problems.push("**bold** does not render; use a ### heading");
if (/^#{1,2}\s/m.test(body)) problems.push("# and ## headings clash with the card's own; use ###");
if (/src-[0-9a-f]{12}/.test(body)) problems.push("paper ids belong in the reference list, which this script builds");
const themes = [];
for (const m of body.matchAll(/\[theme:([a-z0-9-]+)\/([a-z0-9-]+)\]/g)) {
  const cb = model.codebooks.find((c) => c.slug === m[1]);
  if (!cb || !(cb.codes || []).some((c) => c.code === m[2])) { problems.push(`${m[0]} names no code in this corpus`); continue; }
  themes.push(`${m[1]}:${m[2]}`);
}
for (const m of body.matchAll(/\[view:([a-z]+)\]/g))
  if (!["matrix", "passages", "overviews", "codes", "sources"].includes(m[1])) problems.push(`${m[0]} is not a view`);
const claimed = new Set((spec.claims || []).flatMap((c) => c.evidence_ids || []));
for (const id of cited) if (!claimed.has(id)) problems.push(`${id} is cited in the prose but no claim rests on it`);
for (const id of claimed) if (!cited.includes(id)) problems.push(`claim evidence ${id} is never cited in the prose`);
const words = body.replace(/\[(ext-[0-9a-f]{12}|theme:[^\]]+|view:[^\]]+)\]/g, "").replace(/^#+\s/gm, "")
  .split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
if (words > 350) problems.push(`${words} words of prose; the card is meant to be read in a minute (350 at most)`);

// ---- resolve themes to overviews, and build the reference list -----------------
const overviewIds = [...new Set(themes.map((k) => (model.overviewByCode.get(k) || {}).synthesis_id).filter(Boolean))];
const order = [];
for (const id of cited) { const e = extById.get(id); if (e && !order.includes(e.source_id)) order.push(e.source_id); }
const refs = order.map((sid) => {
  const s = srcById.get(sid) || {};
  const title = String(s.title || (s.bibliographic || {}).title || sid).replace(/\s+/g, " ");
  const marks = cited.filter((id) => (extById.get(id) || {}).source_id === sid).map((id) => `[${id}]`).join(" ");
  return `- ${title} · \`${sid}\` · ${marks}`;
});
const output = prose + "\n" + refs.join("\n") + "\n";

const existing = (loaded.syntheses || []).map((x) => x.obj)
  .filter((o) => o && ((o.ext || {})["upc-site"] || {}).placement === "home");

console.log("## Home summary\n");
console.log(`  prose words            ${words}`);
console.log(`  passages cited         ${cited.length} (${quoted.length} quoted)`);
console.log(`  papers in references   ${refs.length}`);
console.log(`  themes linked          ${themes.length} → ${overviewIds.length} overviews recorded as sources`);
console.log(`  claims                 ${(spec.claims || []).length}`);
console.log(`  summaries already placed ${existing.length}${existing.length ? " (" + existing.map((o) => o.synthesis_id).join(", ") + ")" : ""}`);
console.log(`  problems               ${problems.length}\n`);
for (const p of problems) console.log(`  REFUSED  ${p}`);
if (problems.length) { console.log("\nNothing was written. Fix the lines above and run again."); process.exit(1); }
if (existing.length && !has("--replace")) {
  console.log("A summary is already on the home page. Pass --replace to put this one in its place.");
  process.exit(1);
}
if (has("--plan")) { console.log("Planning only; nothing was written."); process.exit(0); }

// ---- add it through the gate ------------------------------------------------------
const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "home-summary-")), "synthesis.md");
fs.writeFileSync(outFile, output);
const prov = spec.provenance || {};
const obj = { ...spec, provenance: { ...prov, produced_by: prov.produced_by || { tool: "upc-corpus", method: "model" },
  derived_from: { ...(prov.derived_from || {}), ...(overviewIds.length ? { synthesis_ids: overviewIds } : {}) } } };
const res = addSynthesisCmd(corpus, obj, { output: outFile, tool: (prov.produced_by || {}).tool || "upc-corpus" });
if (res.status !== "ok") {
  console.log(`UNAVAILABLE: the gate refused it — ${JSON.stringify(res.failures || res.detail).slice(0, 400)}`);
  process.exit(1);
}
console.log(`Added ${res.synthesis_id}: ${res.cited_passages} passages checked, ${res.claims} claims.`);

if (existing.length) {
  for (const o of existing) {
    if (o.synthesis_id === res.synthesis_id) continue;
    fs.rmSync(path.join(corpus, "syntheses", o.synthesis_id), { recursive: true, force: true });
    spawnSync("node", [path.join(SCRIPTS, "upc.mjs"), "event", "--corpus", corpus], {
      input: JSON.stringify({ activity_type: "remove", tool: "upc-corpus", status: "success",
        inputs: { synthesis_ids: [o.synthesis_id] }, notes: `home summary replaced by ${res.synthesis_id}` }) });
    console.log(`Removed the summary it replaces: ${o.synthesis_id}.`);
  }
}
const regen = spawnSync("node", [path.join(SCRIPTS, "upc.mjs"), "regen", corpus], { encoding: "utf8" });
const val = spawnSync("node", [path.join(SCRIPTS, "upc.mjs"), "validate", corpus], { encoding: "utf8" });
try {
  const r = JSON.parse(val.stdout);
  console.log(`Corpus: ${r.status} ${r.level}, ${(r.errors || []).length} errors. Rebuild the site to show it.`);
} catch { console.log("UNAVAILABLE: validate did not return a report after adding; check the corpus before publishing."); }
