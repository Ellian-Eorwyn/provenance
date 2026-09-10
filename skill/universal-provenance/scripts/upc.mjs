#!/usr/bin/env node
// UPC 1.5.0 command-line tool. Zero deps, Node >= 18.
//
//   upc validate <dir> [--strict]
//   upc verify-quotes <file> --corpus <dir> [--strict]
//   upc verify <ext-id> --corpus <dir>
//   upc quote <ext-id> --corpus <dir> [--narrow <start> <end>]
//   upc locate <ext-id> --corpus <dir> [--format json|web-annotation] [--context <n>]
//   upc regen <dir>
//   upc build-index <dir>
//   upc export <dir> --format bibtex|ris|csl-json|jsonl|markdown|ro-crate|prov|obsidian
//                    [-o <file|dir>] [--copy]
//                    obsidian: [-o <dir> | --into <vault>] [--strip none|standard|aggressive]
//                    [--frontmatter approved|extended] [--allow-rewrite-body] [--profile <f>]
//                    [--filenames title|citation] [--image-names id|citation] [--force]
//   upc anchor --corpus <dir> --rep <rep-id> [--set <id>] [--dry-run]  (JSONL candidates on stdin)
//   upc code --corpus <dir> --set <cds-id> [--dry-run]     (JSONL codings on stdin)
//   upc codebook <dir> [<cbk-id>]
//   upc mint [--batch] <src|rep|ext|gen|syn|cod|cbk>       (JSON object / JSONL on stdin)
//   upc batch --corpus <dir>                               (NDJSON commands on stdin)
//   upc reanchor <ext-id>|--all --corpus <dir> [--to <rep-id>]
//   upc version [--json]
//   upc check-compat --requires "^1.6" [--schema-hash <sha256:...>]
//
// The validator implements the spec/08 rule registry exactly; conformance level
// is computed from rules passed, not object counts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as U from "./upc_common.mjs";
import { isTextualMedia as U_TEXTUAL } from "./upc_common.mjs";
import { writeSite, writeSingleFile } from "./site.mjs";
import { writeRoCrate, buildAnnotationTargets } from "./ro-crate.mjs";
import { buildProvGraph } from "./prov.mjs";
import { writeVault } from "./obsidian.mjs";

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

// The VERSION file at the spec root is the single source of truth for the spec
// version; the fallback exists only so a detached scripts/ copy still reports.
const FALLBACK_SPEC_VERSION = "1.8.0";
function specVersion() {
  try {
    const { specRoot } = findSpecDirs();
    if (specRoot) {
      const f = path.join(specRoot, "VERSION");
      if (fs.existsSync(f)) {
        const v = fs.readFileSync(f, "utf8").trim();
        if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)) return v;
      }
    }
  } catch { /* fall through */ }
  return FALLBACK_SPEC_VERSION;
}

const COMMANDS = [
  "validate", "verify-quotes", "verify", "quote", "locate", "anchor", "code",
  "codebook", "regen", "build-index", "export", "mint", "add", "event", "batch", "reanchor",
  "version", "check-compat",
];

