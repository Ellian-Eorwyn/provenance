// UPC Obsidian vault export (spec 1.7.0, spec/09 "Exports").
//
// Projects a corpus into a readable Obsidian vault: one note per source, one per
// generation and synthesis, images copied into the vault's attachment route, and
// every note's origin recorded in a folded `> [!provenance]-` callout.
//
// Three things make this more than a Markdown dump, and all three come from §09,
// which binds any reading surface and not just the offline browser:
//
//   1. Quotations are rendered from the REPRESENTATION BYTES at the locator, never
//      from the note body and never from the extraction's own stored context. The
//      body is boilerplate-stripped and therefore no longer byte-addressable; the
//      evidence is read from the file the gate ran against. Stripping the body can
//      thus never corrupt a quotation.
//   2. Every quotation carries its badge, and a paraphrase is never styled as one.
//   3. What was stripped is COUNTED and reported in the provenance block. A lossy
//      transform that does not say what it dropped is indistinguishable from a
//      faithful one, which is how a reader comes to trust the wrong thing.
//
// The vault's conventions are data, not code: `profiles/obsidian/profile.json`
// describes the frontmatter vocabulary, callout registry, block order and folder
// routes, and `--profile` replaces it. UPC is a standard, so it must not compile
// one vault's private schema into the exporter.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as U from "./upc_common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** Walk up from this script for the shipped profile, the way findSpecDirs does
 *  for schemas/ and vocab/ — the skill directory is designed to be copied out of
 *  the repo, so an absolute path would break the portable case. */
function defaultProfilePath() {
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "profiles", "obsidian", "profile.json");
    if (fs.existsSync(candidate)) return candidate;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function loadProfile(file) {
  const abs = file ? path.resolve(file) : defaultProfilePath();
  if (!abs || !fs.existsSync(abs)) {
    throw new Error("no Obsidian profile found; pass --profile <file> (expected profiles/obsidian/profile.json)");
  }
  return U.readJSON(abs);
}

// ---------------------------------------------------------------------------
// Rendering primitives
//
// These mirror the vault's own emitters exactly (pi-forge's
// vault_reflection.render_callout and vault_schema.serialize_frontmatter), so a
// note exported by UPC and a note written by that toolchain are the same shape.
// ---------------------------------------------------------------------------

/** One block as an Obsidian callout. Every line is quoted and a blank line becomes
 *  a bare ">", which is what continues a callout across a paragraph break. Folding
 *  is the "-" after the type — Markdown, not CSS, so it still works in a vault with
 *  no stylesheet. */
export function renderCallout(kind, title, lines, collapsed = true) {
  const marker = `> [!${kind}]${collapsed ? "-" : ""}`;
  const head = title ? `${marker} ${String(title).replace(/\s*\n\s*/g, " ")}` : marker;
  // Any element carrying its own newlines is split here rather than at each call
  // site. A corpus field is free text — a codebook question, an image description,
  // a soft-wrapped quotation — and one unsplit newline silently ends the callout,
  // dropping the rest of the block into the note as loose prose.
  const flat = [];
  for (const l of lines) {
    if (l == null) { flat.push(""); continue; }
    for (const part of String(l).split("\n")) flat.push(part.replace(/\s+$/, ""));
  }
  return [head, ...flat.map((l) => (l ? `> ${l}` : ">"))].join("\n");
}

