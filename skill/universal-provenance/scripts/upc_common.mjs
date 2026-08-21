// UPC common helpers (spec 1.2.0): hashing & content-addressed id minting,
// canonical JSON (JCS / RFC 8785), codepoint-exact quote gates, marker parsing,
// URL normalization, slugs, atomic writes, RFC 4180 CSV, a dependency-free JSON
// Schema (2020-12 subset) validator, and a corpus loader that resolves manifests.
//
// Zero dependencies, Node >= 18 (node:crypto, node:fs, node:path; global URL,
// TextDecoder). The spec is normative; this file implements it.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Hashing (spec/06)
// ---------------------------------------------------------------------------

export function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function sha256File(absPath) {
  return sha256Hex(fs.readFileSync(absPath));
}

/** Strip an optional "sha256:" prefix and lowercase. */
export function bareHash(h) {
  return String(h || "").replace(/^sha256:/i, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Canonical JSON — JCS, RFC 8785 (spec/06). Used for id keys, input digests,
// and schema_hash. Objects: keys sorted by UTF-16 code unit; no whitespace;
// strings minimally escaped; integers as plain decimals.
// ---------------------------------------------------------------------------

function jcsString(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (cp === 0x08) out += "\\b";
    else if (cp === 0x09) out += "\\t";
    else if (cp === 0x0a) out += "\\n";
    else if (cp === 0x0c) out += "\\f";
    else if (cp === 0x0d) out += "\\r";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

function jcsNumber(n) {
  if (!Number.isFinite(n)) throw new Error("JCS: non-finite number");
  // UPC id keys use only integers; integers serialize as plain decimals.
  // Non-integers use the shortest round-tripping form (V8 String()).
  return String(n === 0 ? 0 : n);
}

export function jcs(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return jcsNumber(value);
  if (t === "string") return jcsString(value);
  if (Array.isArray(value)) return "[" + value.map(jcs).join(",") + "]";
  if (t === "object") {
    const keys = Object.keys(value).sort(); // JS default sort = UTF-16 code unit
    return "{" + keys.map((k) => jcsString(k) + ":" + jcs(value[k])).join(",") + "}";
  }
  throw new Error("JCS: unsupported value type " + t);
}

// ---------------------------------------------------------------------------
// Codepoint helpers (spec/03). char_range counts Unicode codepoints.
// ---------------------------------------------------------------------------

/** Unicode codepoint array of a string (NOT UTF-16 units). */
export function codepoints(str) {
  return Array.from(str);
}

export function codepointLength(str) {
  return Array.from(str).length;
}

/** codepoints(str)[start:end] as a string. */
export function codepointSlice(str, start, end) {
  return Array.from(str).slice(start, end).join("");
}

/** Strict UTF-8 decode; returns {ok, text}. Does not replace invalid bytes. */
export function decodeUtf8Strict(bytes) {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, text: null };
  }
}

// ---------------------------------------------------------------------------
// Line derivation (spec/03). UPC line numbers are 1-based and INCLUSIVE, over
// the same codepoint sequence char_range indexes. A line break is "\n"; a CRLF
// file therefore numbers identically to an LF one (the "\r" is just a codepoint
// on the preceding line). Advisory only: line_range never gates a quotation.
// ---------------------------------------------------------------------------

function lineAtCp(cps, cpOffset) {
  const n = Math.max(0, Math.min(cpOffset, cps.length));
  let line = 1;
  for (let i = 0; i < n; i++) if (cps[i] === "\n") line++;
  return line;
}

/** 1-based line number containing the codepoint at `cpOffset`. */
export function charToLine(text, cpOffset) {
  return lineAtCp(Array.from(text), cpOffset);
}

/** The 1-based, inclusive {start,end} line span covered by codepoints [start,end). */
export function lineRangeForCharRange(text, start, end) {
  const cps = Array.from(text);
  const s = Math.max(0, Math.min(start, cps.length));
  const e = Math.max(s, Math.min(end, cps.length));
  // the last codepoint actually inside the span (empty span => its start line)
  const lastInside = e > s ? e - 1 : s;
  return { start: lineAtCp(cps, s), end: lineAtCp(cps, lastInside) };
}

/** Codepoints of context shown on each side of a resolved span by default. */
export const DEFAULT_CONTEXT = 90;

/** The lines of a text, dropping the empty element a trailing newline produces,
 *  so "a\nb\n" is two lines. Indexed 1-based by line_range. */
export function textLines(text) {
  const lines = String(text == null ? "" : text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// Content-addressed id minting (spec/06). id = prefix + first 12 hex of
// sha256(UTF-8 key). Rep/img ids are the file byte hash (no key string).
// ---------------------------------------------------------------------------

/** Short typed content id: prefix + first 12 hex of sha256(key). */
export function shortId(prefix, key) {
  return prefix + sha256Hex(Buffer.from(key, "utf8")).slice(0, 12);
}

export function mintRepId(bytes) {
  return "rep-" + sha256Hex(bytes).slice(0, 12);
}

export function mintImgId(bytes) {
  return "img-" + sha256Hex(bytes).slice(0, 12);
}

/** src- id from a canonical URL, or from primary bytes when there is no URL. */
export function mintSrcId({ canonicalUrl, primaryBytesSha256 }) {
  if (canonicalUrl) return shortId("src-", "src\n" + canonicalUrl);
  return shortId("src-", "src\nsha256:" + bareHash(primaryBytesSha256));
}

/** The identity locator: exactly {type, representation_ref, value}. */
function canonicalLocator(loc) {
  return { type: loc.type, representation_ref: loc.representation_ref, value: loc.value };
}

/** The ext- text component Q: exact direct_quote if present, else text. */
export function extractionQ(ext) {
  return ext.direct_quote != null ? ext.direct_quote : ext.text != null ? ext.text : "";
}

export function mintExtId(ext) {
  const key =
    "ext\n" +
    ext.source_id +
    "\n" +
    ext.representation_ref +
    "\n" +
    jcs(canonicalLocator(ext.locator)) +
    "\n" +
    extractionQ(ext);
  return shortId("ext-", key);
}

/** All derived_from ids flattened and sorted (for gen-/syn- keys). */
export function collectInputIds(derivedFrom) {
  const df = derivedFrom || {};
  const ids = [].concat(
    df.source_ids || [],
    df.representation_refs || [],
    df.extraction_ids || [],
    df.generation_ids || [],
    df.synthesis_ids || []
  );
  return ids.slice().sort();
}

export function mintGenId(gen) {
  const ids = collectInputIds(gen.provenance && gen.provenance.derived_from);
  const digest = gen.provenance && gen.provenance.input_digest ? gen.provenance.input_digest : "";
  return shortId("gen-", "gen\n" + gen.type + "\n" + jcs(ids) + "\n" + digest);
}

/**
 * cbk-<12hex> over (namespace, slug) ONLY — deliberately not over codes[] (spec/06, spec/12).
 * A controlled vocabulary must keep a stable identity while its contents evolve; hashing the
 * code list would dangle every codebook_ref on every edit. Same reasoning as src-, which is
 * addressed over the canonical URL rather than the page bytes.
 */
export function mintCbkId(cbk) {
  return shortId("cbk-", "cbk\n" + (cbk.namespace || "") + "\n" + (cbk.slug || ""));
}

/**
 * cod-<12hex> over (codebook_ref, target.kind, target.id, coder, {code}|{value}) (spec/06, spec/12).
 * What is excluded is load-bearing: created_at, confidence, rationale, query and status are all
 * out, so re-running an unchanged coding pass is idempotent; `coder` is in, so two raters who
 * agree still produce two records and inter-rater agreement stays computable.
 */
export function mintCodId(cod) {
  const t = cod.target || {};
  const label = cod.code !== undefined && cod.code !== null && cod.code !== ""
    ? { code: cod.code }
    : { value: cod.value };
  const key =
    "cod\n" + (cod.codebook_ref || "") +
    "\n" + (t.kind || "") +
    "\n" + (t.id || "") +
    "\n" + (cod.coder || "") +
    "\n" + jcs(label);
  return shortId("cod-", key);
}

/** "sha256:" + sha256(JCS(codes)) — the advisory codebook revision digest (spec/12). */
export function codebookRevisionDigest(codes) {
  return "sha256:" + sha256Hex(Buffer.from(jcs(codes || []), "utf8"));
}

export function mintSynId(syn) {
  const ids = collectInputIds(syn.provenance && syn.provenance.derived_from);
  return shortId("syn-", "syn\n" + syn.type + "\n" + (syn.question || "") + "\n" + jcs(ids));
}

/** input_digest (spec/07): single input = its byte hash; multi = JCS manifest. */
export function computeInputDigest(inputs) {
  // inputs: [{id, sha256}] where sha256 is hex (with or without prefix).
  const norm = inputs.map((i) => ({ id: i.id, sha256: "sha256:" + bareHash(i.sha256) }));
  if (norm.length === 1) return norm[0].sha256;
  norm.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return "sha256:" + sha256Hex(Buffer.from(jcs({ inputs: norm }), "utf8"));
}

// ---------------------------------------------------------------------------
// URL normalization (spec/06), closed and deterministic.
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = new Set([
  "gclid", "fbclid", "msclkid", "twclid", "igshid",
  "mc_cid", "mc_eid", "wbraid", "gbraid",
]);

function normalizePercent(s) {
  return s.replace(/%[0-9A-Fa-f]{2}/g, (m) => {
    const c = parseInt(m.slice(1), 16);
    const ch = String.fromCharCode(c);
    if (/[A-Za-z0-9\-._~]/.test(ch)) return ch; // decode unreserved (RFC 3986 §6.2.2.2)
    return "%" + m.slice(1).toUpperCase();
  });
}

export function canonicalUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  // scheme+host lowercased & IDN->punycode & default port dropped by WHATWG URL.
  let pathname = normalizePercent(u.pathname);
  if (pathname !== "/" && pathname.endsWith("/")) pathname = pathname.replace(/\/+$/, "") || "/";
  const rawQuery = u.search.replace(/^\?/, "");
  let tokens = rawQuery ? rawQuery.split("&") : [];
  tokens = tokens.filter((tok) => {
    const k = decodeURIComponent((tok.split("=")[0] || "")).toLowerCase();
    return !(k.startsWith("utm_") || TRACKING_PARAMS.has(k));
  });
  tokens.sort(); // bytewise by raw token (key then value)
  const query = tokens.join("&");
  return u.protocol + "//" + u.host + pathname + (query ? "?" + query : "");
}

// ---------------------------------------------------------------------------
// Slugs (spec/06 / spec/10).
// ---------------------------------------------------------------------------

const WIN_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export function slugify(basis) {
  let s = String(basis || "").normalize("NFKD").replace(/\p{Mn}/gu, "");
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > 60) s = s.slice(0, 60).replace(/-+$/, "");
  if (!s) s = "untitled";
  return s;
}

/** slugify with collision + reserved-name suffix from the source id. */
export function slugifyWithCollision(basis, sourceId, existingLowerSet) {
  const base = slugify(basis);
  const idHex = String(sourceId || "").replace(/^[a-z]+-/, "");
  const taken = (s) => existingLowerSet && existingLowerSet.has(s.toLowerCase());
  if (!taken(base) && !WIN_RESERVED.has(base)) return base;
  const s6 = base + "--" + idHex.slice(0, 6);
  if (!taken(s6)) return s6;
  return base + "--" + idHex.slice(0, 12);
}

/** Portable-filename check (spec/10). Returns {ok, reason}. */
export function checkFilename(relPath) {
  if (relPath == null || relPath === "") return { ok: false, reason: "empty path" };
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) return { ok: false, reason: "absolute path" };
  if (relPath.includes("\\")) return { ok: false, reason: "backslash separator" };
  const segs = relPath.split("/");
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return { ok: false, reason: ".. segment" };
    if (/[ -<>:"|?*]/.test(seg)) return { ok: false, reason: "forbidden character in '" + seg + "'" };
    if (/[ .]$/.test(seg)) return { ok: false, reason: "trailing dot/space in '" + seg + "'" };
    const bare = seg.replace(/\.[^.]*$/, "").toLowerCase();
    if (WIN_RESERVED.has(bare)) return { ok: false, reason: "reserved name '" + seg + "'" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Atomic write (spec/10): same-dir temp + fsync + rename.
// ---------------------------------------------------------------------------

export function atomicWriteFile(absPath, data) {
  const dir = path.dirname(absPath);
  const tmp = path.join(
    dir,
    "." + path.basename(absPath) + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp"
  );
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, absPath);
  try {
    const dfd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dfd); } catch {}
    fs.closeSync(dfd);
  } catch {}
}

// ---------------------------------------------------------------------------
// File readers, incl. tolerant JSONL (spec/10).
// ---------------------------------------------------------------------------

export function readJSON(absPath) {
  return JSON.parse(fs.readFileSync(absPath, "utf8"));
}

/** Tolerant JSONL reader. Returns {records, warnings, errors}. A torn FINAL
 *  line (no trailing LF) is a warning (jsonl_torn_tail); a malformed interior
 *  line is an error (jsonl_invalid). */
export function readJSONLSafe(absPath) {
  const text = fs.readFileSync(absPath, "utf8");
  const endsWithLF = text.endsWith("\n");
  const lines = text.split("\n");
  const records = [], warnings = [], errors = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const restBlank = lines.slice(i + 1).every((l) => l.trim() === "");
    try {
      records.push(JSON.parse(t));
    } catch (e) {
      if (restBlank && !endsWithLF) {
        warnings.push({ code: "jsonl_torn_tail", file: absPath, line: i + 1, detail: e.message });
      } else {
        errors.push({ code: "jsonl_invalid", file: absPath, line: i + 1, detail: e.message });
      }
    }
  }
  return { records, warnings, errors };
}

