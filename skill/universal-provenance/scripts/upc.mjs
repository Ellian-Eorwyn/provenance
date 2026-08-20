#!/usr/bin/env node
// UPC 1.2.0 command-line tool. Zero deps, Node >= 18.
//
//   upc validate <dir> [--strict]
//   upc verify-quotes <file> --corpus <dir> [--strict]
//   upc verify <ext-id> --corpus <dir>
//   upc quote <ext-id> --corpus <dir> [--narrow <start> <end>]
//   upc regen <dir>
//   upc build-index <dir>
//   upc export <dir> --format bibtex|ris|csl-json|jsonl|markdown|ro-crate [-o <file>] [--copy]
//   upc mint <src|ext|gen|syn|rep> [--corpus <dir>]        (JSON object on stdin)
//   upc reanchor <ext-id>|--all --corpus <dir> [--to <rep-id>]
//
// The validator implements the spec/08 rule registry exactly; conformance level
// is computed from rules passed, not object counts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as U from "./upc_common.mjs";
import { writeRoCrate } from "./ro-crate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Locate schemas/ and vocab/ (walk up from the script; env overrides).
// ---------------------------------------------------------------------------
function findSpecDirs() {
  let schemaDir = process.env.UPC_SCHEMA_DIR;
  let vocabDir = process.env.UPC_VOCAB_DIR;
  if (!schemaDir || !vocabDir) {
    let dir = HERE;
    for (let i = 0; i < 12; i++) {
      if (fs.existsSync(path.join(dir, "schemas")) && fs.existsSync(path.join(dir, "vocab"))) {
        schemaDir = schemaDir || path.join(dir, "schemas");
        vocabDir = vocabDir || path.join(dir, "vocab");
        return { schemaDir, vocabDir, specRoot: dir };
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return { schemaDir, vocabDir, specRoot: schemaDir ? path.dirname(schemaDir) : null };
}

const SCHEMA_FILE = {
  corpus: "corpus.schema.json",
  source: "source.schema.json",
  extraction: "extraction.schema.json",
  generation: "generation.schema.json",
  synthesis: "synthesis.schema.json",
  event: "event.schema.json",
  bibliographic: "bibliographic.schema.json",
  "extraction-set": "extraction-set.schema.json",
};

function schemaTopProps(schemaDir, file) {
  try {
    const s = U.readJSON(path.join(schemaDir, file));
    return new Set(Object.keys(s.properties || {}));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers for projections (spec/01 CSV, spec/09 exports).
// ---------------------------------------------------------------------------
function renderAuthors(list) {
  if (!Array.isArray(list)) return "";
  return list
    .map((a) => (a.literal ? a.literal : [a.family, a.given].filter(Boolean).join(", ")))
    .filter(Boolean)
    .join("; ");
}

function renderDate(d) {
  if (d == null) return "";
  if (typeof d === "string") return d;
  if (d.date_parts && d.date_parts[0]) {
    return d.date_parts[0].map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, "0"))).join("-");
  }
  if (d.raw) return d.raw;
  if (d.literal) return d.literal;
  return "";
}

function localName(s) {
  const bib = (s.obj && s.obj.bibliographic) || {};
  return s.obj.title || bib.title || s.obj.source_id;
}

// ---------------------------------------------------------------------------
// Build derived model: id maps, counts, CSV rows (shared by validate & regen).
// ---------------------------------------------------------------------------
function buildModel(loaded) {
  const sourceById = new Map();
  for (const s of loaded.sources) if (s.obj) sourceById.set(s.obj.source_id, s);
  const repById = new Map();
  for (const r of loaded.representations) repById.set(r.obj.representation_id, r);
  const extById = new Map();
  for (const e of loaded.extractions) extById.set(e.obj.extraction_id, e.obj);
  const genById = new Map();
  for (const g of loaded.generations) genById.set(g.obj.generation_id, g.obj);
  const synById = new Map();
  for (const y of loaded.syntheses) synById.set(y.obj.synthesis_id, y.obj);

  // per-source counts
  const extBySource = new Map();
  for (const e of loaded.extractions) {
    const sid = e.obj.source_id;
    extBySource.set(sid, (extBySource.get(sid) || 0) + 1);
  }
  const genBySource = new Map();
  for (const g of loaded.generations) {
    const df = (g.obj.provenance && g.obj.provenance.derived_from) || {};
    for (const sid of df.source_ids || []) genBySource.set(sid, (genBySource.get(sid) || 0) + 1);
  }

  const counts = {
    sources: loaded.sources.filter((s) => s.obj).length,
    representations: loaded.representations.length,
    extractions: loaded.extractions.length,
    generations: loaded.generations.length,
    syntheses: loaded.syntheses.length,
  };

  return { sourceById, repById, extById, genById, synById, extBySource, genBySource, counts };
}

const SOURCES_CSV_COLS = [
  "source_id", "title", "source_kind", "item_type", "authors", "issued", "primary_url",
  "final_url", "fetch_status", "sha256", "path", "tags", "n_representations",
  "n_extractions", "n_generations",
];
const EXTRACTIONS_CSV_COLS = [
  "extraction_id", "source_id", "representation_ref", "type", "status", "direct_quote",
  "text", "locator", "query", "interpretation", "confidence", "confidence_score", "created_at",
];

function sourcesCsv(loaded, model) {
  const rows = [SOURCES_CSV_COLS];
  for (const s of loaded.sources) {
    if (!s.obj) continue;
    const o = s.obj, bib = o.bibliographic || {}, ret = o.retrieval || {};
    rows.push([
      o.source_id, o.title || bib.title || "", o.source_kind || "", bib.item_type || "",
      renderAuthors(bib.authors), renderDate(bib.issued),
      ret.original_url || bib.url || "", ret.final_url || "",
      ret.fetch_status || "", ret.sha256 || (o.representations && o.representations[0] && o.representations[0].sha256) || "",
      s.dirRel, (o.tags || []).join("; "),
      (o.representations || []).length, model.extBySource.get(o.source_id) || 0, model.genBySource.get(o.source_id) || 0,
    ]);
  }
  return U.writeCsv(rows);
}

function extractionsCsv(loaded) {
  const rows = [EXTRACTIONS_CSV_COLS];
  for (const e of loaded.extractions) {
    const o = e.obj;
    const loc = o.locator ? U.jcs({ type: o.locator.type, representation_ref: o.locator.representation_ref, value: o.locator.value }) : "";
    rows.push([
      o.extraction_id, o.source_id, o.representation_ref, o.type, o.status || "active",
      o.direct_quote == null ? "" : o.direct_quote, o.text || "", loc, o.query || "",
      o.interpretation || "", o.confidence || "", o.confidence_score == null ? "" : o.confidence_score,
      (o.provenance && o.provenance.created_at) || "",
    ]);
  }
  return U.writeCsv(rows);
}

// ---------------------------------------------------------------------------
// VALIDATE — the spec/08 rule registry.
// ---------------------------------------------------------------------------
const ID_PATTERNS = {
  "src-": /^src-[0-9a-f]{12}$/, "rep-": /^rep-[0-9a-f]{12}$/, "img-": /^img-[0-9a-f]{12}$/,
  "ext-": /^ext-[0-9a-f]{12}$/, "gen-": /^gen-[0-9a-f]{12}$/, "syn-": /^syn-[0-9a-f]{12}$/,
  "cor-": /^cor-[0-9a-f]{12}$/, "evt-": /^evt-.+$/,
};
function idFormatOk(id) {
  const pref = String(id || "").slice(0, 4);
  const re = ID_PATTERNS[pref];
  return re ? re.test(id) : false;
}
const TEXTUAL = (mt) => /^text\//.test(mt || "") || mt === "application/json" || mt === "application/xml";
const BAND = { high: [0.67, 1.0], medium: [0.34, 0.66], low: [0.0, 0.33] };

export function validateCorpus(root, opts = {}) {
  const strict = !!opts.strict;
  const { schemaDir, vocabDir } = findSpecDirs();
  const errors = [], warnings = [];
  const err = (code, level, object, detail, extra) => errors.push({ code, level, object, detail, ...(extra || {}) });
  const warn = (code, object, detail, extra) => warnings.push({ code, object, detail, ...(extra || {}) });
  const promote = (code, level, object, detail, extra) => (strict ? err(code, level, object, detail, extra) : warn(code, object, detail, extra));

  let loaded;
  try {
    loaded = U.loadCorpus(root);
  } catch (e) {
    return { status: "failed", corpus: path.resolve(root), level: null, counts: {}, errors: [{ code: "load_error", detail: e.message }], warnings: [] };
  }
  U.clearRepCache();
  const model = buildModel(loaded);
  const specVer = loaded.corpus.upc_spec_version;

  // Loader diagnostics -> registry codes/levels.
  const LEVEL0_LOADER = new Set(["missing_source_json", "path_escape", "symlink_escape", "missing_file", "schema_invalid", "jsonl_invalid"]);
  for (const d of loaded.diagnostics || []) {
    if (d.code === "jsonl_torn_tail") warn(d.code, d.file, d.detail, { line: d.line });
    else if (LEVEL0_LOADER.has(d.code)) err(d.code, 0, d.object || d.file, d.detail, d.line ? { line: d.line } : undefined);
    else warn(d.code, d.object, d.detail);
  }

  // --- 0.1 corpus manifest ---
  if (schemaDir) {
    const cerr = U.validateWithSchema(schemaDir, SCHEMA_FILE.corpus, loaded.corpus, "corpus.json");
    for (const m of cerr) err("schema_invalid", 0, "corpus.json", m);
  }
  if (!specVer) err("spec_version_missing", 0, "corpus.json", "upc_spec_version missing");
  else if (!/^1\./.test(specVer)) err("spec_version_missing", 0, "corpus.json", `unsupported major version ${specVer}`);

  // --- 0.2 sources listed + valid; detect orphan source dirs ---
  if (schemaDir) {
    for (const s of loaded.sources) {
      if (!s.obj) continue;
      const serr = U.validateWithSchema(schemaDir, SCHEMA_FILE.source, s.obj, s.dirRel);
      for (const m of serr) err("schema_invalid", 0, s.obj.source_id || s.dirRel, m);
    }
  }
  {
    const sourcesDir = loaded.sections.sources || "sources/";
    const { abs: base, contained } = U.resolveInside(loaded.root, sourcesDir);
    if (contained && fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      const known = new Set(loaded.sources.map((s) => path.resolve(loaded.root, s.dirRel)));
      for (const name of fs.readdirSync(base)) {
        const dir = path.join(base, name);
        if (fs.existsSync(path.join(dir, "source.json")) && !known.has(path.resolve(dir))) {
          err("manifest_source_unlisted", 0, path.join(sourcesDir, name).replace(/\\/g, "/"), "source directory not resolvable through the manifest");
        }
      }
    }
  }

  // --- 0.3/0.4/0.5/0.6 representations: containment, existence, hash, filename ---
  for (const r of loaded.representations) {
    const id = r.obj.representation_id;
    if (r.obj.path) {
      const fc = U.checkFilename(r.obj.path);
      if (!fc.ok) err("filename_illegal", 0, id, `${r.obj.path}: ${fc.reason}`);
    }
    if (!r.contained) { err(r.symlinkEscape ? "symlink_escape" : "path_escape", 0, id, r.obj.path); continue; }
    if (!fs.existsSync(r.abs)) { err("missing_file", 0, id, r.obj.path); continue; }
    const repRec = U.getRepFile(r.abs);
    if (U.bareHash(r.obj.sha256) !== repRec.sha256) {
      err("rep_hash_mismatch", 0, id, `stored ${U.bareHash(r.obj.sha256).slice(0, 12)}… != actual ${repRec.sha256.slice(0, 12)}…`, { hop: "A" });
    }
  }
  for (const s of loaded.sources) {
    if (s.obj && (!s.obj.representations || s.obj.representations.length === 0)) err("missing_representation", 0, s.obj.source_id, "source has no representations");
  }

  // --- 1.1 id well-formed, unique, recomputed ---
  const seen = new Map();
  const checkId = (id, kind, obj) => {
    if (!idFormatOk(id)) err("id_format", 1, id, `malformed ${kind} id`);
    if (seen.has(id)) err("id_duplicate", 1, id, `duplicate id (also ${seen.get(id)})`);
    else seen.set(id, kind);
  };
  for (const s of loaded.sources) if (s.obj) checkId(s.obj.source_id, "source", s.obj);
  for (const r of loaded.representations) checkId(r.obj.representation_id, "representation", r.obj);
  for (const e of loaded.extractions) checkId(e.obj.extraction_id, "extraction", e.obj);
  for (const g of loaded.generations) checkId(g.obj.generation_id, "generation", g.obj);
  for (const y of loaded.syntheses) checkId(y.obj.synthesis_id, "synthesis", y.obj);

  // id_mismatch recompute
  for (const r of loaded.representations) {
    if (!r.contained || !fs.existsSync(r.abs)) continue;
    const bytes = U.getRepFile(r.abs).bytes;
    const pref = r.obj.representation_id.slice(0, 4);
    const expect = pref === "img-" ? U.mintImgId(bytes) : U.mintRepId(bytes);
    // accept either rep-/img- prefix matching the hash body
    if (r.obj.representation_id.slice(4) !== expect.slice(4)) err("id_mismatch", 1, r.obj.representation_id, `expected ${expect}`);
  }
  for (const s of loaded.sources) {
    if (!s.obj) continue;
    const o = s.obj, ret = o.retrieval || {}, bib = o.bibliographic || {};
    const candidates = new Set();
    for (const u of [ret.original_url, ret.final_url, bib.url]) {
      const c = u ? U.canonicalUrl(u) : null;
      if (c) candidates.add(U.mintSrcId({ canonicalUrl: c }));
    }
    for (const rep of o.representations || []) {
      if (rep.sha256) candidates.add(U.mintSrcId({ primaryBytesSha256: rep.sha256 }));
    }
    if (candidates.size && !candidates.has(o.source_id)) {
      err("id_mismatch", 1, o.source_id, "src- id reproduces from no declared URL or representation");
    }
  }
  for (const e of loaded.extractions) {
    const o = e.obj;
    if (!o.locator || !o.source_id || !o.representation_ref) continue;
    const expect = U.mintExtId(o);
    if (o.extraction_id !== expect) err("id_mismatch", 1, o.extraction_id, `expected ${expect}`);
  }
  for (const g of loaded.generations) {
    const o = g.obj;
    if (o.type && o.provenance && o.provenance.input_digest) {
      const expect = U.mintGenId(o);
      if (o.generation_id !== expect) warn("id_mismatch", o.generation_id, `expected ${expect} (advisory: gen key inputs)`);
    }
  }
  for (const y of loaded.syntheses) {
    const o = y.obj;
    if (o.type) {
      const expect = U.mintSynId(o);
      if (o.synthesis_id !== expect) warn("id_mismatch", o.synthesis_id, `expected ${expect} (advisory: syn key inputs)`);
    }
  }

  // --- 1.2 dangling refs, 1.3 locator rep match, 1.4/1.5/1.6 quote gates, 1.7 flagged, 1.8 provenance ---
  const hasProvStamp = (obj) => obj.provenance && obj.provenance.produced_by && obj.provenance.produced_by.tool && obj.provenance.created_at;
  for (const r of loaded.representations) {
    if (r.obj.parent_representation_ref && !model.repById.has(r.obj.parent_representation_ref)) warn("dangling_representation", r.obj.representation_id, `parent_representation_ref ${r.obj.parent_representation_ref}`);
    if (!hasProvStamp(r.obj)) err("missing_provenance", 1, r.obj.representation_id, "representation lacks provenance.produced_by/created_at");
  }
  if (schemaDir) {
    for (const e of loaded.extractions) {
      const eerr = U.validateWithSchema(schemaDir, SCHEMA_FILE.extraction, e.obj, e.obj.extraction_id);
      for (const m of eerr) err("schema_invalid", 0, e.obj.extraction_id, m);
    }
  }
  for (const e of loaded.extractions) {
    const o = e.obj;
    const status = o.status || "active";
    if (!model.sourceById.has(o.source_id)) err("dangling_source", 1, o.extraction_id, `source_id ${o.source_id}`);
    const rep = model.repById.get(o.representation_ref);
    if (!rep) err("dangling_representation", 1, o.extraction_id, `representation_ref ${o.representation_ref}`);
    if (o.locator && o.locator.representation_ref !== o.representation_ref) err("locator_rep_mismatch", 1, o.extraction_id, `locator.representation_ref ${o.locator.representation_ref} != ${o.representation_ref}`);
    if (!hasProvStamp(o)) err("missing_provenance", 1, o.extraction_id, "extraction lacks provenance.produced_by/created_at");
    // range shape sanity for range locators
    if (o.locator && (o.locator.type === "char_range" || o.locator.type === "line_range")) {
      const v = o.locator.value || {};
      if (!(Number.isInteger(v.start) && Number.isInteger(v.end) && v.start <= v.end)) err("locator_range_invalid", 1, o.extraction_id, `range [${v.start},${v.end}]`, { hop: "B" });
    }
    // confidence consistency (advisory)
    if (o.confidence && o.confidence_score != null && BAND[o.confidence]) {
      const [lo, hi] = BAND[o.confidence];
      if (o.confidence_score < lo || o.confidence_score > hi) warn("confidence_inconsistent", o.extraction_id, `${o.confidence} vs ${o.confidence_score}`);
    }
    // x- extension type
    if (typeof o.type === "string" && o.type.startsWith("x-")) warn("x_extension", o.extraction_id, `type ${o.type}`);

    if (status !== "active") { warn("flagged_extraction", o.extraction_id, `status=${status}`, { hop: "B" }); continue; }
    if (o.direct_quote == null) continue; // text-only: nothing to gate

    // 1.5 quote requires char_range + textual rep
    if (!o.locator || o.locator.type !== "char_range") { err("quote_locator_missing", 1, o.extraction_id, "direct_quote without a char_range locator", { hop: "B" }); continue; }
    if (!rep) continue;
    if (!TEXTUAL(rep.obj.media_type)) { err("quote_rep_not_text", 1, o.extraction_id, `representation media_type ${rep.obj.media_type} is not textual`, { hop: "B" }); continue; }
    if (!rep.contained || !fs.existsSync(rep.abs)) continue; // already flagged
    const repRec = U.getRepFile(rep.abs);
    const res = U.verifyHopB(o, repRec);
    if (!res.ok) err(res.code, 1, o.extraction_id, res.detail, { hop: "B", ...(res.hint ? { hint: res.hint } : {}) });
  }

  // 1.9 bibliographic valid
  if (schemaDir) {
    for (const s of loaded.sources) {
      if (s.obj && s.obj.bibliographic) {
        const berr = U.validateWithSchema(schemaDir, SCHEMA_FILE.bibliographic, s.obj.bibliographic, s.obj.source_id + ".bibliographic");
        for (const m of berr) err("bibliographic_invalid", 1, s.obj.source_id, m);
      }
    }
  }

  // --- L2: generations, syntheses, outputs, hop C, journal ---
  const hasL2 = loaded.generations.length > 0 || loaded.syntheses.length > 0;
  const resolveOutputText = (obj, ownerDirRel) => {
    if (!obj.output || !obj.output.path) return null;
    const { abs, contained, symlinkEscape } = U.resolveInside(loaded.root, obj.output.path);
    return { abs, contained, symlinkEscape };
  };
  const checkOutput = (obj, id, level) => {
    if (!obj.output || obj.output.value !== undefined) return null; // inline output: no file
    if (!obj.output.path) return null;
    const fc = U.checkFilename(obj.output.path);
    if (!fc.ok) err("filename_illegal", 0, id, `${obj.output.path}: ${fc.reason}`);
    const info = resolveOutputText(obj);
    if (!info.contained) { err(info.symlinkEscape ? "symlink_escape" : "path_escape", 0, id, obj.output.path); return null; }
    if (!fs.existsSync(info.abs)) { err("missing_output", level, id, obj.output.path); return null; }
    const bytes = fs.readFileSync(info.abs);
    const hex = U.sha256Hex(bytes);
    if (!obj.output.sha256) err("output_hash_mismatch", level, id, "output.sha256 missing");
    else if (U.bareHash(obj.output.sha256) !== hex) err("output_hash_mismatch", level, id, `stored != actual (${hex.slice(0, 12)}…)`);
    return U.decodeUtf8Strict(bytes).text;
  };

  const runHopC = (text, id) => {
    if (text == null) return;
    for (const mk of U.parseQuoteMarkers(text)) {
      const ext = model.extById.get(mk.extId);
      if (!ext) { err("output_cites_unknown_extraction", 2, id, `marker cites ${mk.extId}`, { hop: "C" }); continue; }
      if (ext.direct_quote == null) { err("cited_extraction_not_quotable", 2, id, `${mk.extId} has no direct_quote`, { hop: "C" }); continue; }
      const st = ext.status || "active";
      if (st === "retracted") { err("cites_retracted", 2, id, `cites retracted ${mk.extId}`, { hop: "C" }); }
      else if (st === "superseded") { warn("cites_superseded", id, `cites superseded ${mk.extId}`, { hop: "C" }); }
      if (mk.quote !== ext.direct_quote) err("output_quote_mismatch", 2, id, `quoted text for ${mk.extId} != its direct_quote`, { hop: "C" });
    }
    for (const uq of U.findUncitedQuotes(text)) promote("output_quote_uncited", 2, id, `uncited quoted span: "${uq.quote.slice(0, 40)}…"`, { hop: "C" });
  };

  if (schemaDir) {
    for (const g of loaded.generations) {
      const gerr = U.validateWithSchema(schemaDir, SCHEMA_FILE.generation, g.obj, g.obj.generation_id);
      for (const m of gerr) err("schema_invalid", 0, g.obj.generation_id, m);
    }
    for (const y of loaded.syntheses) {
      const yerr = U.validateWithSchema(schemaDir, SCHEMA_FILE.synthesis, y.obj, y.obj.synthesis_id);
      for (const m of yerr) err("schema_invalid", 0, y.obj.synthesis_id, m);
    }
  }

  const checkDerivedRefs = (obj, id) => {
    const df = (obj.provenance && obj.provenance.derived_from) || {};
    for (const sid of df.source_ids || []) if (!model.sourceById.has(sid)) err("dangling_source", 2, id, `derived_from source ${sid}`);
    for (const rid of df.representation_refs || []) if (!model.repById.has(rid)) err("dangling_representation", 2, id, `derived_from representation ${rid}`);
    for (const xid of df.extraction_ids || []) if (!model.extById.has(xid)) err("dangling_extraction", 2, id, `derived_from extraction ${xid}`);
    for (const gid of df.generation_ids || []) if (!model.genById.has(gid)) err("dangling_generation", 2, id, `derived_from generation ${gid}`);
    for (const yid of df.synthesis_ids || []) if (!model.synById.has(yid)) err("dangling_synthesis", 2, id, `derived_from synthesis ${yid}`);
  };

  for (const g of loaded.generations) {
    const o = g.obj, id = o.generation_id;
    if (!hasProvStamp(o)) err("missing_provenance", 1, id, "generation lacks provenance");
    const df = o.provenance && o.provenance.derived_from;
    if (!df || !(df.source_ids && df.source_ids.length)) err("missing_derived_from", 2, id, "generation without derived_from.source_ids");
    else checkDerivedRefs(o, id);
    if (!(o.provenance && o.provenance.input_digest)) err("missing_input_digest", 2, id, "generation without provenance.input_digest");
    else staleCheck(o, id);
    const text = checkOutput(o, id, 2);
    runHopC(text, id);
  }

  for (const y of loaded.syntheses) {
    const o = y.obj, id = o.synthesis_id;
    if (!hasProvStamp(o)) err("missing_provenance", 1, id, "synthesis lacks provenance");
    const df = o.provenance && o.provenance.derived_from;
    if (!df) err("missing_derived_from", 2, id, "synthesis without derived_from");
    else checkDerivedRefs(o, id);
    if (!(o.provenance && o.provenance.input_digest)) err("missing_input_digest", 2, id, "synthesis without provenance.input_digest");
    else staleCheck(o, id);
    // claim integrity
    const citedIds = new Set();
    for (const c of o.claims || []) {
      for (const xid of c.evidence_ids || []) {
        citedIds.add(xid);
        if (!model.extById.has(xid)) err("dangling_extraction", 2, id, `claim ${c.claim_id} evidence ${xid}`);
        else {
          const src = model.extById.get(xid).source_id;
          if (!(c.source_ids || []).includes(src)) err("claim_missing_source", 2, id, `claim ${c.claim_id} cites ${xid} from ${src} but omits it`);
        }
      }
      for (const sid of c.source_ids || []) { citedIds.add(sid); if (!model.sourceById.has(sid)) err("dangling_source", 2, id, `claim ${c.claim_id} source ${sid}`); }
    }
    const text = checkOutput(o, id, 2);
    if (text != null) {
      for (const need of citedIds) if (!text.includes(need)) err("uncited_in_output", 2, id, `output does not cite ${need}`);
      runHopC(text, id);
    }
  }

  function staleCheck(obj, id) {
    const df = (obj.provenance && obj.provenance.derived_from) || {};
    const reps = (df.representation_refs || []).map((rid) => model.repById.get(rid)).filter(Boolean);
    if (reps.length !== 1) return; // multi-input digest not recomputed here
    const rep = reps[0];
    if (!rep.contained || !fs.existsSync(rep.abs)) return;
    const cur = "sha256:" + U.getRepFile(rep.abs).sha256;
    if (U.bareHash(cur) !== U.bareHash(obj.provenance.input_digest)) warn("stale_input", id, "input_digest != current representation hash");
  }

  // --- 2.7 journal ---
  if (hasL2) {
    const provRel = loaded.sections.provenance || "provenance/events.jsonl";
    const { abs, contained } = U.resolveInside(loaded.root, provRel);
    if (!contained || !fs.existsSync(abs)) err("missing_journal", 2, "provenance", "L2 corpus without an activity journal");
    else if (schemaDir) {
      for (const ev of loaded.events) {
        const everr = U.validateWithSchema(schemaDir, SCHEMA_FILE.event, ev, ev.event_id || "event");
        for (const m of everr) err("event_invalid", 2, ev.event_id || "event", m);
        const io = [ev.inputs, ev.outputs];
        for (const grp of io) {
          if (!grp) continue;
          for (const [k, arr] of Object.entries(grp)) {
            for (const rid of arr || []) {
              const known = model.sourceById.has(rid) || model.repById.has(rid) || model.extById.has(rid) || model.genById.has(rid) || model.synById.has(rid);
              if (!known) warn("event_dangling_ref", ev.event_id, `${k} ${rid}`);
            }
          }
        }
      }
    }
  }

  // --- advisory: counts, csv, unknown fields, aliases ---
  if (loaded.corpus.counts) {
    for (const k of Object.keys(model.counts)) {
      if (loaded.corpus.counts[k] != null && loaded.corpus.counts[k] !== model.counts[k]) warn("counts_mismatch", "corpus.json", `${k}: manifest ${loaded.corpus.counts[k]} != actual ${model.counts[k]}`);
    }
  }
  // csv_stale
  const csvCheck = (sectionKey, def, builder) => {
    const rel = (loaded.sections && loaded.sections[sectionKey]) || def;
    const { abs, contained } = U.resolveInside(loaded.root, rel);
    if (contained && fs.existsSync(abs)) {
      const onDisk = fs.readFileSync(abs, "utf8");
      const expected = builder();
      if (onDisk !== expected) warn("csv_stale", rel, "CSV mirror differs from the objects; run `upc regen`");
    }
  };
  csvCheck("sources_csv", "sources.csv", () => sourcesCsv(loaded, model));
  csvCheck("extractions_csv", "extractions.csv", () => extractionsCsv(loaded));

  // unknown_field (top-level of main objects)
  const unknownScan = (obj, schemaFile, id) => {
    const known = schemaTopProps(schemaDir, schemaFile);
    if (!known.size) return;
    for (const k of Object.keys(obj)) if (!known.has(k) && k !== "ext" && k !== "aliases") promote("unknown_field", 1, id, `unknown member "${k}"`);
  };
  if (schemaDir) {
    for (const s of loaded.sources) if (s.obj) unknownScan(s.obj, SCHEMA_FILE.source, s.obj.source_id);
    for (const e of loaded.extractions) unknownScan(e.obj, SCHEMA_FILE.extraction, e.obj.extraction_id);
    for (const g of loaded.generations) unknownScan(g.obj, SCHEMA_FILE.generation, g.obj.generation_id);
    for (const y of loaded.syntheses) unknownScan(y.obj, SCHEMA_FILE.synthesis, y.obj.synthesis_id);
  }
  // alias_collision
  const aliasMap = new Map();
  const scanAlias = (obj, canonical) => {
    for (const [ns, local] of Object.entries(obj.aliases || {})) {
      const key = ns + ":" + local;
      if (aliasMap.has(key) && aliasMap.get(key) !== canonical) warn("alias_collision", canonical, `${key} also maps to ${aliasMap.get(key)}`);
      else aliasMap.set(key, canonical);
    }
  };
  for (const s of loaded.sources) if (s.obj) scanAlias(s.obj, s.obj.source_id);
  for (const e of loaded.extractions) scanAlias(e.obj, e.obj.extraction_id);

  // --- level from rules passed (capped by content) ---
  const errLevels = new Set(errors.map((e) => e.level));
  const ceiling = hasL2 ? 2 : loaded.extractions.length ? 1 : 0;
  let achieved = 0;
  if (!errLevels.has(0)) {
    if (ceiling >= 1) { if (!errLevels.has(1)) { achieved = 1; if (ceiling >= 2 && !errLevels.has(2)) achieved = 2; } else achieved = 0; }
    else achieved = 0;
  }
  const level = "L" + achieved;

  return {
    status: errors.length ? "failed" : "passed",
    corpus: loaded.root,
    upc_spec_version: specVer,
    level,
    counts: model.counts,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// verify-quotes: hop C over an arbitrary file against a corpus.
// ---------------------------------------------------------------------------
function verifyQuotesFile(file, corpusRoot, opts = {}) {
  const strict = !!opts.strict;
  const loaded = U.loadCorpus(corpusRoot);
  const model = buildModel(loaded);
  const text = fs.readFileSync(file, "utf8");
  const errors = [], warnings = [];
  for (const mk of U.parseQuoteMarkers(text)) {
    const ext = model.extById.get(mk.extId);
    if (!ext) { errors.push({ code: "output_cites_unknown_extraction", detail: `cites ${mk.extId}` }); continue; }
    if (ext.direct_quote == null) { errors.push({ code: "cited_extraction_not_quotable", detail: mk.extId }); continue; }
    const st = ext.status || "active";
    if (st === "retracted") errors.push({ code: "cites_retracted", detail: mk.extId });
    else if (st === "superseded") warnings.push({ code: "cites_superseded", detail: mk.extId });
    if (mk.quote !== ext.direct_quote) errors.push({ code: "output_quote_mismatch", detail: `quoted text != direct_quote of ${mk.extId}`, marker: mk.quote.slice(0, 60) });
  }
  for (const uq of U.findUncitedQuotes(text)) {
    const rec = { code: "output_quote_uncited", detail: `"${uq.quote.slice(0, 50)}…"` };
    if (strict) errors.push(rec); else warnings.push(rec);
  }
  return { status: errors.length ? "failed" : "passed", file: path.resolve(file), corpus: loaded.root, errors, warnings };
}

// ---------------------------------------------------------------------------
// verify <ext-id>: full chain (hop A + B) for one extraction.
// ---------------------------------------------------------------------------
function verifyExtractionCmd(extId, corpusRoot) {
  const loaded = U.loadCorpus(corpusRoot);
  const model = buildModel(loaded);
  const ext = model.extById.get(extId);
  if (!ext) return { status: "failed", errors: [{ code: "output_cites_unknown_extraction", detail: extId }] };
  const rep = model.repById.get(ext.representation_ref);
  if (!rep) return { status: "failed", extraction: extId, errors: [{ code: "dangling_representation", detail: ext.representation_ref }] };
  const out = { extraction: extId, representation: ext.representation_ref, status: ext.status || "active" };
  if (!rep.contained || !fs.existsSync(rep.abs)) return { ...out, status: "failed", errors: [{ code: "missing_file", detail: rep.obj.path }] };
  const repRec = U.getRepFile(rep.abs);
  const hopA = U.bareHash(rep.obj.sha256) === repRec.sha256;
  out.hopA = hopA ? "pass" : "fail (rep_hash_mismatch)";
  if (ext.direct_quote == null) { out.hopB = "n/a (text-only, not a quotation)"; out.status = "ok"; return out; }
  const res = U.verifyHopB(ext, repRec);
  out.hopB = res.ok ? "pass" : `fail (${res.code})`;
  if (!res.ok) { out.detail = res.detail; if (res.hint) out.hint = res.hint; }
  out.verified = hopA && res.ok;
  return out;
}

// ---------------------------------------------------------------------------
// quote <ext-id> [--narrow start end]: mechanical copy helper.
// ---------------------------------------------------------------------------
function quoteCmd(extId, corpusRoot, narrow) {
  const loaded = U.loadCorpus(corpusRoot);
  const model = buildModel(loaded);
  const ext = model.extById.get(extId);
  if (!ext) throw new Error(`No extraction ${extId}`);
  if (ext.direct_quote == null) throw new Error(`${extId} is text-only (no direct_quote to copy)`);
  const rep = model.repById.get(ext.representation_ref);
  if (!rep || !fs.existsSync(rep.abs)) throw new Error(`representation ${ext.representation_ref} unavailable`);
  const repRec = U.getRepFile(rep.abs);
  const res = U.verifyHopB(ext, repRec);
  if (!res.ok) throw new Error(`refusing to emit an unverified quote: ${res.code} — ${res.detail}`);

  if (narrow) {
    const [ns, ne] = narrow;
    const base = ext.locator.value;
    const start = base.start + ns, end = base.start + ne;
    if (!(base.start <= start && start <= end && end <= base.end)) throw new Error(`--narrow [${ns},${ne}] is outside the parent span`);
    const span = repRec.cps.slice(start, end).join("");
    const child = {
      source_id: ext.source_id, representation_ref: ext.representation_ref, type: ext.type || "quote",
      status: "active", direct_quote: span,
      locator: { type: "char_range", representation_ref: ext.representation_ref, value: { start, end } },
      provenance: { produced_by: { tool: "upc", method: "manual" }, created_at: nowStamp(),
        derived_from: { source_ids: [ext.source_id], representation_refs: [ext.representation_ref], extraction_ids: [extId] } },
    };
    child.extraction_id = U.mintExtId(child);
    appendExtraction(loaded, ext, child);
    return { marker: `"${span}" [${child.extraction_id}]`, minted: child.extraction_id };
  }
  return { marker: `"${ext.direct_quote}" [${extId}]` };
}

function nowStamp() {
  // ISO without milliseconds; deterministic-ish. Uses the real clock (a write op).
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function appendExtraction(loaded, sibling, child) {
  // Append to the same per-source extractions.jsonl the sibling came from.
  const src = buildModel(loaded).sourceById.get(sibling.source_id);
  const rel = src && src.obj && src.obj.extractions_path;
  if (!rel) throw new Error("cannot locate a per-source extractions.jsonl to append to");
  const { abs } = U.resolveInside(loaded.root, rel);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const line = JSON.stringify(child);
  U.atomicWriteFile(abs, existing + (existing.endsWith("\n") || existing === "" ? "" : "\n") + line + "\n");
}

// ---------------------------------------------------------------------------
// regen: rebuild corpus.json (counts/indexes/schema_hash) + CSV mirrors + index.
// ---------------------------------------------------------------------------
function computeSchemaHash() {
  const { schemaDir, vocabDir } = findSpecDirs();
  if (!schemaDir) return null;
  const map = {};
  for (const f of fs.readdirSync(schemaDir).filter((x) => x.endsWith(".json")).sort()) {
    map[f] = U.sha256File(path.join(schemaDir, f));
  }
  if (vocabDir && fs.existsSync(path.join(vocabDir, "vocab.json"))) map["vocab.json"] = U.sha256File(path.join(vocabDir, "vocab.json"));
  return "sha256:" + U.sha256Hex(Buffer.from(U.jcs(map), "utf8"));
}

async function regenCmd(root) {
  const loaded = U.loadCorpus(root);
  const model = buildModel(loaded);
  const corpus = { ...loaded.corpus };
  corpus.counts = model.counts;
  corpus.sources = loaded.sources.filter((s) => s.obj).map((s) => {
    const o = s.obj, bib = o.bibliographic || {}, ret = o.retrieval || {};
    return { source_id: o.source_id, path: s.dirRel.endsWith("/") ? s.dirRel : s.dirRel + "/", title: o.title || bib.title || "", primary_url: ret.original_url || bib.url || "", sha256: ret.sha256 || (o.representations && o.representations[0] && o.representations[0].sha256) || "" };
  });
  corpus.syntheses = loaded.syntheses.map((y) => ({ synthesis_id: y.obj.synthesis_id, path: (y.dirRel.endsWith("/") ? y.dirRel : y.dirRel + "/"), title: y.obj.title || "" }));
  const sh = computeSchemaHash();
  if (sh) corpus.integrity = { ...(corpus.integrity || {}), schema_hash: sh };

  const wrote = [];
  U.atomicWriteFile(path.join(loaded.root, "corpus.json"), JSON.stringify(corpus, null, 2) + "\n");
  wrote.push("corpus.json");
  const scsvRel = (loaded.sections.sources_csv) || "sources.csv";
  const ecsvRel = (loaded.sections.extractions_csv) || "extractions.csv";
  U.atomicWriteFile(path.join(loaded.root, scsvRel), sourcesCsv(loaded, model)); wrote.push(scsvRel);
  U.atomicWriteFile(path.join(loaded.root, ecsvRel), extractionsCsv(loaded)); wrote.push(ecsvRel);
  if (runBuildIndex(loaded.root)) wrote.push((loaded.sections.index_html) || "index.html");
  return { status: "ok", wrote, counts: model.counts };
}

/** Run the browser generator as a child process (import-safe). */
function runBuildIndex(dir) {
  try {
    execFileSync(process.execPath, [path.join(HERE, "build-index.mjs"), dir], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// export: csl-json | bibtex | ris | jsonl | markdown
// ---------------------------------------------------------------------------
function bibtexKey(o, bib) {
  const a = (bib.authors && bib.authors[0]) || {};
  const name = (a.family || a.literal || "anon").split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  const year = renderDate(bib.issued).slice(0, 4) || "nd";
  return name + year + o.source_id.slice(4, 8);
}
const BIBTEX_TYPE = { "article-journal": "article", book: "book", chapter: "incollection", "paper-conference": "inproceedings", report: "techreport", thesis: "phdthesis", webpage: "misc", dataset: "misc" };
const RIS_TYPE = { "article-journal": "JOUR", book: "BOOK", chapter: "CHAP", "paper-conference": "CPAPER", report: "RPRT", thesis: "THES", webpage: "ELEC", dataset: "DATA" };

function exportCmd(root, format) {
  const loaded = U.loadCorpus(root);
  const items = loaded.sources.filter((s) => s.obj).map((s) => ({ o: s.obj, bib: s.obj.bibliographic || {} }));
  if (format === "csl-json") {
    return JSON.stringify(items.map(({ o, bib }) => ({ id: o.source_id, ...bib })), null, 2) + "\n";
  }
  if (format === "jsonl") {
    const lines = [];
    for (const s of loaded.sources) if (s.obj) lines.push(JSON.stringify({ kind: "source", ...s.obj }));
    for (const e of loaded.extractions) lines.push(JSON.stringify({ kind: "extraction", ...e.obj }));
    for (const g of loaded.generations) lines.push(JSON.stringify({ kind: "generation", ...g.obj }));
    for (const y of loaded.syntheses) lines.push(JSON.stringify({ kind: "synthesis", ...y.obj }));
    return lines.join("\n") + "\n";
  }
  if (format === "bibtex") {
    return items.map(({ o, bib }) => {
      const t = BIBTEX_TYPE[bib.item_type] || "misc";
      const fields = [];
      if (bib.title) fields.push(["title", bib.title]);
      if (bib.authors) fields.push(["author", (bib.authors || []).map((a) => a.literal || [a.family, a.given].filter(Boolean).join(", ")).join(" and ")]);
      if (bib.editors) fields.push(["editor", (bib.editors || []).map((a) => a.literal || [a.family, a.given].filter(Boolean).join(", ")).join(" and ")]);
      const yr = renderDate(bib.issued).slice(0, 4); if (yr) fields.push(["year", yr]);
      if (bib.container_title) fields.push([t === "inproceedings" ? "booktitle" : "journal", bib.container_title]);
      if (bib.volume) fields.push(["volume", bib.volume]);
      if (bib.issue) fields.push(["number", bib.issue]);
      if (bib.pages) fields.push(["pages", bib.pages]);
      if (bib.publisher) fields.push(["publisher", bib.publisher]);
      if (bib.doi) fields.push(["doi", bib.doi]);
      if (bib.url) fields.push(["url", bib.url]);
      if (bib.abstract) fields.push(["abstract", bib.abstract]);
      return `@${t}{${bibtexKey(o, bib)},\n` + fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n") + "\n}";
    }).join("\n\n") + "\n";
  }
  if (format === "ris") {
    return items.map(({ o, bib }) => {
      const L = [];
      L.push(["TY", RIS_TYPE[bib.item_type] || "GEN"]);
      for (const a of bib.authors || []) L.push(["AU", a.literal || [a.family, a.given].filter(Boolean).join(", ")]);
      for (const e of bib.editors || []) L.push(["ED", e.literal || [e.family, e.given].filter(Boolean).join(", ")]);
      if (bib.title) L.push(["TI", bib.title]);
      const yr = renderDate(bib.issued).slice(0, 4); if (yr) L.push(["PY", yr]);
      if (bib.container_title) L.push(["T2", bib.container_title]);
      if (bib.volume) L.push(["VL", bib.volume]);
      if (bib.issue) L.push(["IS", bib.issue]);
      if (bib.pages) L.push(["SP", bib.pages]);
      if (bib.doi) L.push(["DO", bib.doi]);
      if (bib.url) L.push(["UR", bib.url]);
      if (bib.abstract) L.push(["AB", bib.abstract]);
      L.push(["ER", ""]);
      return L.map(([k, v]) => `${k}  - ${v}`).join("\n");
    }).join("\n\n") + "\n";
  }
  if (format === "markdown") {
    return "# Bibliography\n\n" + items.map(({ o, bib }) => {
      const au = renderAuthors(bib.authors);
      const yr = renderDate(bib.issued);
      return `- ${au ? au + ". " : ""}${yr ? "(" + yr + "). " : ""}*${bib.title || o.title || o.source_id}*.${bib.url ? " " + bib.url : ""}`;
    }).join("\n") + "\n";
  }
  throw new Error(`unknown format ${format}`);
}

// ---------------------------------------------------------------------------
// mint <kind>: read a JSON object on stdin, print the content-addressed id.
// ---------------------------------------------------------------------------
function mintCmd(kind, stdinText) {
  const obj = JSON.parse(stdinText);
  if (kind === "ext") return U.mintExtId(obj);
  if (kind === "gen") return U.mintGenId(obj);
  if (kind === "syn") return U.mintSynId(obj);
  if (kind === "src") {
    if (obj.canonical_url || obj.url) return U.mintSrcId({ canonicalUrl: U.canonicalUrl(obj.canonical_url || obj.url) });
    return U.mintSrcId({ primaryBytesSha256: obj.sha256 });
  }
  throw new Error(`mint: unknown kind ${kind} (expected src|ext|gen|syn)`);
}

// ---------------------------------------------------------------------------
// reanchor <ext-id>|--all --to <rep-id>: byte-exact re-locate after a re-render.
// ---------------------------------------------------------------------------
function reanchorOne(loaded, model, ext, toRepId) {
  const rep = model.repById.get(toRepId);
  if (!rep || !fs.existsSync(rep.abs)) return { extraction: ext.extraction_id, result: "error", detail: `target rep ${toRepId} unavailable` };
  if (ext.direct_quote == null) return { extraction: ext.extraction_id, result: "skip", detail: "text-only extraction" };
  const repRec = U.getRepFile(rep.abs);
  const whole = repRec.text;
  const q = ext.direct_quote;
  const hits = [];
  let from = 0, idx;
  while ((idx = whole.indexOf(q, from)) !== -1) { hits.push(idx); from = idx + 1; }
  if (hits.length === 1) {
    const cpStart = U.codepointLength(whole.slice(0, hits[0]));
    const child = {
      source_id: ext.source_id, representation_ref: toRepId, type: ext.type || "quote", status: "active",
      text: ext.text, direct_quote: q,
      locator: { type: "char_range", representation_ref: toRepId, value: { start: cpStart, end: cpStart + U.codepointLength(q) } },
      query: ext.query, interpretation: ext.interpretation, confidence: ext.confidence, confidence_score: ext.confidence_score,
      supersedes: ext.extraction_id,
      provenance: { produced_by: { tool: "upc", method: "manual" }, created_at: nowStamp(),
        derived_from: { source_ids: [ext.source_id], representation_refs: [toRepId], extraction_ids: [ext.extraction_id] } },
    };
    child.extraction_id = U.mintExtId(child);
    return { extraction: ext.extraction_id, result: "reanchored", to: child.extraction_id, child, mark_superseded: true };
  }
  return { extraction: ext.extraction_id, result: "needs_review", candidates: hits.length, detail: hits.length === 0 ? "quote not found in target" : `${hits.length} matches (ambiguous)` };
}

function reanchorCmd(root, target, toRepId) {
  const loaded = U.loadCorpus(root);
  const model = buildModel(loaded);
  let targets;
  if (target === "--all") targets = loaded.extractions.map((e) => e.obj).filter((o) => (o.status || "active") !== "active" || o.direct_quote != null);
  else { const e = model.extById.get(target); if (!e) throw new Error(`no extraction ${target}`); targets = [e]; }

  // group edits per source file for atomic rewrite
  const results = [];
  const perFile = new Map(); // abs -> {objs:[...], edits}
  for (const ext of targets) {
    let rid = toRepId;
    if (!rid) {
      // infer: newest textual representation of the same source, different id
      const src = model.sourceById.get(ext.source_id);
      const reps = (src && src.obj.representations || []).filter((r) => TEXTUAL(r.media_type) && r.representation_id !== ext.representation_ref);
      if (reps.length === 1) rid = reps[0].representation_id;
      else { results.push({ extraction: ext.extraction_id, result: "error", detail: "specify --to <rep-id> (could not infer target)" }); continue; }
    }
    const r = reanchorOne(loaded, model, ext, rid);
    results.push({ extraction: r.extraction, result: r.result, ...(r.to ? { to: r.to } : {}), ...(r.detail ? { detail: r.detail } : {}) });
    const src = model.sourceById.get(ext.source_id);
    const rel = src && src.obj.extractions_path;
    if (!rel) continue;
    const { abs } = U.resolveInside(loaded.root, rel);
    if (!perFile.has(abs)) perFile.set(abs, U.readJSONL(abs));
    const arr = perFile.get(abs);
    if (r.result === "reanchored") {
      for (const o of arr) if (o.extraction_id === ext.extraction_id) { o.status = "superseded"; o.superseded_by = r.to; }
      arr.push(r.child);
    } else if (r.result === "needs_review") {
      for (const o of arr) if (o.extraction_id === ext.extraction_id) o.status = "needs_review";
    }
  }
  for (const [abs, arr] of perFile) U.atomicWriteFile(abs, arr.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return { status: "ok", results };
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------
function arg(flags, name, n = 1) {
  const i = flags.indexOf(name);
  if (i === -1) return undefined;
  return n === 1 ? flags[i + 1] : flags.slice(i + 1, i + 1 + n);
}
function print(obj) { process.stdout.write((typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)) + (typeof obj === "string" ? "" : "\n")); }

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const strict = rest.includes("--strict");
  try {
    switch (cmd) {
      case "validate": {
        const dir = rest.find((a) => !a.startsWith("--"));
        if (!dir) { process.stderr.write("usage: upc validate <dir> [--strict]\n"); process.exit(2); }
        const rep = validateCorpus(dir, { strict });
        print(rep);
        process.exit(rep.status === "failed" ? 1 : 0);
        break;
      }
      case "verify-quotes": {
        const file = rest.find((a) => !a.startsWith("--") && a !== arg(rest, "--corpus"));
        const corpus = arg(rest, "--corpus");
        if (!file || !corpus) { process.stderr.write("usage: upc verify-quotes <file> --corpus <dir> [--strict]\n"); process.exit(2); }
        const rep = verifyQuotesFile(file, corpus, { strict });
        print(rep);
        process.exit(rep.status === "failed" ? 1 : 0);
        break;
      }
      case "verify": {
        const id = rest.find((a) => a.startsWith("ext-"));
        const corpus = arg(rest, "--corpus");
        if (!id || !corpus) { process.stderr.write("usage: upc verify <ext-id> --corpus <dir>\n"); process.exit(2); }
        const rep = verifyExtractionCmd(id, corpus);
        print(rep);
        process.exit(rep.verified === false || rep.status === "failed" ? 1 : 0);
        break;
      }
      case "quote": {
        const id = rest.find((a) => a.startsWith("ext-"));
        const corpus = arg(rest, "--corpus");
        const nar = arg(rest, "--narrow", 2);
        if (!id || !corpus) { process.stderr.write("usage: upc quote <ext-id> --corpus <dir> [--narrow <start> <end>]\n"); process.exit(2); }
        const rep = quoteCmd(id, corpus, nar ? nar.map(Number) : null);
        print(rep.marker + (rep.minted ? `\n(minted ${rep.minted})` : ""));
        break;
      }
      case "regen": {
        const dir = rest.find((a) => !a.startsWith("--"));
        if (!dir) { process.stderr.write("usage: upc regen <dir>\n"); process.exit(2); }
        print(await regenCmd(dir));
        break;
      }
      case "build-index": {
        const dir = rest.find((a) => !a.startsWith("--"));
        if (!dir) { process.stderr.write("usage: upc build-index <dir>\n"); process.exit(2); }
        print({ status: runBuildIndex(dir) ? "ok" : "failed", wrote: "index.html" });
        break;
      }
      case "export": {
        const dir = rest.find((a) => !a.startsWith("--") && a !== arg(rest, "--format") && a !== arg(rest, "-o"));
        const format = arg(rest, "--format");
        const out = arg(rest, "-o");
        if (!dir || !format) { process.stderr.write("usage: upc export <dir> --format bibtex|ris|csl-json|jsonl|markdown|ro-crate [-o <file>] [--copy]\n"); process.exit(2); }
        if (format === "ro-crate") {
          print(writeRoCrate(dir, { outDir: out, copy: rest.includes("--copy") }));
          break;
        }
        const text = exportCmd(dir, format);
        if (out) { U.atomicWriteFile(path.resolve(out), text); print({ status: "ok", wrote: out }); } else process.stdout.write(text);
        break;
      }
      case "mint": {
        const kind = rest[0];
        const corpus = arg(rest, "--corpus");
        const stdin = fs.readFileSync(0, "utf8");
        void corpus;
        print(mintCmd(kind, stdin));
        break;
      }
      case "reanchor": {
        const corpus = arg(rest, "--corpus");
        const to = arg(rest, "--to");
        const target = rest.includes("--all") ? "--all" : rest.find((a) => a.startsWith("ext-"));
        if (!corpus || !target) { process.stderr.write("usage: upc reanchor <ext-id>|--all --corpus <dir> [--to <rep-id>]\n"); process.exit(2); }
        print(reanchorCmd(corpus, target, to));
        break;
      }
      default:
        process.stderr.write("UPC 1.2.0 — commands: validate, verify-quotes, verify, quote, regen, build-index, export, mint, reanchor\n");
        process.exit(cmd ? 2 : 0);
    }
  } catch (e) {
    print({ status: "error", detail: e.message });
    process.exit(2);
  }
}

// Exports for thin wrappers / tests; only run the CLI when invoked directly.
// (validateCorpus is already exported at its declaration.)
export { verifyQuotesFile, verifyExtractionCmd, quoteCmd, regenCmd, exportCmd, mintCmd, reanchorCmd, buildModel, sourcesCsv, extractionsCsv, computeSchemaHash };

const _isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (_isDirect) main();