/** Parse a "^1.6" / "~1.7.0" / "1.7.0" / ">=1.5" requirement against a version. */
function satisfiesRequirement(version, requirement) {
  const req = String(requirement || "").trim();
  const m = /^(\^|~|>=|=)?\s*([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?$/.exec(req);
  if (!m) return { ok: false, reason: `unparseable requirement ${JSON.stringify(requirement)}` };
  const op = m[1] || "=";
  const [rMaj, rMin, rPat] = [Number(m[2]), m[3] === undefined ? null : Number(m[3]), m[4] === undefined ? null : Number(m[4])];
  const v = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);
  if (!v) return { ok: false, reason: `unparseable version ${version}` };
  const [maj, min, pat] = [Number(v[1]), Number(v[2]), Number(v[3])];
  const atLeast = () => maj > rMaj || (maj === rMaj && (rMin === null || min > rMin || (min === rMin && (rPat === null || pat >= rPat))));
  switch (op) {
    // ^1.6 — same major, at least this minor. This is the UPC compatibility promise.
    case "^": return { ok: maj === rMaj && atLeast(), reason: `${version} vs ^${rMaj}.${rMin ?? 0}` };
    case "~": return { ok: maj === rMaj && (rMin === null || min === rMin) && atLeast(), reason: `${version} vs ~${req.slice(1)}` };
    case ">=": return { ok: atLeast(), reason: `${version} vs >=${req.slice(2).trim()}` };
    default: return { ok: maj === rMaj && (rMin === null || min === rMin) && (rPat === null || pat === rPat), reason: `${version} vs ==${req}` };
  }
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
  codebook: "codebook.schema.json",
  coding: "coding.schema.json",
  "coding-set": "coding-set.schema.json",
};

function schemaTopProps(schemaDir, file) {
  try {
    const s = U.readJSON(path.join(schemaDir, file));
    return new Set(Object.keys(s.properties || {}));
  } catch {
    return new Set();
  }
}

// The closed enum of a vocab.json definition (bare `enum` or the enum branch of
// an `anyOf` closed-with-x-escape def). Single source of truth for advisory
// checks so a code-side list never drifts from vocab/vocab.json.
function vocabEnum(vocabDir, name) {
  try {
    const v = U.readJSON(path.join(vocabDir, "vocab.json"));
    const def = (v.$defs && v.$defs[name]) || {};
    if (Array.isArray(def.enum)) return new Set(def.enum);
    const branch = Array.isArray(def.anyOf) && def.anyOf.find((b) => Array.isArray(b.enum));
    return new Set(branch ? branch.enum : []);
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

  const cbkById = new Map();
  for (const c of loaded.codebooks || []) cbkById.set(c.obj.codebook_id, c.obj);
  const codById = new Map();
  for (const c of loaded.codings || []) codById.set(c.obj.coding_id, c.obj);
  // Codings indexed by what they are about, so a reader can go target -> codes in O(1).
  const codByTarget = new Map();
  for (const c of loaded.codings || []) {
    const t = c.obj.target || {};
    if (!t.id) continue;
    if (!codByTarget.has(t.id)) codByTarget.set(t.id, []);
    codByTarget.get(t.id).push(c.obj);
  }

  const counts = {
    sources: loaded.sources.filter((s) => s.obj).length,
    representations: loaded.representations.length,
    extractions: loaded.extractions.length,
    generations: loaded.generations.length,
    syntheses: loaded.syntheses.length,
  };
  // Only advertise the coding counts when the corpus actually has a coding scheme,
  // so an existing corpus regenerates byte-identically.
  if ((loaded.codebooks || []).length) counts.codebooks = loaded.codebooks.length;
  if ((loaded.codings || []).length) counts.codings = loaded.codings.length;

  return { sourceById, repById, extById, genById, synById, cbkById, codById, codByTarget, extBySource, genBySource, counts };
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
  "cbk-": /^cbk-[0-9a-f]{12}$/, "cod-": /^cod-[0-9a-f]{12}$/,
};
function idFormatOk(id) {
  const pref = String(id || "").slice(0, 4);
  const re = ID_PATTERNS[pref];
  return re ? re.test(id) : false;
}
const TEXTUAL = U_TEXTUAL; // shared predicate (upc_common), kept as a local alias
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
  // Representations are content-addressed by BYTE HASH but their records are
  // source-scoped, so the same bytes legitimately appear more than once: a figure
  // syndicated across sources, or one file serving two roles. Rule 1.1 therefore
  // compares hashes before calling it a duplicate (spec/08). Agreeing hashes are a
  // shared representation (advisory); disagreeing hashes mean a record is lying
  // about its own bytes, which stays an error.
  const repSeen = new Map();
  for (const r of loaded.representations) {
    const id = r.obj.representation_id;
    const hash = U.bareHash(r.obj.sha256 || "");
    if (!idFormatOk(id)) err("id_format", 1, id, "malformed representation id");
    if (repSeen.has(id)) {
      const prior = repSeen.get(id);
      if (prior.hash && hash && prior.hash === hash) {
        warn("representation_shared", id, `same bytes recorded by ${prior.sourceId} and ${r.sourceId}`, { sha256: hash.slice(0, 12) });
      } else {
        err("id_duplicate", 1, id, `duplicate representation id with differing sha256 (${(prior.hash || "?").slice(0, 12)}… vs ${(hash || "?").slice(0, 12)}…)`);
      }
    } else {
      repSeen.set(id, { hash, sourceId: r.sourceId });
      if (seen.has(id)) err("id_duplicate", 1, id, `duplicate id (also ${seen.get(id)})`);
      else seen.set(id, "representation");
    }
  }
  for (const e of loaded.extractions) checkId(e.obj.extraction_id, "extraction", e.obj);
  for (const g of loaded.generations) checkId(g.obj.generation_id, "generation", g.obj);
  for (const y of loaded.syntheses) checkId(y.obj.synthesis_id, "synthesis", y.obj);
  for (const c of loaded.codebooks || []) checkId(c.obj.codebook_id, "codebook", c.obj);
  for (const c of loaded.codings || []) checkId(c.obj.coding_id, "coding", c.obj);

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

  // Extractions whose hop-B gate failed, so a coding that targets one can be
  // flagged as inheriting the break (spec/12, advisory coding_targets_failed_gate).
  const gateFailedExtIds = new Set();

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
    // Located by normalized re-find (§03). Informational: the stored quote is
    // still the representation's own bytes and is gated below like any other.
    if (o.anchoring && o.anchoring.method === "normalized") {
      warn("anchored_by_normalization", o.extraction_id, `rules: ${(o.anchoring.rules || []).join(",") || "unstated"}`);
    }

    if (status !== "active") { warn("flagged_extraction", o.extraction_id, `status=${status}`, { hop: "B" }); continue; }
    if (o.direct_quote == null) continue; // text-only: nothing to gate

    // 1.5 quote requires char_range + textual rep
    if (!o.locator || o.locator.type !== "char_range") { err("quote_locator_missing", 1, o.extraction_id, "direct_quote without a char_range locator", { hop: "B" }); continue; }
    if (!rep) continue;
    if (!TEXTUAL(rep.obj.media_type)) { err("quote_rep_not_text", 1, o.extraction_id, `representation media_type ${rep.obj.media_type} is not textual`, { hop: "B" }); continue; }
    if (!rep.contained || !fs.existsSync(rep.abs)) continue; // already flagged
    const repRec = U.getRepFile(rep.abs);
    const res = U.verifyHopB(o, repRec);
    if (!res.ok) {
      gateFailedExtIds.add(o.extraction_id);
      err(res.code, 1, o.extraction_id, res.detail, { hop: "B", ...(res.hint ? { hint: res.hint } : {}) });
    }
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

  // --- 1.9 codebooks & codings (spec/12) ---
  // Every rule here is vacuous on a corpus with no codings, so L1 is unchanged for
  // every corpus that predates 1.7.0. A bad coding pass must never make a corpus
  // report "failed" — the conformance level is about provenance integrity, not
  // about whether a rater was any good.
  const declaredCoders = new Set();
  for (const cs of loaded.codingSets || []) {
    if (schemaDir) {
      const e = U.validateWithSchema(schemaDir, SCHEMA_FILE["coding-set"], cs.obj, cs.dirRel);
      for (const m of e) err("schema_invalid", 0, cs.obj.set_id || cs.dirRel, m);
    }
    for (const c of cs.obj.coders || []) if (c && c.coder) declaredCoders.add(c.coder);
    for (const ref of cs.obj.codebook_refs || []) {
      if (!model.cbkById.has(ref)) warn("dangling_codebook", cs.obj.set_id || cs.dirRel, `codebook_refs ${ref}`);
    }
  }

  for (const c of loaded.codebooks || []) {
    const o = c.obj;
    if (schemaDir) {
      const e = U.validateWithSchema(schemaDir, SCHEMA_FILE.codebook, o, c.from);
      for (const m of e) err("schema_invalid", 0, o.codebook_id || c.from, m);
    }
    if (o.namespace && o.slug) {
      const expect = U.mintCbkId(o);
      if (o.codebook_id !== expect) err("id_mismatch", 1, o.codebook_id, `expected ${expect}`);
    }
    if (!o.provenance || !o.provenance.produced_by || !o.provenance.produced_by.tool) {
      err("missing_provenance", 1, o.codebook_id, "codebook has no provenance.produced_by.tool");
    }
    // Hierarchy integrity: duplicate tokens make a code ambiguous, and a parent
    // cycle makes rollup non-terminating for any reader that walks it.
    const byCode = new Map();
    for (const cd of o.codes || []) {
      if (!cd || !cd.code) continue;
      if (byCode.has(cd.code)) err("codebook_code_duplicate", 1, o.codebook_id, `code ${cd.code} defined more than once`);
      else byCode.set(cd.code, cd);
    }
    for (const cd of byCode.values()) {
      if (cd.parent == null || cd.parent === "") continue;
      if (!byCode.has(cd.parent)) { err("codebook_parent_dangling", 1, o.codebook_id, `code ${cd.code} parent ${cd.parent} is not defined`); continue; }
      const path0 = new Set([cd.code]);
      let cur = byCode.get(cd.parent);
      while (cur) {
        if (path0.has(cur.code)) { err("codebook_parent_cycle", 1, o.codebook_id, `parent cycle at ${cur.code}`); break; }
        path0.add(cur.code);
        cur = cur.parent ? byCode.get(cur.parent) : null;
      }
    }
    if (o.revision_digest) {
      const actual = U.codebookRevisionDigest(o.codes || []);
      if (actual !== o.revision_digest) warn("codebook_revision_stale", o.codebook_id, `revision_digest ${o.revision_digest.slice(0, 19)}… != actual ${actual.slice(0, 19)}…`);
    }
  }

  {
    const usedCodes = new Set();
    // (codebook, target, coder) -> the active single-label judgement, for disagreement detection.
    const byTargetCoder = new Map();
    for (const c of loaded.codings || []) {
      const o = c.obj;
      if (schemaDir) {
        const e = U.validateWithSchema(schemaDir, SCHEMA_FILE.coding, o, c.from);
        for (const m of e) err("schema_invalid", 0, o.coding_id || c.from, m);
      }
      const expect = U.mintCodId(o);
      if (o.coding_id !== expect) err("id_mismatch", 1, o.coding_id, `expected ${expect}`);
      if (!o.provenance || !o.provenance.produced_by || !o.provenance.produced_by.tool) {
        err("missing_provenance", 1, o.coding_id, "coding has no provenance.produced_by.tool");
      }

      const cbk = model.cbkById.get(o.codebook_ref);
      if (!cbk) err("dangling_codebook", 1, o.coding_id, `codebook_ref ${o.codebook_ref}`);
      else {
        const closed = cbk.closed !== false;
        const hasCode = o.code !== undefined && o.code !== null && o.code !== "";
        const hasValue = o.value !== undefined && o.value !== null && o.value !== "";
        if (hasCode === hasValue) {
          err("coding_open_closed_mismatch", 1, o.coding_id, hasCode ? "carries both code and value" : "carries neither code nor value");
        } else if (closed && hasValue) {
          err("coding_open_closed_mismatch", 1, o.coding_id, `codebook ${cbk.codebook_id} is closed but the coding carries a free-text value`);
        } else if (!closed && hasCode) {
          err("coding_open_closed_mismatch", 1, o.coding_id, `codebook ${cbk.codebook_id} is open but the coding carries a code`);
        } else if (closed && hasCode) {
          const known = (cbk.codes || []).some((cd) => cd && cd.code === o.code);
          if (!known) err("coding_code_unknown", 1, o.coding_id, `code ${JSON.stringify(o.code)} is not in codebook ${cbk.codebook_id}`);
          else usedCodes.add(cbk.codebook_id + "\u0000" + o.code);
        }
        if (o.codebook_revision_digest && cbk.revision_digest && o.codebook_revision_digest !== cbk.revision_digest) {
          warn("coding_codebook_drift", o.coding_id, `coded under ${o.codebook_revision_digest.slice(0, 19)}…, codebook is now ${cbk.revision_digest.slice(0, 19)}…`);
        }
      }

      // Target must resolve, and must resolve as the KIND it claims to be.
      const t = o.target || {};
      const resolver = { extraction: model.extById, source: model.sourceById, representation: model.repById }[t.kind];
      if (!resolver) err("dangling_coding_target", 1, o.coding_id, `unknown target kind ${JSON.stringify(t.kind)}`);
      else if (!resolver.has(t.id)) err("dangling_coding_target", 1, o.coding_id, `target ${t.kind} ${t.id} does not resolve`);
      else if (t.kind === "extraction") {
        // A code on a broken span is NOT an error: the coding remains a faithful
        // record of a judgement; the span is what broke (spec/12). Advisory only,
        // and §09 requires a surface to show the break rather than the code.
        const target = model.extById.get(t.id);
        const st = target.status || "active";
        if (st !== "active") warn("coding_targets_failed_gate", o.coding_id, `target ${t.id} has status ${st}`);
        else if (gateFailedExtIds.has(t.id)) warn("coding_targets_failed_gate", o.coding_id, `target ${t.id} fails the hop-B gate`);
      }

      if (o.coder && declaredCoders.size && !declaredCoders.has(o.coder)) {
        warn("coding_coder_undeclared", o.coding_id, `coder ${JSON.stringify(o.coder)} is not declared in any coding set manifest`);
      }

      if ((o.status || "active") === "active" && cbk && cbk.multi_label !== true && t.id && o.coder) {
        const k = o.codebook_ref + "\u0000" + t.id;
        if (!byTargetCoder.has(k)) byTargetCoder.set(k, []);
        byTargetCoder.get(k).push(o);
      }
    }

    // Disagreement is informational: it is the inter-rater signal, recorded as data.
    // §09 forbids a surface from resolving it silently, so the validator must not
    // treat it as a defect either.
    for (const [k, group] of byTargetCoder) {
      if (group.length < 2) continue;
      const labels = new Set(group.map((g) => (g.code !== undefined && g.code !== "" ? "code:" + g.code : "value:" + g.value)));
      const coders = new Set(group.map((g) => g.coder));
      if (labels.size > 1 && coders.size > 1) {
        const [cbkId, targetId] = k.split("\u0000");
        warn("coding_disagreement", targetId, `${coders.size} coders disagree on ${cbkId}: ${[...labels].join(" vs ")}`, { codebook_ref: cbkId });
      }
    }

    for (const c of loaded.codebooks || []) {
      for (const cd of c.obj.codes || []) {
        if (!cd || !cd.code || cd.deprecated) continue;
        if (!usedCodes.has(c.obj.codebook_id + "\u0000" + cd.code)) {
          warn("codebook_code_unused", c.obj.codebook_id, `code ${cd.code} is defined but never applied`);
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

  // source identity enrichment advisories (identifiers[]/relations[], §02/§06/§08).
  // Both are warnings only: an unlisted identifier scheme is never a hard error,
  // and UPC never resolves an external identifier. relation_dangling checks only
  // intra-corpus, id-shaped targets; external strings/URLs are left untouched.
  {
    const knownSchemes = vocabDir ? vocabEnum(vocabDir, "identifier_scheme") : new Set();
    const X_PREFIX = /^x-[a-z0-9-]+$/;
    const RESOLVABLE = new Set(["src-", "rep-", "img-", "ext-", "gen-", "syn-"]);
    const idShaped = (t) => typeof t === "string" && RESOLVABLE.has(t.slice(0, 4));
    const resolves = (t) =>
      model.sourceById.has(t) || model.repById.has(t) || model.extById.has(t) || model.genById.has(t) || model.synById.has(t);
    for (const s of loaded.sources) {
      if (!s.obj) continue;
      const o = s.obj;
      for (const it of o.identifiers || []) {
        const sch = it && it.scheme;
        if (typeof sch === "string" && sch !== "" && !knownSchemes.has(sch) && !X_PREFIX.test(sch)) {
          warn("identifier_scheme_unknown", o.source_id, `unrecognized identifier scheme "${sch}"`);
        }
      }
      for (const rel of o.relations || []) {
        const t = rel && rel.target;
        if (idShaped(t) && !resolves(t)) warn("relation_dangling", o.source_id, `relation target ${t} does not resolve`);
      }
    }
  }

  // secondary_locators advisories (presentation / cross-representation, §03/§05/§08).
  // Warnings only, always: a secondary locator is advisory by construction --
  // never gate-bearing, never part of identity -- so a bad one must never move
  // the conformance level. A secondary MAY address a different representation
  // of the same source (that is how a cross-representation region highlight is
  // recorded); addressing a different SOURCE is what gets flagged.
  {
    for (const e of loaded.extractions) {
      const o = e.obj;
      for (const loc of o.secondary_locators || []) {
        if (!loc || typeof loc !== "object") continue;
        const ref = loc.representation_ref;
        const rep = ref ? model.repById.get(ref) : null;
        if (!rep) { warn("secondary_locator_dangling", o.extraction_id, `secondary locator representation_ref ${ref} does not resolve`); continue; }
        if (rep.sourceId && o.source_id && rep.sourceId !== o.source_id) {
          warn("secondary_locator_cross_source", o.extraction_id, `secondary locator targets ${ref} in source ${rep.sourceId}, not ${o.source_id}`);
        }
        if (loc.type === "bbox") {
          // A bbox lives in its declared reference frame; fall back to the
          // target image's own dimensions when no frame is declared.
          const frame = loc.reference || rep.obj.dimensions;
          const v = loc.value;
          if (frame && Array.isArray(v) && v.length === 4 && Number.isFinite(frame.width) && Number.isFinite(frame.height)) {
            if (v[0] + v[2] > frame.width || v[1] + v[3] > frame.height) {
              warn("bbox_out_of_bounds", o.extraction_id, `bbox [${v.join(",")}] exceeds ${frame.width}x${frame.height} on ${ref}`);
            }
          }
        }
        if (loc.type === "line_range") {
          const v = loc.value || {};
          if (Number.isInteger(v.start) && v.start < 1) {
            warn("line_range_out_of_bounds", o.extraction_id, `line_range start ${v.start} is below 1 (line numbers are 1-based, §03)`);
          } else if (rep.contained && fs.existsSync(rep.abs)) {
            const rec = U.getRepFile(rep.abs);
            if (rec.utf8ok && Number.isInteger(v.end)) {
              const n = U.textLines(rec.text).length;
              if (v.end > n) warn("line_range_out_of_bounds", o.extraction_id, `line_range end ${v.end} exceeds ${n} lines in ${ref}`);
            }
          }
        }
      }
    }
  }

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
// locate <ext-id>: resolve every locator on an extraction into the structured
// context a reading surface needs to bring the source up in place.
//
// The primary locator carries the gate verdict. Every secondary is reported as
// advisory, and one that addresses a different representation is additionally
// flagged cross_representation with trust "recorded_not_gated" -- a surface MUST
// NOT present it as a verified position (spec/05 trust boundary, spec/09).
// Read-only: nothing here writes to the corpus.
// ---------------------------------------------------------------------------
function locateCmd(extId, corpusRoot, opts = {}) {
  const loaded = U.loadCorpus(corpusRoot);
  U.clearRepCache();
  const model = buildModel(loaded);
  const ext = model.extById.get(extId);
  if (!ext) return { status: "failed", errors: [{ code: "output_cites_unknown_extraction", detail: extId }] };

  const ctxOpt = Number.isInteger(opts.context) ? { context: opts.context } : {};
  const rep = model.repById.get(ext.representation_ref);
  const repRec = rep && rep.contained && fs.existsSync(rep.abs) ? U.getRepFile(rep.abs) : null;

  // The §09 badge taxonomy, shared with the browser and the exports (upc_common).
  const lookupRep = (id) => { const r = model.repById.get(id); return r ? r.obj : null; };
  const { badge } = U.badgeForExtraction(ext, rep ? rep.obj : null, repRec, lookupRep);

  const primary = U.resolveLocator(loaded, ext.locator, ctxOpt);
  primary.verified = U.VERIFIED_BADGES.has(badge);

  const secondary = (ext.secondary_locators || []).map((loc) => {
    const r = U.resolveLocator(loaded, loc, ctxOpt);
    r.advisory = true;
    if (loc && loc.representation_ref && loc.representation_ref !== ext.representation_ref) {
      r.cross_representation = true;
    }
    return r;
  });

  const bundle = {
    status: "ok",
    extraction_id: extId,
    source_id: ext.source_id,
    type: ext.type,
    extraction_status: ext.status || "active",
    badge,
    direct_quote: ext.direct_quote != null ? ext.direct_quote : null,
    text: ext.text != null ? ext.text : null,
    primary,
    secondary,
  };

  if (opts.format === "web-annotation") {
    const lookup = (repId) => {
      const r = model.repById.get(repId);
      if (!r || !r.obj) return null;
      const rec = r.contained && fs.existsSync(r.abs) ? U.getRepFile(r.abs) : null;
      return { ref: { "@id": r.obj.path }, rec };
    };
    const target = buildAnnotationTargets(ext, lookup);
    if (!target) return { status: "failed", extraction_id: extId, errors: [{ code: "no_projectable_locator", detail: "no locator projects to a Web Annotation selector" }] };
    const anno = {
      "@context": ["http://www.w3.org/ns/anno.jsonld", { upc: "https://provenance.dev/upc/terms#" }],
      "@id": "#" + extId + "-anno",
      "@type": "Annotation",
      "upc:interopOnly": true,
      "upc:badge": badge,
      target,
    };
    if (ext.direct_quote != null) anno.body = { "@type": "TextualBody", value: ext.direct_quote };
    return anno;
  }
  return bundle;
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
  if (format === "prov") return JSON.stringify(buildProvGraph(loaded), null, 2) + "\n";
  throw new Error(`unknown format ${format}`);
}

// ---------------------------------------------------------------------------
// mint <kind>: read a JSON object on stdin, print the content-addressed id.
// ---------------------------------------------------------------------------
function mintOne(kind, obj) {
  if (kind === "ext") return U.mintExtId(obj);
  if (kind === "gen") return U.mintGenId(obj);
  if (kind === "syn") return U.mintSynId(obj);
  if (kind === "cod") return U.mintCodId(obj);
  if (kind === "cbk") return U.mintCbkId(obj);
  if (kind === "rep") {
    // A rep-/img- id is the byte hash, so mint from a path, raw bytes, or a hash.
    if (obj.path) return U.mintRepId(fs.readFileSync(path.resolve(obj.path)));
    if (obj.sha256) return "rep-" + U.bareHash(obj.sha256).slice(0, 12);
    throw new Error("mint rep: need { path } or { sha256 }");
  }
  if (kind === "src") {
    if (obj.canonical_url || obj.url) return U.mintSrcId({ canonicalUrl: U.canonicalUrl(obj.canonical_url || obj.url) });
    return U.mintSrcId({ primaryBytesSha256: obj.sha256 });
  }
  throw new Error(`mint: unknown kind ${kind} (expected src|rep|ext|gen|syn|cod|cbk)`);
}

function mintCmd(kind, stdinText) {
  return mintOne(kind, JSON.parse(stdinText));
}

/** JSONL in, {i,id} JSONL out. One process for a whole coding pass. */
function mintBatchCmd(kind, stdinText) {
  const objs = readJsonlText(stdinText);
  return objs.map((o, i) => {
    try { return { i, id: mintOne(kind, o) }; }
    catch (e) { return { i, error: e.message }; }
  });
}

/**
 * upc batch — NDJSON commands in, NDJSON results out, over ONE loadCorpus with a warm
 * representation cache. `locate` is O(whole corpus) per invocation, so a reader that
 * shells out per passage is quadratic; this is the fix. Deliberately not a server:
 * no port, no auth, no dependency in a zero-dependency repo.
 */
function batchCmd(root, stdinText) {
  const cmds = readJsonlText(stdinText);
  U.clearRepCache();
  const out = [];
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i] || {};
    try {
      switch (c.cmd) {
        case "locate":
          out.push({ i, cmd: c.cmd, result: locateCmd(c.ext, root, { format: c.format || "json", context: c.context }) });
          break;
        case "verify":
          out.push({ i, cmd: c.cmd, result: verifyExtractionCmd(c.ext, root) });
          break;
        case "quote":
          out.push({ i, cmd: c.cmd, result: quoteCmd(c.ext, root, c.narrow || null) });
          break;
        case "codebook":
          out.push({ i, cmd: c.cmd, result: codebookCmd(root, c.id) });
          break;
        default:
          out.push({ i, error: `unknown cmd ${JSON.stringify(c.cmd)} (expected locate|verify|quote|codebook)` });
      }
    } catch (e) {
      out.push({ i, cmd: c.cmd, error: e.message });
    }
  }
  return out;
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

// ---------------------------------------------------------------------------
// 1.7.0 — anchoring, coding, and batch entry points (spec/03 re-extraction, spec/12)
// ---------------------------------------------------------------------------

/** Append one activity event to the journal, minting the next sequential evt- id. */
/** Declare a section in corpus.json if it is not already declared.
 *
 *  `loadCorpus` reads only what `sections` declares — there is no directory
 *  sniffing — so a tool that writes an extraction set or a coding set into an
 *  undeclared location produces files the corpus cannot see. The objects are on
 *  disk, every reference to them dangles, and nothing says why. corpus.json is
 *  machine-owned and regenerable (spec/01), so the writer declares what it wrote. */
function ensureSection(loaded, key, value) {
  const cjRel = "corpus.json";
  const { abs, contained } = U.resolveInside(loaded.root, cjRel);
  if (!contained || !fs.existsSync(abs)) return false;
  const cj = U.readJSON(abs);
  cj.sections = cj.sections || {};
  if (cj.sections[key]) return false;
  cj.sections[key] = value;
  U.atomicWriteFile(abs, JSON.stringify(cj, null, 2) + "\n");
  loaded.sections[key] = value;
  return true;
}

function appendEvent(loaded, ev) {
  const rel = (loaded.sections && loaded.sections.provenance) || "provenance/events.jsonl";
  const { abs, contained } = U.resolveInside(loaded.root, rel);
  if (!contained) return null;
  const prior = fs.existsSync(abs) ? U.readJSONL(abs) : [];
  let max = 0;
  for (const e of prior) {
    const m = /^evt-(\d+)$/.exec(e.event_id || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  const rec = { event_id: "evt-" + String(max + 1).padStart(6, "0"), ...ev };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  U.atomicWriteFile(abs, prior.concat([rec]).map((o) => JSON.stringify(o)).join("\n") + "\n");
  return rec.event_id;
}

function readJsonlText(text) {
  const out = [];
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); }
    catch (e) { throw new Error(`stdin line ${i + 1}: ${e.message}`); }
  }
  return out;
}

/**
 * upc add source — the producer primitive.
 *
 * UPC deliberately has no PDF reader, no fetcher, no OCR: what a document is made
 * of is the tool's business. What is NOT the tool's business is layout and
 * identity — slug collision, portable filenames, containment, `rep-` ids that are
 * byte hashes, parent links, provenance stamps, the journal entry. Every producer
 * that reimplements those gets some of them subtly wrong, and a corpus that is
 * wrong in those ways is not repairable from the outside.
 *
 * So a producer in any language prepares files and a description, and this writes
 * the corpus. Input (one JSON object, or JSONL with --batch):
 *
 *   { slug?, title, source_kind, bibliographic?, field_evidence?, identifiers?,
 *     aliases?, retrieval?, tags?, provenance?,
 *     files: [ { path, role, media_type, produced_by?, parent?, description?,
 *                has_text?, language?, encoding? } ] }
 *
 * `files[].parent` is an INDEX into files[], so a producer can say "the text came
 * from that PDF" without knowing any id in advance.
 */
function addSourceCmd(root, records, opts = {}) {
  const loaded = U.loadCorpus(root);
  const existingSlugs = new Set();
  for (const s of loaded.sources) existingSlugs.add(String(s.dirRel || "").split("/").pop().toLowerCase());
  const byId = new Map(loaded.sources.map((s) => [s.obj.source_id, s]));
  const sourcesBase = (loaded.sections && loaded.sections.sources) || "sources/";
  const results = [];
  let wrote = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i] || {};
    try {
      const files = Array.isArray(r.files) ? r.files : [];
      if (!files.length) throw new Error("a source needs at least one file (spec/08 rule 0.4)");

      // Hash every file once; refuse symlinks outright rather than resolving them.
      const prepared = files.map((f, fi) => {
        if (!f || !f.path) throw new Error(`files[${fi}]: no path`);
        const abs = path.resolve(f.path);
        const st = fs.lstatSync(abs);
        if (st.isSymbolicLink()) throw new Error(`files[${fi}]: ${f.path} is a symlink; pass the real file`);
        if (!st.isFile()) throw new Error(`files[${fi}]: ${f.path} is not a regular file`);
        const bytes = fs.readFileSync(abs);
        const hash = U.sha256Hex(bytes);
        const media = f.media_type || "application/octet-stream";
        // An image representation is addressed with the img- prefix (spec/05/06).
        const id = /^image\//.test(media) ? U.mintImgId(bytes) : U.mintRepId(bytes);
        return { f, fi, abs, bytes, hash, media, id };
      });

      // Identity: a URL source is addressed by its canonical URL, everything else
      // by the bytes of its first file.
      const url = (r.retrieval && (r.retrieval.canonical_url || r.retrieval.original_url)) || r.url;
      const sourceId = url
        ? U.mintSrcId({ canonicalUrl: U.canonicalUrl(url) })
        : U.mintSrcId({ primaryBytesSha256: "sha256:" + prepared[0].hash });

      if (byId.has(sourceId)) {
        results.push({ i, status: "exists", source_id: sourceId, dir: byId.get(sourceId).dirRel });
        continue;
      }

      const slug = U.slugifyWithCollision(r.slug || r.title || sourceId, sourceId, existingSlugs);
      const bad = U.checkFilename(slug);
      if (bad && bad.ok === false) throw new Error(`slug ${slug}: ${bad.reason}`);
      const dirRel = path.posix.join(sourcesBase.replace(/\/$/, ""), slug);
      const { abs: dirAbs, contained } = U.resolveInside(loaded.root, dirRel);
      if (!contained) throw new Error(`refusing to write outside the corpus: ${dirRel}`);

      const stamp = r.provenance || { produced_by: { tool: opts.tool || "upc", method: "import" }, created_at: nowStamp() };
      const reps = [];
      const seen = new Map();
      for (const p of prepared) {
        const base = path.basename(p.abs);
        const nameCheck = U.checkFilename(base);
        const fileName = nameCheck && nameCheck.ok === false
          ? U.slugify(base.replace(/\.[^.]*$/, "")) + path.extname(base).toLowerCase()
          : base;
        const relPath = path.posix.join(dirRel, "representations", fileName);
        const { abs: fileAbs, contained: inside } = U.resolveInside(loaded.root, relPath);
        if (!inside) throw new Error(`refusing to write outside the corpus: ${relPath}`);
        if (!opts.dryRun) {
          fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
          if (opts.hardlink) { try { fs.linkSync(p.abs, fileAbs); } catch { fs.copyFileSync(p.abs, fileAbs); } }
          else fs.copyFileSync(p.abs, fileAbs);
        }
        const rep = {
          representation_id: p.id,
          role: p.f.role || "original",
          media_type: p.media,
          path: relPath,
          sha256: "sha256:" + p.hash,
          ...(p.f.produced_by ? { produced_by: p.f.produced_by } : {}),
          provenance: stamp,
        };
        if (TEXTUAL(p.media)) {
          const dec = U.decodeUtf8Strict(p.bytes);
          if (!dec.ok) throw new Error(`files[${p.fi}]: declared ${p.media} but is not valid UTF-8`);
          rep.char_count = U.codepointLength(dec.text);
        }
        for (const k of ["description", "has_text", "language", "encoding", "page_count", "dimensions", "duration_seconds", "caption"]) {
          if (p.f[k] != null) rep[k] = p.f[k];
        }
        if (p.f.parent != null) {
          const parent = prepared[p.f.parent];
          if (!parent) throw new Error(`files[${p.fi}]: parent index ${p.f.parent} out of range`);
          rep.parent_representation_ref = parent.id;
        }
        // The same bytes twice in one source is one representation, not two.
        if (seen.has(p.id)) continue;
        seen.set(p.id, true);
        reps.push(rep);
      }

      const source = {
        source_id: sourceId,
        source_kind: r.source_kind || (url ? "url" : "document"),
        ...(r.title ? { title: r.title } : {}),
        ...(r.bibliographic ? { bibliographic: r.bibliographic } : {}),
        ...(r.field_evidence ? { field_evidence: r.field_evidence } : {}),
        ...(r.retrieval ? { retrieval: r.retrieval } : {}),
        ...(r.identifiers ? { identifiers: r.identifiers } : {}),
        ...(r.relations ? { relations: r.relations } : {}),
        ...(r.aliases ? { aliases: r.aliases } : {}),
        ...(r.tags ? { tags: r.tags } : {}),
        ...(r.discovery ? { discovery: r.discovery } : {}),
        representations: reps,
        extractions_path: path.posix.join(dirRel, "extractions.jsonl"),
        provenance: stamp,
        ...(r.ext ? { ext: r.ext } : {}),
      };

      if (!opts.dryRun) {
        fs.mkdirSync(dirAbs, { recursive: true });
        U.atomicWriteFile(path.join(dirAbs, "source.json"), JSON.stringify(source, null, 2) + "\n");
        const extAbs = path.join(dirAbs, "extractions.jsonl");
        if (!fs.existsSync(extAbs)) U.atomicWriteFile(extAbs, "");
        wrote++;
      }
      existingSlugs.add(slug.toLowerCase());
      byId.set(sourceId, { obj: source, dirRel });
      results.push({ i, status: opts.dryRun ? "planned" : "added", source_id: sourceId, slug, dir: dirRel, representation_ids: reps.map((x) => x.representation_id) });
    } catch (e) {
      results.push({ i, status: "error", detail: e.message });
    }
  }

  if (!opts.dryRun && wrote) {
    appendEvent(loaded, {
      activity_type: "import",
      tool: opts.tool || "upc",
      started_at: nowStamp(),
      status: "success",
      outputs: { source_ids: results.filter((r) => r.status === "added").map((r) => r.source_id) },
      notes: `added ${wrote}/${records.length} source(s)`,
    });
  }

  const tally = {};
  for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
  return { status: "ok", wrote, tally, results };
}

/**
 * upc add synthesis — write generated prose, but only if its quotations hold.
 *
 * The gate runs BEFORE anything is written. A synthesis whose quotations do not
 * match the extractions it cites is not a synthesis with a warning attached; it
 * is prose that misquotes its sources, and writing it would put the corpus in a
 * state the validator will fail. So this refuses, prints which markers failed,
 * and leaves the corpus untouched.
 */
function addSynthesisCmd(root, obj, opts = {}) {
  const loaded = U.loadCorpus(root);
  const model = buildModel(loaded);
  if (!opts.output) throw new Error("add synthesis: --output <file.md> is required");
  const srcAbs = path.resolve(opts.output);
  if (!fs.existsSync(srcAbs)) throw new Error(`add synthesis: ${opts.output} does not exist`);
  const text = fs.readFileSync(srcAbs, "utf8");

  // Hop C, exactly as the validator will run it.
  const failures = [];
  for (const mk of U.parseQuoteMarkers(text)) {
    const ext = model.extById.get(mk.extId);
    if (!ext) { failures.push({ marker: mk.extId, reason: "no such passage" }); continue; }
    const q = ext.direct_quote;
    if (q == null) { failures.push({ marker: mk.extId, reason: "that passage is a note, not a quotation" }); continue; }
    if (q !== mk.quote) {
      failures.push({ marker: mk.extId, reason: "quoted text differs from the passage",
                      expected: q.slice(0, 90), got: mk.quote.slice(0, 90) });
    }
  }
  if (failures.length && !opts.allowUnverified) {
    return { status: "refused", wrote: 0, failures,
             detail: "the output misquotes the passages it cites; nothing was written" };
  }

  // A claim must list the sources its evidence comes from (rule 2.2). That is
  // mechanically derivable from the extractions it cites, so derive it rather
  // than making every producer remember.
  const claims = (Array.isArray(obj.claims) ? obj.claims : []).map((c) => {
    const ids = c.evidence_ids || [];
    const from = [...new Set(ids.map((id) => (model.extById.get(id) || {}).source_id).filter(Boolean))];
    return { ...c, ...(from.length ? { source_ids: [...new Set([...(c.source_ids || []), ...from])] } : {}) };
  });
  const evidenceIds = [...new Set(claims.flatMap((c) => c.evidence_ids || []))];
  const sourceIds = [...new Set(claims.flatMap((c) => c.source_ids || [])
    .concat(evidenceIds.map((id) => (model.extById.get(id) || {}).source_id).filter(Boolean)))];
  const repRefs = [...new Set(evidenceIds
    .map((id) => (model.extById.get(id) || {}).representation_ref).filter(Boolean))];

  // Rule 2.4: the rendered output must cite every id its claims depend on — the
  // passages as well as their sources. Catch that here rather than writing a
  // synthesis that makes the corpus fail; the fix is a reference list in the
  // prose, which the writer has to author anyway.
  const uncited = [...evidenceIds, ...sourceIds].filter((id) => !text.includes(id));
  if (uncited.length && !opts.allowUnverified) {
    return { status: "refused", wrote: 0,
             failures: uncited.map((id) => ({ marker: id, reason: "the output never cites this source" })),
             detail: "add a reference list naming every source id the claims rely on; nothing was written" };
  }

  const base = (loaded.sections && loaded.sections.syntheses) || "syntheses/";
  const stamp = obj.provenance || { produced_by: { tool: opts.tool || "upc", method: "model" }, created_at: nowStamp() };
  stamp.created_at = stamp.created_at || nowStamp();
  stamp.derived_from = stamp.derived_from || {
    ...(evidenceIds.length ? { extraction_ids: evidenceIds } : {}),
    ...(sourceIds.length ? { source_ids: sourceIds } : {}),
    ...(repRefs.length ? { representation_refs: repRefs } : {}),
  };
  // The digest is over the representations this prose was written from — the
  // bytes that would have to change for it to be stale.
  if (!stamp.input_digest) {
    const inputs = repRefs
      .map((id) => {
        const r = model.repById.get(id);
        return r ? { id, sha256: r.obj.sha256 } : null;
      })
      .filter(Boolean);
    if (inputs.length) stamp.input_digest = U.computeInputDigest(inputs);
  }

  const syn = {
    type: obj.type || "thematic",
    ...(obj.title ? { title: obj.title } : {}),
    ...(obj.question ? { question: obj.question } : {}),
    ...(claims.length ? { claims } : {}),
    stale: false,
    provenance: stamp,
    ...(obj.ext ? { ext: obj.ext } : {}),
  };
  syn.output = { path: "", media_type: obj.media_type || "text/markdown",
                 sha256: "sha256:" + U.sha256Hex(Buffer.from(text, "utf8")) };
  syn.synthesis_id = U.mintSynId(syn);
  // One directory per synthesis, holding synthesis.json + synthesis.md — the
  // layout loadCorpus scans for (a flat <id>.json is invisible to it).
  const dirRel = path.posix.join(base.replace(/\/$/, ""), syn.synthesis_id);
  const relPath = path.posix.join(dirRel, "synthesis.md");
  syn.output.path = relPath;

  if (opts.dryRun) return { status: "ok", wrote: 0, synthesis_id: syn.synthesis_id, failures };

  const { abs: mdAbs, contained } = U.resolveInside(loaded.root, relPath);
  if (!contained) throw new Error(`refusing to write outside the corpus: ${relPath}`);
  fs.mkdirSync(path.dirname(mdAbs), { recursive: true });
  U.atomicWriteFile(mdAbs, text);
  const { abs: jAbs } = U.resolveInside(loaded.root, path.posix.join(dirRel, "synthesis.json"));
  U.atomicWriteFile(jAbs, JSON.stringify(syn, null, 2) + "\n");
  ensureSection(loaded, "syntheses", base);
  appendEvent(loaded, {
    activity_type: "synthesize", tool: opts.tool || "upc", started_at: nowStamp(), status: "success",
    inputs: { extraction_ids: evidenceIds }, outputs: { synthesis_ids: [syn.synthesis_id] },
    notes: `${syn.type}: ${syn.title || syn.synthesis_id}`,
  });
  return { status: "ok", wrote: 1, synthesis_id: syn.synthesis_id, path: dirRel,
           claims: claims.length, cited_passages: evidenceIds.length, failures };
}

/**
 * upc anchor — the implementation of the re-extraction protocol (spec/03, spec/09).
 * A model proposes candidate quotations as data; THIS decides whether each one is
 * real. Exactly one byte-exact occurrence mints an active char_range extraction that
 * passes hop B by construction. Zero or several occurrences never produce an active
 * quotation. The model chooses WHAT to extract; the tool guarantees THAT IT IS REAL.
 */
function anchorCmd(root, repId, candidates, opts = {}) {
  const loaded = U.loadCorpus(root);
  const model = buildModel(loaded);
  const rep = model.repById.get(repId);
  if (!rep) throw new Error(`no representation ${repId}`);
  if (!TEXTUAL(rep.obj.media_type)) throw new Error(`representation ${repId} is not textual (${rep.obj.media_type})`);
  if (!rep.contained || !fs.existsSync(rep.abs)) throw new Error(`representation ${repId} bytes unavailable`);

  const repRec = U.getRepFile(rep.abs);
  if (!repRec.utf8ok) throw new Error(`representation ${repId} is not valid UTF-8`);
  if (U.bareHash(rep.obj.sha256 || "") !== repRec.sha256) {
    throw new Error(`representation ${repId} fails hop A: stored sha256 does not match its bytes`);
  }
  const whole = repRec.text;
  const sourceId = rep.sourceId;
  const existing = new Set(loaded.extractions.map((e) => e.obj.extraction_id));

  const results = [];
  const minted = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i] || {};
    const q = c.quote;
    if (typeof q !== "string" || q === "") { results.push({ i, status: "invalid", detail: "no quote" }); continue; }
    const hits = [];
    let from = 0, idx;
    while ((idx = whole.indexOf(q, from)) !== -1) { hits.push(idx); from = idx + 1; }

    // The exact search is the first and preferred answer; normalization is only
    // ever a fallback for a span the model rendered in ordinary characters.
    let start, storedQuote = q, anchoring = null;
    if (hits.length === 1) {
      start = U.codepointLength(whole.slice(0, hits[0]));
    } else if (hits.length === 0 && opts.normalize) {
      const re = U.refindSpan(repRec, q);
      if (re.status !== "refound") {
        results.push({ i, status: re.status, quote: q, candidates: re.candidates || 0, normalized: true });
        continue;
      }
      start = re.start;
      storedQuote = re.quote;   // the representation's own codepoints, never the proposal
      anchoring = { method: "normalized", proposed_quote: q, rules: re.classes };
    } else {
      results.push({ i, status: hits.length === 0 ? "not_found" : "ambiguous", quote: q, candidates: hits.length });
      continue;
    }

    const ext = {
      source_id: sourceId,
      representation_ref: repId,
      type: c.type || opts.type || "evidence",
      status: "active",
      direct_quote: storedQuote,
      locator: { type: "char_range", representation_ref: repId, value: { start, end: start + U.codepointLength(storedQuote) } },
      provenance: {
        produced_by: { tool: opts.tool || "upc", method: "model", ...(opts.model ? { model: opts.model } : {}), ...(opts.promptVersion ? { prompt_version: opts.promptVersion } : {}) },
        created_at: nowStamp(),
        derived_from: { source_ids: [sourceId], representation_refs: [repId] },
        input_digest: "sha256:" + repRec.sha256,
      },
    };
    if (c.text) ext.text = c.text;
    if (c.query || opts.query) ext.query = c.query || opts.query;
    if (c.note) ext.rationale = c.note;
    if (c.interpretation) ext.interpretation = c.interpretation;
    if (c.confidence) ext.confidence = c.confidence;
    if (anchoring) ext.anchoring = anchoring;
    ext.extraction_id = U.mintExtId(ext);
    const dup = existing.has(ext.extraction_id);
    if (!dup) minted.push(ext);
    existing.add(ext.extraction_id);
    results.push({
      i,
      status: dup ? "exists" : anchoring ? "refound" : "anchored",
      extraction_id: ext.extraction_id,
      char_range: ext.locator.value,
      ...(anchoring ? { rules: anchoring.rules, stored_quote: storedQuote } : {}),
    });
  }

  if (!opts.dryRun && minted.length) {
    let targetRel;
    if (opts.set) {
      const base = loaded.sections.extractions || "extractions/";
      ensureSection(loaded, "extractions", base);
      targetRel = path.join(base, opts.set, "items.jsonl").replace(/\\/g, "/");
      const manRel = path.join(base, opts.set, "manifest.json").replace(/\\/g, "/");
      const { abs: manAbs } = U.resolveInside(loaded.root, manRel);
      fs.mkdirSync(path.dirname(manAbs), { recursive: true });
      if (!fs.existsSync(manAbs)) {
        U.atomicWriteFile(manAbs, JSON.stringify({
          set_id: opts.set, title: opts.title || opts.set, query: opts.query || "", items_path: targetRel,
          provenance: { produced_by: { tool: opts.tool || "upc", method: "model" }, created_at: nowStamp() },
        }, null, 2) + "\n");
      }
    } else {
      const src = model.sourceById.get(sourceId);
      targetRel = (src && src.obj.extractions_path) || path.join(src ? src.dirRel : "sources", "extractions.jsonl").replace(/\\/g, "/");
    }
    const { abs, contained } = U.resolveInside(loaded.root, targetRel);
    if (!contained) throw new Error(`refusing to write outside the corpus: ${targetRel}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const prior = fs.existsSync(abs) ? U.readJSONL(abs) : [];
    U.atomicWriteFile(abs, prior.concat(minted).map((o) => JSON.stringify(o)).join("\n") + "\n");
    appendEvent(loaded, {
      activity_type: "extract",
      tool: opts.tool || "upc",
      started_at: nowStamp(),
      status: "success",
      inputs: { representation_refs: [repId] },
      outputs: { extraction_ids: minted.map((m) => m.extraction_id) },
      notes: `anchored ${minted.length}/${candidates.length} candidate(s)`,
    });
  }

  const tally = { anchored: 0, refound: 0, exists: 0, not_found: 0, ambiguous: 0, invalid: 0 };
  for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
  return { status: "ok", representation_ref: repId, source_id: sourceId, wrote: opts.dryRun ? 0 : minted.length, tally, results };
}

/**
 * upc code — batch-apply codings (spec/12). Batch only, deliberately: a per-object
 * form would invite one process per coding, which is what made `mint` unusable at scale.
 */
function codeCmd(root, setId, records, opts = {}) {
  const loaded = U.loadCorpus(root);
  const model = buildModel(loaded);
  const base = loaded.sections.codings || "codings/";
  const setDirRel = path.join(base, setId).replace(/\\/g, "/");
  const itemsRel = path.join(setDirRel, "items.jsonl").replace(/\\/g, "/");
  const manRel = path.join(setDirRel, "manifest.json").replace(/\\/g, "/");
  const { abs: itemsAbs, contained: ic } = U.resolveInside(loaded.root, itemsRel);
  const { abs: manAbs, contained: mc } = U.resolveInside(loaded.root, manRel);
  if (!ic || !mc) throw new Error(`refusing to write outside the corpus: ${setDirRel}`);

  const prior = fs.existsSync(itemsAbs) ? U.readJSONL(itemsAbs) : [];
  const byId = new Map(prior.map((o) => [o.coding_id, o]));
  const results = [];
  const fresh = [];
  const coders = new Set();

  for (let i = 0; i < records.length; i++) {
    const r = records[i] || {};
    const t = r.target || {};
    if (!r.codebook_ref || !t.kind || !t.id || !r.coder) { results.push({ i, status: "invalid", detail: "need codebook_ref, target.{kind,id}, coder" }); continue; }
    const cbk = model.cbkById.get(r.codebook_ref);
    if (!cbk) { results.push({ i, status: "error", detail: `unknown codebook ${r.codebook_ref}` }); continue; }
    const closed = cbk.closed !== false;
    const hasCode = r.code !== undefined && r.code !== null && r.code !== "";
    const hasValue = r.value !== undefined && r.value !== null && r.value !== "";
    if (hasCode === hasValue) { results.push({ i, status: "error", detail: hasCode ? "carries both code and value" : "carries neither code nor value" }); continue; }
    if (closed && !hasCode) { results.push({ i, status: "error", detail: `codebook ${cbk.codebook_id} is closed; a code is required` }); continue; }
    if (!closed && !hasValue) { results.push({ i, status: "error", detail: `codebook ${cbk.codebook_id} is open; a value is required` }); continue; }
    if (closed && !(cbk.codes || []).some((cd) => cd && cd.code === r.code)) {
      results.push({ i, status: "error", detail: `code ${JSON.stringify(r.code)} is not in codebook ${cbk.codebook_id}` });
      continue;
    }
    const resolver = { extraction: model.extById, source: model.sourceById, representation: model.repById }[t.kind];
    if (!resolver || !resolver.has(t.id)) { results.push({ i, status: "error", detail: `target ${t.kind} ${t.id} does not resolve` }); continue; }

    const cod = {
      codebook_ref: r.codebook_ref,
      ...(hasCode ? { code: r.code } : { value: r.value }),
      target: { kind: t.kind, id: t.id },
      coder: r.coder,
      status: "active",
      ...(cbk.revision ? { codebook_revision: cbk.revision } : {}),
      ...(cbk.revision_digest ? { codebook_revision_digest: cbk.revision_digest } : {}),
      ...(r.confidence ? { confidence: r.confidence } : {}),
      ...(r.confidence_score != null ? { confidence_score: r.confidence_score } : {}),
      ...(r.rationale ? { rationale: r.rationale } : {}),
      ...(r.query || opts.query ? { query: r.query || opts.query } : {}),
      provenance: r.provenance || {
        produced_by: { tool: opts.tool || "upc", method: opts.method || "model", ...(opts.model ? { model: opts.model } : {}), ...(opts.promptVersion ? { prompt_version: opts.promptVersion } : {}) },
        created_at: nowStamp(),
        derived_from: t.kind === "extraction" ? { extraction_ids: [t.id] } : t.kind === "source" ? { source_ids: [t.id] } : { representation_refs: [t.id] },
      },
    };
    cod.coding_id = U.mintCodId(cod);
    coders.add(r.coder);

    if (byId.has(cod.coding_id)) {
      // Same judgement, same rater: the id is stable by construction, so refresh the
      // mutable fields in place rather than writing a second record. This is what
      // makes re-running an unchanged coding pass idempotent.
      const existingRec = byId.get(cod.coding_id);
      const keepProv = existingRec.provenance;
      Object.assign(existingRec, cod);
      existingRec.provenance = keepProv;
      existingRec.status = "active";
      results.push({ i, status: "unchanged", coding_id: cod.coding_id });
      continue;
    }
    // A DIFFERENT answer from the same rater about the same target supersedes the old
    // one (spec/03's lifecycle, reused) rather than mutating a content-addressed id.
    for (const o of prior) {
      if ((o.status || "active") !== "active") continue;
      if (o.codebook_ref !== cod.codebook_ref || o.coder !== cod.coder) continue;
      if (!o.target || o.target.id !== t.id || o.target.kind !== t.kind) continue;
      if (cbk.multi_label === true) continue;
      o.status = "superseded";
      o.superseded_by = cod.coding_id;
      cod.supersedes = o.coding_id;
    }
    fresh.push(cod);
    byId.set(cod.coding_id, cod);
    results.push({ i, status: "coded", coding_id: cod.coding_id, ...(cod.supersedes ? { supersedes: cod.supersedes } : {}) });
  }

  // A run in which nothing landed must leave nothing behind: a set manifest with
  // an empty `coders` violates its own schema (minItems 1) and would make an
  // otherwise clean corpus fail validation because of a failed command.
  if (!opts.dryRun && !fresh.length && !prior.length && !fs.existsSync(manAbs)) {
    const tally0 = {};
    for (const r of results) tally0[r.status] = (tally0[r.status] || 0) + 1;
    return { status: "ok", set: setId, wrote: 0, tally: tally0, results };
  }

  if (!opts.dryRun) {
    ensureSection(loaded, "codings", base);
    fs.mkdirSync(path.dirname(itemsAbs), { recursive: true });
    let man = fs.existsSync(manAbs) ? U.readJSON(manAbs) : null;
    if (!man) {
      man = { set_id: setId, title: opts.title || setId, ...(opts.query ? { query: opts.query } : {}), items_path: itemsRel, codebook_refs: [], coders: [],
        provenance: { produced_by: { tool: opts.tool || "upc", method: opts.method || "model" }, created_at: nowStamp() } };
    }
    man.items_path = itemsRel;
    const refs = new Set(man.codebook_refs || []);
    for (const c of prior.concat(fresh)) if (c.codebook_ref) refs.add(c.codebook_ref);
    man.codebook_refs = [...refs].sort();
    const declared = new Map((man.coders || []).map((c) => [c.coder, c]));
    for (const c of coders) {
      if (!declared.has(c)) declared.set(c, { coder: c, kind: opts.coderKind || "model", ...(opts.model ? { model: opts.model } : {}), ...(opts.promptVersion ? { prompt_version: opts.promptVersion } : {}), ...(opts.tool ? { tool: opts.tool } : {}) });
    }
    man.coders = [...declared.values()];
    U.atomicWriteFile(manAbs, JSON.stringify(man, null, 2) + "\n");
    U.atomicWriteFile(itemsAbs, prior.concat(fresh).map((o) => JSON.stringify(o)).join("\n") + "\n");
    if (fresh.length) {
      appendEvent(loaded, {
        activity_type: "generate", tool: opts.tool || "upc", started_at: nowStamp(), status: "success",
        outputs: { coding_ids: fresh.map((c) => c.coding_id) },
        notes: `coded ${fresh.length} judgement(s) into ${setId}`,
      });
    }
  }

  const tally = {};
  for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
  return { status: "ok", set: setId, wrote: opts.dryRun ? 0 : fresh.length, tally, results };
}

/** upc codebook — read-only inspection of the coding schemes in a corpus. */
function codebookCmd(root, id) {
  const loaded = U.loadCorpus(root);
  const model = buildModel(loaded);
  const used = new Map();
  for (const c of loaded.codings || []) {
    const k = c.obj.codebook_ref + " " + (c.obj.code !== undefined ? c.obj.code : "");
    used.set(k, (used.get(k) || 0) + 1);
  }
  if (id) {
    const o = model.cbkById.get(id);
    if (!o) throw new Error(`no codebook ${id}`);
    return { ...o, codes: (o.codes || []).map((cd) => ({ ...cd, applied: used.get(o.codebook_id + " " + cd.code) || 0 })) };
  }
  return {
    status: "ok",
    codebooks: (loaded.codebooks || []).map((c) => ({
      codebook_id: c.obj.codebook_id, namespace: c.obj.namespace, slug: c.obj.slug, title: c.obj.title,
      closed: c.obj.closed !== false, unit: c.obj.unit, codes: (c.obj.codes || []).length,
      codings: (loaded.codings || []).filter((x) => x.obj.codebook_ref === c.obj.codebook_id).length,
    })),
  };
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
        process.exitCode = rep.status === "failed" ? 1 : 0;
        break;
        break;
      }
      case "verify-quotes": {
        const file = rest.find((a) => !a.startsWith("--") && a !== arg(rest, "--corpus"));
        const corpus = arg(rest, "--corpus");
        if (!file || !corpus) { process.stderr.write("usage: upc verify-quotes <file> --corpus <dir> [--strict]\n"); process.exit(2); }
        const rep = verifyQuotesFile(file, corpus, { strict });
        print(rep);
        process.exitCode = rep.status === "failed" ? 1 : 0;
        break;
        break;
      }
      case "verify": {
        const id = rest.find((a) => a.startsWith("ext-"));
        const corpus = arg(rest, "--corpus");
        if (!id || !corpus) { process.stderr.write("usage: upc verify <ext-id> --corpus <dir>\n"); process.exit(2); }
        const rep = verifyExtractionCmd(id, corpus);
        print(rep);
        process.exitCode = rep.verified === false || rep.status === "failed" ? 1 : 0;
        break;
        break;
      }

      case "locate": {
        const corpus = arg(rest, "--corpus");
        const id = rest.find((a) => a.startsWith("ext-"));
        if (!id || !corpus) { process.stderr.write("usage: upc locate <ext-id> --corpus <dir> [--format json|web-annotation] [--context <n>]\n"); process.exit(2); }
        const fmt = arg(rest, "--format") || "json";
        if (fmt !== "json" && fmt !== "web-annotation") { process.stderr.write(`unknown --format ${fmt} (expected json|web-annotation)\n`); process.exit(2); }
        const ctxRaw = arg(rest, "--context");
        const ctx = ctxRaw === undefined ? undefined : Number(ctxRaw);
        if (ctxRaw !== undefined && !(Number.isInteger(ctx) && ctx >= 0)) { process.stderr.write("--context must be a non-negative integer\n"); process.exit(2); }
        const out = locateCmd(id, corpus, { format: fmt, context: ctx });
        print(out);
        process.exitCode = out && out.status === "failed" ? 1 : 0;
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
        // A positional is any token that is neither a flag nor a flag's value. The
        // older "not the --format value and not the -o value" test was enough when
        // export had two options; with --into/--strip/--profile it would happily
        // read a flag's argument as the corpus directory.
        const VALUE_FLAGS = new Set(["--format", "-o", "--into", "--profile", "--strip",
          "--frontmatter", "--filenames", "--image-names", "--domain", "--matrix", "--files"]);
        const dir = rest.find((a, i) => !a.startsWith("-") && !(i > 0 && VALUE_FLAGS.has(rest[i - 1])));
        const format = arg(rest, "--format");
        const out = arg(rest, "-o");
        if (!dir || !format) { process.stderr.write("usage: upc export <dir> --format bibtex|ris|csl-json|jsonl|markdown|ro-crate|prov|obsidian|site|site-one [-o <dir|file>] [--copy] [--bundle] [--single-file] [--no-text] [--matrix <a>:<b>]\n"); process.exit(2); }
        if (format === "site-one" || (format === "site" && rest.includes("--single-file"))) {
          const mx = arg(rest, "--matrix");
          const filesArg = arg(rest, "--files");
          print(writeSingleFile(dir, {
            out, matrix: mx ? mx.split(":") : null, withText: !rest.includes("--no-text"),
            // --bundle puts the PDFs in a folder named after the file
            files: filesArg || (rest.includes("--bundle")
              ? path.basename(out || "corpus.html").replace(/\.html?$/i, "") + "_files" : null),
          }));
          break;
        }
        if (format === "site") {
          const mx = arg(rest, "--matrix");
          print(writeSite(dir, {
            out, bundle: rest.includes("--bundle"), allCodes: rest.includes("--all-codes"),
            matrix: mx ? mx.split(":") : null,
          }));
          break;
        }
        if (format === "ro-crate") {
          print(writeRoCrate(dir, { outDir: out, copy: rest.includes("--copy") }));
          break;
        }
        if (format === "obsidian") {
          const res = writeVault(dir, {
            outDir: out,
            into: arg(rest, "--into"),
            profileFile: arg(rest, "--profile"),
            strip: arg(rest, "--strip"),
            frontmatter: arg(rest, "--frontmatter"),
            filenames: arg(rest, "--filenames"),
            imageNames: arg(rest, "--image-names"),
            domain: arg(rest, "--domain"),
            allowRewriteBody: rest.includes("--allow-rewrite-body"),
            force: rest.includes("--force"),
          });
          // A vault is hundreds of files, so the CLI prints a summary and the
          // paths only when they are few enough to read; writeVault still returns
          // the full lists to a programmatic caller.
          const brief = Object.assign({}, res);
          if (res.wrote.length > 25) { brief.wrote = res.wrote.length; brief.wrote_sample = res.wrote.slice(0, 10); }
          if (res.warnings.length > 25) { brief.warnings = res.warnings.length; brief.warnings_sample = res.warnings.slice(0, 10); }
          print(brief);
          // A skipped file is a real outcome a caller must be able to branch on: the
          // vault is now only partly the corpus's projection. Set exitCode rather
          // than calling process.exit(), which discards buffered stdout on a pipe.
          if (res.status === "partial") process.exitCode = 1;
          break;
        }
        const text = exportCmd(dir, format);
        if (out) { U.atomicWriteFile(path.resolve(out), text); print({ status: "ok", wrote: out }); } else process.stdout.write(text);
        break;
      }
      case "mint": {
        const batch = rest.includes("--batch");
        const kind = rest.filter((a) => !a.startsWith("--"))[0];
        const stdin = fs.readFileSync(0, "utf8");
        if (batch) { for (const r of mintBatchCmd(kind, stdin)) process.stdout.write(JSON.stringify(r) + "\n"); }
        else print(mintCmd(kind, stdin));
        break;
      }
      case "add": {
        const ADD_VALUE_FLAGS = new Set(["--corpus", "--output", "--tool"]);
        const kind = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && ADD_VALUE_FLAGS.has(rest[i - 1])))[0];
        const corpus = arg(rest, "--corpus");
        if (!corpus || (kind !== "source" && kind !== "synthesis")) {
          process.stderr.write("usage: upc add source --corpus <dir> [--batch] [--hardlink] [--tool <t>] [--dry-run] < source.json\n"
            + "       upc add synthesis --corpus <dir> --output <file.md> [--tool <t>] [--allow-unverified] [--dry-run] < synthesis.json\n");
          process.exit(2);
        }
        const stdin = fs.readFileSync(0, "utf8");
        if (kind === "synthesis") {
          const out = addSynthesisCmd(corpus, JSON.parse(stdin), {
            output: arg(rest, "--output"), tool: arg(rest, "--tool"),
            allowUnverified: rest.includes("--allow-unverified"), dryRun: rest.includes("--dry-run"),
          });
          print(out);
          process.exitCode = out.status === "refused" ? 1 : 0;
          break;
        }
        const recs = rest.includes("--batch") ? readJsonlText(stdin) : [JSON.parse(stdin)];
        const out = addSourceCmd(corpus, recs, {
          tool: arg(rest, "--tool"), hardlink: rest.includes("--hardlink"), dryRun: rest.includes("--dry-run"),
        });
        print(out);
        process.exitCode = out.tally.error ? 1 : 0;
        break;
      }
      case "event": {
        // Append one activity to the journal. A tool that derives something from
        // the corpus — an index, an export, a conversion — can say so without
        // reimplementing the journal's numbering or its atomic write.
        const corpus = arg(rest, "--corpus");
        if (!corpus) { process.stderr.write("usage: upc event --corpus <dir> < event.json\n"); process.exit(2); }
        const ev = JSON.parse(fs.readFileSync(0, "utf8"));
        if (!ev.activity_type) { process.stderr.write("event: activity_type is required\n"); process.exit(2); }
        const loaded = U.loadCorpus(corpus);
        const id = appendEvent(loaded, {
          started_at: nowStamp(), status: "success", ...ev,
        });
        print({ status: id ? "ok" : "error", event_id: id });
        break;
      }
      case "anchor": {
        const corpus = arg(rest, "--corpus");
        const repId = arg(rest, "--rep");
        if (!corpus || !repId) { process.stderr.write("usage: upc anchor --corpus <dir> --rep <rep-id> [--set <id>] [--type <t>] [--query <q>] [--tool <t>] [--model <m>] [--normalize] [--dry-run] < candidates.jsonl\n"); process.exit(2); }
        const cands = readJsonlText(fs.readFileSync(0, "utf8"));
        const out = anchorCmd(corpus, repId, cands, {
          set: arg(rest, "--set"), type: arg(rest, "--type"), query: arg(rest, "--query"),
          tool: arg(rest, "--tool"), model: arg(rest, "--model"), promptVersion: arg(rest, "--prompt-version"),
          normalize: rest.includes("--normalize"),
          dryRun: rest.includes("--dry-run"),
        });
        print(out);
        break;
      }
      case "code": {
        const corpus = arg(rest, "--corpus");
        const set = arg(rest, "--set");
        if (!corpus || !set) { process.stderr.write("usage: upc code --corpus <dir> --set <cds-id> [--coder-kind model|human] [--tool <t>] [--model <m>] [--dry-run] < codings.jsonl\n"); process.exit(2); }
        const recs = readJsonlText(fs.readFileSync(0, "utf8"));
        const out = codeCmd(corpus, set, recs, {
          query: arg(rest, "--query"), tool: arg(rest, "--tool"), model: arg(rest, "--model"),
          method: arg(rest, "--method"), coderKind: arg(rest, "--coder-kind"), promptVersion: arg(rest, "--prompt-version"),
          dryRun: rest.includes("--dry-run"),
        });
        print(out);
        process.exitCode = Object.keys(out.tally).some((k) => k === "error" || k === "invalid") ? 1 : 0;
        break;
      }
      case "codebook": {
        const corpus = arg(rest, "--corpus") || rest.find((a) => !a.startsWith("--") && !a.startsWith("cbk-"));
        const id = rest.find((a) => a.startsWith("cbk-"));
        if (!corpus) { process.stderr.write("usage: upc codebook <dir> [<cbk-id>]\n"); process.exit(2); }
        print(codebookCmd(corpus, id));
        break;
      }
      case "batch": {
        const corpus = arg(rest, "--corpus") || rest.find((a) => !a.startsWith("--"));
        if (!corpus) { process.stderr.write("usage: upc batch --corpus <dir> < commands.ndjson\n"); process.exit(2); }
        for (const r of batchCmd(corpus, fs.readFileSync(0, "utf8"))) process.stdout.write(JSON.stringify(r) + "\n");
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
      case "version": {
        const info = { spec_version: specVersion(), schema_hash: computeSchemaHash(), commands: COMMANDS, node: process.version };
        if (rest.includes("--json")) print(info);
        else print(`upc ${info.spec_version}\n${info.schema_hash || "(schemas not found)"}\n`);
        break;
      }
      case "check-compat": {
        const requires = arg(rest, "--requires");
        if (!requires) { process.stderr.write('usage: upc check-compat --requires "^1.6" [--schema-hash <sha256:...>]\n'); process.exit(2); }
        const version = specVersion();
        const { ok, reason } = satisfiesRequirement(version, requires);
        const wantHash = arg(rest, "--schema-hash");
        const gotHash = computeSchemaHash();
        const hashOk = wantHash === undefined ? null : wantHash === gotHash;
        const out = { status: ok && hashOk !== false ? "ok" : "incompatible", spec_version: version, requires, reason, schema_hash: gotHash };
        if (hashOk !== null) { out.schema_hash_expected = wantHash; out.schema_hash_match = hashOk; }
        print(out);
        process.exit(out.status === "ok" ? 0 : 1);
      }
      default:
        process.stderr.write(`UPC ${specVersion()} — commands: ${COMMANDS.join(", ")}\n`);
        process.exit(cmd ? 2 : 0);
    }
  } catch (e) {
    print({ status: "error", detail: e.message });
    process.exit(2);
  }
}

// Exports for thin wrappers / tests; only run the CLI when invoked directly.
// (validateCorpus is already exported at its declaration.)
export { verifyQuotesFile, verifyExtractionCmd, quoteCmd, locateCmd, regenCmd, exportCmd, mintCmd, mintBatchCmd, anchorCmd, codeCmd, codebookCmd, batchCmd, addSourceCmd, addSynthesisCmd, appendEvent, ensureSection, reanchorCmd, buildModel, sourcesCsv, extractionsCsv, computeSchemaHash, specVersion, satisfiesRequirement, COMMANDS };

const _isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (_isDirect) main();