/** Strict JSONL (throws on any bad line) — for simple callers/tests. */
export function readJSONL(absPath) {
  const { records, warnings, errors } = readJSONLSafe(absPath);
  if (errors.length) throw new Error(`Invalid JSONL at ${errors[0].file}:${errors[0].line}: ${errors[0].detail}`);
  void warnings;
  return records;
}

// ---------------------------------------------------------------------------
// Representation text cache (fixes O(extractions × filesize)).
// ---------------------------------------------------------------------------

const _repCache = new Map();

/** Cached read of a representation file: {bytes, sha256, utf8ok, text, cps}. */
export function getRepFile(absPath) {
  if (_repCache.has(absPath)) return _repCache.get(absPath);
  const bytes = fs.readFileSync(absPath);
  const dec = decodeUtf8Strict(bytes);
  const rec = {
    bytes,
    sha256: sha256Hex(bytes),
    utf8ok: dec.ok,
    text: dec.text,
    cps: dec.ok ? Array.from(dec.text) : null,
  };
  _repCache.set(absPath, rec);
  return rec;
}

export function clearRepCache() {
  _repCache.clear();
}

// ---------------------------------------------------------------------------
// The quote gates (spec/03 hop B, spec/04 hop C). Dumb equality, no
// normalization.
// ---------------------------------------------------------------------------