function yamlQuote(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** A frontmatter scalar, quoted only where YAML would otherwise reinterpret it.
 *  `date: 2026-08-28` stays bare because that is what the vault stores and what
 *  its Bases date formatters read; a wikilink is always quoted because a bare
 *  "[[x]]" is a YAML flow sequence. */
export function yamlScalar(value, forceQuote = false) {
  const s = String(value);
  if (forceQuote) return yamlQuote(s);
  if (s === "") return '""';
  if (/^\s|\s$/.test(s)) return yamlQuote(s);
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return yamlQuote(s);
  if (/:\s|:$|\s#/.test(s)) return yamlQuote(s);
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return yamlQuote(s);
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return yamlQuote(s);
  return s;
}

const LIST_SHAPES = new Set(["list", "wikilink_list"]);
const WIKILINK_SHAPES = new Set(["wikilink", "wikilink_list"]);

/** Frontmatter in the profile's canonical property order, skipping anything absent
 *  or empty. The schema's rule is that empty strings, empty lists and nulls are
 *  removed rather than emitted — an always-empty property is a filter that fails
 *  silently, not a documented gap. */
export function serializeFrontmatter(metadata, profile) {
  const fm = profile.frontmatter;
  const order = fm.property_order.concat(fm.extended_properties || []);
  const lines = ["---"];
  for (const key of order) {
    if (!(key in metadata)) continue;
    const value = metadata[key];
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    const shape = (fm.properties[key] || {}).shape || "scalar";
    if (LIST_SHAPES.has(shape)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(item, WIKILINK_SHAPES.has(shape))}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value, WIKILINK_SHAPES.has(shape))}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/** A quoted wikilink for frontmatter, from a note title that is already safe. */
const wikilink = (title) => `[[${U.safeTitle(title)}]]`;

// ---------------------------------------------------------------------------
// Boilerplate stripping
//
// Deterministic and model-free. The filters are ports of pi-forge's PDF chrome
// removal (file-conversion.py: pdf_norm_chrome / pdf_running_heads /
// pdf_is_page_number), which are already tuned against this corpus family, plus
// the inverse of its "a line with a URL and enough prose is a citation" test.
//
// The governing rule is that every removal is COUNTED BY CLASS and reported. A
// silent lossy transform is worse than a noisy one: a reader who cannot see that
// twelve lines went away has no way to notice when the wrong twelve did.
// ---------------------------------------------------------------------------

// How many content lines either side of a page break count as that page's head and
// foot. Page furniture lives there; a bare number in the middle of a page is data.
const BOUNDARY_WINDOW = 2;
// A folio run must be at least this long, and may skip at most this far, before a
// sequence of bare integers reads as pagination rather than as data.
const MIN_FOLIO_RUN = 5;
const MAX_FOLIO_GAP = 3;
// Pagination spans a document; a short ascending column near the top is a table.
const MIN_FOLIO_SPAN_FRACTION = 0.3;
// The page divider RA's `_clean.md` files carry, and the equivalent rule/marker.
const PAGE_MARKER_RE = /^(#{1,6}\s*)?(page|p\.)\s*\d+\s*(of\s*\d+\s*)?$/i;
const URL_RE = /https?:\/\/[^\s<>"'\])]+/gi;
// Fraction of pages a normalized line must appear on before it reads as chrome
// rather than as content that happens to repeat.
const RUNNING_HEAD_PAGE_FRACTION = 0.5;
const MIN_PAGES_FOR_RUNNING_HEADS = 3;
// A link-bearing line needs at least this much prose to be a sentence rather than
// navigation. pi-forge uses 20 for the same decision in the opposite direction.
const NAV_PROSE_MIN_CHARS = 20;
const NAV_PROSE_MIN_CHARS_AGGRESSIVE = 40;

// Institutional repositories staple a coversheet onto author manuscripts. It is
// not part of the article, but it is DETECTED AND NEVER REMOVED: a false positive
// would delete the opening of a paper, which is not a tradeoff worth making for
// tidiness. pi-forge takes the same stance in literature-library.py.
const COVERSHEET_MARKERS = [
  "research portal", "repository", "eprints", "author accepted manuscript",
  "version of record", "link to published version", "terms of use",
  "citing this paper", "downloaded from", "this is the peer reviewed version",
  "general rights",
];

/** Normalize a line for chrome detection: drop digits so page numbers cluster into
 *  one key, lowercase, collapse whitespace. */
function normChrome(text) {
  return text.replace(/\d+/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Is this line, standing alone, a page number?
 *
 *  Deliberately narrow, and only ever consulted at a page boundary (see
 *  boundaryZone). Measured against real documents, a looser test eats content: a
 *  map legend's "0.0" and "10.5", a wiring manual's "C" and "L1" terminals, and
 *  the bare "1"/"2" of a numbered list all read as page numbers to a rule that
 *  accepts any short run of digits or roman letters.
 *
 *  So: integers only (a page is never 10.5), a "12 / 340" pair, and roman numerals
 *  of at least two characters — a lone "C" or "m" is a label far more often than
 *  it is page 100. */
function isPageNumberLine(text) {
  const t = text.trim().replace(/^[-–—/|\s.]+/, "").replace(/[-–—/|\s.]+$/, "");
  if (!t || t.length > 12) return false;
  if (/^\d{1,5}$/.test(t)) return true;
  if (/^\d{1,5}\s*(\/|of)\s*\d{1,5}$/i.test(t)) return true;
  if (/^[ivxlcdm]{2,7}$/.test(t) || /^[IVXLCDM]{2,7}$/.test(t)) return true;
  return false;
}

/** The integer a page-number-shaped line carries, or null. */
function folioValue(text) {
  const t = text.trim().replace(/^[-–—/|\s.]+/, "").replace(/[-–—/|\s.]+$/, "");
  const m = /^(\d{1,5})(?:\s*(?:\/|of)\s*\d{1,5})?$/i.exec(t);
  return m ? Number(m[1]) : null;
}

/** Line indices carrying a running folio, for a document with no page markers.
 *
 *  Most converted PDFs have no `## Page N` dividers, so boundary detection has
 *  nothing to work with — but pagination still leaves a signature no data table
 *  does: a long run of bare integers, ascending, spread through the document. A
 *  lone "7" is data; "1, 2, 3, … 48" at regular intervals is a page footer.
 *
 *  Requiring a RUN is the whole safety margin. It is why a map legend's "0.0" and a
 *  wiring diagram's "L1" survive: neither ascends, and neither has company. */
function folioRun(lines) {
  const cands = [];
  for (let i = 0; i < lines.length; i++) {
    const v = folioValue(lines[i]);
    if (v != null && isPageNumberLine(lines[i])) cands.push({ i, v });
  }
  if (cands.length < MIN_FOLIO_RUN) return new Set();

  // Longest ascending chain, allowing a small value gap between consecutive links.
  // A contiguous run is not enough: real documents interleave chart data and figure
  // numbers between their folios, and one stray "2024" would otherwise end the
  // sequence. Skipping non-members is exactly what makes those numbers survive —
  // they are what the chain steps over, not what it picks up.
  const len = new Array(cands.length).fill(1);
  const prev = new Array(cands.length).fill(-1);
  let bestEnd = 0;
  for (let i = 1; i < cands.length; i++) {
    for (let j = 0; j < i; j++) {
      const d = cands[i].v - cands[j].v;
      if (d > 0 && d <= MAX_FOLIO_GAP && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
    if (len[i] > len[bestEnd]) bestEnd = i;
  }
  if (len[bestEnd] < MIN_FOLIO_RUN) return new Set();

  const chain = [];
  for (let k = bestEnd; k !== -1; k = prev[k]) chain.push(cands[k]);
  chain.reverse();

  // Pagination runs through a document. A short ascending column of numbers near
  // the top is a table, so the chain must also SPAN most of the text to count.
  const span = chain[chain.length - 1].i - chain[0].i;
  if (span < lines.length * MIN_FOLIO_SPAN_FRACTION) return new Set();
  return new Set(chain.map((c) => c.i));
}

/** Line indices that sit at a page head or foot, derived from the page markers a
 *  converted document carries. Without markers this is empty and the
 *  boundary-only filters simply do not run — we cannot tell a page foot from a
 *  paragraph, so we do not guess. */
function boundaryZone(lines, pageBreaks) {
  const zone = new Set();
  const walk = (from, step) => {
    let n = 0;
    for (let i = from; i >= 0 && i < lines.length && n < BOUNDARY_WINDOW; i += step) {
      if (!lines[i].trim()) continue;
      zone.add(i);
      n++;
    }
  };
  for (const idx of pageBreaks) { walk(idx + 1, 1); walk(idx - 1, -1); }
  // The last page has no marker after it, so its foot needs the document tail.
  if (pageBreaks.length) walk(lines.length - 1, -1);
  return zone;
}

/** Prose left on a line once its URLs and Markdown link syntax are removed. */
function proseWeight(line) {
  let s = line.replace(URL_RE, " ");
  s = s.replace(/^[\s>*+-]+/, " ").replace(/[[\]()|]/g, " ");
  return s.replace(/[^0-9A-Za-z]+/g, "").length;
}

const hasLink = (line) => /https?:\/\//i.test(line) || /\]\(\s*[^)]*\)/.test(line);

/** Detect a repository coversheet in the opening lines. Detection only. */
export function detectCoversheet(lines) {
  const head = lines.slice(0, 60).join("\n").toLowerCase();
  const hits = COVERSHEET_MARKERS.filter((m) => head.includes(m));
  return hits.length >= 3 ? { markers: hits } : null;
}

/**
 * Strip navigational and page furniture from a representation's text.
 *
 * Returns `{ text, removed, warnings }` where `removed` counts by class. Levels:
 * `none` (identity), `standard` (page markers, page numbers, running heads, and
 * link-only navigation), `aggressive` (standard, with a higher prose bar for
 * navigation and short lines that repeat throughout the document).
 */
export function stripBoilerplate(text, opts = {}) {
  const level = opts.level || "standard";
  const removed = {};
  const warnings = [];
  const bump = (k) => { removed[k] = (removed[k] || 0) + 1; };
  if (level === "none" || !text) return { text: text || "", removed, warnings };

  const lines = text.split("\n");
  const coversheet = detectCoversheet(lines);
  if (coversheet) {
    warnings.push({
      code: "coversheet_detected",
      detail: `repository coversheet markers in the opening lines (${coversheet.markers.join(", ")}); kept verbatim, review the note's opening`,
    });
  }

  // Page boundaries let running-head detection see which lines are page tops and
  // bottoms. Without markers we cannot tell, so we do not guess: the running-head
  // pass simply does not run, and only the unambiguous filters apply.
  const pageBreaks = [];
  lines.forEach((l, i) => { if (PAGE_MARKER_RE.test(l.trim())) pageBreaks.push(i); });
  const pageCount = pageBreaks.length;

  const chromeKeys = new Set();
  if (pageCount >= MIN_PAGES_FOR_RUNNING_HEADS) {
    const counts = new Map();
    for (const idx of pageBreaks) {
      // The line after a page marker is that page's head; the line before it is the
      // previous page's foot. Blank lines are skipped so a marker padded with them
      // still finds the real candidate.
      for (const probe of [nextContentLine(lines, idx, 1), nextContentLine(lines, idx, -1)]) {
        if (probe == null) continue;
        const key = normChrome(lines[probe]);
        if (key && key.length <= 120) counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const threshold = pageCount * RUNNING_HEAD_PAGE_FRACTION;
    for (const [key, n] of counts) if (n > threshold) chromeKeys.add(key);
  }

  let repeated = new Set();
  if (level === "aggressive") {
    const counts = new Map();
    for (const l of lines) {
      const key = normChrome(l);
      if (key && key.length <= 80) counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, n] of counts) if (n > 3) repeated.add(key);
  }

  const navMin = level === "aggressive" ? NAV_PROSE_MIN_CHARS_AGGRESSIVE : NAV_PROSE_MIN_CHARS;
  const zone = boundaryZone(lines, pageBreaks);
  // With page markers the boundary rule is precise, so the folio heuristic is not
  // needed and not run.
  const folios = pageBreaks.length ? new Set() : folioRun(lines);
  const kept = [];
  let inFence = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const trimmed = line.trim();
    // A fenced block is verbatim by definition; chrome heuristics have no business
    // inside code, and a stripped fence stops parsing.
    if (/^(```|~~~)/.test(trimmed)) { inFence = !inFence; kept.push(line); continue; }
    if (inFence) { kept.push(line); continue; }

    if (PAGE_MARKER_RE.test(trimmed)) { bump("page_marker"); continue; }
    if ((zone.has(li) || folios.has(li)) && isPageNumberLine(trimmed)) { bump("page_number"); continue; }
    if (trimmed && chromeKeys.has(normChrome(trimmed))) { bump("running_head"); continue; }
    if (trimmed && repeated.has(normChrome(trimmed))) { bump("repeated_line"); continue; }
    if (trimmed && hasLink(trimmed) && proseWeight(trimmed) < navMin) { bump("nav_line"); continue; }
    kept.push(line);
  }

  // Collapse the blank-line runs the removals left behind. This is whitespace, not
  // content, so it is not counted as a removal.
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s+$/, "");
  return { text: out ? out + "\n" : "", removed, warnings };
}

function nextContentLine(lines, from, step) {
  for (let i = from + step; i >= 0 && i < lines.length; i += step) {
    if (lines[i].trim()) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bibliographic helpers
// ---------------------------------------------------------------------------

/** A contributor's display name. `literal` wins because a corporate author is not
 *  a family/given pair and splitting one produces "Studio, Watchdog". */
function contributorName(a) {
  if (!a) return "";
  if (a.literal) return String(a.literal).trim();
  const parts = [a.non_dropping_particle, a.family].filter(Boolean).join(" ");
  return [a.given, parts].filter(Boolean).join(" ").trim();
}

/** CSL date -> the vault's `YYYY-MM-DD`, padded only as far as the date is known.
 *  A year-only date stays a year rather than being invented into January 1st. */
function cslDate(d) {
  if (d == null) return "";
  if (typeof d === "string") return d.trim();
  if (d.date_parts && Array.isArray(d.date_parts[0])) {
    return d.date_parts[0].map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, "0"))).join("-");
  }
  return String(d.raw || d.literal || "").trim();
}

/** The vault's `date` property: a full ISO date, or an ISO date the year alone
 *  implies. The vault stores `YYYY-MM-DD`, so a bare year becomes Jan 1 — which is
 *  what its own imported notes already do (`date: 2025-01-01` for a 2025 article)
 *  and what its Bases date formatters require. */
function vaultDate(issued) {
  const raw = cslDate(issued);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}$/.test(raw)) return raw + "-01";
  if (/^\d{4}$/.test(raw)) return raw + "-01-01";
  return "";
}

const yearOf = (issued) => (cslDate(issued).match(/^(\d{4})/) || [])[1] || "";

// ---------------------------------------------------------------------------
// Classification and naming
// ---------------------------------------------------------------------------

/** Which vault source_kind a source is filed under.
 *
 *  Every rule reads a field the corpus actually stores — CSL item_type first
 *  because it is the most specific, then UPC source_kind, then representation
 *  roles. None of it inspects content: guessing a kind from prose would be a
 *  classification the corpus never made. */
function vaultKindFor(source, reps, profile) {
  const map = profile.kind_mapping;
  const kinds = profile.source_kinds;
  const bib = source.bibliographic || {};
  const byItem = map.by_item_type[bib.item_type];
  if (byItem && kinds[byItem]) return byItem;
  for (const rep of reps) {
    const byRole = map.by_representation_role[rep.role];
    if (byRole && kinds[byRole]) return byRole;
  }
  const bySource = map.by_source_kind[source.source_kind];
  if (bySource && kinds[bySource]) return bySource;
  return map.default;
}

/** The note's title. `bibliographic.title` is the citable one and wins; `title` is
 *  the working label; the id is the last resort so a note is never nameless. */
function titleFor(obj, idKey) {
  const bib = obj.bibliographic || {};
  const raw = bib.title || obj.title || obj[idKey] || "untitled";
  return U.safeTitle(raw) || U.safeTitle(String(obj[idKey] || "untitled"));
}

/** `Author - Year - Title`, the stem the vault already uses for imported papers.
 *  Assembled first and sanitised once, so the result is idempotent. */
function citationStem(obj) {
  const bib = obj.bibliographic || {};
  const first = (bib.authors || [])[0];
  const author = contributorName(first).split(",")[0].trim() || "";
  const surname = author.includes(" ") && !first?.literal ? author.split(" ").pop() : author;
  const year = yearOf(bib.issued) || "n.d.";
  const title = bib.title || obj.title || "";
  const stem = [surname, year, title].filter(Boolean).join(" - ");
  return U.safeTitle(stem);
}

/** Resolve a note name against the names already taken, disambiguating with the
 *  object's own id rather than a counter — a counter renames notes when an
 *  unrelated source is added, and a wikilink to a renamed note is a dead link.
 *  Reserved Windows stems are disambiguated the same way. */
function claimName(base, id, taken) {
  let name = base || String(id);
  if (U.isReservedStem(name) || taken.has(name.toLowerCase())) {
    name = `${name} (${id})`;
  }
  let n = 2;
  while (taken.has(name.toLowerCase())) name = `${base} (${id}) ${n++}`;
  taken.add(name.toLowerCase());
  return name;
}

// ---------------------------------------------------------------------------
// Representation selection
// ---------------------------------------------------------------------------

const isImageRep = (rep) => rep.role === "image" || /^image\//.test(rep.media_type || "");

/**
 * The representation a note's body is read from: the cleanest textual one, in the
 * profile's preference order.
 *
 * A model-rewritten representation is skipped unless `allowRewriteBody`. This is
 * the same judgement §09 makes about badges, applied to the body: a model may
 * silently re-word, normalise or correct its parent, so a reader given the rewrite
 * without being told is reading the model's prose believing it is the source's.
 * When the flag is passed the note still says so, in its provenance block.
 */
function chooseBodyRep(reps, profile, lookupRep, allowRewrite) {
  const order = profile.body_roles.prefer;
  const textual = reps.filter((r) => U.isTextualMedia(r.media_type));
  const rank = (r) => { const i = order.indexOf(r.role); return i === -1 ? order.length : i; };
  const sorted = textual.slice().sort((a, b) => rank(a) - rank(b) ||
    (a.representation_id < b.representation_id ? -1 : a.representation_id > b.representation_id ? 1 : 0));
  const rewritten = [];
  for (const rep of sorted) {
    if (U.isModelRewrittenText(rep, lookupRep)) { rewritten.push(rep); continue; }
    return { rep, rewritten: false };
  }
  if (allowRewrite && rewritten.length) return { rep: rewritten[0], rewritten: true };
  return { rep: null, rewritten: false, skippedRewrites: rewritten.length };
}

// ---------------------------------------------------------------------------
// Evidence, codes, images, provenance
// ---------------------------------------------------------------------------

const BADGE_LABEL = {
  verified: "verified",
  "verified-to-transcript": "verified to the derived text (OCR / transcript / extracted layer)",
  "verified-to-rewrite": "verified to a model rewrite, not to the source",
  failed: "GATE FAILED",
  unverifiable: "not gate-checkable",
  paraphrase: "paraphrase",
};

/** Active codings on one target, grouped by codebook.
 *
 *  §09, applied line by line: a code is a JUDGEMENT, never a gate result, so a chip
 *  is plain inline text rather than anything shaped like a badge; it is never shown
 *  without its coder, because one model's guess must not read as consensus; where
 *  two coders disagree BOTH are shown and neither wins, since an adjudication is
 *  itself just another coding by a coder whose handle says so; and the chip links
 *  to the code's definition, so a code cannot reach a reader as bare jargon. */
function codeLines(targetId, ctx) {
  const rows = (ctx.codingsByTarget.get(targetId) || []).filter((c) => (c.status || "active") === "active");
  if (!rows.length) return [];
  const byBook = new Map();
  for (const c of rows) {
    if (!byBook.has(c.codebook_ref)) byBook.set(c.codebook_ref, []);
    byBook.get(c.codebook_ref).push(c);
  }
  const out = [];
  for (const ref of [...byBook.keys()].sort()) {
    const group = byBook.get(ref);
    const noteName = ctx.codebookNoteNames.get(ref);
    const book = ctx.codebookById.get(ref);
    const scheme = noteName ? `[[${noteName}]]` : `\`${ref}\``;
    const judged = group.map((c) => {
      const label = c.code != null ? c.code : c.value;
      const shown = c.code != null && noteName ? `[[${noteName}#${label}]]` : `\`${label}\``;
      const open = c.code == null ? " (open value)" : "";
      return `${shown}${open} — coder \`${c.coder}\``;
    });
    const distinct = new Set(group.filter((c) => c.code != null).map((c) => c.code));
    const disagree = distinct.size > 1 ? " — **coders disagree; both judgements stand**" : "";
    out.push(`- ${book && book.title ? `**${U.safeTitle(book.title)}**` : scheme}: ${judged.join("; ")}${disagree}`);
  }
  return out;
}

/** The source note's `## Codes` section.
 *
 *  §09 requires a count to state its unit, so source-level and representation-level
 *  judgements are labelled and never merged into one list. Span-level codings are
 *  deliberately absent here: they belong beside the span they judge, which is where
 *  the evidence callout and the extractions list put them. */
function codesSection(sourceId, reps, ctx) {
  const own = codeLines(sourceId, ctx);
  const repLines = [];
  for (const rep of reps) {
    for (const line of codeLines(rep.representation_id, ctx)) {
      repLines.push(`${line} _(on representation \`${rep.representation_id}\`, ${rep.role})_`);
    }
  }
  if (!own.length && !repLines.length) return [];
  const blocks = ["## Codes",
    "Judgements recorded against this source in the corpus's codebooks. A code is a coder's reading, not a verified fact, and it says nothing about whether any quotation below passed its gate."];
  if (own.length) blocks.push(["**On the source as a whole**", ...own].join("\n"));
  if (repLines.length) blocks.push(["**On individual representations**", ...repLines].join("\n"));
  return blocks;
}

/** One gated quotation inside the evidence callout, with its §09 badge and a
 *  footnote pointing at the exact position it was checked against.
 *
 *  A quotation is reproduced EXACTLY, newlines included — those bytes are what the
 *  gate compared. Markdown emphasis does not survive a line break, so a quote that
 *  spans lines takes a label-then-quote shape instead of the tidy inline one, for
 *  the same reason §02 asks tools to soft-wrap their clean text. */
function evidenceLines(item) {
  const suffix = item.badge === "verified" ? "verified" : BADGE_LABEL[item.badge];
  if (!/\n/.test(item.quote)) return [`**"${item.quote}"** — ${suffix}[^${item.extId}]`];
  return [`Quotation — ${suffix}[^${item.extId}]`, `"${item.quote}"`];
}

/** The footnote body: where the quotation lives, in reading terms (a line number)
 *  and in gate terms (the codepoint range hop B actually compared). */
function evidenceFootnote(item) {
  const bits = [`\`${item.extId}\``];
  if (item.repPath) bits.push(path.posix.basename(item.repPath));
  if (item.line) bits.push(item.line.start === item.line.end ? `line ${item.line.start}` : `lines ${item.line.start}–${item.line.end}`);
  if (item.range) bits.push(`char ${item.range.start}–${item.range.end}`);
  const label = BADGE_LABEL[item.badge];
  return `[^${item.extId}]: ${bits.join(", ")}. ${label.charAt(0).toUpperCase()}${label.slice(1)}.`;
}

/** A figure: the embed, then its caption folded beneath it.
 *
 *  `info` is a STOCK Obsidian callout, deliberately: the vault's registry forbids
 *  inventing a type, and lists `info` among those that keep their stock rendering
 *  and stock meaning. Folding keeps the caption out of the reading flow while
 *  leaving it one click — and one grep — away.
 *
 *  The three pieces §05 gives an image each get a line: what it shows
 *  (`description`), whether it says anything (`has_text`), and where the verified
 *  reading of that text lives. `ocr_text` is never rendered as a quotation. */
function figureBlock(rep, attachmentName, index, ocrExtId) {
  const lines = [];
  if (rep.description) lines.push(rep.description);
  if (rep.has_text) {
    lines.push(ocrExtId
      ? `Contains legible text; the verified reading is \`${ocrExtId}\`.`
      : "Contains legible text; no verified reading of it is recorded in the corpus.");
  }
  const facts = [`\`${rep.representation_id}\``];
  if (rep.dimensions && rep.dimensions.width && rep.dimensions.height) {
    facts.push(`${rep.dimensions.width}×${rep.dimensions.height}`);
  }
  if (rep.parent_representation_ref) facts.push(`from \`${rep.parent_representation_ref}\``);
  lines.push(facts.join(" · "));
  const title = rep.caption || `Figure ${index}`;
  return `![[${attachmentName}]]\n\n` + renderCallout("info", title, lines, true);
}

/** How this note was made.
 *
 *  Written in code and never by a model, because §09 requires it to be accurate
 *  about what produced the note and a model cannot be accurate about that. The
 *  shape is pi-forge's: a prose line, a blank `>`, backticked-id bullets with an
 *  em-dash detail, and a trailing digest line. */
function provenanceLines(ctx, parts) {
  const lines = [parts.lead, ""];
  for (const group of parts.groups) {
    if (!group.lines.length) continue;
    if (group.title) lines.push(group.title);
    lines.push(...group.lines, "");
  }
  lines.push(`Corpus \`${ctx.corpusId}\`; UPC spec ${ctx.specVersion}; export \`${ctx.exportId}\`.`);
  return lines;
}

/** Removals, stated as counts by class so a reader can see the transform's size
 *  without being handed the removed text. */
function strippedSummary(removed) {
  const parts = Object.keys(removed).sort().map((k) => `${removed[k]} ${k.replace(/_/g, " ")}${removed[k] === 1 ? "" : "s"}`);
  return parts.length ? `Stripped at export: ${parts.join(", ")}.` : "Stripped at export: nothing.";
}

/** Exactly one level-one heading per note is a grammar rule, and a cleaned
 *  representation almost always opens with its own title. So the leading H1 is
 *  dropped (the note supplies its own) and any remaining H1 is demoted to H2
 *  rather than deleted — it is a real section boundary, just not the title. */
function normalizeHeadings(text) {
  const lines = text.split("\n");
  const out = [];
  let inFence = false, seenContent = false, droppedLead = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line.trim())) { inFence = !inFence; out.push(line); seenContent = true; continue; }
    if (inFence) { out.push(line); continue; }
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1) {
      if (!seenContent && !droppedLead) { droppedLead = true; continue; }
      out.push(`## ${h1[1]}`);
      seenContent = true;
      continue;
    }
    if (line.trim()) seenContent = true;
    out.push(line);
  }
  return out.join("\n").replace(/^\n+/, "");
}

/** Point the body's image links at the vault's attachment copies.
 *
 *  Only links whose basename matches a representation we actually copied are
 *  rewritten; anything else is left exactly as it was, because a link this
 *  exporter does not understand is not a link it should be editing. */
function relinkImages(text, byBasename) {
  let n = 0;
  const seen = new Set();
  const swap = (target) => {
    const clean = String(target).split("#")[0].split("?")[0].trim().replace(/^<|>$/g, "");
    const hit = byBasename.get(path.posix.basename(clean));
    if (!hit) return null;
    seen.add(hit.name);
    n++;
    return hit.name;
  };
  let out = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (m, alt, target) => {
    const name = swap(target);
    return name ? `![[${name}]]` : m;
  });
  out = out.replace(/!\[\[([^\]|#]+)((?:\|[^\]]*)?)\]\]/g, (m, target) => {
    const name = swap(target);
    return name ? `![[${name}]]` : m;
  });
  return { text: out, count: n, embedded: seen };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, "0");
const posix = (...parts) => parts.filter(Boolean).join("/");

/** A deterministic identifier for this export: a digest over the corpus's object
 *  ids and its RECORDED representation hashes, so it changes when the corpus's own
 *  records change. It deliberately does not re-hash the files — that is `upc
 *  validate`'s job, and a fingerprint that moved when a file drifted would report
 *  corpus damage in a field whose purpose is to identify a projection.
 *
 *  A timestamp would be the obvious choice and is the wrong one: it would make two
 *  exports of identical material differ, which defeats byte-idempotence. */
function exportFingerprint(loaded) {
  const bits = [];
  for (const s of loaded.sources) if (s.obj) bits.push("src\n" + s.obj.source_id);
  for (const r of loaded.representations) bits.push("rep\n" + r.obj.representation_id + "\n" + U.bareHash(r.obj.sha256 || ""));
  for (const e of loaded.extractions) bits.push("ext\n" + e.obj.extraction_id);
  for (const g of loaded.generations) bits.push("gen\n" + g.obj.generation_id);
  for (const y of loaded.syntheses) bits.push("syn\n" + y.obj.synthesis_id);
  for (const c of loaded.codings || []) bits.push("cod\n" + c.obj.coding_id);
  return U.sha256Hex(Buffer.from(bits.sort().join("\n"), "utf8")).slice(0, 12);
}

function indexCorpus(loaded) {
  const repById = new Map();
  for (const r of loaded.representations) repById.set(r.obj.representation_id, r);
  const lookupRep = (id) => { const r = repById.get(id); return r ? r.obj : null; };

  const extsBySource = new Map();
  for (const e of loaded.extractions) {
    const sid = e.obj.source_id;
    if (!extsBySource.has(sid)) extsBySource.set(sid, []);
    extsBySource.get(sid).push(e.obj);
  }
  for (const list of extsBySource.values()) {
    list.sort((a, b) => (a.extraction_id < b.extraction_id ? -1 : a.extraction_id > b.extraction_id ? 1 : 0));
  }

  const codingsByTarget = new Map();
  for (const c of loaded.codings || []) {
    const t = c.obj.target || {};
    if (!t.id) continue;
    if (!codingsByTarget.has(t.id)) codingsByTarget.set(t.id, []);
    codingsByTarget.get(t.id).push(c.obj);
  }
  for (const list of codingsByTarget.values()) {
    list.sort((a, b) => (a.coding_id < b.coding_id ? -1 : a.coding_id > b.coding_id ? 1 : 0));
  }

  const codebookById = new Map();
  for (const b of loaded.codebooks || []) codebookById.set(b.obj.codebook_id, b.obj);

  return { repById, lookupRep, extsBySource, codingsByTarget, codebookById };
}

/**
 * Build the whole vault as a plan object, without touching the filesystem beyond
 * reading representation bytes (which §09 requires: a quotation is rendered from
 * the bytes the gate ran against, never from the record).
 *
 * Deterministic and clock-free, so `writeVault` can be byte-idempotent and the
 * tests can assert the plan twice over and compare.
 */
export function buildVaultPlan(loaded, opts = {}) {
  const profile = opts.profile || loadProfile(opts.profileFile);
  const routes = profile.routes;
  const inboxMode = !!opts.inbox;
  const strip = { level: opts.strip || "standard" };
  const ctxWarnings = [];

  const idx = indexCorpus(loaded);
  const corpusId = loaded.corpus.corpus_id || "cor-unknown";
  const specVersion = loaded.corpus.upc_spec_version || "unknown";
  const exportId = exportFingerprint(loaded);

  const domainValue = opts.domain || U.slugify(loaded.corpus.title || "corpus");
  const domainLabel = opts.domainLabel || U.safeTitle(loaded.corpus.title || "Corpus");

  const sourcesRoot = `${pad2(routes.sources_root.number)} ${routes.sources_root.label}`;
  const metaRoot = `${pad2(routes.meta_root.number)} ${routes.meta_root.label}`;
  const metaSub = (key) => {
    const s = routes.meta_subdomains[key];
    return `${metaRoot}/${routes.meta_root.number}.${pad2(s.number)} ${s.label}`;
  };
  const attachDir = posix(metaSub("attachments"), routes.attachment_subfolders.image);

  // Note names are resolved into their own map rather than stamped onto the loaded
  // corpus objects: buildVaultPlan is a projection and has no business writing into
  // the thing it projects.
  const codebookNoteNames = new Map();
  const ctx = {
    corpusId, specVersion, exportId, profile,
    codingsByTarget: idx.codingsByTarget, codebookNoteNames, codebookById: idx.codebookById,
  };

  // --- Pass 1: names ------------------------------------------------------
  // Every note is named before any is rendered, because notes link to each other
  // by name and a wikilink written before its target is named is a dead link.
  const taken = new Set();
  const sources = loaded.sources.filter((s) => s.obj).map((s) => s.obj)
    .sort((a, b) => (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0));

  const sourceNotes = new Map();
  for (const src of sources) {
    const reps = src.representations || [];
    const kind = vaultKindFor(src, reps, profile);
    const base = opts.filenames === "citation" ? citationStem(src) : titleFor(src, "source_id");
    const name = claimName(base, src.source_id, taken);
    sourceNotes.set(src.source_id, { name, kind, src, reps });
  }

  const derived = [];
  for (const g of loaded.generations) {
    derived.push({ kind: "generation", obj: g.obj, id: g.obj.generation_id, from: g.from });
  }
  for (const y of loaded.syntheses) {
    derived.push({ kind: "synthesis", obj: y.obj, id: y.obj.synthesis_id, dirRel: y.dirRel });
  }
  derived.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const derivedNotes = new Map();
  for (const d of derived) {
    const base = U.safeTitle(d.obj.title || d.obj.question || d.id);
    derivedNotes.set(d.id, { name: claimName(base, d.id, taken), entry: d });
  }

  const codebookNotes = new Map();
  for (const [id, book] of [...idx.codebookById].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const base = U.safeTitle(book.title || `${book.namespace} ${book.slug}`);
    const name = claimName(base, id, taken);
    codebookNotes.set(id, { name, book });
    codebookNoteNames.set(id, name);
  }

  // --- Pass 2: attachments -------------------------------------------------
  const attachments = [];
  const attachByRep = new Map();
  const attachByBasename = new Map();
  const attachTaken = new Set();
  for (const rep of loaded.representations.slice()
    .sort((a, b) => (a.obj.representation_id < b.obj.representation_id ? -1 : 1))) {
    if (!isImageRep(rep.obj)) continue;
    if (!rep.contained || !rep.abs || !fs.existsSync(rep.abs)) {
      ctxWarnings.push({ code: "image_unreadable", object: rep.obj.representation_id, detail: rep.obj.path });
      continue;
    }
    const ext = path.posix.extname(rep.obj.path || "") || "";
    const owner = sourceNotes.get(rep.sourceId);
    const stem = opts.imageNames === "citation" && owner
      ? `${owner.name} - ${rep.obj.representation_id}`
      : rep.obj.representation_id;
    let name = U.safeTitle(stem) + ext;
    while (attachTaken.has(name.toLowerCase())) name = U.safeTitle(`${stem} ${rep.sourceId}`) + ext;
    attachTaken.add(name.toLowerCase());
    const record = { name, repId: rep.obj.representation_id, from: rep.abs, to: posix(attachDir, name) };
    attachments.push(record);
    attachByRep.set(rep.obj.representation_id, record);
    attachByBasename.set(path.posix.basename(rep.obj.path || ""), record);
  }

  // --- Pass 3: notes -------------------------------------------------------
  const notes = [];
  const counts = { sources: 0, generations: 0, syntheses: 0, codebooks: 0, images: attachments.length,
    quotes_verified: 0, quotes_failed: 0, paraphrases: 0, stripped: {} };

  const noteFolder = (kind) => {
    if (inboxMode) return routes.inbox;
    const k = profile.source_kinds[kind];
    return posix(sourcesRoot, `${routes.sources_root.number}.${pad2(k.number)} ${k.label}`, domainLabel);
  };

  const baseFrontmatter = (extra) => {
    const fm = { type: "source", status: "raw" };
    // In inbox mode `domain` is deliberately left unset: guessing one would file the
    // note into the wrong folder of a live vault. The vault's own schema documents
    // this exact escape hatch — an unclassifiable note waits in the inbox at
    // `status: raw` for the processor that owns classification.
    if (!inboxMode) fm.domain = domainValue;
    return Object.assign(fm, extra);
  };

  for (const src of sources) {
    const meta = sourceNotes.get(src.source_id);
    const bib = src.bibliographic || {};
    const reps = meta.reps;
    const warnings = [];

    // Body ---------------------------------------------------------------
    const choice = chooseBodyRep(reps, profile, idx.lookupRep, !!opts.allowRewriteBody);
    let body = "", removed = {}, bodyRep = choice.rep, embedded = new Set();
    if (bodyRep) {
      const entry = idx.repById.get(bodyRep.representation_id);
      if (entry && entry.contained && entry.abs && fs.existsSync(entry.abs)) {
        const rec = U.getRepFile(entry.abs);
        if (rec.utf8ok) {
          const stripped = stripBoilerplate(rec.text, strip);
          removed = stripped.removed;
          warnings.push(...stripped.warnings);
          const relinked = relinkImages(normalizeHeadings(stripped.text), attachByBasename);
          body = relinked.text;
          embedded = relinked.embedded;
        } else {
          warnings.push({ code: "body_not_utf8", object: bodyRep.representation_id, detail: bodyRep.path });
          bodyRep = null;
        }
      } else {
        warnings.push({ code: "body_unreadable", object: bodyRep.representation_id, detail: bodyRep.path });
        bodyRep = null;
      }
    } else if (choice.skippedRewrites) {
      warnings.push({
        code: "body_only_rewritten",
        object: src.source_id,
        detail: `${choice.skippedRewrites} textual representation(s) are model rewrites; pass --allow-rewrite-body to read one`,
      });
    }
    for (const k of Object.keys(removed)) counts.stripped[k] = (counts.stripped[k] || 0) + removed[k];

    // Figures --------------------------------------------------------------
    // An image the body already referenced is embedded in place; the rest are
    // gathered so a figure is never silently dropped from the note.
    const images = reps.filter(isImageRep).filter((r) => attachByRep.has(r.representation_id));
    const figures = [];
    images.forEach((rep, i) => {
      const record = attachByRep.get(rep.representation_id);
      const ocrRep = reps.find((r) => r.parent_representation_ref === rep.representation_id && r.role === "ocr");
      const ocrExt = ocrRep && (idx.extsBySource.get(src.source_id) || [])
        .find((e) => e.representation_ref === ocrRep.representation_id && e.direct_quote != null);
      figures.push({
        rep, record, inline: embedded.has(record.name),
        block: figureBlock(rep, record.name, i + 1, ocrExt ? ocrExt.extraction_id : null),
      });
    });
    const orphanFigures = figures.filter((f) => !f.inline);

    // Evidence -------------------------------------------------------------
    const all = idx.extsBySource.get(src.source_id) || [];
    const active = all.filter((e) => (e.status || "active") === "active");
    const inactive = all.length - active.length;
    const gated = [], failed = [], paraphrases = [];
    for (const ext of active) {
      const entry = idx.repById.get(ext.representation_ref);
      const readable = entry && entry.contained && entry.abs && fs.existsSync(entry.abs);
      const rec = readable ? U.getRepFile(entry.abs) : null;
      const { badge } = U.badgeForExtraction(ext, entry ? entry.obj : null, rec, idx.lookupRep);
      const item = {
        extId: ext.extraction_id, badge, quote: ext.direct_quote, text: ext.text,
        repPath: entry ? entry.obj.path : null,
        range: ext.locator && ext.locator.type === "char_range" ? ext.locator.value : null,
        line: null, type: ext.type,
      };
      if (rec && rec.utf8ok && item.range && U.VERIFIED_BADGES.has(badge)) {
        item.line = U.lineRangeForCharRange(rec.text, item.range.start, item.range.end);
      }
      if (badge === "paraphrase" || badge === "unverifiable") paraphrases.push(item);
      else if (badge === "failed") failed.push(item);
      else gated.push(item);
    }
    counts.quotes_verified += gated.length;
    counts.quotes_failed += failed.length;
    counts.paraphrases += paraphrases.length;

    // Assemble -------------------------------------------------------------
    const blocks = [];
    const footnotes = [];
    blocks.push(`# ${meta.name}`);
    if (bib.abstract) blocks.push(renderCallout("summary", "", String(bib.abstract).split("\n"), false));
    if (body) blocks.push(body.trimEnd());
    if (orphanFigures.length) {
      blocks.push("## Figures");
      for (const f of orphanFigures) blocks.push(f.block);
    }

    if (paraphrases.length) {
      // Kept out of the evidence callout on purpose. §09 forbids rendering a
      // paraphrase in quotation marks or a blockquote, and an Obsidian callout IS
      // a blockquote — so the ungated readings live here, as plain prose, and the
      // green evidence block stays reserved for material that passed the gate.
      blocks.push("## Extractions");
      blocks.push("Readings recorded against this source. These are paraphrases and image-region readings, not quotations: they were never gate-checked and must not be cited as the source's words.");
      blocks.push(paraphrases.map((p) => {
        const bits = [`\`${p.extId}\``, p.type];
        if (p.type === "image_region") bits.push("region is an inference, recorded not gated");
        const chips = codeLines(p.extId, ctx);
        const head = `- ${p.text || "(no text)"} — ${bits.join(", ")}`;
        return chips.length ? [head, ...chips.map((c) => `  ${c}`)].join("\n") : head;
      }).join("\n"));
    }

    blocks.push(...codesSection(src.source_id, reps, ctx));

    if (gated.length) {
      const lines = [];
      gated.forEach((item, i) => {
        if (i) lines.push("");
        lines.push(...evidenceLines(item));
        lines.push(...codeLines(item.extId, ctx));
        footnotes.push(evidenceFootnote(item));
      });
      blocks.push(renderCallout("evidence", "Evidence", lines, false));
    }

    if (failed.length) {
      // A broken corpus must never look clean (§09). The banner is per-note here and
      // repeated in the export report, so neither reading path can miss it.
      const n = failed.length;
      const lines = [`${n} quotation${n === 1 ? "" : "s"} recorded against this source no longer ${n === 1 ? "matches" : "match"} the representation byte-for-byte. ${n === 1 ? "It is" : "They are"} shown by id only — quoting text that failed its gate is exactly what the gate exists to prevent.`, ""];
      for (const f of failed) lines.push(`- \`${f.extId}\` — run \`upc verify ${f.extId} --corpus <corpus>\``);
      blocks.push(renderCallout("caution", "Failed quotation gates", lines, false));
    }

    // Connections ----------------------------------------------------------
    const connections = [];
    for (const rel of src.relations || []) {
      const target = sourceNotes.get(rel.target);
      connections.push(target ? `- [[${target.name}]] — \`${rel.type}\`` : `- \`${rel.target}\` — \`${rel.type}\``);
    }
    for (const genId of src.generations || []) {
      const d = derivedNotes.get(genId);
      if (d) connections.push(`- [[${d.name}]] — generated from this source`);
    }
    if (connections.length) blocks.push(renderCallout("connections", "Connections", connections, true));

    // Provenance -----------------------------------------------------------
    const retrieval = src.retrieval || {};
    const url = retrieval.original_url || bib.url || retrieval.final_url || "";
    const stamp = src.provenance || {};
    const by = stamp.produced_by || {};
    const originGroup = [`Source \`${src.source_id}\`${url ? ` — ${url}` : ""}`];
    if (retrieval.fetched_at || by.tool) {
      const bits = [];
      if (retrieval.fetched_at) bits.push(`Retrieved ${retrieval.fetched_at}`);
      if (by.tool) bits.push(`by \`${by.tool}${by.tool_version ? " " + by.tool_version : ""}\``);
      if (retrieval.fetch_method) bits.push(`(${retrieval.fetch_method})`);
      if (retrieval.http_status) bits.push(`HTTP ${retrieval.http_status}`);
      originGroup.push(bits.join(" ") + ".");
    }
    const primaryPath = (reps[0] || {}).path;
    if (primaryPath) originGroup.push(`Original file: \`${path.posix.basename(primaryPath)}\`.`);
    for (const ident of src.identifiers || []) originGroup.push(`${ident.scheme.toUpperCase()}: ${ident.value}`);

    const bodyGroup = [];
    if (bodyRep) {
      bodyGroup.push(`Body from \`${bodyRep.representation_id}\` (${bodyRep.role}${bodyRep.produced_by ? ", " + bodyRep.produced_by : ""}), sha256 \`${U.bareHash(bodyRep.sha256 || "").slice(0, 12)}\`.`);
      if (choice.rewritten) {
        bodyGroup.push("This representation is a MODEL REWRITE of its parent, not the source's own words. Quotations above are gated against the representation named with each one, never against this body.");
      }
      bodyGroup.push(strippedSummary(removed));
    } else {
      bodyGroup.push("No readable textual representation; this note carries metadata only.");
    }
    if (inactive) bodyGroup.push(`${inactive} superseded/retracted extraction${inactive === 1 ? "" : "s"} not shown.`);

    const repGroup = reps.map((r) => `- \`${r.representation_id}\` ${r.role} — ${r.path}`);

    blocks.push(renderCallout("provenance", "How this note was made", provenanceLines(ctx, {
      lead: `Exported by \`upc export --format obsidian\` from UPC corpus \`${corpusId}\`.`,
      groups: [
        { title: null, lines: originGroup },
        { title: null, lines: bodyGroup },
        { title: "Representations:", lines: repGroup },
      ],
    }), true));

    // Sources + Notes + footnotes -------------------------------------------
    const sourceLines = [];
    if (url) {
      const host = (url.match(/^https?:\/\/([^/]+)/) || [])[1] || "";
      sourceLines.push(`- [${bib.title || meta.name}${host ? " — " + host : ""}](${url})`);
    }
    const authors = (bib.authors || []).map(contributorName).filter(Boolean);
    if (authors.length) sourceLines.push(`- ${authors.join("; ")}${yearOf(bib.issued) ? ` (${yearOf(bib.issued)})` : ""}${bib.container_title ? `. *${bib.container_title}*` : ""}.`);
    if (sourceLines.length) blocks.push("## Sources", sourceLines.join("\n"));
    blocks.push("## Notes", "");
    if (footnotes.length) blocks.push(footnotes.join("\n"));

    const frontmatter = baseFrontmatter({
      people: authors.map(wikilink),
      organization: bib.publisher ? wikilink(bib.publisher) : undefined,
      source_kind: meta.kind,
      capture_type: "imported",
      date: vaultDate(bib.issued) || undefined,
    });
    if (opts.frontmatter === "extended") {
      frontmatter.url = url || undefined;
      frontmatter.upc_source_id = src.source_id;
      frontmatter.upc_corpus_id = corpusId;
    }

    notes.push({
      path: posix(noteFolder(meta.kind), `${meta.name}.md`),
      kind: "source", objectId: src.source_id, frontmatter, blocks, warnings,
      text: serializeFrontmatter(frontmatter, profile) + "\n" + blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    });
    counts.sources++;
    ctxWarnings.push(...warnings.map((w) => Object.assign({ note: meta.name }, w)));
  }

  // --- Derived notes: generations and syntheses ---------------------------
  const genKind = profile.kind_mapping.generated;
  for (const [id, { name, entry }] of derivedNotes) {
    const obj = entry.obj;
    const stamp = obj.provenance || {};
    const by = stamp.produced_by || {};
    const out = obj.output || {};
    let body = "";
    if (out.path) {
      const { abs, contained } = U.resolveInside(loaded.root, out.path);
      if (contained && fs.existsSync(abs)) {
        const rec = U.getRepFile(abs);
        if (rec.utf8ok) body = normalizeHeadings(rec.text).trimEnd();
      }
    } else if (typeof out.value === "string") {
      body = normalizeHeadings(out.value).trimEnd();
    }

    const blocks = [`# ${name}`];
    if (obj.question) blocks.push(renderCallout("summary", "", [obj.question], false));
    if (body) blocks.push(body);
    else blocks.push("_The output for this object is not readable from the corpus._");

    if (Array.isArray(obj.claims) && obj.claims.length) {
      blocks.push("## Claims");
      blocks.push(obj.claims.map((c) => {
        const ev = (c.evidence_ids || []).map((e) => `\`${e}\``).join(", ");
        return `- ${c.text}${ev ? ` — evidence: ${ev}` : ""}${c.confidence ? ` (${c.confidence})` : ""}`;
      }).join("\n"));
    }

    const cited = [];
    for (const sid of (stamp.derived_from || {}).source_ids || []) {
      const s = sourceNotes.get(sid);
      if (s) cited.push(`- [[${s.name}]]`);
    }
    if (cited.length) blocks.push(renderCallout("connections", "Sources this draws on", cited, true));

    const madeBy = [`Object \`${id}\` (${entry.kind}) in UPC corpus \`${corpusId}\`.`];
    if (by.tool) madeBy.push(`Produced by \`${by.tool}${by.tool_version ? " " + by.tool_version : ""}\`${by.model ? ` using model \`${by.model}\`` : ""}${by.method ? ` (${by.method})` : ""}.`);
    if (by.prompt_version) madeBy.push(`Prompt \`${by.prompt_version}\`.`);
    if (stamp.input_digest) madeBy.push(`Input digest \`${U.bareHash(stamp.input_digest).slice(0, 12)}\`.`);
    if (obj.stale) madeBy.push("Marked STALE in the corpus: its inputs changed after it was produced.");
    madeBy.push("This is model-written material, not a source's own words.");

    const frontmatter = baseFrontmatter({
      source_kind: genKind,
      capture_type: "generated",
    });
    if (opts.frontmatter === "extended") frontmatter.upc_corpus_id = corpusId;

    blocks.push(renderCallout("provenance", "How this note was made", provenanceLines(ctx, {
      lead: `Exported by \`upc export --format obsidian\` from UPC corpus \`${corpusId}\`.`,
      groups: [{ title: null, lines: madeBy }],
    }), true));
    blocks.push("## Notes", "");

    notes.push({
      path: posix(noteFolder(genKind), `${name}.md`),
      kind: entry.kind, objectId: id, frontmatter, blocks, warnings: [],
      text: serializeFrontmatter(frontmatter, profile) + "\n" + blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    });
    if (entry.kind === "generation") counts.generations++; else counts.syntheses++;
  }

  // --- Codebook notes ------------------------------------------------------
  // §09 requires a code's definition to be at most one interaction away. A chip
  // links to a heading in these notes, so an undefined code cannot reach a reader
  // as uninterpretable jargon.
  for (const [id, { name, book }] of codebookNotes) {
    const blocks = [`# ${name}`];
    if (book.question) blocks.push(renderCallout("summary", "", [book.question], false));
    blocks.push(`A coding scheme from the corpus: namespace \`${book.namespace}\`, slug \`${book.slug}\`, ${book.closed ? "closed" : "open"}${book.multi_label ? ", multi-label" : ""}.`);
    for (const code of book.codes || []) {
      blocks.push(`## ${code.code}`);
      const bits = [];
      if (code.label) bits.push(`**${code.label}**`);
      if (code.definition) bits.push(code.definition);
      if (code.parent) bits.push(`Parent: \`${code.parent}\`.`);
      if (code.deprecated) bits.push("_Deprecated._");
      blocks.push(bits.join("\n\n") || "_No definition recorded._");
    }
    const frontmatter = { type: "system", status: "raw", subdomain: "schemas", capture_type: "imported" };
    if (!inboxMode) frontmatter.domain = "meta";
    blocks.push(renderCallout("provenance", "How this note was made", provenanceLines(ctx, {
      lead: `Exported by \`upc export --format obsidian\` from UPC corpus \`${corpusId}\`.`,
      groups: [{ title: null, lines: [`Codebook \`${id}\`, revision ${book.revision != null ? book.revision : "unrecorded"}.`] }],
    }), true));
    notes.push({
      path: posix(inboxMode ? routes.inbox : metaSub("schemas"), `${name}.md`),
      kind: "codebook", objectId: id, frontmatter, blocks, warnings: [],
      text: serializeFrontmatter(frontmatter, profile) + "\n" + blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    });
    counts.codebooks++;
  }

  const plan = {
    mode: inboxMode ? "inbox" : "vault",
    corpusId, exportId, specVersion,
    domain: { value: domainValue, label: domainLabel },
    notes: notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    attachments,
    scaffold: inboxMode ? [] : buildScaffold(profile, { domainValue, domainLabel, sourcesRoot, metaRoot, metaSub, corpusId, specVersion, exportId }),
    counts,
    warnings: ctxWarnings,
  };
  plan.report = buildReport(plan);
  return plan;
}

// ---------------------------------------------------------------------------
// Standalone scaffold
//
// A standalone export ships the notes that make the vault self-describing: the
// schema its own frontmatter validates against, the format note its blocks follow,
// and a Bases dashboard so the sources are browsable the moment it opens. They are
// GENERATED FROM THE PROFILE, not copied from anyone's vault, so the two cannot
// drift and the export carries no vault's private conventions it did not compute.
// ---------------------------------------------------------------------------

function buildScaffold(profile, v) {
  const routes = profile.routes;
  const fm = profile.frontmatter;
  const files = [];
  const kinds = Object.entries(profile.source_kinds).sort((a, b) => a[1].number - b[1].number);

  const schemaRows = fm.property_order
    .map((k) => {
      const p = fm.properties[k] || {};
      const req = p.required ? "yes" : p.required_when ? "conditional" : "no";
      return `| \`${k}\` | ${req} | ${p.shape}${p.human_owned ? ", human-owned" : ""} |`;
    }).join("\n");
  const kindRows = kinds.map(([value, k]) => `| \`${value}\` | \`${k.number}\` | \`${k.label}\` |`).join("\n");

  files.push({
    path: `${v.metaSub("schemas")}/0.00 Vault Schema.md`,
    text: `---
type: system
status: active
domain: meta
subdomain: schemas
capture_type: generated
---

# Vault Schema

Metadata and folder routing for this vault. **Generated** by
\`upc export --format obsidian\` from the UPC Obsidian profile
(\`${profile.profile_id}\`); it is a projection, and editing it by hand is
overwritten on the next export.

This vault is a projection of UPC corpus \`${v.corpusId}\` (spec ${v.specVersion}),
export \`${v.exportId}\`. The corpus is the source of truth: correct a fact there
and re-export, never here.

## Approved properties

Properties must appear in this order when present.

| Property | Required | Shape |
| --- | --- | --- |
${schemaRows}

## Note types

- \`source\` — an external source: the corpus objects this vault was built from.
- \`system\` — vault infrastructure: this note, codebooks, and the export report.

## Status values

- \`raw\` — exported and not yet reviewed by a person.
- \`active\`, \`in-progress\`, \`complete\`, \`someday\`, \`archived\` — as a reader sets them.

## Domains

| Value | Number | Label |
| --- | --- | --- |
| \`${v.domainValue}\` | \`1\` | \`${v.domainLabel}\` |
| \`meta\` | \`${routes.meta_root.number}\` | \`${routes.meta_root.label}\` |

## Sources root

| Number | Label |
| --- | --- |
| \`${routes.sources_root.number}\` | \`${routes.sources_root.label}\` |

## Source kinds

\`source_kind\` is required when \`type: source\`. Each kind names a folder under the
sources root, with the note's \`domain\` label following as an unnumbered subfolder.

| Value | Number | Label |
| --- | --- | --- |
${kindRows}

## Capture types

- \`imported\` — the note's body came from a representation in the corpus.
- \`generated\` — the note's body is model-written material (a generation or synthesis).
`,
  });

  files.push({
    path: `${v.metaSub("schemas")}/0.04 Note Format.md`,
    text: `---
type: system
status: active
domain: meta
subdomain: schemas
capture_type: generated
---

# Note Format

The blocks a note in this vault is assembled from, in this order. **Generated** by
\`upc export --format obsidian\`.

\`\`\`
frontmatter          schema-controlled; see 0.00 Vault Schema
# Title              exactly one level-one heading
> [!summary]         the lead — what this note is
<body>               the source's own text, boilerplate stripped
## Extractions       ungated readings; never quotations
> [!evidence]        gate-verified quotations, with their badge
> [!caution]         quotations whose gate failed
> [!connections]-    links out
> [!provenance]-     how this note was made
## Sources           a plain bullet list of links
## Notes             owner-authored; never written, never read
[^ext-…]: …          footnote definitions, unheaded, at the end of the file
\`\`\`

## Callout registry

| Callout | Means | Folded |
| --- | --- | --- |
| \`summary\` | Orientation — what this note is | no |
| \`evidence\` | Gate-verified quotation, with its citation | no |
| \`caution\` | A quotation whose byte-exact gate failed | no |
| \`info\` | A figure's caption (stock Obsidian callout) | yes |
| \`connections\` | Relations to other notes | yes |
| \`provenance\` | How this note was made | yes |

## What the exporter will not do

- **\`## Notes\` is never written and never read.** It is yours; a re-export carries
  it across untouched.
- **A paraphrase is never styled as a quotation.** Ungated readings live under
  \`## Extractions\` as plain prose, never in quotation marks or a callout.
- **A quotation is never shown without its badge.** \`verified\` means checked
  byte-for-byte against the representation named in its footnote — which for an OCR
  or transcript is not the same claim as checked against the original.
`,
  });

  // Two Obsidian settings the notes depend on, written only for a STANDALONE vault
  // (never for --into, where the config is the vault owner's). Every note writes an
  // explicit `# Title` because the block grammar requires one, so leaving the inline
  // title on shows every title twice; and frontmatter here is machine metadata, not
  // something a reader should meet at the top of each note.
  files.push({
    path: ".obsidian/app.json",
    text: JSON.stringify({ showInlineTitle: false, propertiesInDocument: "hidden", alwaysUpdateLinks: true }, null, 2) + "\n",
  });

  files.push({
    path: `${v.metaSub("dashboards")}/_Sources.base`,
    text: `filters:
  and:
    - type == "source"
formulas:
  when: if(note.date, note.date.format("YYYY-MM-DD"), "")
properties:
  file.name:
    displayName: Source
  source_kind:
    displayName: Kind
  status:
    displayName: Status
  formula.when:
    displayName: Date
views:
  - type: table
    name: By kind
    groupBy:
      property: source_kind
      direction: ASC
    order:
      - file.name
      - status
      - formula.when
    sort:
      - property: file.name
        direction: ASC
    limit: 500
`,
  });

  files.push({
    path: `${v.metaSub("dashboards")}/_Sources.md`,
    text: `---
type: index
status: active
domain: meta
subdomain: dashboards
capture_type: generated
---

# Sources

Every source note in this vault, grouped by kind.

![[_Sources.base]]
`,
  });

  return files;
}

/** The export report. A corpus with a failed gate must not produce a vault that
 *  looks clean, so the counts and every warning land in a note of their own as
 *  well as in the per-note caution blocks. */
function buildReport(plan) {
  const c = plan.counts;
  const stripped = Object.keys(c.stripped).sort().map((k) => `| \`${k}\` | ${c.stripped[k]} |`).join("\n");
  const warnRows = plan.warnings.map((w) => `| \`${w.code}\` | ${w.note || w.object || ""} | ${(w.detail || "").replace(/\|/g, "\\|")} |`).join("\n");
  const body = `---
type: system
status: active
domain: meta
subdomain: maintenance
capture_type: generated
---

# UPC Export Report

Corpus \`${plan.corpusId}\` (spec ${plan.specVersion}), export \`${plan.exportId}\`.

${c.quotes_failed ? `> [!caution] ${c.quotes_failed} quotation gate failure${c.quotes_failed === 1 ? "" : "s"}
> ${c.quotes_failed} quotation${c.quotes_failed === 1 ? " no longer matches" : "s no longer match"} the representation byte-for-byte. Those notes show the ids rather than the text. Run \`upc validate\` on the corpus — this vault is a projection and cannot be the place you fix it.
` : `> [!summary]
> Every quotation in this export passed its byte-exact gate.
`}
## Counts

| What | Count |
| --- | --- |
| Source notes | ${c.sources} |
| Generation notes | ${c.generations} |
| Synthesis notes | ${c.syntheses} |
| Codebook notes | ${c.codebooks} |
| Images | ${c.images} |
| Verified quotations | ${c.quotes_verified} |
| Failed quotations | ${c.quotes_failed} |
| Ungated readings | ${c.paraphrases} |

## Stripped at export

${stripped ? `| Class | Lines |\n| --- | --- |\n${stripped}` : "Nothing was stripped."}

## Warnings

${warnRows ? `| Code | Where | Detail |\n| --- | --- | --- |\n${warnRows}` : "None."}

## Notes
`;
  return { path: null, text: body };
}

// ---------------------------------------------------------------------------
// Writing
//
// A projection is regenerable; a vault is somewhere a person writes. Both hold
// because the export is byte-idempotent and remembers what it wrote: a file that
// still matches the manifest is refreshed, and a file a person has touched is
// LEFT ALONE and reported. The vault schema's own rule is "never overwrite an
// existing file; on a collision, record the conflict", and this is that rule.
// ---------------------------------------------------------------------------

const MANIFEST_NAME = "export-manifest.json";

function manifestPath(profile, corpusId) {
  const r = profile.routes;
  const w = r.meta_subdomains.workflows;
  return posix(`${pad2(r.meta_root.number)} ${r.meta_root.label}`,
    `${r.meta_root.number}.${pad2(w.number)} ${w.label}`, "UPC Export", corpusId, MANIFEST_NAME);
}

/** The owner's `## Notes` section, carried across a rewrite verbatim. Never read
 *  for content, only preserved — the vault's rule is that no tool writes it and no
 *  tool quotes it back, and losing it on re-export would be exactly the same
 *  betrayal as writing into it. */
function carriedNotes(existingText) {
  const m = /\n## Notes\n([\s\S]*?)(?=\n## |\n\[\^|$)/.exec(existingText);
  const kept = m ? m[1].replace(/^\n+|\s+$/g, "") : "";
  return kept;
}

function withCarriedNotes(text, existingText) {
  const kept = carriedNotes(existingText);
  if (!kept) return text;
  return text.replace(/(\n## Notes\n)(\n*)/, `$1\n${kept}\n\n`);
}

/**
 * Write a vault. `outDir` for a standalone one, `into` for an existing vault's
 * inbox. Returns `{ status, mode, out, wrote, skipped, counts, warnings }`.
 */
export function writeVault(root, opts = {}) {
  const loaded = U.loadCorpus(root);
  U.clearRepCache();
  const inbox = !!opts.into;
  const target = path.resolve(inbox ? opts.into : (opts.outDir || ""));
  if (!target || target === path.resolve("")) {
    throw new Error("obsidian export requires -o <dir> (standalone) or --into <vault>");
  }
  if (inbox && !fs.existsSync(path.join(target, ".obsidian"))) {
    throw new Error(`--into ${opts.into}: no .obsidian directory there, so it is not a vault`);
  }
  const profile = loadProfile(opts.profileFile);
  const plan = buildVaultPlan(loaded, Object.assign({}, opts, { profile, inbox }));

  const manifestRel = manifestPath(profile, plan.corpusId);
  const manifestAbs = path.join(target, manifestRel);
  const previous = fs.existsSync(manifestAbs) ? (U.readJSON(manifestAbs).files || {}) : {};

  const wrote = [], skipped = [], files = {};
  const put = (rel, text) => {
    const abs = path.join(target, rel);
    let out = text;
    if (fs.existsSync(abs)) {
      const current = fs.readFileSync(abs, "utf8");
      const known = previous[rel];
      if (!known || U.sha256Hex(Buffer.from(current, "utf8")) !== known) {
        if (!opts.force) {
          skipped.push({ path: rel, reason: known ? "modified_since_export" : "exists_unknown" });
          files[rel] = known || U.sha256Hex(Buffer.from(current, "utf8"));
          return;
        }
      }
      out = withCarriedNotes(out, current);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    U.atomicWriteFile(abs, out);
    files[rel] = U.sha256Hex(Buffer.from(out, "utf8"));
    wrote.push(rel);
  };

  for (const f of plan.scaffold) put(f.path, f.text);
  for (const n of plan.notes) put(n.path, n.text);

  const reportRel = posix(
    `${pad2(profile.routes.meta_root.number)} ${profile.routes.meta_root.label}`,
    `${profile.routes.meta_root.number}.${pad2(profile.routes.meta_subdomains.maintenance.number)} ${profile.routes.meta_subdomains.maintenance.label}`,
    `UPC Export Report (${plan.corpusId}).md`);
  put(reportRel, plan.report.text);

  for (const a of plan.attachments) {
    const abs = path.join(target, a.to);
    const bytes = fs.readFileSync(a.from);
    const digest = U.sha256Hex(bytes);
    if (fs.existsSync(abs)) {
      // An attachment is content-addressed by construction: same id, same bytes. If
      // what is there already hashes the same, rewriting it is pure churn.
      if (U.sha256Hex(fs.readFileSync(abs)) === digest) { files[a.to] = digest; continue; }
      if (!opts.force) { skipped.push({ path: a.to, reason: "differs_from_corpus" }); continue; }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    U.atomicWriteFile(abs, bytes);
    files[a.to] = digest;
    wrote.push(a.to);
  }

  if (!inbox) fs.mkdirSync(path.join(target, profile.routes.inbox), { recursive: true });

  fs.mkdirSync(path.dirname(manifestAbs), { recursive: true });
  U.atomicWriteFile(manifestAbs, JSON.stringify({
    corpus_id: plan.corpusId, upc_spec_version: plan.specVersion, export_id: plan.exportId,
    mode: plan.mode, profile: profile.profile_id,
    files: Object.keys(files).sort().reduce((o, k) => (o[k] = files[k], o), {}),
  }, null, 2) + "\n");

  return {
    status: skipped.length && !opts.force ? "partial" : "ok",
    mode: plan.mode, out: target, export_id: plan.exportId,
    wrote: wrote.sort(), skipped, counts: plan.counts, warnings: plan.warnings,
  };
}
