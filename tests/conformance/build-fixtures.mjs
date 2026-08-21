#!/usr/bin/env node
// Builds conformance fixtures: a valid base corpus per level, then a corrupted
// corpus per error code produced by scripted mutation. Each fixture carries an
// expected.json listing the codes that MUST fire. An independent implementation
// can self-test against these without this repo's validator.
//
//   node tests/conformance/build-fixtures.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  sha256Hex, mintRepId, mintSrcId, mintExtId, mintGenId, mintSynId,
  mintCbkId, mintCodId, codebookRevisionDigest,
  computeInputDigest, codepointLength, atomicWriteFile,
} from "../../skill/universal-provenance/scripts/upc_common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPC = path.join(HERE, "..", "..", "skill", "universal-provenance", "scripts", "upc.mjs");
const TS = "2026-08-17T12:00:00Z";

const sha = (s) => "sha256:" + sha256Hex(Buffer.from(s, "utf8"));
const wText = (abs, s) => { fs.mkdirSync(path.dirname(abs), { recursive: true }); atomicWriteFile(abs, s); };
const wJSON = (abs, o) => wText(abs, JSON.stringify(o, null, 2) + "\n");
const wJSONL = (abs, a) => wText(abs, a.map((o) => JSON.stringify(o)).join("\n") + "\n");
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const anchor = (text, sub) => { const i = text.indexOf(sub); const start = codepointLength(text.slice(0, i)); return { start, end: start + codepointLength(sub) }; };
const regen = (dir) => execFileSync(process.execPath, [UPC, "regen", dir], { stdio: "ignore" });

const CLEAN = ["# Note", "The migration rule is simple: cut over DNS only after the staging copy is fully validated, so visitors never see downtime."].join("\n\n") + "\n";
const QUOTE = "cut over DNS only after the staging copy is fully validated";

// Build a valid source+rep+extraction into <dir>. Returns ids + the built ext.
function seed(dir, { withL2 } = {}) {
  rmrf(dir);
  const slug = "note-migration";
  const sd = path.join(dir, "sources", slug);
  wText(path.join(sd, "representations", "clean.md"), CLEAN);
  const repId = mintRepId(Buffer.from(CLEAN, "utf8"));
  const srcId = mintSrcId({ primaryBytesSha256: sha(CLEAN) });
  const rep = { representation_id: repId, role: "clean_markdown", media_type: "text/markdown", path: `sources/${slug}/representations/clean.md`, sha256: sha(CLEAN), char_count: codepointLength(CLEAN), produced_by: "manual", provenance: { produced_by: { tool: "t", method: "manual" }, created_at: TS } };
  const ext = { source_id: srcId, representation_ref: repId, type: "evidence", status: "active", text: "Cut over DNS after staging validation.", direct_quote: QUOTE, locator: { type: "char_range", representation_ref: repId, value: anchor(CLEAN, QUOTE) }, query: "migration?", interpretation: "explicit", confidence: "high", confidence_score: 0.9, provenance: { produced_by: { tool: "t", model: "m", method: "model" }, created_at: TS, derived_from: { source_ids: [srcId], representation_refs: [repId] }, input_digest: sha(CLEAN) } };
  ext.extraction_id = mintExtId(ext);
  const source = { source_id: srcId, source_kind: "document", title: "Note", bibliographic: { item_type: "document", title: "Note", issued: { date_parts: [[2026]] } }, representations: [rep], extractions_path: `sources/${slug}/extractions.jsonl`, provenance: { produced_by: { tool: "t", method: "manual" }, created_at: TS } };
  wJSON(path.join(sd, "source.json"), source);
  wJSONL(path.join(sd, "extractions.jsonl"), [ext]);
  const sections = { sources: "sources/", provenance: "provenance/events.jsonl", sources_csv: "sources.csv", extractions_csv: "extractions.csv", index_html: "index.html" };

  let gen, syn;
  if (withL2) {
    const summaryMd = ["# Summary", `Key point: "${QUOTE}" [${ext.extraction_id}].`].join("\n\n") + "\n";
    gen = { type: "summary", title: "Summary", output: { path: `sources/${slug}/generated/X.md`, media_type: "text/markdown", sha256: sha(summaryMd) }, stale: false, provenance: { produced_by: { tool: "t", model: "m", method: "model" }, created_at: TS, derived_from: { source_ids: [srcId], representation_refs: [repId], extraction_ids: [ext.extraction_id] }, input_digest: sha(CLEAN), activity_ref: "evt-000001" } };
    gen.generation_id = mintGenId(gen);
    gen.output.path = `sources/${slug}/generated/${gen.generation_id}.md`;
    wText(path.join(sd, "generated", `${gen.generation_id}.md`), summaryMd);
    wJSON(path.join(sd, "generated", `${gen.generation_id}.json`), gen);
    source.generations = [gen.generation_id];
    wJSON(path.join(sd, "source.json"), source);

    const question = "How do you migrate without downtime?";
    syn = { type: "answer", title: "Answer", question, claims: [{ claim_id: "cl-1", text: "Cut over DNS after validating staging.", evidence_ids: [ext.extraction_id], source_ids: [srcId], confidence: "high", notes: null }], output: { path: "syntheses/X/synthesis.md", media_type: "text/markdown" }, stale: false, provenance: { produced_by: { tool: "t", model: "m", method: "model" }, created_at: TS, derived_from: { source_ids: [srcId], extraction_ids: [ext.extraction_id] }, input_digest: computeInputDigest([{ id: repId, sha256: sha(CLEAN) }]), activity_ref: "evt-000002" } };
    syn.synthesis_id = mintSynId(syn);
    const synMd = ["# Answer", `The rule: "${QUOTE}" [${ext.extraction_id}]. See \`${ext.extraction_id}\`, \`${srcId}\`.`].join("\n\n") + "\n";
    syn.output = { path: `syntheses/${syn.synthesis_id}/synthesis.md`, media_type: "text/markdown", sha256: sha(synMd) };
    wText(path.join(dir, "syntheses", syn.synthesis_id, "synthesis.md"), synMd);
    wJSON(path.join(dir, "syntheses", syn.synthesis_id, "synthesis.json"), syn);
    sections.extractions = "extractions/";
    sections.syntheses = "syntheses/";
    wJSONL(path.join(dir, "provenance", "events.jsonl"), [
      { event_id: "evt-000001", activity_type: "generate", tool: "t", started_at: TS, ended_at: TS, inputs: { representation_refs: [repId] }, outputs: { generation_ids: [gen.generation_id] }, status: "success", notes: null },
      { event_id: "evt-000002", activity_type: "synthesize", tool: "t", started_at: TS, ended_at: TS, inputs: { extraction_ids: [ext.extraction_id] }, outputs: { synthesis_ids: [syn.synthesis_id] }, status: "success", notes: null },
    ]);
  }
  wJSON(path.join(dir, "corpus.json"), { upc_spec_version: "1.6.0", corpus_id: "cor-" + sha256Hex(Buffer.from(dir, "utf8")).slice(0, 12), title: "Fixture", readme: "fixture", created: TS, modified: TS, sections });
  regen(dir);
  return { slug, sd, repId, srcId, ext, gen, syn };
}

const loadJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const saveJSON = (p, o) => atomicWriteFile(p, JSON.stringify(o, null, 2) + "\n");

const FX = path.join(HERE, "fixtures");
rmrf(FX);
const fixtures = [];
const make = (name, expect, fn) => { const dir = path.join(FX, name); fn(dir); wJSON(path.join(dir, "expected.json"), { fixture: name, expect }); fixtures.push(name); };

// -- passing --
make("pass-l1", [], (d) => seed(d));
make("pass-l2", [], (d) => seed(d, { withL2: true }));

// -- extraction-level (L1 base, no gen/syn to cascade to) --
make("quote-gate-failed", ["quote_gate_failed"], (d) => {
  const { sd, ext } = seed(d);
  ext.direct_quote = "a fabricated quote that is not present anywhere"; ext.extraction_id = mintExtId(ext);
  wJSONL(path.join(sd, "extractions.jsonl"), [ext]); regen(d);
});
make("locator-drift", ["quote_gate_failed"], (d) => {
  const { sd, ext } = seed(d);
  ext.locator.value = { start: ext.locator.value.start - 1, end: ext.locator.value.end - 1 }; ext.extraction_id = mintExtId(ext);
  wJSONL(path.join(sd, "extractions.jsonl"), [ext]); regen(d);
});
make("locator-range-invalid", ["locator_range_invalid"], (d) => {
  const { sd, ext } = seed(d);
  ext.locator.value = { start: 0, end: 99999 }; ext.extraction_id = mintExtId(ext);
  wJSONL(path.join(sd, "extractions.jsonl"), [ext]); regen(d);
});
make("rep-hash-mismatch", ["rep_hash_mismatch"], (d) => {
  const { sd } = seed(d); const p = path.join(sd, "source.json"); const s = loadJSON(p);
  s.representations[0].sha256 = "sha256:" + "0".repeat(64); saveJSON(p, s); regen(d);
});
make("id-mismatch", ["id_mismatch"], (d) => {
  const { sd, ext } = seed(d); ext.extraction_id = "ext-000000000000";
  wJSONL(path.join(sd, "extractions.jsonl"), [ext]); regen(d);
});
make("id-duplicate", ["id_duplicate"], (d) => {
  const { sd, ext } = seed(d); wJSONL(path.join(sd, "extractions.jsonl"), [ext, ext]); regen(d);
});
make("missing-provenance", ["missing_provenance"], (d) => {
  const { sd, ext } = seed(d); delete ext.provenance; wJSONL(path.join(sd, "extractions.jsonl"), [ext]); regen(d);
});
make("path-escape", ["path_escape"], (d) => {
  const { sd } = seed(d); const p = path.join(sd, "source.json"); const s = loadJSON(p);
  s.representations[0].path = "../escape.md"; saveJSON(p, s); regen(d);
});
make("torn-jsonl", ["jsonl_torn_tail"], (d) => {
  const { sd, ext } = seed(d); const abs = path.join(sd, "extractions.jsonl");
  atomicWriteFile(abs, JSON.stringify(ext) + "\n" + '{"extraction_id":"ext-truncated","source'); // no closing, no trailing LF
  regen(d);
});
make("jsonl-invalid", ["jsonl_invalid"], (d) => {
  const { sd, ext } = seed(d); const abs = path.join(sd, "extractions.jsonl");
  atomicWriteFile(abs, "{ this is not json }\n" + JSON.stringify(ext) + "\n"); // bad interior line
  regen(d);
});
make("symlink-escape", ["symlink_escape"], (d) => {
  const { sd } = seed(d);
  const outside = path.join(path.dirname(d), "OUTSIDE_" + path.basename(d) + ".md");
  fs.writeFileSync(outside, "secret\n");
  const link = path.join(sd, "representations", "clean.md");
  fs.rmSync(link, { force: true });
  // relative target so the committed fixture is portable across machines
  const rel = path.relative(path.dirname(link), outside);
  try { fs.symlinkSync(rel, link); } catch { /* platforms without symlink perms */ }
  // do not regen (regen would follow/normalize); validate directly
});