export function exactEquals(a, b) {
  return a === b;
}

/** Media types that can carry a verified quotation: bytes that ARE text (spec/02). */
export function isTextualMedia(mt) {
  return /^text\//.test(mt || "") || mt === "application/json" || mt === "application/xml";
}

/** Is this representation role a DERIVED text (transcript / OCR) rather than the
 *  captured source text? Role-only check; prefer isDerivedText when the corpus is
 *  available, because the role name alone cannot see a text layer pulled out of a
 *  PDF (spec/05 trust boundary, spec/09 badge). */
export function isTranscriptRole(role) {
  return role === "transcript" || role === "ocr_pdf" || /ocr/.test(role || "");
}

/** Does a quotation against this representation land on the §05 trust boundary?
 *
 *  The boundary is not a naming convention, it is a question about bytes: the
 *  quote gate is byte-exact, and bytes only exist for text. So a textual
 *  representation is DERIVED text whenever the bytes it came from were not
 *  themselves text — an OCR of an image, a transcript of audio, a text layer
 *  pulled out of a PDF. Each of those steps is inference, not equality.
 *
 *  A text-to-text conversion (raw HTML -> cleaned Markdown) is NOT on the
 *  boundary: §11 counts that as "exact in the cleaned representation".
 *
 *  `lookupRep(id)` resolves a representation_ref to its record, or null. */