// -- output-level (L2 base) --
make("output-quote-mismatch", ["output_quote_mismatch"], (d) => {
  const { syn } = seed(d, { withL2: true }); const p = path.join(d, "syntheses", syn.synthesis_id, "synthesis.md");
  const md = fs.readFileSync(p, "utf8").replace(QUOTE, "cut over DNS whenever you like");
  atomicWriteFile(p, md);
  const sp = path.join(d, "syntheses", syn.synthesis_id, "synthesis.json"); const s = loadJSON(sp);
  s.output.sha256 = sha(md); saveJSON(sp, s); regen(d);
});
make("output-cites-unknown", ["output_cites_unknown_extraction"], (d) => {
  const { syn } = seed(d, { withL2: true }); const p = path.join(d, "syntheses", syn.synthesis_id, "synthesis.md");
  const md = fs.readFileSync(p, "utf8").replace(/\[ext-[0-9a-f]{12}\]/, "[ext-000000000000]");
  atomicWriteFile(p, md);
  const sp = path.join(d, "syntheses", syn.synthesis_id, "synthesis.json"); const s = loadJSON(sp);
  s.output.sha256 = sha(md); saveJSON(sp, s); regen(d);
});
make("uncited-output-quote", ["output_quote_uncited"], (d) => {
  const { syn } = seed(d, { withL2: true }); const p = path.join(d, "syntheses", syn.synthesis_id, "synthesis.md");
  const md = fs.readFileSync(p, "utf8") + '\nAn extra unsupported line: "this is a long fabricated quotation with no citation".\n';
  atomicWriteFile(p, md);
  const sp = path.join(d, "syntheses", syn.synthesis_id, "synthesis.json"); const s = loadJSON(sp);
  s.output.sha256 = sha(md); saveJSON(sp, s); regen(d);
});
make("paraphrase-as-quote", ["cited_extraction_not_quotable"], (d) => {
  const { sd, srcId, repId, syn } = seed(d, { withL2: true });
  // add a text-only extraction, then cite it as if it were a quote
  const tOnly = { source_id: srcId, representation_ref: repId, type: "claim", status: "active", text: "A paraphrased claim with no verbatim quote.", locator: { type: "section", representation_ref: repId, value: "Note" }, interpretation: "inferred", provenance: { produced_by: { tool: "t", method: "model", model: "m" }, created_at: TS, derived_from: { source_ids: [srcId], representation_refs: [repId] } } };
  tOnly.extraction_id = mintExtId(tOnly);
  const exAbs = path.join(sd, "extractions.jsonl");
  const arr = fs.readFileSync(exAbs, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  arr.push(tOnly); wJSONL(exAbs, arr);
  const p = path.join(d, "syntheses", syn.synthesis_id, "synthesis.md");
  const md = fs.readFileSync(p, "utf8") + `\nAnd: "A paraphrased claim with no verbatim quote." [${tOnly.extraction_id}]\n`;
  atomicWriteFile(p, md);
  const sp = path.join(d, "syntheses", syn.synthesis_id, "synthesis.json"); const s = loadJSON(sp);
  s.output.sha256 = sha(md); saveJSON(sp, s); regen(d);
});

// -- 1.6.0 codebooks & codings (spec/12) --------------------------------------
// A coding pass layered onto the L1 base. `seedCoded` returns the ids so each
// mutation below can corrupt exactly one thing.
function seedCoded(dir, { closed = true, codes = null } = {}) {
  const base = seed(dir);
  const theCodes = codes || [
    { code: "operator", label: "Operator", definition: "Runs the system." },
    { code: "utility", label: "Utility", definition: "A regulated utility.", parent: "operator" },
  ];
  const cbk = {
    codebook_id: "", namespace: "fixture", slug: closed ? "actor" : "theme",
    title: "Actor", closed, unit: "passage", revision: 1,
    revision_digest: codebookRevisionDigest(theCodes), codes: theCodes,
    provenance: { produced_by: { tool: "t", method: "manual" }, created_at: TS },
  };
  cbk.codebook_id = mintCbkId(cbk);
  wJSON(path.join(dir, "codebooks", cbk.codebook_id + ".json"), cbk);

  const cod = {
    codebook_ref: cbk.codebook_id,
    ...(closed ? { code: "utility" } : { value: "an emergent theme" }),
    target: { kind: "extraction", id: base.ext.extraction_id },
    coder: "coder-a", status: "active",
    codebook_revision: 1, codebook_revision_digest: cbk.revision_digest,
    provenance: { produced_by: { tool: "t", model: "m", method: "model" }, created_at: TS, derived_from: { extraction_ids: [base.ext.extraction_id] } },
  };
  cod.coding_id = mintCodId(cod);
  const man = {
    set_id: "cds-fixture", title: "Fixture coding pass", items_path: "codings/cds-fixture/items.jsonl",
    codebook_refs: [cbk.codebook_id], coders: [{ coder: "coder-a", kind: "model", model: "m" }],
    provenance: { produced_by: { tool: "t", method: "model" }, created_at: TS },
  };
  wJSON(path.join(dir, "codings", "cds-fixture", "manifest.json"), man);
  wJSONL(path.join(dir, "codings", "cds-fixture", "items.jsonl"), [cod]);

  const cj = path.join(dir, "corpus.json");
  const corpus = loadJSON(cj);
  corpus.sections.codebooks = "codebooks/";
  corpus.sections.codings = "codings/";
  saveJSON(cj, corpus);
  regen(dir);
  return { ...base, cbk, cod, man };
}
const itemsPath = (d) => path.join(d, "codings", "cds-fixture", "items.jsonl");
const cbkPath = (d, cbk) => path.join(d, "codebooks", cbk.codebook_id + ".json");

// A coded corpus is still a clean corpus. `codebook_code_unused` is a warning, and
// warnings never appear in `expect`, which lists the codes that MUST fire as errors.
make("pass-coded", [], (d) => { seedCoded(d); });

make("coding-dangling-codebook", ["dangling_codebook"], (d) => {
  const { cod, cbk } = seedCoded(d);
  fs.rmSync(cbkPath(d, cbk));
  wJSONL(itemsPath(d), [cod]); regen(d);
});
make("coding-dangling-target", ["dangling_coding_target"], (d) => {
  const { cod } = seedCoded(d);
  cod.target = { kind: "extraction", id: "ext-000000000000" }; cod.coding_id = mintCodId(cod);
  wJSONL(itemsPath(d), [cod]); regen(d);
});
make("coding-code-unknown", ["coding_code_unknown"], (d) => {
  const { cod } = seedCoded(d);
  cod.code = "no-such-code"; cod.coding_id = mintCodId(cod);
  wJSONL(itemsPath(d), [cod]); regen(d);
});
make("coding-open-closed-mismatch", ["coding_open_closed_mismatch"], (d) => {
  // A free-text value against a CLOSED codebook: the scheme says pick from the list.
  const { cod } = seedCoded(d);
  delete cod.code; cod.value = "freehand"; cod.coding_id = mintCodId(cod);
  wJSONL(itemsPath(d), [cod]); regen(d);
});
make("coding-id-mismatch", ["id_mismatch"], (d) => {
  const { cod } = seedCoded(d);
  cod.coding_id = "cod-000000000000";
  wJSONL(itemsPath(d), [cod]); regen(d);
});
make("coding-missing-provenance", ["missing_provenance"], (d) => {
  const { cod } = seedCoded(d);
  delete cod.provenance;
  wJSONL(itemsPath(d), [cod]); regen(d);
});
make("codebook-code-duplicate", ["codebook_code_duplicate"], (d) => {
  const { cbk } = seedCoded(d);
  cbk.codes = [{ code: "dup", label: "One" }, { code: "dup", label: "Two" }];
  cbk.revision_digest = codebookRevisionDigest(cbk.codes);
  saveJSON(cbkPath(d, cbk), cbk); regen(d);
});
make("codebook-parent-cycle", ["codebook_parent_cycle"], (d) => {
  const { cbk } = seedCoded(d);
  cbk.codes = [{ code: "utility", label: "U", parent: "operator" }, { code: "operator", label: "O", parent: "utility" }];
  cbk.revision_digest = codebookRevisionDigest(cbk.codes);
  saveJSON(cbkPath(d, cbk), cbk); regen(d);
});
make("codebook-parent-dangling", ["codebook_parent_dangling"], (d) => {
  const { cbk } = seedCoded(d);
  cbk.codes = [{ code: "utility", label: "U", parent: "ghost" }];
  cbk.revision_digest = codebookRevisionDigest(cbk.codes);
  saveJSON(cbkPath(d, cbk), cbk); regen(d);
});

// -- 1.6.0 shared representations ---------------------------------------------
// The SAME bytes recorded by two sources is legitimate (a syndicated figure), so
// rule 1.1 demotes it to an advisory. Disagreeing hashes on one id stays an error.
make("representation-shared", [], (d) => {
  const { slug, repId } = seed(d);
  const slug2 = "note-copy";
  const sd2 = path.join(d, "sources", slug2);
  wText(path.join(sd2, "representations", "clean.md"), CLEAN);
  const srcId2 = mintSrcId({ canonicalUrl: "https://example.org/syndicated" });
  wJSON(path.join(sd2, "source.json"), {
    source_id: srcId2, source_kind: "url", title: "Syndicated copy",
    retrieval: { original_url: "https://example.org/syndicated", fetch_status: "success" },
    representations: [{ representation_id: repId, role: "clean_markdown", media_type: "text/markdown", path: `sources/${slug2}/representations/clean.md`, sha256: sha(CLEAN), produced_by: "manual", provenance: { produced_by: { tool: "t", method: "manual" }, created_at: TS } }],
    provenance: { produced_by: { tool: "t", method: "manual" }, created_at: TS },
  });
  void slug;
  const cj1 = path.join(d, "corpus.json"); const c1 = loadJSON(cj1); delete c1.sources; saveJSON(cj1, c1);
  regen(d);
});
make("representation-id-conflict", ["id_duplicate"], (d) => {
  // Same id, DIFFERENT bytes: one of the two records is lying about its own hash.
  const { repId } = seed(d);
  const slug2 = "note-conflict";
  const sd2 = path.join(d, "sources", slug2);
  const other = CLEAN + "\nA different document entirely.\n";
  wText(path.join(sd2, "representations", "clean.md"), other);
  const srcId2 = mintSrcId({ canonicalUrl: "https://example.org/conflict" });
  wJSON(path.join(sd2, "source.json"), {
    source_id: srcId2, source_kind: "url", title: "Conflicting copy",
    retrieval: { original_url: "https://example.org/conflict", fetch_status: "success" },
    representations: [{ representation_id: repId, role: "clean_markdown", media_type: "text/markdown", path: `sources/${slug2}/representations/clean.md`, sha256: sha(other), produced_by: "manual", provenance: { produced_by: { tool: "t", method: "manual" }, created_at: TS } }],
    provenance: { produced_by: { tool: "t", method: "manual" }, created_at: TS },
  });
  const cj2 = path.join(d, "corpus.json"); const c2 = loadJSON(cj2); delete c2.sources; saveJSON(cj2, c2);
  regen(d);
});


// -- write the fixture list --
console.log(JSON.stringify({ status: "ok", fixtures }));