/**
 * A textual representation is MODEL-REWRITTEN when a model produced it from another
 * textual representation (spec/05, spec/09). Rewriting is inference, exactly like OCR
 * or transcription: the model may silently normalise, correct or re-word its parent,
 * so a quotation gated against it is verified TO THE REWRITE and not to the source.
 * Deciding this from `produced_by` rather than from the role name is the whole point —
 * a model-cleaned Markdown carries the same `clean_markdown` role as a deterministic
 * conversion, and only the derivation tells them apart.
 */
export function isModelRewrittenText(repObj, lookupRep) {
  if (!repObj) return false;
  const method =
    (repObj.produced_by && (repObj.produced_by.method || repObj.produced_by)) ||
    (repObj.provenance && repObj.provenance.produced_by && repObj.provenance.produced_by.method) ||
    null;
  if (method !== "model") return false;
  const parentRef = repObj.parent_representation_ref;
  if (!parentRef || typeof lookupRep !== "function") return false;
  const parent = lookupRep(parentRef);
  // Only a text->text rewrite lands here; a model reading a non-textual parent is
  // already covered by isDerivedText (transcription / vision), which badges first.
  return !!(parent && isTextualMedia(parent.media_type));
}

export function isDerivedText(repObj, lookupRep) {
  if (!repObj) return false;
  if (isTranscriptRole(repObj.role)) return true;
  const parentRef = repObj.parent_representation_ref;
  if (!parentRef || typeof lookupRep !== "function") return false;
  const parent = lookupRep(parentRef);
  return !!(parent && !isTextualMedia(parent.media_type));
}

/** Hop B for one extraction against an already-decoded representation.
 *  repRec is a getRepFile() record. Returns {ok, code, detail, hint}. */
export function verifyHopB(ext, repRec) {
  if (!repRec.utf8ok) return { ok: false, code: "invalid_utf8", detail: "representation is not valid UTF-8" };
  const loc = ext.locator || {};
  if (loc.type !== "char_range") return { ok: false, code: "quote_locator_missing", detail: "direct_quote requires a char_range locator" };
  const v = loc.value || {};
  const start = v.start, end = v.end, len = repRec.cps.length;
  if (!(Number.isInteger(start) && Number.isInteger(end) && 0 <= start && start <= end && end <= len)) {
    return { ok: false, code: "locator_range_invalid", detail: `range [${start},${end}] invalid for length ${len}` };
  }
  const span = repRec.cps.slice(start, end).join("");
  if (span === ext.direct_quote) return { ok: true };
  // Repair hint: does the quote occur byte-exactly elsewhere?
  const whole = repRec.text;
  const idx = whole.indexOf(ext.direct_quote);
  let hint;
  if (idx >= 0) {
    const cpStart = codepointLength(whole.slice(0, idx));
    hint = `quote occurs byte-exact at codepoint [${cpStart},${cpStart + codepointLength(ext.direct_quote)}] — offset drift; run \`upc reanchor ${ext.extraction_id}\``;
  } else {
    hint = "quote not present in representation — representation rewritten or quote fabricated";
  }
  return { ok: false, code: "quote_gate_failed", detail: `codepoints[${start}:${end}] != direct_quote`, hint };
}

/** Parse citation markers from output text (spec/04). Returns
 *  [{quote, extId, form}]. Block form first; inline on the remainder. */
export function parseQuoteMarkers(text) {
  const markers = [];
  const blockRe = /^(`{3,})quote (ext-[0-9a-f]{12})[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm;
  let masked = text;
  let m;
  const spans = [];
  while ((m = blockRe.exec(text)) !== null) {
    markers.push({ quote: m[3], extId: m[2], form: "block" });
    spans.push([m.index, m.index + m[0].length]);
  }
  // Mask block spans so inline scan doesn't re-match inside a block body.
  if (spans.length) {
    let out = "", pos = 0;
    for (const [s, e] of spans) {
      out += masked.slice(pos, s) + " ".repeat(e - s);
      pos = e;
    }
    out += masked.slice(pos);
    masked = out;
  }
  const inlineRe = /"([^"\n]+)"\s?\[(ext-[0-9a-f]{12})\]/g;
  while ((m = inlineRe.exec(masked)) !== null) {
    markers.push({ quote: m[1], extId: m[2], form: "inline" });
  }
  return markers;
}

/** Strict-mode: double-quoted spans >= minLen codepoints with no adjacent
 *  marker. Returns [{quote, index}]. */
export function findUncitedQuotes(text, minLen = 20) {
  // Mask block bodies first.
  const blockRe = /^(`{3,})quote (ext-[0-9a-f]{12})[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm;
  let masked = text, m;
  const spans = [];
  while ((m = blockRe.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  if (spans.length) {
    let out = "", pos = 0;
    for (const [s, e] of spans) { out += masked.slice(pos, s) + " ".repeat(e - s); pos = e; }
    out += masked.slice(pos);
    masked = out;
  }
  const out = [];
  const spanRe = /"([^"\n]+)"(\s?\[ext-[0-9a-f]{12}\])?/g;
  while ((m = spanRe.exec(masked)) !== null) {
    if (m[2]) continue; // has an adjacent marker
    if (codepointLength(m[1]) >= minLen) out.push({ quote: m[1], index: m.index });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RFC 4180 CSV (spec/01).
// ---------------------------------------------------------------------------

export function csvField(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function writeCsv(rows) {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, inQ = false;
  const s = text.replace(/\r\n/g, "\n");
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator (2020-12 subset). Supports: type (incl. arrays
// & null), enum, const, properties, required, additionalProperties (bool|schema),
// items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum,
// anyOf, allOf, oneOf, and cross-file $ref. `format` is an annotation.
// ---------------------------------------------------------------------------

const _docCache = new Map();

function loadDoc(absPath) {
  if (!_docCache.has(absPath)) _docCache.set(absPath, readJSON(absPath));
  return _docCache.get(absPath);
}

function pointer(doc, fragment) {
  if (!fragment || fragment === "") return doc;
  const parts = fragment.replace(/^#/, "").split("/").filter((p) => p.length);
  let node = doc;
  for (let part of parts) {
    part = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node == null || !(part in node)) throw new Error(`Cannot resolve pointer ${fragment}`);
    node = node[part];
  }
  return node;
}

function resolveRef(ref, baseFile) {
  const hashIdx = ref.indexOf("#");
  const filePart = hashIdx === -1 ? ref : ref.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? "" : ref.slice(hashIdx + 1);
  let targetFile = baseFile, doc;
  if (filePart === "") doc = loadDoc(baseFile);
  else { targetFile = path.resolve(path.dirname(baseFile), filePart); doc = loadDoc(targetFile); }
  return { schema: pointer(doc, fragment), baseFile: targetFile };
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  if (t === "object") return actual === "object";
  return actual === t;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Returns an array of error strings (empty = valid). */
export function validateAgainst(schema, data, baseFile, dataPath = "") {
  let errors = [];
  const at = dataPath || "(root)";

  if (schema.$ref !== undefined) {
    const { schema: t, baseFile: b } = resolveRef(schema.$ref, baseFile);
    errors = errors.concat(validateAgainst(t, data, b, dataPath));
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(data, t))) errors.push(`${at}: expected type ${types.join("|")}, got ${typeOf(data)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, data))) errors.push(`${at}: value ${JSON.stringify(data)} not in enum`);
  if (schema.const !== undefined && !deepEqual(schema.const, data)) errors.push(`${at}: value ${JSON.stringify(data)} !== const`);
  if (schema.pattern !== undefined && typeof data === "string" && !new RegExp(schema.pattern).test(data)) errors.push(`${at}: string does not match pattern ${schema.pattern}`);
  if (schema.minLength !== undefined && typeof data === "string" && Array.from(data).length < schema.minLength) errors.push(`${at}: string shorter than minLength ${schema.minLength}`);
  if (schema.maxLength !== undefined && typeof data === "string" && Array.from(data).length > schema.maxLength) errors.push(`${at}: string longer than maxLength ${schema.maxLength}`);
  if (schema.minimum !== undefined && typeof data === "number" && data < schema.minimum) errors.push(`${at}: ${data} < minimum ${schema.minimum}`);
  if (schema.maximum !== undefined && typeof data === "number" && data > schema.maximum) errors.push(`${at}: ${data} > maximum ${schema.maximum}`);
  if (schema.minItems !== undefined && Array.isArray(data) && data.length < schema.minItems) errors.push(`${at}: array length ${data.length} < minItems ${schema.minItems}`);
  if (schema.maxItems !== undefined && Array.isArray(data) && data.length > schema.maxItems) errors.push(`${at}: array length ${data.length} > maxItems ${schema.maxItems}`);
  if (schema.items !== undefined && Array.isArray(data)) data.forEach((el, i) => { errors = errors.concat(validateAgainst(schema.items, el, baseFile, `${at}[${i}]`)); });

  const isObj = data && typeof data === "object" && !Array.isArray(data);
  if (schema.required !== undefined && isObj) for (const key of schema.required) if (!(key in data)) errors.push(`${at}: missing required property "${key}"`);
  if (schema.properties !== undefined && isObj) for (const key of Object.keys(schema.properties)) if (key in data) errors = errors.concat(validateAgainst(schema.properties[key], data[key], baseFile, `${at}.${key}`));
  if (schema.additionalProperties !== undefined && isObj) {
    const known = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(data)) {
      if (known.has(key)) continue;
      if (schema.additionalProperties === false) errors.push(`${at}: additional property "${key}" not allowed`);
      else if (typeof schema.additionalProperties === "object") errors = errors.concat(validateAgainst(schema.additionalProperties, data[key], baseFile, `${at}.${key}`));
    }
  }
  if (schema.anyOf !== undefined && !schema.anyOf.some((sub) => validateAgainst(sub, data, baseFile, dataPath).length === 0)) errors.push(`${at}: value did not match any of anyOf`);
  if (schema.allOf !== undefined) for (const sub of schema.allOf) errors = errors.concat(validateAgainst(sub, data, baseFile, dataPath));
  if (schema.oneOf !== undefined) {
    const passes = schema.oneOf.filter((sub) => validateAgainst(sub, data, baseFile, dataPath).length === 0).length;
    if (passes !== 1) errors.push(`${at}: value matched ${passes} of oneOf (need exactly 1)`);
  }
  return errors;
}

export function validateWithSchema(schemaDir, schemaFile, data, label) {
  const abs = path.resolve(schemaDir, schemaFile);
  const schema = loadDoc(abs);
  return validateAgainst(schema, data, abs, label || schemaFile);
}

// ---------------------------------------------------------------------------
// Path containment with realpath (spec/08 rule 0.3, spec/10).
// ---------------------------------------------------------------------------

export function resolveInside(root, relPath) {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, relPath);
  let contained = abs === absRoot || abs.startsWith(absRoot + path.sep);
  let symlinkEscape = false;
  if (contained) {
    try {
      const realRoot = fs.realpathSync(absRoot);
      let probe = abs;
      while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
      const realProbe = fs.realpathSync(probe);
      if (!(realProbe === realRoot || realProbe.startsWith(realRoot + path.sep))) { contained = false; symlinkEscape = true; }
    } catch { /* realpath failure: leave lexical result */ }
  }
  return { abs, contained, symlinkEscape };
}

// ---------------------------------------------------------------------------
// Corpus loader (spec/01). Resolves objects through the manifests, honoring
// `sections` everywhere. Never throws except on a missing/unparseable
// corpus.json; other problems are collected in `diagnostics`.
// ---------------------------------------------------------------------------

export function loadCorpus(root) {
  const absRoot = path.resolve(root);
  const corpusPath = path.join(absRoot, "corpus.json");
  if (!fs.existsSync(corpusPath)) throw new Error(`No corpus.json at ${absRoot}`);
  const corpus = readJSON(corpusPath); // parse error propagates -> load_error
  const sections = corpus.sections || {};
  const diagnostics = [];

  const collectJSONL = (relOrAbs, absPath, tag) => {
    const r = readJSONLSafe(absPath);
    for (const w of r.warnings) diagnostics.push(w);
    for (const e of r.errors) diagnostics.push(e);
    return r.records.map((obj) => ({ obj, from: relOrAbs, tag }));
  };

  // --- Sources ---
  const sources = [];
  const sourcesDir = sections.sources || "sources/";
  const pushSource = (dirRel, sjsonAbs) => {
    if (fs.existsSync(sjsonAbs)) {
      try { sources.push({ obj: readJSON(sjsonAbs), dirRel, file: sjsonAbs }); }
      catch (e) { diagnostics.push({ code: "schema_invalid", object: dirRel, detail: "source.json parse: " + e.message }); }
    } else {
      diagnostics.push({ code: "missing_source_json", object: dirRel, detail: sjsonAbs });
    }
  };
  if (Array.isArray(corpus.sources) && corpus.sources.length) {
    for (const entry of corpus.sources) {
      const rel = entry.path;
      const { abs, contained, symlinkEscape } = resolveInside(absRoot, rel);
      if (!contained) { diagnostics.push({ code: symlinkEscape ? "symlink_escape" : "path_escape", object: entry.source_id || rel, detail: rel }); continue; }
      // path may be a directory (canonical) or a source.json file (alt layout)
      const isFile = fs.existsSync(abs) && fs.statSync(abs).isFile();
      const sjson = isFile ? abs : path.join(abs, "source.json");
      const dirRel = (isFile ? path.dirname(rel) : rel).replace(/\/+$/, "");
      pushSource(dirRel, sjson);
    }
  } else {
    const { abs: base, contained } = resolveInside(absRoot, sourcesDir);
    if (contained && fs.existsSync(base)) {
      for (const name of fs.readdirSync(base)) {
        const sjson = path.join(base, name, "source.json");
        if (fs.existsSync(sjson)) pushSource(path.join(sourcesDir, name).replace(/\\/g, "/"), sjson);
      }
    }
  }

  // --- Representations (flattened; abs path + containment for hop A) ---
  const representations = [];
  for (const s of sources) {
    if (!s.obj) continue;
    for (const rep of s.obj.representations || []) {
      const { abs, contained, symlinkEscape } = resolveInside(absRoot, rep.path || "");
      representations.push({ obj: rep, sourceId: s.obj.source_id, ownerDir: s.dirRel, abs, contained, symlinkEscape });
    }
  }

  // --- Extractions: per-source jsonl + declared extraction sets ---
  const extractions = [];
  for (const s of sources) {
    if (!s.obj || !s.obj.extractions_path) continue;
    const { abs, contained, symlinkEscape } = resolveInside(absRoot, s.obj.extractions_path);
    if (!contained) { diagnostics.push({ code: symlinkEscape ? "symlink_escape" : "path_escape", object: s.obj.source_id, detail: s.obj.extractions_path }); continue; }
    if (fs.existsSync(abs)) extractions.push(...collectJSONL(s.obj.extractions_path, abs, "per-source"));
    else diagnostics.push({ code: "missing_file", object: s.obj.source_id, detail: "extractions_path: " + s.obj.extractions_path });
  }
  const extractionSets = [];
  if (sections.extractions) {
    const { abs: base, contained } = resolveInside(absRoot, sections.extractions);
    if (contained && fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      for (const name of fs.readdirSync(base)) {
        const setDir = path.join(base, name);
        if (!fs.statSync(setDir).isDirectory()) continue;
        const manifestAbs = path.join(setDir, "manifest.json");
        let itemsRel = path.join(sections.extractions, name, "items.jsonl").replace(/\\/g, "/");
        if (fs.existsSync(manifestAbs)) {
          try {
            const man = readJSON(manifestAbs);
            extractionSets.push({ obj: man, dirRel: path.join(sections.extractions, name).replace(/\\/g, "/") });
            if (man.items_path) itemsRel = man.items_path;
          } catch (e) { diagnostics.push({ code: "schema_invalid", object: name, detail: "set manifest: " + e.message }); }
        }
        const { abs: itemsAbs, contained: ic } = resolveInside(absRoot, itemsRel);
        if (ic && fs.existsSync(itemsAbs)) extractions.push(...collectJSONL(itemsRel, itemsAbs, "set:" + name));
      }
    }
  }

  // --- Generations: honor sections.generations; else per-source generated/ ---
  const generations = [];
  const readGensIn = (dirAbs, dirRel) => {
    if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) return;
    for (const name of fs.readdirSync(dirAbs)) {
      if (!name.endsWith(".json")) continue;
      try {
        const obj = readJSON(path.join(dirAbs, name));
        if (obj && obj.generation_id) generations.push({ obj, from: path.join(dirRel, name).replace(/\\/g, "/") });
      } catch (e) { diagnostics.push({ code: "schema_invalid", object: name, detail: "generation parse: " + e.message }); }
    }
  };
  if (sections.generations) {
    const { abs, contained } = resolveInside(absRoot, sections.generations);
    if (contained) readGensIn(abs, sections.generations);
  } else {
    for (const s of sources) {
      if (!s.obj) continue;
      const gdir = path.join(absRoot, s.dirRel, "generated");
      readGensIn(gdir, path.join(s.dirRel, "generated"));
    }
  }

  // --- Syntheses: index, else sections.syntheses scan ---
  const syntheses = [];
  const synIndex = Array.isArray(corpus.syntheses) ? corpus.syntheses : [];
  const pushSyn = (dirRel) => {
    const sjson = path.join(absRoot, dirRel, "synthesis.json");
    if (fs.existsSync(sjson)) {
      try { syntheses.push({ obj: readJSON(sjson), dirRel }); }
      catch (e) { diagnostics.push({ code: "schema_invalid", object: dirRel, detail: "synthesis parse: " + e.message }); }
    }
  };
  if (synIndex.length) for (const entry of synIndex) pushSyn(entry.path);
  else if (sections.syntheses) {
    const base = path.join(absRoot, sections.syntheses);
    if (fs.existsSync(base)) for (const name of fs.readdirSync(base)) pushSyn(path.join(sections.syntheses, name).replace(/\\/g, "/"));
  }

  // --- Codebooks (1.6.0, spec/12): flat directory of cbk-*.json ---
  const codebooks = [];
  if (sections.codebooks) {
    const { abs: base, contained } = resolveInside(absRoot, sections.codebooks);
    if (contained && fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      for (const name of fs.readdirSync(base).sort()) {
        if (!name.endsWith(".json")) continue;
        const rel = path.join(sections.codebooks, name).replace(/\\/g, "/");
        try {
          const obj = readJSON(path.join(base, name));
          if (obj && obj.codebook_id) codebooks.push({ obj, from: rel });
        } catch (e) { diagnostics.push({ code: "schema_invalid", object: name, detail: "codebook parse: " + e.message }); }
      }
    }
  }

  // --- Coding sets (1.6.0, spec/12): codings/<set-id>/{manifest.json,items.jsonl} ---
  const codings = [];
  const codingSets = [];
  if (sections.codings) {
    const { abs: base, contained } = resolveInside(absRoot, sections.codings);
    if (contained && fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      for (const name of fs.readdirSync(base).sort()) {
        const setDir = path.join(base, name);
        if (!fs.statSync(setDir).isDirectory()) continue;
        const manifestAbs = path.join(setDir, "manifest.json");
        let itemsRel = path.join(sections.codings, name, "items.jsonl").replace(/\\/g, "/");
        if (fs.existsSync(manifestAbs)) {
          try {
            const man = readJSON(manifestAbs);
            codingSets.push({ obj: man, dirRel: path.join(sections.codings, name).replace(/\\/g, "/") });
            if (man.items_path) itemsRel = man.items_path;
          } catch (e) { diagnostics.push({ code: "schema_invalid", object: name, detail: "coding set manifest: " + e.message }); }
        } else {
          diagnostics.push({ code: "missing_file", object: name, detail: "coding set manifest.json" });
        }
        const { abs: itemsAbs, contained: ic } = resolveInside(absRoot, itemsRel);
        if (ic && fs.existsSync(itemsAbs)) codings.push(...collectJSONL(itemsRel, itemsAbs, "set:" + name));
      }
    }
  }

  // --- Activity journal ---
  let events = [];
  const provRel = sections.provenance || "provenance/events.jsonl";
  {
    const { abs, contained } = resolveInside(absRoot, provRel);
    if (contained && fs.existsSync(abs)) {
      const r = readJSONLSafe(abs);
      for (const w of r.warnings) diagnostics.push(w);
      for (const e of r.errors) diagnostics.push(e);
      events = r.records;
    }
  }

  return { root: absRoot, corpus, sections, sources, representations, extractions, extractionSets, generations, syntheses, codebooks, codings, codingSets, events, diagnostics };
}

// ---------------------------------------------------------------------------
// Locator resolution (spec/03, spec/05, spec/09). Turns a locator into the
// structured context a reading surface needs to "bring up the source."
//
// EXACTLY ONE locator type is gate-bearing: char_range. Every other type is a
// PRESENTATION locator - resolved for display, never verified, never part of
// identity. `gate_bearing` and `verified` are reported per locator so a caller
// can never accidentally present an advisory position as a checked one.
// ---------------------------------------------------------------------------

const STRING_LOCATORS = new Set(["heading", "section", "css_selector", "xpath", "url"]);

/** The loadCorpus representation wrapper for a rep id, or undefined. */
export function findRepEntry(loaded, repId) {
  return (loaded.representations || []).find((r) => r.obj && r.obj.representation_id === repId);
}

/** A compact, display-oriented summary of a representation. */
function repSummary(entry) {
  const o = entry.obj;
  const out = { id: o.representation_id, role: o.role, media_type: o.media_type, path: o.path };
  if (o.parent_representation_ref) out.parent_representation_ref = o.parent_representation_ref;
  if (o.description != null) out.description = o.description;
  if (o.caption != null) out.caption = o.caption;
  if (o.has_text != null) out.has_text = o.has_text;
  if (o.dimensions) out.dimensions = o.dimensions;
  return out;
}

/** Resolve one locator against a loaded corpus. Returns a structured context
 *  block; never throws. opts: {context} codepoints of surrounding text. */
export function resolveLocator(loaded, locator, opts = {}) {
  const ctx = Number.isInteger(opts.context) && opts.context >= 0 ? opts.context : DEFAULT_CONTEXT;
  const loc = locator || {};
  const kind = loc.type;
  const gate_bearing = kind === "char_range";
  const base = { kind, gate_bearing, representation_ref: loc.representation_ref };
  // advisory metadata rides along untouched, so a caller can honour unit/frames
  if (loc.conforms_to != null) base.conforms_to = loc.conforms_to;
  if (loc.quote_hint != null) base.quote_hint = loc.quote_hint;

  const entry = findRepEntry(loaded, loc.representation_ref);
  if (!entry) return { ...base, resolved: false, reason: "dangling_representation" };
  base.representation = repSummary(entry);
  const path = entry.obj.path;

  if (!gate_bearing) base.trust = "recorded_not_gated";

  const readText = () => {
    if (!entry.contained || !fs.existsSync(entry.abs)) return null;
    const rec = getRepFile(entry.abs);
    return rec.utf8ok ? rec : null;
  };

  switch (kind) {
    case "char_range": {
      const v = loc.value || {};
      const rec = readText();
      if (!rec) return { ...base, resolved: false, reason: "representation_unreadable" };
      const len = rec.cps.length;
      if (!(Number.isInteger(v.start) && Number.isInteger(v.end) && 0 <= v.start && v.start <= v.end && v.end <= len)) {
        return { ...base, resolved: false, reason: "locator_range_invalid", detail: `range [${v.start},${v.end}] invalid for length ${len}` };
      }
      return {
        ...base,
        resolved: true,
        unit: loc.unit || "codepoint",
        context: {
          before: rec.cps.slice(Math.max(0, v.start - ctx), v.start).join(""),
          exact: rec.cps.slice(v.start, v.end).join(""),
          after: rec.cps.slice(v.end, Math.min(len, v.end + ctx)).join(""),
        },
        char_range: { start: v.start, end: v.end },
        line_range: lineRangeForCharRange(rec.text, v.start, v.end),
      };
    }
    case "line_range": {
      const v = loc.value || {};
      const rec = readText();
      if (!rec) return { ...base, resolved: false, reason: "representation_unreadable" };
      const lines = textLines(rec.text);
      if (!(Number.isInteger(v.start) && Number.isInteger(v.end) && v.start >= 1 && v.start <= v.end)) {
        return { ...base, resolved: false, reason: "locator_range_invalid", detail: `line range [${v.start},${v.end}]` };
      }
      const slice = lines.slice(v.start - 1, v.end);
      return {
        ...base,
        resolved: true,
        unit: loc.unit || "line",
        basis: "1-based-inclusive",
        line_range: { start: v.start, end: v.end },
        line_count: lines.length,
        path,
        lines: slice,
        text: slice.join("\n"),
      };
    }
    case "page": {
      const page = loc.value;
      return { ...base, resolved: true, unit: loc.unit || "page", page, path, fragment: `#page=${page}` };
    }
    case "bbox": {
      const b = Array.isArray(loc.value) ? loc.value : [];
      const reference = loc.reference || entry.obj.dimensions || null;
      const out = { ...base, resolved: true, unit: loc.unit || "pixel", bbox: b, path };
      if (reference) out.reference = reference;
      if (out.unit === "pixel" && b.length === 4) out.fragment = `#xywh=pixel:${b[0]},${b[1]},${b[2]},${b[3]}`;
      else if (out.unit === "percent" && b.length === 4) out.fragment = `#xywh=percent:${b[0]},${b[1]},${b[2]},${b[3]}`;
      return out;
    }
    case "timestamp_range": {
      const v = loc.value || {};
      return { ...base, resolved: true, unit: loc.unit || "second", start: v.start, end: v.end, path, fragment: `#t=${v.start},${v.end}` };
    }
    default: {
      if (STRING_LOCATORS.has(kind)) return { ...base, resolved: true, value: loc.value, path };
      return { ...base, resolved: false, reason: "unknown_locator_type" };
    }
  }
}
