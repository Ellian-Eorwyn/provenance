#!/usr/bin/env node
/**
 * upc export --format site — the researcher-facing projection.
 *
 * `index.html` (build-index.mjs) is a *verification* surface: it exists to show
 * whether a corpus's quotations hold up, and it speaks the standard's own
 * vocabulary. This is the other audience. A colleague opening this has a
 * question about the literature, not about the corpus, and should never meet the
 * words extraction, representation, locator, or hop.
 *
 * Four properties are deliberate:
 *
 *   - **It reads from the bytes.** Every quotation and its surrounding context
 *     is sliced out of the representation file at build time and re-gated, so a
 *     page cannot show a quotation the corpus can no longer prove. A failure is
 *     rendered as a failure, never quietly omitted.
 *   - **It is a pile of files, not an app.** No fetch, no router, no CDN. Data
 *     rides in `<script src>` so every page works from `file://`, which is what
 *     "email someone the folder" actually requires.
 *   - **A code is a judgement, not a check mark.** §09 forbids styling the two
 *     alike, and forbids showing a code without its coder or resolving a
 *     disagreement on the reader's behalf. That is enforced here, not left to
 *     the person writing the template.
 *   - **Counts state their unit.** "212 passages · 41 sources" — never a bare
 *     number that silently mixes span-level and source-level judgements.
 */

import fs from "node:fs";
import path from "node:path";
import * as U from "./upc_common.mjs";
import { textBlocks, contextWindow, windowText, utf16Offsets } from "./context.mjs";
import { checkStructure, blocksU16, sectionsCompact, readingHtml, READING_JS, READING_CSS } from "./reading.mjs";
import * as IV from "./interviews.mjs";

const INLINE_TEXT_MAX = 2_000_000;   // a reading copy embedded straight into its page
const SIDECAR_TEXT_MAX = 8_000_000;  // ... or loaded from data/text/<rep>.js
const CONTEXT_MIN_ADDED = 40;        // characters "In context" must add to the passage to be offered

// --- plain English (docs/adoption-plan.md) --------------------------------

const BADGE_TEXT = {
  "verified": ["✓", "Checked against the original", "This quotation was compared with the source text character by character when this page was built."],
  "verified-to-transcript": ["✓", "Checked against the extracted text", "Compared with the text extracted from the PDF, not with the PDF's own layout. Wording is the author's; page numbers may differ."],
  "verified-to-rewrite": ["✓", "Checked against an edited copy", "Compared with a copy that a model rewrote, so the wording may differ from the author's original."],
  "failed": ["⚠", "Doesn't match the source", "The text at this position is no longer what the record says. Treat this quotation as unreliable until it is re-checked."],
  "paraphrase": ["✎", "Summary, not a quotation", "Someone's summary of the source in their own words. It is not quoted and has not been checked."],
  "unverifiable": ["?", "Not checkable", "This passage has no position in a text copy, so it could not be checked."],
};
const STATUS_TEXT = {
  active: "", needs_review: "Needs a look", superseded: "Replaced", retracted: "Withdrawn",
};

// "p. 14" is the PDF's 14th page, which is not always the number printed on it
// (a journal's page 412, a preprint's cover sheet), so the link says so on hover.
// The browse engine carries the same words (ORIGINAL in BROWSE_JS).
const ordinal = (n) => {
  const v = Number(n), t = v % 100;
  return `${v}${t >= 11 && t <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[v % 10] || "th"}`;
};
const PAGE_NOTE = "The page number printed on the paper may differ.";
const ORIGINAL_TIP = {
  pdf: (pg) => pg ? `Opens the original PDF at its ${ordinal(pg)} page. ${PAGE_NOTE}` : "Opens the original PDF.",
  doi: (pg) => "Opens the publisher's page for this paper." +
    (pg ? ` In the PDF, this passage is on the ${ordinal(pg)} page. ${PAGE_NOTE}` : ""),
  page: (pg) => `In the PDF, this passage is on the ${ordinal(pg)} page. ${PAGE_NOTE}`,
};

/** "See in original, p. 14 ↗": the PDF at that page when the PDFs travel with
 *  the site; otherwise the publisher's page by DOI; otherwise the bare page. */
function originalLinkHtml(page, pdfHref, doi) {
  if (pdfHref) {
    return ` <a class="muted orig" href="${pdfHref}${page ? `#page=${encodeURIComponent(page)}` : ""}" target="_blank" rel="noopener"` +
      ` title="${attr(ORIGINAL_TIP.pdf(page))}">See in original${page ? `, p. ${esc(page)}` : ""} ↗</a>`;
  }
  if (doi) {
    return ` <a class="muted orig" href="https://doi.org/${encodeURIComponent(doi)}" target="_blank" rel="noopener"` +
      ` title="${attr(ORIGINAL_TIP.doi(page))}">See in original (publisher) ↗</a>`;
  }
  return page ? ` <span class="muted orig" title="${attr(ORIGINAL_TIP.page(page))}">p. ${esc(page)}</span>` : "";
}

// A quotation that opens to the sentences around it ("In context"): the same
// attributes on the server's pages and in the browse engine (QUOTE_TOGGLE there).
const CONTEXT_TIP = "Show the sentences around it";
const quoteToggle = (fromPdf) =>
  `data-q="${fromPdf ? "pdf" : "text"}" tabindex="0" role="button" aria-expanded="false" title="${CONTEXT_TIP}"`;

// --- small helpers --------------------------------------------------------

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const attr = esc;
const j = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function authorList(bib) {
  const a = (bib && (bib.authors || bib.author)) || [];
  const names = a.map((x) => (typeof x === "string" ? x : [x.family, x.given].filter(Boolean).join(", "))).filter(Boolean);
  if (!names.length) return "";
  if (names.length <= 3) return names.join("; ");
  return names.slice(0, 3).join("; ") + " et al.";
}
function yearOf(bib) {
  const dp = bib && bib.issued && bib.issued.date_parts;
  return (dp && dp[0] && dp[0][0]) || "";
}
function shortCite(src) {
  const iv = IV.interviewOf(src);
  if (iv && iv.interviewee) return iv.date ? `${iv.interviewee}, ${IV.niceDate(iv.date)}` : iv.interviewee;
  const b = src.bibliographic || {};
  const a = (b.authors || [])[0];
  const fam = a ? (typeof a === "string" ? a.split(",")[0] : a.family) : (src.title || "Source").slice(0, 24);
  const y = yearOf(b);
  return y ? `${fam} ${y}` : String(fam);
}

// --- model ----------------------------------------------------------------

/**
 * Build everything the pages need, reading representation bytes once.
 * Pure apart from the file reads; the renderers below take only this.
 */
/** What a UPC object asks of the reader's site: its ext["upc-site"], or {}. */
const siteExt = (o) => ((o && o.ext) || {})["upc-site"] || {};
/** A codebook in the evidence group (1.15.0): ratings, kept apart from the topics. */
const isEvidence = (cb) => !!cb && siteExt(cb).group === "evidence";
/** A codebook whose codes are shown but offered as no filter (low agreement, say). */
const noFacet = (cb) => !!cb && siteExt(cb).facet === false;
/** How a revised synthesis labels itself: {label, date}. */
const revisionOf = (o) => {
  const r = siteExt(o).revision || {};
  return { label: r.label || "Revised", date: r.date || String((o.provenance || {}).created_at || "").slice(0, 10),
           note: r.note || "", first: o.supersedes };
};
// --- findings (1.15.0): a support matrix's statements in plain words --------
//
// A rated corpus records each statement's support on the IPCC scale (evidence ×
// agreement). The pages say four plain words instead, and keep the IPCC term in
// a tooltip and on the Methods page: readers came with a question about the
// literature, not about a confidence scale. Very high and high are one word.
const SUPPORT_KEYS = ["well", "some", "limited", "weak"];
const SUPPORT_WORDS = { well: "Well supported", some: "Some support", limited: "Limited", weak: "Weak or unclear" };
const SUPPORT_DOTS = { well: "●●●●", some: "●●●○", limited: "●●○○", weak: "●○○○" };
const IPCC_SUPPORT = { "very high": "well", high: "well", medium: "some", low: "limited", "very low": "weak" };
const KIND_WORDS = { finding: "Finding from data or cases", framework: "About a framework", argument: "Argument or interpretation",
                     recommendation: "Recommendation", unsupported: "Not backed by its passages" };
const PLACE_WORDS = { us: "United States", europe: "Europe", elsewhere: "Elsewhere", "not-stated": "No one place" };
/** A matrix claim's plain support key: the producer's own, or read off its IPCC term. */
const supportOf = (x) => SUPPORT_WORDS[x.support] ? x.support
  : IPCC_SUPPORT[String(x.ipcc || "").replace(/ confidence$/, "")] || "weak";
/** Does a statement fall under a starting point's `match`? groups and themes name
 *  the overview's scheme (slug) or theme (slug:code); the rest are any-of lists. */
function matchStart(f, m) {
  if (!m) return true;
  const g = f.group || "", t = f.theme || "";
  if (m.groups && m.groups.length && !m.groups.includes(g)) return false;
  if (m.themes && m.themes.length && !m.themes.includes(t)) return false;
  if (m.kinds && m.kinds.length && !m.kinds.includes(f.kind)) return false;
  if (m.support && m.support.length && !m.support.includes(f.support)) return false;
  if (m.places && m.places.length && !f.places.some((p) => m.places.includes(p))) return false;
  return true;
}
/** `--findings <json>`: starting points and wording for the Findings pages. */
export function readFindingsSettings(file) {
  if (!file) return null;
  const o = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  // A theme may be written as in an overview's markers (actor/installers) or as a key (actor:installers).
  const starts = (Array.isArray(o.starting_points) ? o.starting_points : []).map((x) => ({ ...x,
    match: x.match ? { ...x.match, ...(x.match.themes ? { themes: x.match.themes.map((t) => String(t).replace("/", ":")) } : {}) } : null }));
  return { starts, words: o.words || {}, mapPlace: o.map_place || "" };
}

const DATE_FMT = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || "");
  if (!m) return d || "";
  return `${+m[3]} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m[2] - 1]} ${m[1]}`;
};

export function buildSiteModel(loaded, opts = {}) {
  const repById = new Map();
  for (const r of loaded.representations) repById.set(r.obj.representation_id, r);
  const lookupRep = (id) => (repById.get(id) ? repById.get(id).obj : null);

  const srcById = new Map();
  for (const s of loaded.sources) srcById.set(s.obj.source_id, s.obj);

  // codebooks
  const codebooks = (loaded.codebooks || []).map((c) => c.obj);
  const cbkById = new Map(codebooks.map((c) => [c.codebook_id, c]));
  // Schemes in the "evidence" group (1.15.0): ratings of the evidence rather than
  // topics. They never change what a topical page shows (spec/09).
  const coderKind = new Map();
  for (const set of loaded.codingSets || []) {
    for (const c of set.obj.coders || []) coderKind.set(c.coder, c);
  }

  // codings, grouped by target
  const codingsByTarget = new Map();
  for (const c of loaded.codings || []) {
    const o = c.obj;
    if ((o.status || "active") !== "active") continue;
    const t = o.target || {};
    const key = `${t.kind}:${t.id}`;
    if (!codingsByTarget.has(key)) codingsByTarget.set(key, []);
    const cbk = cbkById.get(o.codebook_ref);
    const codeDef = cbk && (cbk.codes || []).find((x) => x.code === o.code);
    codingsByTarget.get(key).push({
      coding_id: o.coding_id,
      codebook_ref: o.codebook_ref,
      codebook_slug: cbk ? cbk.slug : o.codebook_ref,
      codebook_title: cbk ? cbk.title : o.codebook_ref,
      code: o.code,
      value: o.value,
      label: codeDef ? codeDef.label : (o.code || o.value),
      definition: codeDef ? codeDef.definition || "" : "",
      coder: o.coder,
      coder_kind: (coderKind.get(o.coder) || {}).kind || "",
      coder_model: (coderKind.get(o.coder) || {}).model || "",
      confidence: o.confidence || "",
      rationale: o.rationale || "",
      ev: isEvidence(cbk),
    });
  }

  // passages
  const passages = [];
  let failures = 0;
  // Per text, computed once: its blocks (context.mjs) and the codepoint → UTF-16 map.
  // A text with a structure map (a full-text XML's reading copy) knows what each block
  // is, so "In context" stops at a real heading and steps over a real caption.
  const perText = new Map();
  const textInfo = (rec, repId) => {
    if (!perText.has(rec)) {
      const blocks = textBlocks(rec.text), u16 = utf16Offsets(rec.text);
      const st = structureOf(loaded, repId, rec);
      if (st) structuredContext(blocks, st, u16);
      perText.set(rec, { blocks, u16 });
    }
    return perText.get(rec);
  };
  // Hidden sets (1.15.0): quotations that back a judgement (a rating's evidence),
  // checked like any other but never listed as passages.
  const hiddenTags = new Set((loaded.extractionSets || []).filter((x) => x.obj && siteExt(x.obj).hidden)
    .map((x) => "set:" + String(x.dirRel).split("/").pop()));
  const hiddenById = new Map();
  // An interview saved again (1.16.0) is a new source; the revision it supersedes steps aside.
  const retired = new Set(loaded.sources.filter((s) => IV.isSuperseded(s.obj)).map((s) => s.obj.source_id));
  for (const e of loaded.extractions) {
    const o = e.obj;
    if (retired.has(o.source_id)) continue;
    const repEntry = repById.get(o.representation_ref);
    if (hiddenTags.has(e.tag)) {
      let rec = null;
      if (repEntry && repEntry.contained && fs.existsSync(repEntry.abs)) {
        const r = U.getRepFile(repEntry.abs);
        if (r.utf8ok) rec = r;
      }
      hiddenById.set(o.extraction_id, { id: o.extraction_id, source_id: o.source_id, quote: o.direct_quote || "",
        badge: U.badgeForExtraction(o, repEntry ? repEntry.obj : null, rec, lookupRep).badge });
      continue;
    }
    const repObj = repEntry ? repEntry.obj : null;
    let repRec = null;
    if (repEntry && repEntry.contained && fs.existsSync(repEntry.abs)) {
      const rec = U.getRepFile(repEntry.abs);
      if (rec.utf8ok) repRec = rec;
    }
    const { badge } = U.badgeForExtraction(o, repObj, repRec, lookupRep);
    if (badge === "failed") failures++;

    let lineRange = null, actual = null, span = null, context = null, cx = null;
    if (repRec && o.locator && o.locator.type === "char_range") {
      const v = o.locator.value || {};
      const cps = repRec.cps;
      if (Number.isInteger(v.start) && Number.isInteger(v.end) && v.start <= v.end && v.end <= cps.length) {
        actual = cps.slice(v.start, v.end).join("");
        lineRange = U.lineRangeForCharRange(repRec.text, v.start, v.end);
        span = [v.start, v.end];   // codepoints; trusted for a highlight only once the badge says it verified
        // "In context": the whole sentences around it, sliced from the same bytes
        // at build time — and only around a quotation this build has just checked.
        if (U.VERIFIED_BADGES.has(badge) && v.start < v.end) {
          const ti = textInfo(repRec, o.representation_ref);
          const qa = ti.u16(v.start), qb = ti.u16(v.end);
          const win = contextWindow(repRec.text, qa, qb, { blocks: ti.blocks });
          const t = win && windowText(repRec.text, win, qa, qb);
          // A passage that is already all of its paragraph ("4.3. Skills" + two
          // sentences + "4.3.1. …") has nothing to expand to, and does not offer to.
          if (t && t[0].length - (t[2] - t[1]) >= CONTEXT_MIN_ADDED) {
            context = { segs: win.segs, lead: win.lead, tail: win.tail, at: [qa, qb] };   // UTF-16 units
            cx = t;
          }
        }
      }
    }
    const secondaryPage = (o.secondary_locators || []).find((s) => s.type === "page");
    const place = (o.secondary_locators || []).some((s) => s.type === "section" && s.block) ? U.placeOf(o) : "";
    const { time, speakers } = IV.timeOf(o);
    passages.push({
      id: o.extraction_id,
      source_id: o.source_id,
      rep: o.representation_ref,
      quote: o.direct_quote || "",
      note: o.text || "",
      badge,
      status: o.status || "active",
      type: o.type || "",
      query: o.query || "",
      confidence: o.confidence || "",
      anchoring: o.anchoring || null,
      actual, span, context, cx,
      line_range: lineRange,
      page: secondaryPage ? secondaryPage.value : null,
      place,                   // "§3.2 ¶4": a full-text XML's section and paragraph (paginate.py)
      time, speakers, names: IV.namesOf(o),
      codings: codingsByTarget.get(`extraction:${o.extraction_id}`) || [],
    });
  }
  const passageById = new Map(passages.map((p) => [p.id, p]));

  // sources
  const sources = loaded.sources.filter((s) => !retired.has(s.obj.source_id)).map((s) => {
    const o = s.obj;
    const mine = passages.filter((p) => p.source_id === o.source_id);
    const pdfs = (o.representations || []).filter((r) => /pdf$/.test(r.media_type));
    // The text read on the paper's page: the one its passages are anchored in (never a
    // publisher's XML original over the reading copy made from it).
    const anchored = new Map();
    for (const p of mine) anchored.set(p.rep, (anchored.get(p.rep) || 0) + 1);
    const textRep = U.readingCopyOf(o.representations, anchored);
    const parent = textRep && textRep.parent_representation_ref
      ? (o.representations || []).find((r) => r.representation_id === textRep.parent_representation_ref) : null;
    const xmlRep = parent && /^(text|application)\/xml$/.test(parent.media_type || "") ? parent : null;
    return {
      id: o.source_id,
      slug: String(s.dirRel).split("/").pop(),
      dirRel: s.dirRel,
      title: o.title || (o.bibliographic && o.bibliographic.title) || o.source_id,
      bibliographic: o.bibliographic || {},
      authors: authorList(o.bibliographic),
      year: yearOf(o.bibliographic),
      doi: (o.bibliographic && o.bibliographic.doi) || ((o.identifiers || []).find((i) => i.scheme === "doi") || {}).value || "",
      container: (o.bibliographic && (o.bibliographic.container_title || o.bibliographic["container-title"])) || "",
      aliases: o.aliases || {},
      cite: shortCite(o),
      passages: mine,
      textRep: textRep || null,
      pdfRep: pdfs[0] || null,
      xmlRep,                  // a publisher's full-text XML the reading copy was converted from
      structureRep: textRep ? (o.representations || []).find((r) => r.media_type === U.STRUCTURE_MEDIA_TYPE &&
        r.parent_representation_ref === textRep.representation_id) || null : null,
      codings: codingsByTarget.get(`source:${o.source_id}`) || [],
      // Recordings (1.16.0): the copy a page plays, its timings, an interview's record.
      interview: IV.interviewOf(o),
      audioRep: IV.playableAudio(o.representations),
      duration: (IV.playableAudio(o.representations) || {}).duration_seconds || 0,
      timingsRep: (o.representations || []).find((r) => r.media_type === U.TIMINGS_MEDIA_TYPE) || null,
      notesRep: IV.interviewOf(o) ? (o.representations || []).find((r) => r.role === "original" && r.produced_by === "import") || null : null,
    };
  });
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  for (const p of passages) {
    const s = sourceById.get(p.source_id);
    p.cite = s ? s.cite : p.source_id;
    p.source_title = s ? s.title : "";
    p.source_slug = s ? s.slug : "";
    p.year = s ? s.year : "";
  }

  // code index: unit-separated counts, computed here and never stored (§12)
  const codeIndex = new Map();
  const touch = (cbkId, code) => {
    const k = `${cbkId}:${code}`;
    if (!codeIndex.has(k)) codeIndex.set(k, { codebook_ref: cbkId, code, passages: [], sources: new Set(), coders: new Set() });
    return codeIndex.get(k);
  };
  for (const p of passages) {
    for (const c of p.codings) {
      const rec = touch(c.codebook_ref, c.code != null ? c.code : c.value);
      rec.passages.push(p.id);
      rec.sources.add(p.source_id);
      rec.coders.add(c.coder);
    }
  }
  for (const s of sources) {
    for (const c of s.codings) {
      const rec = touch(c.codebook_ref, c.code != null ? c.code : c.value);
      rec.sources.add(s.id);
      rec.coders.add(c.coder);
    }
  }

  // disagreement: two coders, one target, one single-label codebook, different labels
  for (const p of passages) {
    const byBook = new Map();
    for (const c of p.codings) {
      if (!byBook.has(c.codebook_ref)) byBook.set(c.codebook_ref, []);
      byBook.get(c.codebook_ref).push(c);
    }
    p.disagreements = [];
    for (const [cbkId, list] of byBook) {
      const cbk = cbkById.get(cbkId);
      if (cbk && cbk.multi_label === true) continue;
      if (isEvidence(cbk)) continue;     // shown as two chips where the rating is opened, not as a banner
      const labels = new Set(list.map((c) => (c.code != null ? c.code : c.value)));
      const coders = new Set(list.map((c) => c.coder));
      if (labels.size > 1 && coders.size > 1) p.disagreements.push(cbkId);
    }
  }

  // Group overviews by the scheme they were written for. A producer may say so
  // outright in `ext`; otherwise the title is a code's label, which is a lookup
  // and not a guess — and an ambiguous label is left ungrouped rather than filed
  // under whichever codebook happened to be read first.
  const labelOwner = new Map();
  for (const cb of codebooks) {
    for (const c of cb.codes || []) {
      const key = (c.label || c.code).toLowerCase();
      labelOwner.set(key, labelOwner.has(key) ? null : { cb, code: c });
    }
  }
  // A summary placed on the home page is not one of the themed overviews: it is
  // not listed, counted or grouped with them.
  const isHome = (o) => ((o.ext || {})["upc-site"] || {}).placement === "home";
  const allSyn = (loaded.syntheses || []).map((x) => x.obj).filter(Boolean);
  // Revisions (1.15.0, spec/04): a synthesis another one supersedes steps aside,
  // and the newest in the chain is shown at the address of the first, so every
  // link made to the theme keeps working.
  const synById = new Map(allSyn.map((o) => [o.synthesis_id, o]));
  const supersededIds = new Set(allSyn.map((o) => o.supersedes).filter((id) => synById.has(id)));
  const isSuperseded = (o) => supersededIds.has(o.synthesis_id) || !!(o.superseded_by && synById.has(o.superseded_by));
  const firstOf = (o) => {
    let x = o;
    const seen = new Set([o.synthesis_id]);
    while (x.supersedes && synById.has(x.supersedes) && !seen.has(x.supersedes)) { seen.add(x.supersedes); x = synById.get(x.supersedes); }
    return x.synthesis_id;
  };
  // A statement-support matrix: an evidence_matrix derived from an overview. It
  // joins that overview's claims table instead of being an overview of its own.
  const supportFor = (o) => o.type === "evidence_matrix"
    ? (((o.provenance || {}).derived_from || {}).synthesis_ids || [])
        .filter((id) => synById.has(id) && synById.get(id).type !== "evidence_matrix") : [];
  const supports = new Map();
  for (const o of allSyn) {
    for (const id of supportFor(o)) {
      const cur = supports.get(id);
      if (!cur || String((o.provenance || {}).created_at || "") > String((cur.provenance || {}).created_at || "")) supports.set(id, o);
    }
  }
  const syntheses = allSyn.filter((o) => !isHome(o) && !isSuperseded(o) && !supportFor(o).length).map((o) => {
    const declared = ((o.ext || {})["upc-corpus"] || {}).codebook;
    const title = String(o.title || "").toLowerCase();
    let owner = null;
    if (declared) {
      const cb = codebooks.find((c) => c.slug === declared);
      owner = cb ? { cb, code: (cb.codes || []).find((c) => (c.label || c.code).toLowerCase() === title) || null } : null;
    } else {
      owner = labelOwner.get(title) || null;
    }
    return { ...o, _group: owner && owner.cb ? owner.cb : null, _code: owner && owner.code ? owner.code.code : null,
             _addr: firstOf(o), _support: supports.get(o.synthesis_id) || null,
             _revision: o.supersedes && synById.has(o.supersedes) ? revisionOf(o) : null };
  });
  // Findings (1.15.0): every statement of a current overview whose support was
  // checked, in the overview's own order, with its matrix's plain fields.
  const findings = [];
  for (const s of syntheses) {
    if (!s._support) continue;
    const byClaim = new Map((s._support.claims || []).map((c) => [c.claim_id, c]));
    const order = (s.claims || []).map((c) => c.claim_id).filter((id) => byClaim.has(id));
    const ids = order.concat([...byClaim.keys()].filter((id) => !order.includes(id)));
    ids.forEach((id, k) => {
      const m = byClaim.get(id), x = (m.ext || {})["upc-corpus"] || {};
      findings.push({
        syn: s, claim_id: id, ord: k, text: m.text || "",
        group: s._group ? s._group.slug : "", theme: s._group && s._code ? `${s._group.slug}:${s._code}` : "",
        support: supportOf(x), ipcc: x.ipcc || "", evidence: x.evidence || "", agreement: x.agreement || "",
        studies: x.studies != null ? x.studies : (x.independent || 0), papers: x.papers != null ? x.papers : (x.independent || 0),
        same_lead: !!x.same_lead, relayed_only: !!x.relayed_only, kind: x.kind || "",
        places: x.places || [], countries: x.countries || [], designs: x.designs || [],
        passages: (x.passages || []).map((v) => ({ id: v.extraction_id, verdict: v.verdict || "", gap: v.gap || "" })),
      });
    });
  }

  // The overview written for each code. A link that names a theme resolves
  // through this, not through an overview id: ids are content hashes (spec/06),
  // so re-running an overview mints a new one and a hard-coded link would die.
  const overviewByCode = new Map();
  // A revision stands where the first in its chain stood, so the list doesn't reshuffle.
  const firstPos = new Map(allSyn.map((o, i) => [o.synthesis_id, i]));
  syntheses.sort((a, b) => firstPos.get(a._addr) - firstPos.get(b._addr));
  for (const x of syntheses) if (x._group && x._code) overviewByCode.set(`${x._group.slug}:${x._code}`, x);
  // Newest placed summary wins; its prose is read here so either shape can render it.
  let homeSummary = null;
  const homes = allSyn.filter((o) => isHome(o) && !isSuperseded(o)).sort((a, b) =>
    String((b.provenance || {}).created_at || "").localeCompare(String((a.provenance || {}).created_at || "")));
  if (homes.length) {
    const h = homes[0];
    let md = "";
    const outPath = h.output && h.output.path;
    if (outPath) {
      const { abs, contained } = U.resolveInside(loaded.root, outPath);
      if (contained && fs.existsSync(abs)) md = fs.readFileSync(abs, "utf8");
    }
    const want = h.output && h.output.sha256;
    homeSummary = { ...h, md: md.replace(/^\s*#\s+.*\n+/, ""),
                    _changed: !!(want && md && "sha256:" + U.sha256Hex(Buffer.from(md, "utf8")) !== want),
                    _revision: h.supersedes && synById.has(h.supersedes) ? revisionOf(h) : null };
  }

  // Cards about a paper (1.15.0): a generation whose ext["upc-site"].card names
  // its heading — an evidence rating, say — shown on the paper's page. The
  // newest per heading; generations without one are not shown, as before.
  const cardsBySource = new Map();
  for (const g of loaded.generations || []) {
    const o = g.obj || {};
    const card = siteExt(o).card;
    const sid = o.source_id || ((((o.provenance || {}).derived_from || {}).source_ids || [])[0]);
    if (!card || !sid) continue;
    let md = "";
    const outPath = o.output && o.output.path;
    if (outPath) {
      const { abs, contained } = U.resolveInside(loaded.root, outPath);
      if (contained && fs.existsSync(abs)) md = fs.readFileSync(abs, "utf8");
    }
    if (!md && o.output && typeof o.output.value === "string") md = o.output.value;
    const list = cardsBySource.get(sid) || [];
    const at = list.findIndex((c) => c.card === card);
    const rec = { card, id: o.generation_id, md: md.replace(/^\s*#\s+.*\n+/, ""), created: String((o.provenance || {}).created_at || ""),
                  order: Number(siteExt(o).order || 0) };
    if (at < 0) list.push(rec);
    else if (rec.created > list[at].created) list[at] = rec;
    cardsBySource.set(sid, list);
  }
  for (const s of sources) s.cards = (cardsBySource.get(s.id) || []).sort((a, b) => a.order - b.order || a.card.localeCompare(b.card));

  return {
    title: (loaded.corpus && loaded.corpus.title) || "Research corpus",
    specVersion: loaded.corpus && loaded.corpus.upc_spec_version,
    // An interview corpus is one with interviews, or with a guide waiting for its first (1.16.0).
    interviews: sources.some((s) => s.interview) || !!IV.guideBooks({ codebooks }).qs,
    sources, sourceById, passages, passageById,
    codebooks, cbkById, codeIndex, syntheses, homeSummary, overviewByCode, homeCandidates: homes.length, hiddenById,
    about: typeof opts.about === "string" ? readAbout(opts.about) : (opts.about || null),
    findings,
    findingsSettings: (typeof opts.findings === "string" ? readFindingsSettings(opts.findings) : opts.findings) ||
      { starts: [], words: {}, mapPlace: "" },
    originalEdition: opts.originalEdition || null,
    coders: [...new Set(passages.flatMap((p) => p.codings.map((c) => c.coder)).concat(sources.flatMap((s) => s.codings.map((c) => c.coder))))],
    failures,
    generatedFrom: loaded.root,
    matrix: opts.matrix || null,
  };
}

// --- shared chrome --------------------------------------------------------

const CSS = `
:root{
  --bg:#fbfaf8; --panel:#fff; --ink:#17202a; --muted:#5b6672; --line:#e3e0da;
  --accent:#0b6b57; --accent-soft:#e6f2ee; --warn:#a4341f; --warn-soft:#fbeae6;
  --chip:#eef1f5; --chip-ink:#2c3a47; --mark:#fdf3c7;
  --well:#1f7a4d; --some:#2f7f96; --limited:#9a6b0c; --weak:#6b757b;
  --well-bg:#e3f2e9; --some-bg:#e3eff3; --limited-bg:#f8eedb; --weak-bg:#eef0f1;
  --maxw:min(1180px,94vw);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#12151a; --panel:#181d24; --ink:#e7ebf0; --muted:#9aa6b2; --line:#28303a;
  --accent:#5fd0ae; --accent-soft:#122a24; --warn:#ff9d86; --warn-soft:#2e1a16;
  --chip:#212a34; --chip-ink:#cbd5e0; --mark:#4a4020;
  --well:#5cc39b; --some:#6fb6cc; --limited:#e0b04f; --weak:#9aa3a8;
  --well-bg:#1f3a2d; --some-bg:#1d333b; --limited-bg:#3a3020; --weak-bg:#2a3135;
}}
:root[data-theme="dark"]{
  --bg:#12151a; --panel:#181d24; --ink:#e7ebf0; --muted:#9aa6b2; --line:#28303a;
  --accent:#5fd0ae; --accent-soft:#122a24; --warn:#ff9d86; --warn-soft:#2e1a16;
  --chip:#212a34; --chip-ink:#cbd5e0; --mark:#4a4020;
  --well:#5cc39b; --some:#6fb6cc; --limited:#e0b04f; --weak:#9aa3a8;
  --well-bg:#1f3a2d; --some-bg:#1d333b; --limited-bg:#3a3020; --weak-bg:#2a3135;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.55 ui-serif,Georgia,"Iowan Old Style",Palatino,serif;}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header.top{border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:10}
header.top .in{max-width:var(--maxw);margin:0 auto;padding:.7rem 1rem;display:flex;gap:.8rem;align-items:baseline;flex-wrap:wrap}
header.top .brand{font-weight:700;letter-spacing:-.01em}
header.top nav{display:flex;gap:.75rem;flex-wrap:wrap;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.86rem}
header.top nav a.on{color:var(--ink);border-bottom:2px solid var(--accent)}
header.top .spacer{flex:1}
button.theme{font:inherit;font-size:.8rem;background:var(--chip);color:var(--chip-ink);border:1px solid var(--line);
  border-radius:999px;padding:.15rem .6rem;cursor:pointer}
main{max-width:var(--maxw);margin:0 auto;padding:1.4rem 1rem 4rem}
h1{font-size:1.6rem;margin:.2rem 0 .3rem;letter-spacing:-.02em}
h2{font-size:1.15rem;margin:1.8rem 0 .5rem}
h3{font-size:1rem;margin:1.2rem 0 .4rem}
p.lede{color:var(--muted);margin:.2rem 0 1.2rem;max-width:62ch}
.sans{font-family:ui-sans-serif,system-ui,sans-serif}
.small{font-size:.84rem}
.muted{color:var(--muted)}
.grid{display:grid;gap:.9rem}
.cards{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:.9rem 1rem}
.card h3{margin:.1rem 0 .3rem;font-size:1rem}
.tile{display:block}
.tile .n{font-size:1.7rem;font-weight:700;font-family:ui-sans-serif,system-ui,sans-serif;letter-spacing:-.02em}
.tile .u{color:var(--muted);font-size:.82rem;font-family:ui-sans-serif,system-ui,sans-serif}
/* a passage */
.passage{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);
  border-radius:10px;padding:.85rem 1rem;margin:.75rem 0}
.passage.bad{border-left-color:var(--warn)}
.passage blockquote{margin:0;font-size:1.02rem}
.passage .ctx{color:var(--muted);font-size:.92rem}
/* "In context": a quotation opens to the sentences around it */
.passage blockquote[data-q]{cursor:pointer;border-radius:6px;margin:0 -.35rem;padding:.1rem .35rem}
.passage blockquote[data-q][aria-expanded="false"]:hover{background:var(--chip)}
.passage blockquote[data-q]:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.passage blockquote[data-q]::after{content:"▸ in context";margin-left:.5rem;white-space:nowrap;
  font:600 .7rem/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.02em;color:var(--accent)}
.passage blockquote[data-q][aria-expanded="true"]::after{content:"▴ less"}
.passage blockquote[data-q] .cx{color:var(--muted)}
.passage .cxnote{font:.74rem/1.45 ui-sans-serif,system-ui,sans-serif;color:var(--muted);margin:0 0 .3rem}
.passage .cxnote b{font-size:.68rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink)}
.passage .note{margin:0;font-style:italic;color:var(--ink);background:var(--chip);
  border-radius:8px;padding:.5rem .7rem}
.passage .meta{margin-top:.55rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;
  font-family:ui-sans-serif,system-ui,sans-serif;font-size:.8rem}
.passage .meta .spacer{flex:1}
/* the way out of a card — its place in the text, the original — wraps as one, kept right */
.passage .meta .go{display:inline-flex;flex-wrap:wrap;gap:.25rem .7rem;align-items:baseline;margin-left:auto}
mark{background:var(--mark);color:inherit;padding:.05em 0;border-radius:2px}
/* a verification badge — NEVER shares styling with a code chip (spec/09) */
.badge{display:inline-flex;gap:.3rem;align-items:center;border-radius:6px;padding:.1rem .45rem;
  background:var(--accent-soft);color:var(--accent);border:1px solid transparent;font-weight:600}
.badge.bad{background:var(--warn-soft);color:var(--warn)}
.badge.plain{background:transparent;color:var(--muted);border-color:var(--line);font-weight:400}
/* a code chip — a judgement, pill-shaped, always carrying its coder */
.chip{display:inline-flex;align-items:baseline;gap:.35rem;border-radius:999px;padding:.1rem .6rem;
  background:var(--chip);color:var(--chip-ink);border:1px dashed var(--line)}
.chip .who{font-size:.74rem;color:var(--muted)}
.chip.detached{opacity:.55;text-decoration:line-through}
.disagree{color:var(--warn);font-family:ui-sans-serif,system-ui,sans-serif;font-size:.8rem;margin-top:.35rem}
.banner{background:var(--warn-soft);color:var(--warn);border:1px solid currentColor;border-radius:10px;
  padding:.7rem .9rem;margin:0 0 1rem;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.88rem}
table{border-collapse:collapse;width:100%;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.88rem}
th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
/* NOT offset against the viewport: .wrap below is an overflow container, so it
   becomes the sticky containing block and a top offset would push this header
   down over the first row instead of pinning it to the window. */
th{color:var(--muted);font-weight:600;background:var(--bg);position:sticky;top:0;z-index:1}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto}
input[type=search],select{font:inherit;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.9rem;
  padding:.4rem .55rem;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink)}
.filters{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.8rem 0}
.reading{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.4rem 1.1rem;
  font-size:.95rem;line-height:1.65;max-height:70vh;overflow:auto}
/* content-visibility is deliberately NOT used here: with max-height + overflow it
   collapses the container, because skipped children report no intrinsic size. */
.reading p{margin:.65rem 0}
.reading mark{scroll-margin:40vh}
.btn{display:inline-block;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.82rem;
  background:var(--chip);color:var(--chip-ink);border:1px solid var(--line);border-radius:8px;
  padding:.3rem .7rem;cursor:pointer}
ul.plain{list-style:none;padding:0;margin:0}
ul.plain li{padding:.35rem 0;border-bottom:1px solid var(--line)}
.defbox{background:var(--accent-soft);border-radius:10px;padding:.7rem .9rem;margin:.3rem 0 1rem;max-width:70ch}
/* --- two-pane browsing: a list that never goes away, and a pane beside it --- */
.split{display:grid;grid-template-columns:20rem minmax(0,1fr);gap:1.3rem;align-items:start;margin-top:1rem}
.side{position:sticky;top:3.6rem;max-height:calc(100vh - 5rem);overflow:auto;overscroll-behavior:contain;
  background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:.75rem .85rem;
  font-family:ui-sans-serif,system-ui,sans-serif;font-size:.86rem}
.side h2{font-size:.92rem;margin:.1rem 0 .5rem}
.side details{border-top:1px solid var(--line);padding:.3rem 0}
.side details:first-of-type{border-top:0}
.side summary{cursor:pointer;font-weight:600;padding:.22rem 0;list-style:none;display:flex;gap:.4rem;align-items:baseline}
.side summary::-webkit-details-marker{display:none}
.side summary::before{content:"▸";color:var(--muted);font-size:.8em}
.side details[open]>summary::before{content:"▾"}
.side summary .n{margin-left:auto;color:var(--accent);font-weight:400;font-size:.76rem}
.side label{display:flex;gap:.45rem;align-items:baseline;padding:.15rem .25rem;border-radius:6px;cursor:pointer}
.side label:hover{background:var(--chip)}
.side label>span:first-of-type{flex:1}
.side label .n{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.76rem}
.side label.off{opacity:.4}
.side input[type=checkbox]{margin:0;accent-color:var(--accent);flex:none;position:relative;top:1px}
.side .sidesearch{width:100%;margin-bottom:.1rem}
.side ul.ovlist{list-style:none;padding:0;margin:0}
.side ul.ovlist a{display:block;padding:.26rem .4rem;border-radius:6px;color:var(--ink);line-height:1.3}
.side ul.ovlist a:hover{background:var(--chip);text-decoration:none}
.side ul.ovlist a.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.pane{min-width:0}
/* the papers an overview drew on */
.card ul.refs{padding-left:1.15rem;margin:.4rem 0 .2rem}
.card ul.refs li{margin:.4rem 0;line-height:1.45}
a.pn{display:inline-block;min-width:1.5em;text-align:center;font:600 .72rem/1.5 ui-sans-serif,system-ui,sans-serif;
  border:1px solid var(--line);border-radius:6px;padding:0 .3em;margin:0 .06em;text-decoration:none}
a.pn:hover{background:var(--accent-soft);text-decoration:none}
.card code{font-size:.85em;background:var(--chip);border-radius:4px;padding:0 .25em}
/* the home page's summary of what the literature says */
.homesum{margin:1.1rem 0 1.5rem;border-left:3px solid var(--accent)}
.homesum h2{margin:.1rem 0 .35rem}
.homesum h3{font-size:1rem;margin:1.05rem 0 .3rem}
.homesum ul{padding-left:1.15rem;margin:.3rem 0}
.homesum li{margin:.4rem 0;line-height:1.5}
.homesum details.refs-fold{margin-top:.9rem;border-top:1px solid var(--line);padding-top:.5rem}
.homesum details.refs-fold>summary{cursor:pointer;font:.84rem ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
/* Only the lazily-built list opts into this: a card the reader can deep-link to
   must not be skipped, and .reading collapses under it (see above). */
.lazy .passage{content-visibility:auto;contain-intrinsic-size:auto 190px}
/* evidence ratings (1.15.0): kept apart from the themes, shown where a passage is opened or on its paper's page */
.passage .evchips{display:none}
.passage blockquote[aria-expanded="true"] ~ .meta .evchips,.evshow .passage .evchips{display:inline-flex;gap:.35rem;flex-wrap:wrap}
.evcard{margin:.7rem 0}
.evchips .chip,.evcard .chip{background:transparent;border-style:solid}
.evcard>summary{cursor:pointer;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.92rem}
.evcard ul{padding-left:1.15rem}
.evcard li{margin:.35rem 0}
p.revised{background:var(--accent-soft);color:var(--ink);border-radius:8px;padding:.45rem .7rem;max-width:74ch;margin:.2rem 0 .9rem}
/* findings (1.15.0): plain support words, never colour alone (the dots carry it too) */
.sup-b{display:inline-flex;align-items:center;gap:.35rem;font:600 .78rem/1.3 ui-sans-serif,system-ui,sans-serif;
  padding:.1rem .5rem;border-radius:999px;white-space:nowrap}
.sup-b .dots{letter-spacing:1px;font-size:.62rem}
.sup-b.s-well,.legend .s-well::before{background:var(--well-bg);color:var(--well)}
.sup-b.s-some,.legend .s-some::before{background:var(--some-bg);color:var(--some)}
.sup-b.s-limited,.legend .s-limited::before{background:var(--limited-bg);color:var(--limited)}
.sup-b.s-weak,.legend .s-weak::before{background:var(--weak-bg);color:var(--weak)}
.strip{display:flex;height:.8rem;border-radius:999px;overflow:hidden;background:var(--weak-bg);min-width:5rem}
.strip i{display:block;height:100%}
.strip i.s-well{background:var(--well)} .strip i.s-some{background:var(--some)}
.strip i.s-limited{background:var(--limited)} .strip i.s-weak{background:var(--weak)}
.legend{display:flex;gap:.9rem;flex-wrap:wrap;font:.8rem ui-sans-serif,system-ui,sans-serif;color:var(--muted);margin-top:.45rem}
.legend span::before{content:"";display:inline-block;width:.65rem;height:.65rem;border-radius:2px;margin-right:.3rem;vertical-align:-1px}
.legend .s-well::before{background:var(--well)} .legend .s-some::before{background:var(--some)}
.legend .s-limited::before{background:var(--limited)} .legend .s-weak::before{background:var(--weak)}
.flag{font:600 .7rem/1.4 ui-sans-serif,system-ui,sans-serif;padding:.05rem .4rem;border-radius:4px;background:var(--warn-soft);color:var(--warn);white-space:nowrap}
.kf{max-width:74ch;margin:.4rem 0 1.2rem;border-left:3px solid var(--accent)}
.kf h2{margin:.1rem 0 .3rem}
.kf h3{font-size:.95rem;margin:1rem 0 .3rem}
.kf ol{padding-left:1.2rem;margin:.3rem 0}
.kf li{margin:.45rem 0;line-height:1.5}
.kf .ftext{margin-left:.15rem}
.starts .tile strong{font-size:1rem}
.fstarts{display:flex;flex-direction:column;gap:.35rem;margin-bottom:.6rem}
.btn.sbtn{text-align:left;width:100%}
.btn.sbtn small{display:block;color:var(--muted);font-size:.72rem}
.btn.sbtn.on{background:var(--accent-soft);border-color:var(--accent);color:var(--ink)}
.side .fwrap-d>summary{display:none}
.side .fwrap-d{border-top:0;padding:0}
.fnote{background:var(--accent-soft);border-radius:8px;padding:.55rem .8rem;margin:0 0 .7rem;font-size:.92rem}
.fcount{display:flex;justify-content:space-between;gap:.6rem;flex-wrap:wrap;font-family:ui-sans-serif,system-ui,sans-serif;margin:.2rem 0 .6rem}
article.fd{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.7rem 1rem;margin:0 0 .65rem}
.fd .ftop{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.fd p.ftext{font-size:1.04rem;line-height:1.45;margin:.4rem 0 .25rem}
.fd p.fmeta{margin:0;font-family:ui-sans-serif,system-ui,sans-serif}
.fd details{margin-top:.35rem}
.fd details>summary{cursor:pointer;color:var(--accent);font-family:ui-sans-serif,system-ui,sans-serif}
.fpass{border-top:1px solid var(--line);margin-top:.5rem;padding-top:.35rem}
.fpass .passage{margin:.3rem 0}
.fpass p.fv{margin:.2rem 0;font-family:ui-sans-serif,system-ui,sans-serif}
.v{font-weight:600;padding:0 .35rem;border-radius:4px}
.v.v-yes{background:var(--well-bg);color:var(--well)} .v.v-part{background:var(--limited-bg);color:var(--limited)}
.v.v-no{background:var(--weak-bg);color:var(--weak)}
table.emap td{vertical-align:middle}
table.emap tr.grp td{background:var(--bg);font:600 .95rem ui-serif,Georgia,serif;padding-top:.9rem}
table.emap .strip{width:11rem}
.fnote-card{max-width:80ch}
table.claims .sup{display:none}
table.claims.show-support .sup{display:table-cell}
@media (max-width:860px){
  .split{grid-template-columns:1fr}
  .side{position:static;max-height:20rem}
  #fside{max-height:none}
  .side .fwrap-d>summary{display:flex}
  table.emap .strip{width:5rem}
  table.emap .hide-s{display:none}
}
@media print{.side{display:none}.split{display:block}}
footer{max-width:var(--maxw);margin:0 auto;padding:1.5rem 1rem 3rem;color:var(--muted);font-size:.8rem;
  font-family:ui-sans-serif,system-ui,sans-serif;border-top:1px solid var(--line)}
@media print{
  header.top,.filters,button,.btn,footer nav{display:none!important}
  body{background:#fff}
  .passage{break-inside:avoid;border:1px solid #ccc}
  .passage .cx,.passage .cxnote{display:none!important}
  .passage blockquote[data-q]::after,.passage blockquote[data-q][aria-expanded="true"]::after{content:none}
  .reading{max-height:none;overflow:visible}
  a{color:inherit;text-decoration:none}
}
${READING_CSS}`;

const JS = `
(function(){
  var K="upc-site-theme";
  try{var t=localStorage.getItem(K); if(t)document.documentElement.setAttribute("data-theme",t);}catch(e){}
  window.__toggleTheme=function(){
    var cur=document.documentElement.getAttribute("data-theme");
    var next=cur==="dark"?"light":cur==="light"?"dark":
      (window.matchMedia&&window.matchMedia("(prefers-color-scheme:dark)").matches?"light":"dark");
    document.documentElement.setAttribute("data-theme",next);
    try{localStorage.setItem(K,next);}catch(e){}
  };
  // Deep links: #ex=<id> / #coding=<id> scroll to and flash the thing named;
  // #text=<id> to the passage highlighted in the paper's text ("line N →").
  function jump(){
    var h=location.hash||"";
    var m=/^#(ex|coding|code|text)=([^&]+)/.exec(h);
    if(!m)return;
    var id=decodeURIComponent(m[2]);
    var el=m[1]==="text"?document.getElementById("t-"+id)
      :document.getElementById(id)||document.querySelector('[data-id="'+CSS.escape(id)+'"]');
    // A paper whose text is too large to show here: the passage's card, opened in context.
    if(!el&&m[1]==="text"&&(el=document.getElementById(id))&&window.UPCB) UPCB.open(el);
    if(el){el.scrollIntoView({block:"center"});el.style.outline="2px solid var(--accent)";
      setTimeout(function(){el.style.outline="";},2400);}
  }
  window.addEventListener("hashchange",jump);
  document.addEventListener("DOMContentLoaded",function(){
    jump();
    // Filters: every [data-filter] select narrows [data-row] by data-<key>.
    var sels=[].slice.call(document.querySelectorAll("[data-filter]"));
    var q=document.querySelector("[data-q]");
    function apply(){
      var terms=(q&&q.value||"").toLowerCase().trim().split(/\\s+/).filter(Boolean);
      var rows=[].slice.call(document.querySelectorAll("[data-row]"));
      var shown=0;
      rows.forEach(function(r){
        var ok=true;
        sels.forEach(function(s){
          var v=s.value; if(!v)return;
          var have=(r.getAttribute("data-"+s.getAttribute("data-filter"))||"").split("|");
          if(have.indexOf(v)<0)ok=false;
        });
        if(ok&&terms.length){
          var hay=((r.getAttribute("data-search")||"")+" "+r.textContent).toLowerCase();
          ok=terms.every(function(t){return hay.indexOf(t)>=0;});
        }
        r.hidden=!ok; if(ok)shown++;
      });
      var c=document.querySelector("[data-count]");
      if(c)c.textContent=shown+" "+(shown===1?c.getAttribute("data-one"):c.getAttribute("data-many"));
    }
    sels.forEach(function(s){s.addEventListener("change",apply);});
    if(q)q.addEventListener("input",apply);
    if(sels.length||q)apply();

    // Two-pane browsing, on the pages that ask for it. The data rides in
    // data/browse.js as a <script src>, so this still works when opened from disk.
    var host=document.querySelector("[data-browse]");
    function browseInit(B,base){
      UPCB.init({
        sources:B.sources, codebooks:B.codebooks, badges:B.badges, coderKind:B.ck,
        files:B.files?base+B.files:null, base:base,
        hrefSource:function(p){
          var src=B.sources[p.s]||{};
          return base+"sources/"+encodeURIComponent(src.sl||"")+".html#ex="+encodeURIComponent(p.id);
        },
        hrefText:function(p){
          var src=B.sources[p.s]||{};
          return base+"sources/"+encodeURIComponent(src.sl||"")+".html#text="+encodeURIComponent(p.id);
        },
        hrefCode:function(slug,code){
          return base+"codes/"+encodeURIComponent(slug)+"/"+encodeURIComponent(code)+".html";
        },
        ctxSrc:function(p){
          var src=B.sources[p.s]||{};
          return base+"data/ctx/"+encodeURIComponent(src.sl||"")+".js";
        }
      });
    }
    if(host&&window.UPCB&&window.__UPCB_DATA){
      var B=window.__UPCB_DATA, base=host.getAttribute("data-base")||"";
      browseInit(B,base);
      var only=host.getAttribute("data-only"), omit=host.getAttribute("data-omit");
      var items=B.passages;
      if(only) items=items.filter(function(p){
        for(var i=0;i<p.g.length;i++) if(p.g[i][0]+":"+p.g[i][1]===only) return true;
        return false;
      });
      // #with=<scheme>:<code> — a matrix cell: this code's passages that also carry that one.
      var mw=/[#&]with=([^&]+)/.exec(location.hash||"");
      host.innerHTML="";
      UPCB.browse(host,items,{omit:omit?[omit]:[],with:mw?decodeURIComponent(mw[1]).split(","):[]});
    }

    // Findings and the evidence map (1.15.0): the statements of the rated reviews.
    var fh=document.querySelector("[data-findings]"), eh=document.querySelector("[data-evidence]");
    if((fh||eh)&&window.UPCF&&window.__UPCF_DATA){
      var FB=window.__UPCB_DATA||{sources:[],passages:[],codebooks:[],badges:{}};
      if(window.UPCB) browseInit(FB,"");
      UPCF.init({F:window.__UPCF_DATA, passages:FB.passages, sources:FB.sources,
        label:UPCB.label, card:function(p){ return UPCB.card(p,{context:false}); },
        placeCount:function(want){
          var n=0; FB.sources.forEach(function(s){ if((s.g||[]).some(function(g){return g[0]==="place"&&want.indexOf(g[1])>=0;})) n++; });
          return [n,FB.sources.length];
        },
        hrefFindings:function(q){ return "findings.html"+(q?"#"+q:""); },
        setQuery:function(q){ try{ history.replaceState(null,"",q?"#"+q:location.pathname+location.search); }catch(e){} }});
      if(fh) UPCF.findings(fh,location.hash);
      if(eh) UPCF.map(eh);
      // A link to this page with other filters (#start=…) arrives as a hash change, not a load.
      if(fh) window.addEventListener("hashchange",function(){ UPCF.findings(fh,location.hash); });
    }

    // The overviews list: filtered in place, never replaced.
    var sf=document.querySelector("[data-sidefilter]");
    if(sf)sf.addEventListener("input",function(){
      var t=sf.value.toLowerCase().trim();
      [].slice.call(document.querySelectorAll("#ov-side details[data-ovg]")).forEach(function(d){
        var any=0;
        [].slice.call(d.querySelectorAll("li")).forEach(function(li){
          var ok=!t||li.textContent.toLowerCase().indexOf(t)>=0;
          li.hidden=!ok; if(ok)any++;
        });
        d.hidden=!any; if(t&&any)d.open=true;
      });
    });
    // Keep the review being read in view when a long list opens at the top.
    var ovSide=document.getElementById("ov-side");
    if(ovSide&&window.UPCB)UPCB.reveal(ovSide,ovSide.querySelector("a.on"));

    // CSV of whatever is currently shown.
    var dl=document.querySelector("[data-export]");
    if(dl)dl.addEventListener("click",function(){
      var rows=[].slice.call(document.querySelectorAll("[data-row]")).filter(function(r){return !r.hidden;});
      var head=["quote","source","year","doi","codes","coders","checked"];
      var out=[head.join(",")];
      rows.forEach(function(r){
        var f=JSON.parse(r.getAttribute("data-csv")||"null"); if(!f)return;
        out.push(head.map(function(k){return '"'+String(f[k]==null?"":f[k]).replace(/"/g,'""')+'"';}).join(","));
      });
      var blob=new Blob([out.join("\\n")],{type:"text/csv"});
      var a=document.createElement("a");a.href=URL.createObjectURL(blob);
      a.download=(document.title.replace(/[^A-Za-z0-9]+/g,"-").toLowerCase()||"passages")+".csv";
      document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href);
    });
  });
})();
`;

// The browse engine, shared by both shapes of the site.
//
// One renderer for a passage card, and one two-pane browser: a sidebar of
// checkable facets on the left that never scrolls away, and a lazily-rendered
// list on the right. Filtering runs over the data, never over the DOM — walking
// 3,220 articles and reading their textContent on every keystroke is what made
// the old page unusable — and only the cards near the viewport are built.
//
// Both clients hand it a context with the two things that differ between them:
// how to link to a source, and how to link to a code.
const BROWSE_JS = String.raw`
(function(){
  var X=null, CHUNK=30, codeDef={};
  var E=function(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");};
  var PL=function(n,a,b){return n+" "+(n===1?a:b);};

  function init(ctx){
    X=ctx; codeDef={};
    X.codebooks.forEach(function(cb){ cb.codes.forEach(function(c){
      codeDef[cb.slug+":"+c.code]={cb:cb,c:c}; }); });
    return API;
  }
  function label(slug,code){ var d=codeDef[slug+":"+code]; return d?d.c.label:code; }

  // ---- one passage, rendered one way ----

  function badge(b,terse){
    var t=X.badges[b]||X.badges.unverifiable;
    var cls=b==="failed"?"badge bad":(b==="paraphrase"||b==="unverifiable")?"badge plain":"badge";
    return '<span class="'+cls+'"'+(terse?"":' title="'+E(t[2])+'"')+'>'+t[0]+" "+E(t[1])+"</span>";
  }
  // Who made a judgement lives in the chip's tooltip, with its confidence and
  // reason. Each view also says once, visibly, what kind of coder made its codes
  // (codeNote) — so a model's judgement never passes for a fact (spec/09).
  // A code on a quotation that no longer matches its paper is shown struck
  // through (detached), as the pages built on the server show it.
  function chip(g,detached){
    var d=codeDef[g[0]+":"+g[1]], lbl=d?d.c.label:g[1];
    var kind=(X.coderKind||{})[g[2]];
    var tip=(d&&d.c.def?d.c.label+": "+d.c.def+"\n":"")+"Coded by "+g[2]+(kind?" ("+({rule:"a rule",ensemble:"a vote of model runs"}[kind]||kind)+")":"")+
      (g[3]?" · confidence "+g[3]:"")+(g[4]?"\nWhy: "+g[4]:"")+(g[5]?"\n"+g[5]:"");
    return '<span class="chip'+(detached?" detached":"")+'" title="'+E(tip)+'">'+
      '<a href="'+E(X.hrefCode(g[0],g[1]))+'">'+E(lbl)+"</a></span>";
  }
  // "See in original, p. 14 ↗": the PDF at that page when the PDFs travel with
  // the library, else the publisher's page by DOI, else the bare page number.
  // Same words as the server-side pages (ORIGINAL_TIP in site.mjs).
  var NOTE=" The page number printed on the paper may differ.";
  function nth(n){ var t=n%100; return n+(t>=11&&t<=13?"th":({1:"st",2:"nd",3:"rd"})[n%10]||"th"); }
  function original(p,s){
    if(X.files&&s.p){
      return ' <a class="muted orig" href="'+E(X.files+"/"+encodeURIComponent(s.p)+(p.pg?"#page="+p.pg:""))+
        '" target="_blank" rel="noopener" title="'+
        E(p.pg?"Opens the original PDF at its "+nth(p.pg)+" page."+NOTE:"Opens the original PDF.")+'">See in original'+
        (p.pg?", p. "+p.pg:"")+" ↗</a>";
    }
    if(s.d){
      return ' <a class="muted orig" href="https://doi.org/'+encodeURIComponent(s.d)+'" target="_blank" rel="noopener" title="'+
        E("Opens the publisher's page for this paper."+(p.pg?" In the PDF, this passage is on the "+nth(p.pg)+" page."+NOTE:""))+
        '">See in original (publisher) ↗</a>';
    }
    return p.pg?' <span class="muted orig" title="'+E("In the PDF, this passage is on the "+nth(p.pg)+" page."+NOTE)+'">p. '+p.pg+"</span>":"";
  }
  // A quotation that opens to the sentences around it: the attributes the
  // server's pages give it too (quoteToggle in site.mjs).
  function QT(pdf){
    return 'data-q="'+(pdf?"pdf":"text")+'" tabindex="0" role="button" aria-expanded="false" title="Show the sentences around it"';
  }
  function codeNote(){
    var k={}, ck=X.coderKind||{};
    Object.keys(ck).forEach(function(c){ k[ck[c]||"other"]=1; });
    var m=k.model||k.ensemble;
    var who=m&&k.human?"a language model and by people":k.human?"people":m?"a language model":"";
    if(k.rule) who=who?who+", and some by rules":"rules";
    return (who?"Codes were assigned by "+who+". ":"Codes are judgements, not checks. ")+
      "Hover a code to see who assigned it, how sure they were, and why.";
  }
  // Recordings (1.16.0): a transcript's speaker headings, and ▶ for a passage with a time.
  function SP(h){ return h.replace(/\*\*([^*<>\n]{1,80})\*\* \[(\d{2}:\d{2}:\d{2})\]\n?/g,
    function(m,w,t){ return '<span class="who">'+w+'</span> <span class="ts">'+t+"</span> "; }); }
  function CLK(x){ x=Math.max(0,Math.floor(x)); var h=Math.floor(x/3600),m=Math.floor(x%3600/60),s=x%60;
    return (h?h+":"+(m<10?"0":"")+m:m)+":"+(s<10?"0":"")+s; }
  function PLAY(p,s){
    if(!p.tm||!s.au||!X.base) return "";
    return '<button type="button" class="play" data-play data-src="'+E(X.base+s.au)+'" data-t0="'+Math.max(0,p.tm[0]-0.4).toFixed(2)+
      '" data-t1="'+(p.tm[1]+0.6).toFixed(2)+'" aria-pressed="false" title="Listen"><span class="i" aria-hidden="true">▶</span> '+CLK(p.tm[0])+"</button>";
  }
  // An evidence scheme's code (1.15.0): shown where the passage is opened, not on the list.
  function isEv(g){ var d=codeDef[g[0]+":"+g[1]]; return !!(d&&d.cb.ev); }
  function card(p,opts){
    opts=opts||{};
    var s=X.sources[p.s]||{}, bad=p.b==="failed";
    var top=p.g.filter(function(g){return !isEv(g);}), ev=p.g.filter(isEv);
    var cx=!!(p.q&&(p.w||p.cx||p.cw));      // its sentences can be shown ("In context")
    var body;
    if(p.q){
      body="<blockquote"+(cx?" "+QT(s.p):"")+"><mark>"+SP(E(p.q))+"</mark></blockquote>";
      if(bad&&p.act) body+='<p class="small" style="color:var(--warn)">The source now reads: “'+E(p.act.slice(0,240))+'”</p>';
    } else { body='<p class="note">'+E(p.n)+"</p>"; }
    var where=p.l?p.sc||"line "+p.l:"";
    // "line N →" opens the passage where it sits in the paper's text.
    var href=where&&X.hrefText?X.hrefText(p):X.hrefSource(p);
    return '<article class="passage'+(bad?" bad":"")+'" id="'+E(p.id)+'"'+
      (cx&&X.ctxSrc?' data-cx="'+E(X.ctxSrc(p))+'"':"")+' data-row'+
      ' data-code="'+E(p.g.map(function(g){return g[0]+":"+g[1];}).join("|"))+'"'+
      ' data-coder="'+E(p.g.map(function(g){return g[2];}).join("|"))+'"'+
      ' data-year="'+E(s.y||"")+'"'+
      ' data-search="'+E([s.t,s.k].concat(p.g.map(function(g){return label(g[0],g[1])+" "+g[2];})).join(" "))+'">'+
      body+
      (p.dis?'<div class="disagree">Coders disagree here — both judgements are kept and shown.</div>':"")+
      '<div class="meta">'+badge(p.b,!!opts.terse)+
      (p.st?'<span class="badge plain">'+E(p.st)+"</span>":"")+
      top.map(function(g){return chip(g,bad);}).join(" ")+
      (ev.length?' <span class="evchips">'+ev.map(function(g){return chip(g,bad);}).join(" ")+"</span>":"")+
      (p.sp?'<span class="speaker">'+E(p.sp.join(", "))+"</span>":"")+
      '<span class="spacer"></span>'+PLAY(p,s)+'<span class="go"><a class="muted" href="'+E(href)+'">'+
      (opts.showSource===false?E(where||"in context"):E(s.k||"")+(where?" · "+E(where):""))+" →</a>"+original(p,s)+
      "</span></div></article>";
  }

  // ---- "In context": a quotation opens to the sentences around it ----
  // One open at a time; a second click, or Escape, closes it. The sentences come
  // from the reader's own copy: the folder's data/ctx/<paper>.js, loaded the first
  // time one of that paper's passages is opened (a <script src>, so it works
  // opened from disk too), or the single file's own data (API.cx, set by its client).
  var cxOpen=null, cxWait={};
  function cxLoad(src,done){
    if(cxWait[src]===true) return done();
    if(cxWait[src]){ cxWait[src].push(done); return; }
    cxWait[src]=[done];
    var el=document.createElement("script");
    el.src=src;
    el.onload=el.onerror=function(){ var q=cxWait[src]; cxWait[src]=true; q.forEach(function(f){f();}); };
    document.head.appendChild(el);
  }
  function cxGet(art,done){
    if(API.cx) return done(API.cx(art.id));
    var have=function(){ return (window.__UPC_CTX||{})[art.id]||null; };
    if(have()) return done(have());
    var src=art.getAttribute("data-cx");
    if(!src) return done(null);
    cxLoad(src,function(){ done(have()); });
  }
  function cxClose(art){
    if(!art) return;
    var bq=art.querySelector("blockquote[data-q]"), note=art.querySelector(".cxnote");
    if(note) note.parentNode.removeChild(note);
    if(bq){ if(bq.__q!=null){ bq.innerHTML=bq.__q; bq.__q=null; } bq.setAttribute("aria-expanded","false"); }
    if(cxOpen===art) cxOpen=null;
  }
  function cxToggle(art){
    if(cxOpen===art){ cxClose(art); return; }
    var bq=art.querySelector("blockquote[data-q]");
    if(!bq){ cxClose(cxOpen); return; }
    // Closing one higher up the page moves this one up: keep it where it was clicked.
    var top=bq.getBoundingClientRect().top;
    cxClose(cxOpen);
    var moved=bq.getBoundingClientRect().top-top;
    if(moved) window.scrollBy(0,moved);
    cxOpen=art;
    bq.setAttribute("aria-expanded","true");
    cxGet(art,function(w){
      if(cxOpen!==art) return;                 // another was opened while this one loaded
      var note=document.createElement("div"), orig=art.querySelector(".orig");
      note.className="cxnote";
      if(!w) note.textContent="The sentences around this passage could not be loaded.";
      else note.innerHTML="<b>In context</b> · from the text "+
        (bq.getAttribute("data-q")==="pdf"?"extracted from the PDF":"of the paper")+(orig?" · "+orig.outerHTML:"");
      bq.parentNode.insertBefore(note,bq);
      if(!w) return;
      bq.__q=bq.innerHTML;
      bq.innerHTML='<span class="cx">'+E(w[0].slice(0,w[1]))+"</span><mark>"+E(w[0].slice(w[1],w[2]))+
        '</mark><span class="cx">'+E(w[0].slice(w[2]))+"</span>";
    });
  }
  document.addEventListener("click",function(e){
    var t=e.target, bq=t&&t.closest?t.closest("blockquote[data-q]"):null;
    if(!bq) return;
    // Selecting words to copy them is not a request to open the passage.
    var sel=window.getSelection?window.getSelection():null;
    if(sel&&String(sel)&&bq.contains(sel.anchorNode)) return;
    var art=bq.closest("article");
    if(art) cxToggle(art);
  });
  document.addEventListener("keydown",function(e){
    var t=e.target;
    if(e.key==="Escape"&&cxOpen){
      var b=cxOpen.querySelector("blockquote[data-q]");
      cxClose(cxOpen);
      if(b) b.focus();
      return;
    }
    if((e.key==="Enter"||e.key===" ")&&t&&t.matches&&t.matches("blockquote[data-q]")){
      e.preventDefault();
      var art=t.closest("article");
      if(art) cxToggle(art);
    }
  });
  // The single file's form of a window: [flags, a1, b1, a2, b2, …], ranges of the
  // paper's text (UTF-16) to join by a space; flag 1 "…" before, 2 "…" after.
  // The same string as windowText() in context.mjs, which the folder ships ready-made.
  function windowText(t,cw,qa,qb){
    var out="",qs=-1,qe=-1;
    for(var k=1;k+1<cw.length;k+=2){
      var a=cw[k],b=cw[k+1];
      if(k>1) out+=" ";
      if(qs<0&&qa>=a&&qa<=b) qs=out.length+(qa-a);
      if(qe<0&&qb>=a&&qb<=b) qe=out.length+(qb-a);
      out+=t.slice(a,b);
    }
    if(qs<0||qe<qs) return null;
    var pre=out.slice(0,qs).replace(/\s+/g," ").replace(/^ /,""), q=out.slice(qs,qe).replace(/\s+/g," "),
        post=out.slice(qe).replace(/\s+/g," ").replace(/ $/,"");
    if(cw[0]&1) pre="…"+pre;
    if(cw[0]&2) post+="…";
    return [pre+q+post,pre.length,pre.length+q.length];
  }

  // ---- the two-pane browser ----

  // Everything a filter needs, computed once: the codes and coders as flat
  // strings, and one lowercase haystack per passage.
  function prep(items){
    if(items.__prepped) return;
    items.forEach(function(p){
      var s=X.sources[p.s]||{};
      p._c=p.g.map(function(g){return g[0]+":"+g[1];});
      p._k=p.g.map(function(g){return g[2];});
      // About the paper (1.15.0): its evidence-group codes, as filters on its passages
      p._p=(s.g||[]).filter(isEv).map(function(g){return g[0]+":"+g[1];});
      p._h=((p.q||"")+" "+(p.n||"")+" "+(s.t||"")+" "+(s.k||"")+" "+(s.a||"")+" "+(s.y||"")+" "+
            p.g.map(function(g){return label(g[0],g[1])+" "+g[2];}).join(" ")).toLowerCase();
    });
    items.__prepped=1;
  }

  function browse(host,items,opts){
    opts=opts||{};
    prep(items);

    // A matrix cell opens a code's list with another code ticked (opts.with).
    // A scheme the page leaves out has no box to tick, so for that one the list
    // itself is narrowed, and the sidebar says so.
    var omit=opts.omit||[], tick=[], also=[];
    (opts.with||[]).forEach(function(k){
      if(!codeDef[k]) return;
      if(omit.indexOf(k.split(":")[0])>=0){
        items=items.filter(function(p){return p._c.indexOf(k)>=0;});
        also.push(codeDef[k].c.label);
      } else tick.push(k);
    });

    // groups: one per codebook that anything is coded against, plus the coders
    var groups=[];
    X.codebooks.forEach(function(cb){
      if(omit.indexOf(cb.slug)>=0||cb.nf) return;
      var codes=[];
      cb.codes.forEach(function(c){
        var key=cb.slug+":"+c.code, n=0;
        items.forEach(function(p){ if(p._c.indexOf(key)>=0) n++; });
        if(n) codes.push({key:key,label:c.label,def:c.def,n:n});
      });
      codes.sort(function(a,b){return b.n-a.n;});
      if(codes.length) groups.push({id:cb.slug,title:cb.title,question:cb.question||"",kind:"code",codes:codes,ev:!!cb.ev});
    });
    // About the paper: its evidence-group codes, one section, after the themes.
    var pc={};
    items.forEach(function(p){ p._p.forEach(function(k){ pc[k]=(pc[k]||0)+1; }); });
    var pk=Object.keys(pc).filter(function(k){ var d=codeDef[k]; return d&&!d.cb.nf; });
    if(pk.length){
      groups.push({id:"__paper",title:"About the paper",kind:"paper",ev:true,
        question:"Ratings of the paper a passage comes from (advisory).",
        codes:pk.sort(function(a,b){ var A=codeDef[a],B=codeDef[b];
          return A.cb.slug<B.cb.slug?-1:A.cb.slug>B.cb.slug?1:pc[b]-pc[a]; }).map(function(k){
          var d=codeDef[k]; return {key:k,label:d.cb.title+": "+d.c.label,def:d.c.def,n:pc[k]}; })});
    }
    // The scheme that covers most of the list goes first, and is the one opened:
    // a sidebar whose first section is a scheme almost nothing was coded against
    // teaches the reader that the sidebar is not worth opening.
    groups.forEach(function(g){
      g.total=items.filter(function(p){
        for(var i=0;i<p._c.length;i++) if(p._c[i].indexOf(g.id+":")===0) return true;
        return false; }).length;
    });
    // Evidence schemes after every theme, however much they cover.
    groups.forEach(function(g){ if(g.kind==="paper") g.total=items.filter(function(p){return p._p.length;}).length; });
    groups.sort(function(a,b){return (a.ev?1:0)-(b.ev?1:0)||b.total-a.total;});
    var coders={};
    items.forEach(function(p){ p._k.forEach(function(k){ coders[k]=(coders[k]||0)+1; }); });
    var ck=Object.keys(coders);
    if(ck.length>1){
      groups.push({id:"__coder",title:"Coder",kind:"coder",question:"Who made the judgement.",
        codes:ck.sort().map(function(k){return {key:k,label:k,def:"",n:coders[k]};})});
    }

    var sel={};           // group id -> array of checked keys
    groups.forEach(function(g){ sel[g.id]=[]; });
    var terms=[], matches=items.slice(), drawn=0;

    host.innerHTML=
      '<div class="split">'+
      '<aside class="side" id="pfacets">'+
        '<input type="search" class="sidesearch" id="pq" placeholder="Search every passage…">'+
        '<p class="small muted" id="pcount" style="margin:.5rem 0 .3rem"></p>'+
        (also.length?'<p class="small" style="margin:0 0 .5rem">Only passages also coded '+E(also.join(", "))+".</p>":"")+
        '<p class="small muted" style="margin:0 0 .5rem">'+E(codeNote())+"</p>"+
        '<p class="small" style="margin:0 0 .5rem"><button class="btn" id="pclear">Clear all</button> '+
        '<button class="btn" id="pcsv">Download CSV</button></p>'+
        groups.map(function(g,i){
          return '<details'+(i===0&&!g.ev?" open":"")+' data-g="'+E(g.id)+'"><summary>'+E(g.title)+
            '<span class="n" data-gn></span></summary>'+
            (g.question?'<p class="small muted" style="margin:.1rem 0 .3rem">'+E(g.question)+"</p>":"")+
            g.codes.map(function(c){
              return '<label'+(c.def?' title="'+E(c.def)+'"':"")+'><input type="checkbox" data-f="'+
                E(g.id)+'" value="'+E(c.key)+'"><span>'+E(c.label)+'</span><span class="n">'+c.n+"</span></label>";
            }).join("")+"</details>";
        }).join("")+
      "</aside>"+
      '<section class="pane"><div class="lazy" id="plist"></div>'+
      '<div id="pmore"></div></section></div>';

    var list=host.querySelector("#plist"), more=host.querySelector("#pmore");
    var countEl=host.querySelector("#pcount"), q=host.querySelector("#pq");
    [].slice.call(host.querySelectorAll("input[data-f]")).forEach(function(c){
      if(tick.indexOf(c.value)<0) return;
      c.checked=true; sel[c.getAttribute("data-f")].push(c.value);
      var d=c.parentNode; while(d&&d.tagName!=="DETAILS") d=d.parentNode;
      if(d) d.open=true;
    });

    function keep(p,skip){
      for(var i=0;i<groups.length;i++){
        var g=groups[i]; if(g.id===skip) continue;
        var want=sel[g.id]; if(!want.length) continue;
        var have=g.kind==="coder"?p._k:g.kind==="paper"?p._p:p._c, ok=false;
        for(var k=0;k<want.length;k++){ if(have.indexOf(want[k])>=0){ok=true;break;} }
        if(!ok) return false;
      }
      for(var t=0;t<terms.length;t++){ if(p._h.indexOf(terms[t])<0) return false; }
      return true;
    }

    // A facet's own counts ignore its own selection, or every unchecked sibling
    // reads zero and the reader cannot see what else is there.
    function recount(){
      groups.forEach(function(g){
        var pool=items.filter(function(p){return keep(p,g.id);});
        var seen={};
        pool.forEach(function(p){
          var have=g.kind==="coder"?p._k:g.kind==="paper"?p._p:p._c;
          have.forEach(function(h){ seen[h]=(seen[h]||0)+1; });
        });
        var box=host.querySelector('details[data-g="'+g.id.replace(/"/g,"")+'"]');
        if(!box) return;
        [].slice.call(box.querySelectorAll("label")).forEach(function(lb){
          var cbx=lb.querySelector("input"), n=seen[cbx.value]||0;
          lb.querySelector(".n").textContent=n;
          lb.className=(n||cbx.checked)?"":"off";
        });
        var chosen=sel[g.id].length;
        box.querySelector("[data-gn]").textContent=chosen?chosen+" chosen":"";
      });
    }

    function draw(n){
      var frag=[], end=Math.min(matches.length,drawn+n);
      // Not terse: only what is on screen is built, so a chip can afford to carry
      // its definition, its coder's reason and the confidence in a tooltip again.
      for(var i=drawn;i<end;i++) frag.push(card(matches[i],{context:false}));
      if(frag.length) list.insertAdjacentHTML("beforeend",frag.join(""));
      drawn=end;
      more.innerHTML = drawn<matches.length
        ? '<p class="small muted" id="psent">Showing '+drawn+" of "+matches.length+
          '. <button class="btn" id="pmorebtn">Show more</button></p>' : "";
      var b=host.querySelector("#pmorebtn");
      if(b) b.addEventListener("click",function(){draw(CHUNK*3);});
      if(io&&drawn<matches.length) io.observe(host.querySelector("#psent"));
    }

    // Printing draws everything that matches: a code page printed as a reading
    // list must not stop at whatever the reader had scrolled past.
    if(window.matchMedia){ try{ window.matchMedia("print").addListener(function(m){ if(m.matches) draw(matches.length); }); }catch(e){} }
    window.addEventListener("beforeprint",function(){ draw(matches.length); });

    var io=null;
    if(window.IntersectionObserver){
      io=new IntersectionObserver(function(es){
        es.forEach(function(e){ if(e.isIntersecting){ io.unobserve(e.target); draw(CHUNK*2); } });
      },{rootMargin:"900px"});
    }

    function apply(){
      matches=items.filter(function(p){return keep(p,null);});
      drawn=0; list.innerHTML="";
      countEl.textContent=matches.length===items.length
        ? PL(items.length,"passage","passages")
        : matches.length+" of "+items.length+" passages";
      draw(CHUNK*2);
      recount();
    }

    host.addEventListener("change",function(e){
      var t=e.target; if(!t||t.getAttribute("data-f")==null) return;
      var g=t.getAttribute("data-f"), v=t.value, at=sel[g].indexOf(v);
      if(t.checked){ if(at<0) sel[g].push(v); } else if(at>=0) sel[g].splice(at,1);
      apply();
    });
    var timer=null;
    q.addEventListener("input",function(){
      clearTimeout(timer);
      timer=setTimeout(function(){
        terms=q.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
        apply();
      },60);
    });
    host.querySelector("#pclear").addEventListener("click",function(){
      groups.forEach(function(g){sel[g.id]=[];});
      [].slice.call(host.querySelectorAll('input[data-f]')).forEach(function(c){c.checked=false;});
      q.value=""; terms=[]; apply();
    });
    host.querySelector("#pcsv").addEventListener("click",function(){
      var head=["quote","source","year","doi","page","section","codes","coders","checked"],out=[head.join(",")];
      matches.forEach(function(p){
        var s=X.sources[p.s]||{};
        var f=[p.q||p.n, (s.k||"")+" — "+(s.t||""), s.y||"", s.d||"", p.pg||"", p.sc||"",
               p.g.map(function(g){return g[0]+":"+g[1];}).join("; "),
               p.g.map(function(g){return g[2];}).join("; "),
               (X.badges[p.b]||[])[1]||""];
        out.push(f.map(function(v){return '"'+String(v==null?"":v).replace(/"/g,'""')+'"';}).join(","));
      });
      var a=document.createElement("a");
      a.href=URL.createObjectURL(new Blob([out.join("\n")],{type:"text/csv"}));
      a.download="passages.csv"; document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(a.href);
    });

    apply();
  }

  // scrollIntoView would scroll the window as well as the list, throwing the
  // reader down the page every time they picked something. This moves only the
  // list, and only when the thing is actually out of sight.
  function reveal(box,el){
    if(!box||!el) return;
    var r=el.getBoundingClientRect(), b=box.getBoundingClientRect();
    if(r.top>=b.top&&r.bottom<=b.bottom) return;
    box.scrollTop+=(r.top-b.top)-box.clientHeight/2+r.height/2;
  }

  // "Show support for each statement" (1.15.0): the claims table's extra columns.
  document.addEventListener("change",function(e){
    var t=e.target;
    if(!t||!t.matches||!t.matches("input[data-support]")) return;
    var box=t.closest("section,main")||document, tb=box.querySelector("table.claims");
    if(tb) tb.classList.toggle("show-support",t.checked);
  });

  var API={init:init,card:card,chip:chip,badge:badge,browse:browse,label:label,reveal:reveal,codeNote:codeNote,esc:E,plural:PL,
           windowText:windowText,open:function(art){ if(art&&cxOpen!==art) cxToggle(art); },close:function(){ cxClose(cxOpen); }};
  window.UPCB=API;
  // Printing includes everything: open whatever the reader left folded.
  window.addEventListener("beforeprint",function(){
    [].slice.call(document.querySelectorAll("details")).forEach(function(d){ d.open=true; });
  });
})();
`;

// The findings engine (1.15.0), shared by both shapes: the Findings page — every
// statement of the rated reviews, filtered by how well it is supported, what kind
// of statement it is, where its evidence comes from and which review it is in,
// with starting points a corpus names for its readers — and the evidence map.
// Both read one payload (findingsPayload in site.mjs). A statement's passages are
// rendered by the browse engine's own card, so "In context" works here as well.
const FINDINGS_JS = String.raw`
(function(){
  var X=null, F=null, byId={}, S=null, host=null;
  var E=function(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");};
  var PL=function(n,a,b){return n+" "+(n===1?a:b);};
  var KEYS=["well","some","limited","weak"], RANK={well:0,some:1,limited:2,weak:3}, STEP=40;
  // What the passage's paper is, on one line: its grade, design and place (never its citation impact,
  // which is shown beside the grade on the paper's page and never combined with it).
  var PAPER=["evidence-grade","study-design","place"];

  function init(ctx){ X=ctx; F=ctx.F; byId={}; (ctx.passages||[]).forEach(function(p){ byId[p.id]=p; }); return API; }
  function badge(s,i){
    return '<span class="sup-b s-'+s+'"'+(i?' title="'+E("On the IPCC scale: "+i)+'"':"")+'><span class="dots" aria-hidden="true">'+
      F.dots[s]+"</span>"+E(F.words[s])+"</span>";
  }
  function studies(f){
    if(f.ro) return "only relayed from other work";
    if(!f.n) return "no supporting study";
    var t=f.n===1?"1 study":f.n+" studies agree";
    return f.np>f.n?t+" ("+f.np+" papers)":t;
  }
  function flags(f){
    return (f.sl?' <span class="flag" title="Every supporting paper has the same lead author">one lead author</span>':"")+
           (f.ro?' <span class="flag" title="The papers cited only report this from other work">relayed only</span>':"");
  }
  function parse(q){
    var o={};
    String(q||"").replace(/^[#?]/,"").split("&").forEach(function(kv){
      if(!kv) return; var i=kv.indexOf("=");
      o[i<0?kv:kv.slice(0,i)]=i<0?"":decodeURIComponent(kv.slice(i+1));
    });
    return o;
  }
  function query(){
    var a=[];
    if(S.start) a.push("start="+encodeURIComponent(S.start));
    if(S.theme) a.push("theme="+encodeURIComponent(S.theme));
    if(S.group) a.push("group="+encodeURIComponent(S.group));
    if(S.src>=0) a.push("src="+S.src);
    if(S.support.length) a.push("support="+S.support.join(","));
    if(S.kinds.length) a.push("kind="+S.kinds.join(","));
    if(S.places.length) a.push("place="+S.places.join(","));
    if(S.sort!=="strength") a.push("sort="+S.sort);
    if(S.q) a.push("q="+encodeURIComponent(S.q));
    return a.join("&");
  }
  function startOf(id){ for(var i=0;i<F.starts.length;i++) if(F.starts[i].id===id) return F.starts[i]; return null; }
  function ov(f){ return F.ov[f.o]; }
  function inStart(f,m){
    if(!m) return true;
    var o=ov(f);
    if(m.groups&&m.groups.length&&m.groups.indexOf(o.g)<0) return false;
    if(m.themes&&m.themes.length&&m.themes.indexOf(o.k)<0) return false;
    if(m.kinds&&m.kinds.length&&m.kinds.indexOf(f.k)<0) return false;
    if(m.support&&m.support.length&&m.support.indexOf(f.s)<0) return false;
    if(m.places&&m.places.length&&!f.pl.some(function(p){return m.places.indexOf(p)>=0;})) return false;
    return true;
  }
  function hay(f){
    if(f._h==null){
      var o=ov(f);
      f._h=(f.t+" "+o.t+" "+f.co.join(" ")+" "+f.de.join(" ")+" "+f.ps.map(function(p){
        var x=byId[p[0]], s=x&&X.sources[x.s]; return (s?s.k+" "+s.t:"")+" "+(x&&x.q||""); }).join(" ")).toLowerCase();
    }
    return f._h;
  }
  function keep(f,skip){
    var st=startOf(S.start);
    if(st&&!inStart(f,st.match)) return false;
    if(skip!=="support"&&S.support.length&&S.support.indexOf(f.s)<0) return false;
    if(skip!=="kinds"&&S.kinds.length&&S.kinds.indexOf(f.k)<0) return false;
    if(skip!=="places"&&S.places.length&&!f.pl.some(function(p){return S.places.indexOf(p)>=0;})) return false;
    var o=ov(f);
    if(S.group&&o.g!==S.group) return false;
    if(S.theme&&o.k!==S.theme&&o.a!==S.theme) return false;
    if(S.src>=0&&!f.ps.some(function(p){return p[3]===S.src&&(p[1]==="supports"||p[1]==="partly");})) return false;
    for(var i=0;i<S.terms.length;i++) if(hay(f).indexOf(S.terms[i])<0) return false;
    return true;
  }
  var SORTS={
    strength:function(a,b){ return RANK[a.s]-RANK[b.s]||b.n-a.n||a.o-b.o||a.r-b.r; },
    studies:function(a,b){ return b.n-a.n||RANK[a.s]-RANK[b.s]||a.o-b.o||a.r-b.r; },
    review:function(a,b){ var A=ov(a),B=ov(b); return A.g<B.g?-1:A.g>B.g?1:A.t<B.t?-1:A.t>B.t?1:a.r-b.r; }
  };

  // ---- the Findings page ----
  function box(name,val,label){
    return '<label><input type="checkbox" data-ff="'+name+'" value="'+E(val)+'"'+(S[name].indexOf(val)>=0?" checked":"")+
      "><span>"+E(label)+'</span><span class="n" data-fn="'+name+":"+E(val)+'"></span></label>';
  }
  function side(){
    var kinds=Object.keys(F.kinds).filter(function(k){ return F.f.some(function(f){return f.k===k;}); });
    var places=Object.keys(F.places).filter(function(k){ return k!=="not-stated"; });
    var themes=F.ov.map(function(o,i){return {o:o,i:i};}).filter(function(x){return !S.group||x.o.g===S.group;})
      .sort(function(a,b){return a.o.t<b.o.t?-1:1;});
    return (F.starts.length?'<div class="fstarts"><p class="small muted" style="margin:0 0 .3rem">Start from</p>'+
        F.starts.map(function(s){
          return '<button class="btn sbtn'+(S.start===s.id?" on":"")+'" data-start="'+E(s.id)+'">'+E(s.label)+
            (s.task?"<small>"+E(s.task)+"</small>":"")+"</button>";
        }).join("")+"</div>":"")+
      '<input type="search" class="sidesearch" id="fq" placeholder="Search the statements…" value="'+E(S.q)+'">'+
      '<p class="small" style="margin:.5rem 0"><button class="btn" id="fclear">Clear all</button></p>'+
      '<details open><summary>How well supported</summary>'+KEYS.map(function(k){return box("support",k,F.words[k]);}).join("")+"</details>"+
      '<details open><summary>What kind of statement</summary>'+kinds.map(function(k){return box("kinds",k,F.kinds[k]);}).join("")+"</details>"+
      (places.length?'<details open><summary>Where the evidence is from</summary>'+places.map(function(k){return box("places",k,F.places[k]);}).join("")+
        '<p class="small muted" style="margin:.2rem 0">Where the supporting studies did their research; a statement only relayed from other work has no place.</p></details>':"")+
      '<details open><summary>Review</summary>'+
        '<select id="fgroup" style="width:100%"><option value="">Every group</option>'+F.groups.map(function(g){
          return '<option value="'+E(g.slug)+'"'+(S.group===g.slug?" selected":"")+">"+E(g.title)+"</option>"; }).join("")+"</select>"+
        '<select id="ftheme" style="width:100%;margin-top:.35rem"><option value="">Every review</option>'+themes.map(function(x){
          var v=x.o.k||x.o.a; return '<option value="'+E(v)+'"'+(S.theme===v?" selected":"")+">"+E(x.o.t)+"</option>"; }).join("")+"</select></details>"+
      '<details open><summary>Order</summary><select id="fsort" style="width:100%">'+
        [["strength","Best supported first"],["studies","Most studies first"],["review","By review, as written"]].map(function(o){
          return '<option value="'+o[0]+'"'+(S.sort===o[0]?" selected":"")+">"+o[1]+"</option>"; }).join("")+"</select></details>";
  }
  function item(f,i){
    var o=ov(f);
    var meta=[F.kinds[f.k]||"", 'from <a href="'+E(o.h)+'">'+E(o.t)+"</a>",
              f.co.length?E(f.co.join(", ")):"", f.de.length?E(f.de.join(", ")):""].filter(Boolean);
    return '<article class="fd">'+
      '<div class="ftop">'+badge(f.s,f.i)+' <span class="small muted">'+E(studies(f))+"</span>"+flags(f)+"</div>"+
      '<p class="ftext">'+E(f.t)+"</p>"+
      '<p class="small muted fmeta">'+meta.join(" · ")+"</p>"+
      '<details data-fi="'+i+'"><summary class="small">The passages ('+f.ps.length+") and how each was checked</summary>"+
      '<div class="fps"></div></details></article>';
  }
  function paperLine(s){
    var bits=[];
    PAPER.forEach(function(slug){ var mine=[];
      (s.g||[]).forEach(function(g){ var l=X.label(g[0],g[1]); if(g[0]===slug&&mine.indexOf(l)<0) mine.push(l); });
      if(mine.length) bits.push(mine.join(" / ")); });
    return bits.join(" · ");
  }
  function passages(f){
    return f.ps.map(function(p){
      var x=byId[p[0]], s=x?(X.sources[x.s]||{}):{};
      var v=p[1]||"no majority", cls=v==="supports"?"yes":v==="partly"?"part":"no";
      return '<div class="fpass"><p class="small fv"><span class="v v-'+cls+'">'+E(v)+(p[2]&&p[2]!=="none"?" · "+E(p[2]):"")+"</span> "+
        "<strong>"+E(s.k||"")+"</strong>"+(paperLine(s)?' <span class="muted">· '+E(paperLine(s))+"</span>":"")+"</p>"+
        (x?X.card(x):'<p class="small muted">This passage is not in the library.</p>')+"</div>";
    }).join("")+'<p class="small muted" style="margin:.3rem 0 0">A verdict says whether the passage backs the whole statement '+
      "(supports), part of it, or not. Advisory: three runs of a model, by majority.</p>";
  }
  function notes(){
    var out="", st=startOf(S.start);
    if(st){
      var pc="";
      if(st.match&&st.match.places&&st.match.places.length&&X.placeCount){
        var n=X.placeCount(st.match.places); if(n) pc=" "+n[0]+" of "+PL(n[1],"paper","papers")+" in the library studied there.";
      }
      out+='<div class="fnote"><strong>'+E(st.label)+(st.task?" ("+E(st.task)+")":"")+".</strong> "+E(st.note||"")+E(pc)+"</div>";
    }
    if(S.src>=0&&X.sources[S.src]){
      var s=X.sources[S.src];
      out+='<div class="fnote">Statements backed by <strong>'+E(s.k)+"</strong>, "+E(s.t)+'. <a href="#" data-fsrc>Show every paper’s</a></div>';
    }
    return out;
  }
  function counts(list){
    return KEYS.map(function(k){ var n=list.filter(function(f){return f.s===k;}).length; return n?n+" "+F.words[k].toLowerCase():""; })
      .filter(Boolean).join(" · ");
  }
  function draw(){
    var list=F.f.filter(function(f){return keep(f,null);}).sort(SORTS[S.sort]||SORTS.strength);
    var pane=host.querySelector("#fpane");
    pane.innerHTML=notes()+'<p class="small fcount"><span>'+(list.length===F.f.length?PL(list.length,"statement","statements")
        :"Showing "+list.length+" of "+PL(F.f.length,"statement","statements"))+"</span><span class=\"muted\">"+E(counts(list))+"</span></p>"+
      (list.length?"":'<p class="muted">Nothing matches. <a href="#" data-fclear>Clear the filters</a>.</p>')+
      '<div id="flist">'+list.slice(0,S.shown).map(function(f){return item(f,F.f.indexOf(f));}).join("")+"</div>"+
      (list.length>S.shown?'<p><button class="btn" id="fmore">Show '+Math.min(STEP,list.length-S.shown)+" more</button></p>":"");
    recount();
    if(X.setQuery) X.setQuery(query());
  }
  function recount(){
    ["support","kinds","places"].forEach(function(name){
      var seen={};
      F.f.forEach(function(f){ if(!keep(f,name)) return;
        (name==="places"?f.pl:[name==="support"?f.s:f.k]).forEach(function(v){ seen[v]=(seen[v]||0)+1; }); });
      [].slice.call(host.querySelectorAll('[data-fn^="'+name+':"]')).forEach(function(el){
        var v=el.getAttribute("data-fn").slice(name.length+1), n=seen[v]||0;
        el.textContent=n; el.parentNode.className=n||S[name].indexOf(v)>=0?"":"off";
      });
    });
  }
  function redrawSide(){ host.querySelector("#fside .fwrap").innerHTML=side(); }
  function findings(el,q){
    host=el;
    var p=parse(q);
    S={start:p.start&&startOf(p.start)?p.start:"", q:p.q||"", terms:[],
       support:p.support?p.support.split(","):[], kinds:p.kind?p.kind.split(","):[], places:p.place?p.place.split(","):[],
       group:p.group||"", theme:p.theme||"", src:p.src!=null&&p.src!==""?+p.src:-1, sort:SORTS[p.sort]?p.sort:"strength", shown:STEP};
    S.terms=S.q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    var wide=!window.matchMedia||window.matchMedia("(min-width:861px)").matches;
    host.innerHTML='<div class="split"><aside class="side" id="fside"><details class="fwrap-d"'+(wide?" open":"")+
      '><summary>Filters and starting points</summary><div class="fwrap">'+side()+'</div></details></aside><section class="pane" id="fpane"></section></div>';
    if(!host.__wired){ host.__wired=1; wire(); }
    draw();
  }
  function wire(){
    host.addEventListener("change",function(e){
      var t=e.target; if(!t) return;
      var ff=t.getAttribute&&t.getAttribute("data-ff");
      if(ff){ var at=S[ff].indexOf(t.value); if(t.checked){ if(at<0) S[ff].push(t.value); } else if(at>=0) S[ff].splice(at,1); }
      else if(t.id==="fgroup"){ S.group=t.value; S.theme=""; redrawSide(); }
      else if(t.id==="ftheme"){ S.theme=t.value; }
      else if(t.id==="fsort"){ S.sort=t.value; }
      else return;
      S.shown=STEP; draw();
    });
    var timer=null;
    host.addEventListener("input",function(e){
      if(!e.target||e.target.id!=="fq") return;
      clearTimeout(timer);
      timer=setTimeout(function(){ S.q=e.target.value; S.terms=S.q.toLowerCase().trim().split(/\s+/).filter(Boolean); S.shown=STEP; draw(); },80);
    });
    host.addEventListener("click",function(e){
      var t=e.target&&e.target.closest?e.target.closest("[data-start],#fmore,#fclear,[data-fclear],[data-fsrc]"):null;
      if(!t) return;
      if(t.id==="fmore"){ S.shown+=STEP; draw(); return; }
      e.preventDefault();
      if(t.hasAttribute("data-start")){ var id=t.getAttribute("data-start"); S.start=S.start===id?"":id; S.group=""; S.theme=""; }
      else if(t.hasAttribute("data-fsrc")){ S.src=-1; }
      else { S.start=""; S.q=""; S.terms=[]; S.support=[]; S.kinds=[]; S.places=[]; S.group=""; S.theme=""; S.src=-1; }
      S.shown=STEP; redrawSide(); draw();
    });
    // A statement's passages are built the first time it is opened.
    host.addEventListener("toggle",function(e){
      var d=e.target;
      if(!d||!d.hasAttribute||!d.hasAttribute("data-fi")||!d.open) return;
      var box=d.querySelector(".fps");
      if(box&&!box.__done){ box.__done=1; box.innerHTML=passages(F.f[+d.getAttribute("data-fi")]); }
    },true);
  }

  // ---- the evidence map ----
  function strip(c){
    var tot=c.n||1;
    return '<div class="strip">'+KEYS.map(function(k){ return c[k]?'<i class="s-'+k+'" style="width:'+(100*c[k]/tot).toFixed(2)+'%" title="'+
      E(c[k]+" "+F.words[k].toLowerCase())+'"></i>':""; }).join("")+"</div>";
  }
  function map(el){
    var rows=F.ov.map(function(o,i){
      var c={n:0,well:0,some:0,limited:0,weak:0,finding:0,place:0};
      F.f.forEach(function(f){ if(f.o!==i) return; c.n++; c[f.s]++; if(f.k==="finding") c.finding++;
        if(F.mapPlace&&f.pl.indexOf(F.mapPlace)>=0) c.place++; });
      c.good=c.n?(c.well+c.some)/c.n:0;
      return {o:o,c:c};
    });
    var thin=rows.filter(function(r){return !r.c.well&&!r.c.some;});
    var pl=F.mapPlace?(F.places[F.mapPlace]||F.mapPlace):"";
    var tot={n:0,well:0,some:0,limited:0,weak:0}; F.f.forEach(function(f){ tot.n++; tot[f.s]++; });
    el.innerHTML=(F.notes.map_note?'<div class="card fnote-card"><p style="margin:0">'+E(F.notes.map_note)+"</p></div>":"")+
      '<div class="card" style="margin:.8rem 0">'+strip(tot)+'<div class="legend">'+KEYS.map(function(k){
        return '<span class="s-'+k+'">'+E(F.words[k])+" "+tot[k]+"</span>"; }).join("")+"</div>"+
      (thin.length?'<p class="small" style="margin:.5rem 0 0">'+PL(thin.length,"review has","reviews have")+
        " no statement above limited support: "+thin.map(function(r){return E(r.o.t);}).join(", ")+".</p>":"")+"</div>"+
      '<div class="wrap"><table class="emap"><thead><tr><th>Review</th><th class="num">Papers</th><th class="num">Statements</th>'+
      '<th>Support</th><th class="num hide-s">From data or cases</th>'+(pl?'<th class="num hide-s">With evidence from '+E(pl)+"</th>":"")+
      "</tr></thead><tbody>"+F.groups.map(function(g){
        var rs=rows.filter(function(r){return r.o.g===g.slug;}).sort(function(a,b){return b.c.good-a.c.good||b.c.n-a.c.n;});
        if(!rs.length) return "";
        return '<tr class="grp"><td colspan="'+(pl?6:5)+'">'+E(g.title)+"</td></tr>"+rs.map(function(r){
          var t=r.o.k||r.o.a;
          return "<tr"+(!r.c.well&&!r.c.some?' class="thin"':"")+'><td><a href="'+E(r.o.h)+'">'+E(r.o.t)+"</a>"+
            (!r.c.well&&!r.c.some?' <span class="flag">thin</span>':"")+'</td><td class="num">'+r.o.np+
            '</td><td class="num"><a href="'+E(X.hrefFindings("theme="+encodeURIComponent(t)))+'" title="See its statements">'+r.c.n+"</a></td>"+
            "<td>"+strip(r.c)+'</td><td class="num hide-s">'+(r.c.finding||"")+"</td>"+(pl?'<td class="num hide-s">'+(r.c.place||"")+"</td>":"")+"</tr>";
        }).join("");
      }).join("")+"</tbody></table></div>";
  }

  var API={init:init,findings:findings,map:map,parse:parse};
  window.UPCF=API;
})();
`;

function page({ title, rel, body, model, active, extraHead = "", data = false }) {
  const up = rel.split("/").length - 1;
  const base = up ? "../".repeat(up) : "";
  const library = model.interviews
    ? [...(IV.guideBooks(model).qs ? [["questions/", "Questions", "questions"]] : []), ["sources/", "Interviews", "sources"],
       ...(model.passages.some((p) => p.names.length) ? [["people/", "People", "people"]] : []),
       ["passages/", "Passages", "passages"], ["codes/", "Codes", "codes"]]
    : [["codes/", "Codes", "codes"], ["sources/", "Sources", "sources"], ["passages/", "Passages", "passages"]];
  const reviews = model.syntheses.length ? [["overviews/", "Overviews", "overviews"]] : [];
  const nav = [
    // Not "": on a top-level page (the matrix) an empty link is *this* page.
    ["index.html", "Home", "home"],
    // A rated library (1.15.0) leads with what the literature says, then how it was built.
    ...(model.findings.length
      ? [["findings.html", "Findings", "findings"], ["evidence.html", "Evidence map", "evidence"], ...reviews, ...library]
      : [...library, ...reviews]),
    ...(model.matrix ? [["matrix.html", "Matrix", "matrix"]] : []),
    ...(model.about ? [["methods.html", "Methods", "methods"]] : []),
  ];
  const banner = model.failures
    ? `<div class="banner"><strong>${plural(model.failures, "quotation does", "quotations do")} not match the source.</strong>
       They are shown with a warning wherever they appear, and should be re-checked before use.</div>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${base}assets/site.css">
${extraHead}
${data ? `<script src="${base}data/browse.js" defer></script>` : ""}
${data === "findings" ? `<script src="${base}data/findings.js" defer></script>` : ""}
<script src="${base}assets/site.js" defer></script>
</head><body>
<header class="top"><div class="in">
  <span class="brand">${esc(model.title)}</span>
  <nav>${nav.map(([href, label, key]) =>
    `<a class="${key === active ? "on" : ""}" href="${base}${href}">${esc(label)}</a>`).join("")}</nav>
  <span class="spacer"></span>
  <button class="theme" onclick="__toggleTheme()">Light / dark</button>
</div></header>
<main>${banner}${body}</main>
<footer>
  Built from a Universal Provenance Corpus (spec ${esc(model.specVersion || "")}).
  Every quotation here was compared with the source text character by character when this page was built${
  model.interviews ? " (for an interview, with its transcript: a machine's hearing of the recording, not the recording itself)" : ""}.
  A <em>code</em> is somebody's judgement about a passage — hover it to see who made it — and is never a check mark.
</footer>
</body></html>
`;
}

// --- fragments ------------------------------------------------------------

function badgeHtml(badge, terse) {
  const [icon, label, why] = BADGE_TEXT[badge] || BADGE_TEXT.unverifiable;
  const cls = badge === "failed" ? "badge bad" : (badge === "paraphrase" || badge === "unverifiable") ? "badge plain" : "badge";
  return `<span class="${cls}"${terse ? "" : ` title="${attr(why)}"`}>${icon} ${esc(label)}</span>`;
}

function chipHtml(c, base, detached) {
  const label = esc(c.label || c.code || c.value);
  // Who made the judgement lives in the tooltip, with its confidence and reason;
  // each page also says once, visibly, what kind of coder made its codes (§09).
  const title = [c.definition ? `${c.label}: ${c.definition}` : c.label,
                 `Coded by ${c.coder}${c.coder_kind ? ` (${KIND_LABEL[c.coder_kind] || c.coder_kind})` : ""}${c.confidence ? ` · confidence ${c.confidence}` : ""}`,
                 c.rationale ? `Why: ${c.rationale}` : ""].filter(Boolean).join("\n");
  const href = c.code != null ? `${base}codes/${encodeURIComponent(c.codebook_slug)}/${encodeURIComponent(c.code)}.html` : null;
  return `<span class="chip${detached ? " detached" : ""}" data-id="${attr(c.coding_id)}" title="${attr(title)}">${
    href ? `<a href="${href}">${label}</a>` : label}</span>`;
}

/** A paper's evidence codes, one chip per code: when two coders gave the same code
 *  (the vote of model runs and a blind second coder, say) the chip names both in its
 *  tooltip. Different codes still get a chip each, so a disagreement stays visible. */
function evChipsHtml(list, base) {
  const groups = new Map();
  for (const c of list) {
    const k = `${c.codebook_slug}:${c.code != null ? c.code : c.value}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return [...groups.values()].map((cs) => {
    const html = chipHtml(cs[0], base, false);
    if (cs.length < 2) return html;
    const more = cs.slice(1).map((c) => `Also coded so by ${c.coder}${c.coder_kind ? ` (${KIND_LABEL[c.coder_kind] || c.coder_kind})` : ""}`).join("\n");
    return html.replace(/title="([^"]*)"/, (m, t) => `title="${t}\n${attr(more)}"`);
  }).join(" ");
}

/** How a chip's tooltip names a kind of coder. */
const KIND_LABEL = { rule: "a rule", ensemble: "a vote of model runs" };

/** Who made this corpus's codes: "a language model", "people", both, or "". */
function codedBy(model) {
  const kinds = new Set();
  for (const x of [...model.passages, ...model.sources]) for (const c of x.codings) kinds.add(c.coder_kind || "other");
  const machine = kinds.has("model") || kinds.has("ensemble");
  const base = machine && kinds.has("human") ? "a language model and by people"
       : kinds.has("human") ? "people" : machine ? "a language model" : "";
  // A citation tier is computed, not judged: say so when there are such codes.
  return kinds.has("rule") ? (base ? `${base}, and some by rules` : "rules") : base;
}

/** The one visible sentence that replaces a coder name on every chip. */
function codeNote(model) {
  const who = codedBy(model);
  return (who ? `Codes were assigned by ${who}. ` : "Codes are judgements, not checks. ") +
    "Hover a code to see who assigned it, how sure they were, and why.";
}

function passageHtml(p, model, base, { showSource = true, context = true, compact = false } = {}) {
  const bad = p.badge === "failed";
  const status = STATUS_TEXT[p.status] || "";
  const srcHref = `${base}sources/${encodeURIComponent(p.source_slug)}.html#ex=${encodeURIComponent(p.id)}`;
  const src = model.sourceById.get(p.source_id);
  let body;
  if (p.quote) {
    const q = `<mark>${IV.speech(esc(p.quote))}</mark>`;
    if (context && p.cx) {
      // Where there is no script to open it (the code pages' <noscript> list), shown open.
      const [t, a, b] = p.cx;
      body = `<blockquote class="ctx">${esc(t.slice(0, a))}<mark>${esc(t.slice(a, b))}</mark>${esc(t.slice(b))}</blockquote>`;
    } else {
      body = p.cx ? `<blockquote ${quoteToggle(src && src.pdfRep)}>${q}</blockquote>` : `<blockquote>${q}</blockquote>`;
    }
    if (bad && p.actual != null) {
      body += `<p class="small" style="color:var(--warn)">The source now reads: “${esc(p.actual.slice(0, 240))}”</p>`;
    }
  } else {
    // A summary is never dressed as a quotation (spec/09).
    body = `<p class="note">${esc(p.note)}</p>`;
  }
  // Evidence ratings (1.15.0) ride apart, shown where a passage is opened in
  // context or read on its paper's page, never on a topical list's cards.
  const ev = p.codings.filter((c) => c.ev);
  const chips = p.codings.filter((c) => !c.ev).map((c) => chipHtml(c, base, bad, compact)).join(" ") +
    (ev.length ? ` <span class="evchips">${ev.map((c) => chipHtml(c, base, bad, compact)).join(" ")}</span>` : "");
  const dis = p.disagreements.length
    ? `<div class="disagree">Coders disagree here — both judgements are kept and shown.</div>` : "";
  // "line N →" opens the passage where it sits in the paper's text (#text=, the
  // highlight), not the card it is written on; "See in original, p. N ↗" opens
  // the original — the same pair the passages page shows.
  const where = p.line_range ? p.place || `line ${p.line_range.start}` : "";
  const textHref = where
    ? `${base}sources/${encodeURIComponent(p.source_slug)}.html#text=${encodeURIComponent(p.id)}` : srcHref;
  const pdfName = src && src.pdfRep && !src.pdfOff ? path.basename(src.pdfRep.path) : "";
  const pdfLink = originalLinkHtml(p.page,
    model.filesDir && pdfName ? `${base}${model.filesDir}/${encodeURIComponent(pdfName)}` : null,
    src && src.doi);
  const csv = compact ? "" : j({
    quote: p.quote || p.note, source: `${p.cite} — ${p.source_title}`, year: p.year,
    doi: (model.sourceById.get(p.source_id) || {}).doi || "",
    codes: p.codings.map((c) => `${c.codebook_slug}:${c.code != null ? c.code : c.value}`).join("; "),
    coders: [...new Set(p.codings.map((c) => c.coder))].join("; "),
    checked: (BADGE_TEXT[p.badge] || [])[1] || "",
  });
  // The searchable string repeats the quote, so on a page that lists every
  // passage in the corpus it is the quote's own text that is searched instead —
  // otherwise each row carries its text three times and the page runs to
  // megabytes. Codes and titles still have to be there to be findable.
  const searchable = compact
    ? [p.source_title, p.cite, ...p.codings.map((c) => `${c.label} ${c.coder}`)].join(" ")
    : [p.quote, p.note, p.source_title, p.cite,
       ...p.codings.map((c) => `${c.label} ${c.code || c.value} ${c.codebook_slug} ${c.coder}`)].join(" ");
  // The sentences around it ride in data/ctx/<paper>.js, loaded the first time one is opened.
  const cxSrc = p.cx && !context ? ` data-cx="${base}data/ctx/${encodeURIComponent(p.source_slug)}.js"` : "";
  return `<article class="passage${bad ? " bad" : ""}" id="${attr(p.id)}"${cxSrc} data-row
   data-code="${attr(p.codings.map((c) => `${c.codebook_slug}:${c.code != null ? c.code : c.value}`).join("|"))}"
   data-coder="${attr([...new Set(p.codings.map((c) => c.coder))].join("|"))}"
   data-source="${attr(p.source_id)}" data-year="${attr(p.year)}"
   data-search="${attr(searchable)}"${compact ? "" : ` data-csv="${attr(csv)}"`}>
  ${body}${dis}
  <div class="meta">
    ${badgeHtml(p.badge, compact)}
    ${status ? `<span class="badge plain">${esc(status)}</span>` : ""}
    ${chips}
    ${p.speakers && p.speakers.length ? `<span class="speaker">${esc(p.speakers.join(", "))}</span>` : ""}
    <span class="spacer"></span>
    ${IV.passagePlay(p, src && src.audioHref ? base + src.audioHref : null)}
    <span class="go">${showSource ? `<a class="muted" href="${textHref}">${esc(p.cite)}${where ? ` · ${esc(where)}` : ""} →</a>`
                 : `<a class="muted" href="${textHref}">${esc(where || "in context")} →</a>`}${pdfLink}</span>
  </div>
</article>`;
}

// --- pages ----------------------------------------------------------------

function homePage(model) {
  if (model.interviews) return page({ title: model.title, rel: "index.html", model, active: "home", body: IV.interviewHomeBody(model) });
  const hc = homeCard(model, folderLinks(""));
  const nPass = model.passages.filter((p) => p.quote).length;
  const nNote = model.passages.length - nPass;
  const verified = model.passages.filter((p) => U.VERIFIED_BADGES.has(p.badge)).length;
  const tiles = [
    [model.sources.length, "sources", "sources/"],
    [nPass, "passages (quoted)", "passages/"],
    [model.codebooks.filter((cb) => !isEvidence(cb)).length, "codebooks", "codes/"],
    [model.syntheses.length, "overviews", "overviews/"],
  ].filter(([n, , href]) => n || href === "sources/");
  return page({
    title: model.title, rel: "index.html", model, active: "home",
    body: `<h1>${esc(model.title)}</h1>
<p class="lede">A searchable library of what this literature actually says. Every quotation was compared with the
source text character by character when this page was built${verified === nPass && nPass ? " — all of them matched" : ""}.</p>
${findingsHomeHtml(model, folderLinks(""))}
${hc ? `${model.findings.length ? "<h2>What the literature says</h2>" : ""}<section class="card homesum"><h2>${esc(hc.t)}</h2>${hc.r || ""}${hc.h}</section>` : ""}
${model.syntheses.length ? `<p class="lede">${hc ? "<strong>Go deeper:</strong> read the" : "<strong>New here?</strong> Start with the"}
<a href="overviews/">${plural(model.syntheses.length, "overview", "overviews")}</a> — a short review per theme,
written from the coded passages, with every quotation linked back to the paper it came from. Then browse by
<a href="codes/">theme</a>, by <a href="sources/">paper</a>, or search <a href="passages/">every passage</a>.</p>`
 : `<p class="lede">Browse by <a href="codes/">theme</a>, by <a href="sources/">paper</a>, or search
<a href="passages/">every passage</a>.</p>`}
<div class="grid cards">
${tiles.map(([n, u, href]) => `<a class="card tile" href="${href}"><span class="n">${n}</span><br><span class="u">${esc(u)}</span></a>`).join("\n")}
</div>
${nNote ? `<p class="small muted">${plural(nNote, "passage is", "passages are")} a summary rather than a quotation; those are shown in italics and are never checked.</p>` : ""}
<h2>How to read this</h2>
<div class="card">
<p class="small"><strong>A passage</strong> is a span of text from one paper, quoted exactly.
<strong>A check mark</strong> means the quotation matched the paper's text when this site was built.
<strong>A code</strong> is a judgement someone made about that passage — which theory it invokes, which dimension it speaks to.
Hover a code to see who made it and why; where two coders disagree, both judgements are shown. Nothing is resolved for you.</p>
</div>`,
  });
}

function codesIndexPage(model) {
  const table = ({ cb, rows }, h = "h2") => `
<${h}>${esc(cb.title)}</${h}>
${cb.question ? `<p class="small muted">${esc(cb.question)}</p>` : ""}
<div class="wrap"><table>
<thead><tr><th>Code</th><th>What it means</th><th class="num">Passages</th><th class="num">Sources</th></tr></thead>
<tbody>
${rows.map((r) => `<tr>
  <td>${r.nP || r.nS
    ? `<a href="${encodeURIComponent(cb.slug)}/${encodeURIComponent(r.code)}.html">${esc(r.label || r.code)}</a>`
    : `<span class="muted">${esc(r.label || r.code)}</span>`}</td>
  <td class="muted">${esc(r.definition || "")}</td>
  <td class="num">${r.nP || ""}</td><td class="num">${r.nS || ""}</td>
</tr>`).join("\n")}
${rows.every((r) => !r.nP && !r.nS)
  ? `<tr><td colspan="4" class="muted">Nothing has been coded against this scheme yet.</td></tr>` : ""}
</tbody></table></div>`;
  const byBook = model.codebooks.map((cb) => {
    const rows = (cb.codes || []).map((c) => {
      const rec = model.codeIndex.get(`${cb.codebook_id}:${c.code}`);
      return { ...c, nP: rec ? rec.passages.length : 0, nS: rec ? rec.sources.size : 0 };
    }).sort((a, b) => (b.nP - a.nP) || (b.nS - a.nS) || a.code.localeCompare(b.code));
    return { cb, rows };
  });
  const topical = byBook.filter((b) => !isEvidence(b.cb)), evidence = byBook.filter((b) => isEvidence(b.cb));
  return page({
    title: `Codes — ${model.title}`, rel: "codes/index.html", model, active: "codes",
    body: `<h1>Codes</h1>
<p class="lede">Each codebook asks one question of the literature. Counts state what they count:
a <em>passage</em> is one quoted span; a <em>source</em> is one paper.</p>
${topical.map((b) => table(b)).join("\n")}${evidence.length ? `
<h2 id="evidence">${esc(EVIDENCE_TITLE)}</h2>
<p class="small muted">${esc(EVIDENCE_NOTE)}${model.about ? ` <a href="../methods.html">How they were made</a>.` : ""}</p>
${evidence.map((b) => table(b, "h3")).join("\n")}` : ""}`,
  });
}

const EVIDENCE_TITLE = "Evidence ratings (advisory)";
const EVIDENCE_NOTE = "Judgements of how strong the evidence is, kept apart from the themes above. Each is a judgement " +
  "like any code — hover one to see who made it and why — and none is a check mark.";

/** "528 passages from 120 papers, plus 3 papers coded as a whole" — never one mixed number. */
function countsLede(passages, allSources) {
  const fromPapers = new Set(passages.map((p) => p.source_id)).size;
  const wholeOnly = Math.max(0, allSources.length - fromPapers);
  return `${plural(passages.length, "passage", "passages")} from ${plural(fromPapers, "paper", "papers")}` +
    (wholeOnly ? `, plus ${plural(wholeOnly, "paper", "papers")} coded as a whole` : "");
}

function codePage(model, cb, code) {
  const rec = model.codeIndex.get(`${cb.codebook_id}:${code.code}`);
  const passages = rec ? rec.passages.map((id) => model.passageById.get(id)).filter(Boolean) : [];
  const sourcesCoded = rec ? [...rec.sources] : [];
  const base = "../../";
  return page({
    title: `${code.label || code.code} — ${cb.title}`, rel: `codes/${cb.slug}/${code.code}.html`, model, active: "codes", data: true,
    body: `<p class="small muted"><a href="${base}codes/">Codes</a> › ${esc(cb.title)}</p>
<h1>${esc(code.label || code.code)}</h1>
${code.definition ? `<div class="defbox">${esc(code.definition)}${
  (code.examples || []).length ? `<div class="small muted" style="margin-top:.4rem">For example: “${esc(code.examples[0])}”</div>` : ""}</div>` : ""}
<p class="lede">${countsLede(passages, sourcesCoded)}.${
  passages.length ? " Narrow them on the left — those counts are within this code." : ""}</p>
${passages.length
  ? `<div data-browse data-base="${base}" data-only="${attr(cb.slug + ":" + code.code)}" data-omit="${attr(cb.slug)}"></div>
<noscript>${passages.map((p) => passageHtml(p, model, base)).join("\n")}</noscript>`
  : `<p class="muted">No passages carry this code yet.</p>`}`,
  });
}

function sourcesIndexPage(model) {
  if (model.interviews) {
    return page({ title: `Interviews — ${model.title}`, rel: "sources/index.html", model, active: "sources",
                  body: IV.interviewsIndexBody(model, "../") });
  }
  const rows = [...model.sources].sort((a, b) => String(a.cite).localeCompare(String(b.cite)));
  return page({
    title: `Sources — ${model.title}`, rel: "sources/index.html", model, active: "sources",
    body: `<h1>Sources</h1>
<p class="lede">${plural(model.sources.length, "paper", "papers")} in this corpus.</p>
<div class="filters sans small">
  <input type="search" data-q placeholder="Search titles, authors, journals…" style="min-width:20rem">
  <span class="muted" data-count data-one="source shown" data-many="sources shown"></span>
</div>
<div class="wrap"><table>
<thead><tr><th>Author, year</th><th>Title</th><th>Published in</th><th class="num">Passages</th></tr></thead>
<tbody>
${rows.map((s) => `<tr data-row data-search="${attr([s.title, s.authors, s.container, s.year, s.doi].join(" "))}">
  <td>${esc(s.cite)}</td>
  <td><a href="${encodeURIComponent(s.slug)}.html">${esc(s.title)}</a></td>
  <td class="muted">${esc(s.container || "")}</td>
  <td class="num">${s.passages.length || ""}</td>
</tr>`).join("\n")}
</tbody></table></div>`,
  });
}

function sourcePage(model, s, textInfo) {
  const base = "../";
  const b = s.bibliographic || {};
  const bits = [s.authors, s.year ? String(s.year) : "", s.container, b.volume ? `vol. ${b.volume}` : "",
    b.page ? `pp. ${b.page}` : ""].filter(Boolean).join(" · ");
  const pdfHref = model.filesDir && s.pdfRep && !s.pdfOff
    ? `${base}${model.filesDir}/${encodeURIComponent(path.basename(s.pdfRep.path))}` : null;
  const xmlHref = model.filesDir && s.xmlRep && !s.xmlOff
    ? `${base}${model.filesDir}/${encodeURIComponent(path.basename(s.xmlRep.path))}` : null;
  const marks = s.passages.filter((p) => p.quote && p.line_range).sort((a, b2) => (a.line_range.start - b2.line_range.start));
  if (s.interview || s.timingsRep) return recordingPage(model, s, textInfo, marks);
  return page({
    title: `${s.cite} — ${s.title}`, rel: `sources/${s.slug}.html`, model, active: "sources",
    extraHead: textInfo && textInfo.sidecar ? `<script src="${base}data/text/${encodeURIComponent(textInfo.sidecar)}" defer></script>` : "",
    body: `<p class="small muted"><a href="${base}sources/">Sources</a></p>
<h1>${esc(s.title)}</h1>
<p class="lede">${esc(bits)}${s.doi ? ` · <a href="https://doi.org/${encodeURIComponent(s.doi)}">doi:${esc(s.doi)}</a>` : ""}</p>
${s.codings.length || s.passages.some((p) => p.codings.length) ? `<p class="small muted">${esc(codeNote(model))}</p>` : ""}
${contributesHtml(model, s, folderLinks(base))}
${s.codings.some((c) => !c.ev) ? `<div class="card"><div class="small muted">Judgements about this paper as a whole</div>
  <div class="meta" style="margin-top:.4rem">${s.codings.filter((c) => !c.ev).map((c) => chipHtml(c, base, false)).join(" ")}</div></div>` : ""}
${sourceCardsHtml(model, s, folderLinks(base))}

<h2>Passages (${s.passages.length})</h2>
${s.passages.length ? `<div class="evshow">${s.passages.map((p) => passageHtml(p, model, base, { showSource: false, context: false })).join("\n")}</div>`
  : `<p class="muted">No passages have been coded from this paper yet.</p>`}

<h2>The text this was checked against</h2>
<p class="small muted">${s.xmlRep ? xmlNote(s, xmlHref, textInfo, model) : `Extracted from the PDF${pdfHref ? ` — <a href="${pdfHref}">open the PDF</a>`
  : model.filesDir && s.pdfOff ? ` — the PDF (${mib(s.pdfOff.bytes)}) is over the ${mib(s.pdfOff.max)} a file can be here, so it is not included` : ""}.`}
Highlighted spans are the passages above.${textInfo && textInfo.omitted ? " The full text is too large to show here." : ""}</p>
${textInfo && textInfo.inline != null
  ? `<div class="reading${textInfo.structured ? " structured" : ""}" id="reading">${textInfo.inline}</div>`
  : textInfo && textInfo.sidecar
    ? `<div class="reading${textInfo.structured ? " structured" : ""}" id="reading">Loading…</div>
       <script>document.addEventListener("DOMContentLoaded",function(){
         var el=document.getElementById("reading");
         if(window.__UPC_TEXT)el.innerHTML=window.__UPC_TEXT; else el.textContent="The text could not be loaded.";});</script>`
    : `<p class="muted">Not available.</p>`}
${marks.length ? `<p class="small muted">${plural(marks.length, "highlight", "highlights")} in the text above.</p>` : ""}`,
  });
}

/** "Converted from the publisher's full-text XML …": a full-text XML's reading copy is a
 *  deterministic text-to-text conversion (badged plain verified, spec/09), with no page
 *  numbers, so its passages are cited by the paper's own sections. */
function xmlNote(s, xmlHref, textInfo, model) {
  const by = textInfo && textInfo.madeBy ? ` by ${esc(textInfo.madeBy)}` : "";
  const links = [xmlHref ? `<a href="${xmlHref}">open the XML</a>` : "",
    model.filesDir && s.xmlOff ? `the XML (${mib(s.xmlOff.bytes)}) is over the ${mib(s.xmlOff.max)} a file can be here, so it is not included` : "",
    s.doi ? `<a href="https://doi.org/${encodeURIComponent(s.doi)}" target="_blank" rel="noopener">the article at doi.org ↗</a>` : ""]
    .filter(Boolean).join(" · ");
  return `Converted from the publisher's full-text XML${by}, word for word in reading order. It has no page numbers, so a ` +
    `passage is cited by the paper's own section and paragraph${textInfo && textInfo.structured ? " (¶ in the margin)" : ""}` +
    `${links ? ` — ${links}` : ""}.`;
}

/** A recording's page (1.16.0): who and when, the recording, the answers by question,
 *  every passage, and the transcript with each turn ready to play. */
function recordingPage(model, s, textInfo, marks) {
  const base = "../";
  const reading = textInfo && textInfo.inline != null
    ? `<div class="reading transcript" id="reading">${textInfo.inline}</div>`
    : textInfo && textInfo.sidecar
      ? `<div class="reading transcript" id="reading">Loading…</div>
       <script>document.addEventListener("DOMContentLoaded",function(){
         var el=document.getElementById("reading");
         if(window.__UPC_TEXT)el.innerHTML=window.__UPC_TEXT; else el.textContent="The text could not be loaded.";});</script>`
      : `<p class="muted">Not available.</p>`;
  const answers = new Set(s.passages.filter((p) => p.type === "x-answer").map((p) => p.id));
  const others = s.passages.filter((p) => !answers.has(p.id));
  return page({
    title: `${s.cite} — ${model.title}`, rel: `sources/${s.slug}.html`, model, active: "sources",
    extraHead: textInfo && textInfo.sidecar ? `<script src="${base}data/text/${encodeURIComponent(textInfo.sidecar)}" defer></script>` : "",
    body: `<p class="small muted"><a href="${base}sources/">${model.interviews ? "Interviews" : "Sources"}</a></p>
<h1>${esc(s.interview ? s.interview.interviewee || s.title : s.title)}</h1>
${s.interview ? IV.interviewTopHtml(model, s, base) : (s.audioHref ? `<div class="player"><audio id="upc-audio" controls preload="metadata" src="${attr(base + s.audioHref)}"></audio></div>` : "")}
${s.codings.some((c) => !c.ev) ? `<div class="card"><div class="small muted">Judgements about this ${s.interview ? "interview" : "source"} as a whole</div>
  <div class="meta" style="margin-top:.4rem">${s.codings.filter((c) => !c.ev).map((c) => chipHtml(c, base, false)).join(" ")}</div></div>` : ""}
${others.length ? `<h2>Passages (${others.length})</h2>
<p class="small muted">${esc(codeNote(model))}</p>
<div class="evshow">${others.map((p) => passageHtml(p, model, base, { showSource: false, context: false })).join("\n")}</div>` : ""}
<h2>Transcript</h2>
<p class="small muted">A machine's transcription of the recording, cleaned as described above; the quotations on this site are
checked against it character by character. Highlighted spans are passages.${s.audioHref ? " Click a turn to hear it." : ""}</p>
${reading}
${marks.length ? `<p class="small muted">${plural(marks.length, "highlight", "highlights")} in the transcript above.</p>` : ""}`,
  });
}

/** A paper's evidence: its evidence-group codes, then each card (a rating, say),
 *  each in its own box — an impact figure and an evidence grade are never one. */
function sourceCardsHtml(model, s, links) {
  const ev = s.codings.filter((c) => c.ev);
  const base = links.source({ slug: "x" }).replace(/sources\/x\.html$/, "");
  const head = ev.length ? `<div class="card evcard"><div class="small muted">${esc(EVIDENCE_TITLE)}</div>
  <div class="meta" style="margin-top:.4rem">${evChipsHtml(ev, base)}</div></div>` : "";
  return head + (s.cards || []).map((c) => `<details class="card evcard"><summary><strong>${esc(c.card)}</strong></summary>
${renderOverviewMarkdown(c.md, model, links)}</details>`).join("\n");
}

const structureCache = new WeakMap();

/** A reading copy's structure map (1.16.0, spec/02), when one is stored for it and fits
 *  it (reading.mjs checkStructure); else null, and the text reads as paragraphs. */
function structureOf(loaded, repId, rec) {
  if (!repId || !rec) return null;
  let byRep = structureCache.get(loaded);
  if (!byRep) structureCache.set(loaded, byRep = new Map());
  if (byRep.has(repId)) return byRep.get(repId);
  let st = null;
  const entry = (loaded.representations || []).find((r) => r.obj.media_type === U.STRUCTURE_MEDIA_TYPE &&
    r.obj.parent_representation_ref === repId && r.contained && fs.existsSync(r.abs));
  if (entry) {
    try {
      const doc = JSON.parse(fs.readFileSync(entry.abs, "utf8"));
      const got = checkStructure(doc, rec.cps);
      if (got.ok) st = { sections: got.sections, blocks: got.blocks, made_by: doc.made_by || "" };
    } catch { st = null; }
  }
  byRep.set(repId, st);
  return st;
}

// What each kind of block is to "In context" (context.mjs): a map says it outright,
// so its guesses (a heading glued to a paragraph, a caption at its end) are dropped.
const CONTEXT_KIND = { paragraph: "prose", list_item: "prose", formula: "prose", heading: "heading", title: "heading",
  keywords: "heading", caption: "caption", table_note: "caption", box: "caption", row: "label", note: "footnote",
  reference: "end" };

function structuredContext(blocks, st, u16) {
  const kindAt = new Map(st.blocks.map((b) => [u16(b.c0), CONTEXT_KIND[b.kind] || "prose"]));
  for (const b of blocks) {
    const k = kindAt.get(b.a);
    if (!k) continue;
    b.kind = k;
    delete b.cut; delete b.cutKind; delete b.headLead;
  }
}

/** Render the reading copy as paragraphs, with every passage highlighted.
 *
 *  Paragraph elements rather than one `pre-wrap` block: a 78,000-character text
 *  in a single inline box is one enormous layout, and it was heavy enough to
 *  take the renderer down while this was being tested. One <p> per paragraph is
 *  also simply how a paper reads.
 *
 *  Offsets are recomputed from the stored quote rather than trusted from the
 *  locator, so a drifted locator cannot smear a highlight across the wrong text.
 */
function renderReading(text, passages, paraAttr = null, repId = null, st = null) {
  const cps = Array.from(text);
  const marks = [];
  for (const p of passages) {
    if (!p.quote) continue;
    // Where the record puts it, once this build has checked that the text there
    // is the quotation: a sentence a paper repeats is highlighted where the
    // passage actually is, not at its first occurrence. A quotation that did not
    // verify is looked for by its words instead, so a drifted locator cannot
    // smear a highlight across the wrong text.
    if (p.span && U.VERIFIED_BADGES.has(p.badge) && (!repId || p.rep === repId)) {
      marks.push({ start: p.span[0], end: p.span[1], id: p.id, bad: false });
      continue;
    }
    const idx = text.indexOf(p.quote);
    if (idx < 0) continue;
    const start = U.codepointLength(text.slice(0, idx));
    marks.push({ start, end: start + U.codepointLength(p.quote), id: p.id, bad: p.badge === "failed" });
  }
  marks.sort((a, b) => a.start - b.start || b.end - a.end);

  // A full-text XML's reading copy, by its structure map: headings, tables and
  // captions as they are, each paragraph's number in the margin (reading.mjs).
  if (st) {
    const u = utf16Offsets(text);
    return readingHtml(text, blocksU16(text, st.blocks), sectionsCompact(st.sections),
      marks.map((m) => ({ a: u(m.start), b: u(m.end), id: m.id, bad: m.bad })), esc);
  }

  // Paragraph boundaries, in codepoints.
  const paras = [];
  let cur = 0;
  for (let i = 0; i < cps.length; i++) {
    if (cps[i] === "\n" && cps[i + 1] === "\n") {
      paras.push([cur, i]);
      while (cps[i] === "\n") i++;
      cur = i;
      i--;
    }
  }
  paras.push([cur, cps.length]);

  let mi = 0;
  const out = [];
  for (const [ps, pe] of paras) {
    if (pe <= ps) continue;
    while (mi < marks.length && marks[mi].end <= ps) mi++;
    let at = ps, html = "";
    for (let k = mi; k < marks.length && marks[k].start < pe; k++) {
      const m = marks[k];
      if (m.end <= ps) continue;                // ended in an earlier paragraph
      const a = Math.max(m.start, ps), b = Math.min(m.end, pe);
      if (a < at) continue;                     // overlapping passages: keep the first
      // A quotation running over a paragraph break is highlighted in each
      // paragraph it covers; only the first piece carries the id a link jumps to.
      const name = a === m.start ? `id="t-${attr(m.id)}"` : `data-for="t-${attr(m.id)}"`;
      html += esc(cps.slice(at, a).join(""));
      html += `<mark ${name}${m.bad ? ' style="background:var(--warn-soft)"' : ""}>` +
              esc(cps.slice(a, b).join("")) + `</mark>`;
      at = b;
    }
    html += esc(cps.slice(at, pe).join(""));
    out.push(paraAttr ? `<p${paraAttr(ps, pe)}>${IV.speech(html)}</p>` : `<p>${html}</p>`);
  }
  return out.join("\n");
}

function passagesPage(model) {
  return page({
    title: `Passages — ${model.title}`, rel: "passages/index.html", model, active: "passages", data: true,
    body: `<h1>Passages</h1>
<p class="lede">Every coded passage in the corpus — ${plural(model.passages.length, "passage", "passages")}
from ${plural(model.sources.length, "paper", "papers")}. Tick codes on the left to narrow the list. Ticks inside
one scheme widen the set; ticks across two schemes narrow it, so <em>MLP</em> plus <em>Power</em> shows only
passages carrying both.</p>
<div data-browse data-base="../"></div>
<noscript><p class="banner">This page builds its list as you filter, so it needs JavaScript.
Every other page here works without it — browse by <a href="../codes/">theme</a> or by
<a href="../sources/">paper</a> instead.</p></noscript>`,
  });
}

function matrixPage(model) {
  const [aSlug, bSlug] = model.matrix;
  const A = model.codebooks.find((c) => c.slug === aSlug);
  const B = model.codebooks.find((c) => c.slug === bSlug);
  if (!A || !B) return null;
  const aCodes = (A.codes || []).filter((c) => model.codeIndex.has(`${A.codebook_id}:${c.code}`));
  const bCodes = (B.codes || []).filter((c) => model.codeIndex.has(`${B.codebook_id}:${c.code}`));
  const cell = (ac, bc) => model.passages.filter((p) =>
    p.codings.some((c) => c.codebook_ref === A.codebook_id && c.code === ac.code) &&
    p.codings.some((c) => c.codebook_ref === B.codebook_id && c.code === bc.code)).length;
  return page({
    title: `${A.title} × ${B.title}`, rel: "matrix.html", model, active: "matrix",
    body: `<h1>${esc(A.title)} × ${esc(B.title)}</h1>
<p class="lede">How many passages carry both codes. Every number is a count of passages, not of papers.
Click a number to see those passages, or a heading to see all of a code's.</p>
<div class="wrap"><table>
<thead><tr><th></th>${bCodes.map((bc) =>
  `<th class="num"><a href="codes/${encodeURIComponent(B.slug)}/${encodeURIComponent(bc.code)}.html">${esc(bc.label || bc.code)}</a></th>`).join("")}</tr></thead>
<tbody>
${aCodes.map((ac) => `<tr>
  <th><a href="codes/${encodeURIComponent(A.slug)}/${encodeURIComponent(ac.code)}.html">${esc(ac.label || ac.code)}</a></th>
  ${bCodes.map((bc) => { const n = cell(ac, bc); return `<td class="num">${n
    // A number opens the row's code with the column's code already ticked.
    ? `<a href="codes/${encodeURIComponent(A.slug)}/${encodeURIComponent(ac.code)}.html#with=${encodeURIComponent(`${B.slug}:${bc.code}`)}"` +
      ` title="${attr(`Passages coded both ${ac.label || ac.code} and ${bc.label || bc.code}`)}">${n}</a>`
    : `<span class="muted">·</span>`}</td>`; }).join("")}
</tr>`).join("\n")}
</tbody></table></div>`,
  });
}

// --- overviews: one list, always beside whatever is being read ---------------

function overviewGroups(model) {
  const groups = new Map();
  for (const s of model.syntheses) {
    const key = s._group ? s._group.slug : "";
    if (!groups.has(key)) groups.set(key, { cb: s._group, items: [] });
    groups.get(key).items.push(s);
  }
  // Biggest scheme first, ungrouped last: a reader scanning for orientation wants
  // the theories before the odds and ends.
  return [...groups.values()].sort((a, b) => (a.cb ? 0 : 1) - (b.cb ? 0 : 1) || b.items.length - a.items.length);
}

function overviewSide(model, selectedId) {
  return `<aside class="side" id="ov-side">
<input type="search" class="sidesearch" data-sidefilter placeholder="Filter these reviews…">
${overviewGroups(model).map((g) => `<details open data-ovg>
<summary>${g.cb ? esc(g.cb.title) : "Other overviews"}<span class="n">${g.items.length}</span></summary>
${g.cb && g.cb.question ? `<p class="small muted" style="margin:.1rem 0 .3rem">${esc(g.cb.question)}</p>` : ""}
<ul class="ovlist">${g.items.map((s) => `<li><a class="${s._addr === selectedId ? "on" : ""}"
  href="${encodeURIComponent(s._addr)}.html">${esc(s.title || s.synthesis_id)}</a></li>`).join("")}</ul>
</details>`).join("\n")}
</aside>`;
}

// --- overview prose: one renderer for both shapes -------------------------------
//
// A synthesis is markdown written by a model, and a reader should see its
// structure — paragraphs, headings, and the list of papers it drew on — not a
// run-on block. It is rendered once, here, for both shapes: the single file and
// the folder each had their own copy and both showed that list as one line of
// text. The grammar is deliberately small — what synthesize.py writes, plus
// italics and inline code. Everything is escaped first; nothing in the markdown
// becomes markup except through the rules below.
export function renderOverviewMarkdown(md, model, links, opts = {}) {
  const cite = (p) => esc(p.cite || "");
  const unesc = (t) => t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const passageHref = (p) => attr(links.passage(p));
  const inline = (raw, inRefs) => esc(raw)
    // "quotation" [ext-id] — a linked quotation, badged by whether it verified
    // Up to the closing &quot;, not the first "&": escaping turns ' and & into
    // entities, and a pattern that stopped there never recognised such a
    // quotation — it showed as plain text, unlinked and unbadged. \s? is the
    // gate's own spacing rule (upc_common.parseQuoteMarkers).
    .replace(/&quot;((?:(?!&quot;)[^\n])+?)&quot;\s?\[(ext-[0-9a-f]{12})\]/g, (m, q, id) => {
      const p = model.passageById.get(id);
      // A quotation from a hidden set (a rating's evidence): checked, never a card to link to.
      const hid = !p && model.hiddenById && model.hiddenById.get(id);
      if (hid) {
        const ok = unesc(q) === hid.quote && U.VERIFIED_BADGES.has(hid.badge);
        return `“${q}” <span class="small" title="${attr(ok ? "Found word for word in the paper" : "Doesn't match the paper")}">${ok ? "✓" : "⚠"}</span>`;
      }
      if (!p) return m;
      // ✓ only when the words quoted here are the passage's own words *and* the
      // passage still matches its paper — re-checked at every build, so prose
      // edited after it passed the gate cannot keep a check mark it lost.
      const same = unesc(q) === p.quote;
      const ok = same && U.VERIFIED_BADGES.has(p.badge);
      const why = same ? (BADGE_TEXT[p.badge] || [])[1] || "" : "Doesn't match the passage it cites";
      return `<a href="${passageHref(p)}" title="${attr(why)}">“${q}”</a>` +
        ` <span class="small">${ok ? "✓" : "⚠"} ${cite(p)}</span>`;
    })
    // a source id, backticked or bare — the paper it names, as a link
    .replace(/`?(src-[0-9a-f]{12})`?/g, (m, id) => {
      const src = model.sourceById.get(id);
      return src ? `<a class="small" href="${attr(links.source(src))}">${esc(src.cite)}</a>` : m;
    })
    // bare markers, one or a run of them
    .replace(/\[(ext-[0-9a-f]{12})\](?:[ ,;]*\[ext-[0-9a-f]{12}\])*/g, (run) => {
      const ids = run.match(/ext-[0-9a-f]{12}/g).filter((id) => !(model.hiddenById && model.hiddenById.has(id)));
      if (!ids.length) return "";
      if (inRefs) {
        // The item already names its paper, so its passages are just numbered.
        const nums = ids.map((id, i) => {
          const p = model.passageById.get(id);
          return p ? `<a class="pn" href="${passageHref(p)}" title="${attr(p.cite + " — passage " + (i + 1))}">${i + 1}</a>`
                   : esc(`[${id}]`);
        });
        return `<span class="small muted">${ids.length === 1 ? "passage" : "passages"}</span> ${nums.join(" ")}`;
      }
      return ids.map((id) => {
        const p = model.passageById.get(id);
        return p ? `<a class="small" href="${passageHref(p)}">${cite(p)}</a>` : esc(`[${id}]`);
      }).join("; ");
    })
    // [theme:<slug>/<code>] — the theme by name, linked to its current overview,
    // with live counts that state their unit. Numbers are never typed into prose,
    // so a rebuild cannot leave them stale.
    .replace(/\[theme:([a-z0-9-]+)\/([a-z0-9-]+)\]/g, (m, slug, code) => {
      const cb = model.codebooks.find((c) => c.slug === slug);
      const def = cb && (cb.codes || []).find((c) => c.code === code);
      if (!def) return `<span class="muted">${esc(slug + "/" + code)} (not in this corpus)</span>`;
      const rec = model.codeIndex.get(`${cb.codebook_id}:${code}`);
      const nP = rec ? rec.passages.length : 0, nS = rec ? rec.sources.size : 0;
      // codeIndex.sources mixes papers with coded passages and papers coded as a
      // whole; beside a passage count only the former is true (spec/09).
      const nPP = rec ? new Set(rec.passages.map((i) => (model.passageById.get(i) || {}).source_id).filter(Boolean)).size : 0;
      const ov = model.overviewByCode && model.overviewByCode.get(`${slug}:${code}`);
      const label = esc(def.label || code);
      const name = ov && links.overview ? `<a href="${attr(links.overview(ov))}">${label}</a>`
        : rec && links.code ? `<a href="${attr(links.code(slug, code))}">${label}</a>` : label;
      const n = rec && links.code
        ? ` <a class="small muted" href="${attr(links.code(slug, code))}">(${nP
            ? `${plural(nP, "passage", "passages")} from ${plural(nPP, "paper", "papers")}`
            : `${plural(nS, "paper", "papers")} coded as a whole`})</a>`
        : "";
      return name + n;
    })
    // [view:<name>] — one of the site's own views.
    .replace(/\[view:(matrix|passages|overviews|codes|sources|findings|evidence|methods)\]/g, (m, name) => {
      let text = { passages: "every passage", overviews: "the overviews", codes: "the codes", sources: "the papers",
                   findings: "the findings", evidence: "the evidence map", methods: "how this was made" }[name];
      if ((name === "findings" || name === "evidence") && !model.findings.length) return esc(text);
      if (name === "methods" && !model.about) return esc(text);
      if (name === "matrix") {
        const [a, b] = model.matrix || [];
        const A = model.codebooks.find((c) => c.slug === a), B = model.codebooks.find((c) => c.slug === b);
        if (!A || !B) return "the comparison table (not built for this site)";
        text = `${A.title} × ${B.title}`;
      }
      return links.view ? `<a href="${attr(links.view(name))}">${esc(text)}</a>` : esc(text);
    })
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    // [text](https://…) (1.15.0: a Methods page cites its sources). The text is already
    // escaped; only http(s) targets, opened in a new tab.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"<>]+)\)/g,
      (m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
    // **strong** (1.15.0: rating cards and Methods pages use it), before *em*
    .replace(/\*\*([^*\s](?:[^*\n]*?[^*\s])?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?=[^*\w]|$)/g, "$1<em>$2</em>");

  const html = [];
  let para = [], list = null;
  const bullet = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/;
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "), false)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const refs = list.items.some((it) => /src-[0-9a-f]{12}/.test(it));
    const tag = list.ordered ? "ol" : "ul";
    const block = `<${tag}${refs ? ' class="refs"' : ""}>` +
      list.items.map((it) => `<li>${inline(it, refs)}</li>`).join("") + `</${tag}>`;
    // On a page meant to be read in a minute, the papers behind a summary fold
    // away — present, printable, and one click from every claim.
    html.push(refs && opts.foldRefs
      ? `<details class="refs-fold"><summary>${plural(list.items.length, "paper", "papers")} this draws on</summary>${block}</details>`
      : block);
    list = null;
  };
  for (const line of String(md || "").replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      html.push(h[1].length <= 2 ? `<h2>${inline(h[2], false)}</h2>` : `<h3>${inline(h[2], false)}</h3>`);
      continue;
    }
    const b = bullet.exec(line);
    if (b) {
      flushPara();
      if (!list) list = { ordered: b[1] != null, items: [] };
      list.items.push(b[2]);
      continue;
    }
    if (list) { list.items[list.items.length - 1] += " " + line.trim(); continue; }   // a wrapped item
    para.push(line.trim());
  }
  flushPara(); flushList();
  return html.join("\n");
}

/** "#start=task3&theme=actor%3Ainstallers" for the Findings page; "" for none. */
const findingsQuery = (q, sep = "#") => {
  const parts = Object.entries(q || {}).filter(([, v]) => v !== "" && v != null && v !== -1)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length ? sep + parts.join("&") : "";
};

/** Where every kind of link points, for a folder page `base` levels deep. */
function folderLinks(base) {
  const e = encodeURIComponent;
  return {
    passage: (p) => `${base}sources/${e(p.source_slug)}.html#ex=${e(p.id)}`,
    source: (src) => `${base}sources/${e(src.slug)}.html`,
    overview: (syn) => `${base}overviews/${e(syn._addr || syn.synthesis_id)}.html`,
    code: (slug, code) => `${base}codes/${e(slug)}/${e(code)}.html`,
    view: (name) => base + ({ matrix: "matrix.html", passages: "passages/", overviews: "overviews/",
                              codes: "codes/", sources: "sources/", findings: "findings.html", evidence: "evidence.html",
                              methods: "methods.html" }[name] || ""),
    // #start=<id>&theme=<slug:code>&src=<n>: the Findings page, filtered
    findings: (q) => `${base}findings.html` + findingsQuery(q),
  };
}

/** The placed home summary, rendered for either shape: {t, h}, or null. */
function homeCard(model, links) {
  const h = model.homeSummary;
  if (!h) return null;
  // The card leads with the summary itself. Who wrote it and what it rests on
  // stay in its record (provenance.produced_by, derived_from), which the
  // verification browser shows (spec/09 requirement 8). A text edited after its
  // quotations were checked is the one thing the card still says about itself.
  const changed = h._changed
    ? '<p class="small" style="color:var(--warn)">⚠ This text was changed after its quotations were checked.</p>' : "";
  return { t: h.title || "What the literature says",
           r: h._revision ? revisionHtml(model, h._revision, "") : "",
           h: changed + renderOverviewMarkdown(h.md, model, links, { foldRefs: true }) };
}

function overviewBodyHtml(model, syn, root) {
  const base = "../";
  let body = "";
  const outPath = syn.output && syn.output.path;
  if (outPath) {
    const { abs, contained } = U.resolveInside(root, outPath);
    if (contained && fs.existsSync(abs)) body = fs.readFileSync(abs, "utf8");
  }
  // The page already shows the title, so drop a leading H1 that repeats it.
  body = body.replace(/^\s*#\s+.*\n+/, "");
  // Render the marker grammar: "…" [ext-id] becomes a linked, badged quotation.
  const rendered = renderOverviewMarkdown(body, model, folderLinks(base));
  const kf = keyFindingsHtml(model, syn, folderLinks(base));
  return `<h1 style="margin-top:0">${esc(syn.title || syn.synthesis_id)}</h1>
${syn._revision ? revisionHtml(model, syn._revision, syn._addr) : ""}
${kf}${kf ? `<h2>The review</h2>` : ""}
<div class="card" style="max-width:74ch">${rendered || `<p class="muted">No text.</p>`}</div>
${claimsTableHtml(model, syn, folderLinks(base))}`;
}

/** "Revised from rated evidence · 6 Oct 2026 · the previous version ↗" */
function revisionHtml(model, rev, addr) {
  // addr: the overview's address; "" for the home page's summary, which links to that edition's home page.
  const prev = model.originalEdition && addr != null
    ? ` · <a href="${attr(model.originalEdition.replace(/\/?$/, "/") + (addr ? "overviews/" + encodeURIComponent(addr) + ".html" : ""))}"
  target="_blank" rel="noopener">the previous version, in the original edition ↗</a>` : "";
  return `<p class="revised sans small"><strong>${esc(rev.label)}</strong>${rev.date ? ` · ${esc(DATE_FMT(rev.date))}` : ""}${prev}${
    rev.note ? `<br><span class="muted">${esc(rev.note)}</span>` : ""}</p>`;
}


// --- findings: the fragments both shapes render on the server -------------------

/** "●●●○ Some support", the IPCC term on hover. */
function supportBadgeHtml(key, ipcc) {
  const k = SUPPORT_WORDS[key] ? key : "weak";
  return `<span class="sup-b s-${k}"${ipcc ? ` title="${attr(`On the IPCC scale: ${ipcc}`)}"` : ""}><span class="dots" aria-hidden="true">${
    SUPPORT_DOTS[k]}</span>${esc(SUPPORT_WORDS[k])}</span>`;
}
/** "3 studies agree", counting lead authors, never papers by one author twice. */
function studiesText(f) {
  if (f.relayed_only) return "only relayed from other work";
  if (!f.studies) return "no supporting study";
  const n = f.studies === 1 ? "1 study" : `${f.studies} studies agree`;
  return f.papers > f.studies ? `${n} (${f.papers} papers)` : n;
}
/** Who backs a statement, by name: the papers whose passages support it. */
function backersOf(model, f) {
  const names = [];
  for (const v of f.passages) {
    if (v.verdict !== "supports" && v.verdict !== "partly") continue;
    const p = model.passageById.get(v.id);
    if (p && !names.includes(p.cite)) names.push(p.cite);
  }
  return names;
}
const SUPPORT_RANK = { well: 0, some: 1, limited: 2, weak: 3 };
const byStrength = (a, b) => SUPPORT_RANK[a.support] - SUPPORT_RANK[b.support] || b.studies - a.studies || a.ord - b.ord;
const findingsWord = (model, key, dflt) => ((model.findingsSettings || {}).words || {})[key] || dflt;

function findingLiHtml(model, f) {
  const who = backersOf(model, f);
  const flags = (f.same_lead ? ` <span class="flag" title="Every supporting paper has the same lead author">one lead author</span>` : "");
  return `<li>${supportBadgeHtml(f.support, f.ipcc)} <span class="ftext">${esc(f.text)}</span>${flags}
<span class="small muted"> — ${esc(studiesText(f))}${who.length ? `: ${esc(who.join(", "))}` : ""}${
    f.countries.length ? ` · ${esc(f.countries.join(", "))}` : ""}</span></li>`;
}

/** The box above an overview's prose: what it says that is best supported, what
 *  rests on one study (a lead), and what it only relays. Nothing is hidden: the
 *  prose and the full support table follow as before. */
export function keyFindingsHtml(model, syn, links) {
  const fs = model.findings.filter((f) => f.syn === syn).sort(byStrength);
  if (!fs.length) return "";
  const strong = fs.filter((f) => f.support === "well" || f.support === "some");
  const one = fs.filter((f) => !f.relayed_only && f.studies <= 1 && !strong.includes(f));
  const relayed = fs.filter((f) => f.relayed_only);
  const count = SUPPORT_KEYS.map((k) => [k, fs.filter((f) => f.support === k).length]).filter(([, n]) => n)
    .map(([k, n]) => `${n} ${SUPPORT_WORDS[k].toLowerCase()}`).join(" · ");
  const theme = syn._group && syn._code ? `${syn._group.slug}:${syn._code}` : syn._addr;
  const all = links.findings ? `<a href="${attr(links.findings({ theme }))}">All ${fs.length} with their passages and how each was checked, in Findings →</a>` : "";
  const list = (xs, max) => `<ol>${xs.slice(0, max).map((f) => findingLiHtml(model, f)).join("")}</ol>${
    xs.length > max ? `<p class="small muted">and ${xs.length - max} more.</p>` : ""}`;
  return `<section class="card kf"><h2>Key findings</h2>
<p class="small muted">${plural(fs.length, "statement", "statements")} in this review: ${esc(count)}. How well each is supported comes
from a check of the passages it cites (advisory, made by a model)${links.view ? `: <a href="${attr(links.view("methods"))}">how</a>` : ""}.</p>
${strong.length ? list(strong, 8)
  : `<p>No statement in this review has more than limited support. Most rest on a single study: read them as leads to test, not as settled findings.</p>`}
${one.length ? `<h3>${esc(findingsWord(model, "one_study", "Rests on one study: a lead worth testing"))} (${one.length})</h3>${list(one, strong.length ? 5 : 8)}` : ""}
${relayed.length ? `<h3>Only relayed from other work (${relayed.length})</h3>${list(relayed, 4)}` : ""}
${all ? `<p class="small" style="margin-bottom:0">${all}</p>` : ""}
</section>`;
}

/** Home: the starting points, then how strong the evidence is overall. */
function findingsHomeHtml(model, links) {
  const fs = model.findings;
  if (!fs.length) return "";
  const st = model.findingsSettings || {};
  const n = (k) => fs.filter((f) => f.support === k).length;
  const lim = fs.filter((f) => f.support === "limited");
  const themes = new Map();
  for (const f of fs) {
    const t = themes.get(f.syn) || { syn: f.syn, n: 0, good: 0 };
    t.n++; if (f.support === "well" || f.support === "some") t.good++;
    themes.set(f.syn, t);
  }
  const thin = [...themes.values()].filter((t) => !t.good);
  const starts = (st.starts || []).map((x) => ({ ...x, n: fs.filter((f) => matchStart(f, x.match)).length })).filter((x) => x.n);
  return `${starts.length ? `<h2>Start from what you are working on</h2>
<div class="grid cards starts">${starts.map((x) => `<a class="card tile" href="${attr(links.findings({ start: x.id }))}"><strong>${esc(x.label)}</strong>${
    x.task ? ` <span class="small muted">${esc(x.task)}</span>` : ""}<br><span class="small muted">${esc(String(x.note || "").split(/(?<=\.)\s/)[0])}</span><br>
<span class="small">${plural(x.n, "statement", "statements")} →</span></a>`).join("\n")}</div>` : ""}
<h2>How strong is the evidence?</h2>
<div class="card">${strengthStripHtml(SUPPORT_KEYS.map((k) => [k, n(k)]))}
<p class="small" style="margin:.6rem 0 0">Of ${fs.length} statements in the ${plural(themes.size, "review", "reviews")}, ${n("well")} are well supported and
${n("some")} have some support. Of the ${lim.length} limited ones, ${lim.filter((f) => !f.relayed_only && f.studies <= 1).length} rest on a single study and
${lim.filter((f) => f.relayed_only).length} only relay other work.${thin.length ? ` ${plural(thin.length, "review has", "reviews have")} nothing above limited support.` : ""}
<a href="${attr(links.view("evidence"))}">See the evidence map →</a> · <a href="${attr(links.view("findings"))}">all findings →</a></p></div>`;
}

function strengthStripHtml(pairs) {
  const tot = pairs.reduce((a, [, v]) => a + v, 0) || 1;
  return `<div class="strip" role="img" aria-label="${attr(pairs.map(([k, v]) => `${v} ${SUPPORT_WORDS[k].toLowerCase()}`).join(", "))}">${
    pairs.map(([k, v]) => v ? `<i class="s-${k}" style="width:${(100 * v / tot).toFixed(2)}%" title="${attr(`${v} ${SUPPORT_WORDS[k].toLowerCase()}`)}"></i>` : "").join("")}</div>
<div class="legend">${pairs.map(([k, v]) => `<span class="s-${k}">${esc(SUPPORT_WORDS[k])} ${v}</span>`).join("")}</div>`;
}

/** A paper's page: what it contributes to the reviews, before its ratings. */
function contributesHtml(model, s, links) {
  const mine = new Set(s.passages.map((p) => p.id));
  const fs = model.findings.filter((f) => f.passages.some((v) => mine.has(v.id) && (v.verdict === "supports" || v.verdict === "partly")))
    .sort(byStrength);
  const cited = model.syntheses.filter((o) => (o.claims || []).some((c) => (c.evidence_ids || []).some((id) => mine.has(id))));
  if (!fs.length && !cited.length) return "";
  const src = model.sources.indexOf(s);
  return `<section class="card kf"><h2 style="margin-top:0">What this paper contributes</h2>
${fs.length ? `<p class="small muted">It backs ${plural(fs.length, "statement", "statements")} in the reviews${
    links.findings ? ` (<a href="${attr(links.findings({ src }))}">all of them in Findings →</a>)` : ""}.</p>
<ol>${fs.slice(0, 6).map((f) => findingLiHtml(model, f).replace(/<\/li>$/, ` <span class="small">in <a href="${attr(links.overview(f.syn))}">${esc(f.syn.title || "")}</a></span></li>`)).join("")}</ol>` : ""}
${cited.length ? `<p class="small" style="margin-bottom:0">Cited in ${plural(cited.length, "review", "reviews")}: ${cited.map((o) =>
    `<a href="${attr(links.overview(o))}">${esc(o.title || o.synthesis_id)}</a>`).join(", ")}.</p>` : ""}
</section>`;
}

/** What the Findings and Evidence map pages read, for either shape. */
function findingsPayload(model, srcIndex, links) {
  const ovs = [], ovAt = new Map();
  for (const f of model.findings) {
    if (ovAt.has(f.syn)) continue;
    const papers = new Set();
    for (const g of model.findings) if (g.syn === f.syn) for (const v of g.passages) { const p = model.passageById.get(v.id); if (p) papers.add(p.source_id); }
    ovAt.set(f.syn, ovs.length);
    ovs.push({ a: f.syn._addr, t: f.syn.title || f.syn._addr, g: f.group, k: f.theme, h: links.overview(f.syn), np: papers.size });
  }
  const groups = [...new Set(ovs.map((o) => o.g))].map((slug) => {
    const cb = model.codebooks.find((c) => c.slug === slug);
    return { slug, title: cb ? cb.title : (slug || "Other") };
  });
  const placeCb = model.codebooks.find((c) => c.slug === "place");
  const places = {};
  const used = new Set(model.findings.flatMap((f) => f.places));
  const order = (placeCb ? (placeCb.codes || []).map((c) => c.code) : Object.keys(PLACE_WORDS)).concat([...used]);
  for (const k of order) {
    if (!used.has(k) || k in places) continue;
    const c = placeCb && (placeCb.codes || []).find((x) => x.code === k);
    places[k] = c ? c.label : (PLACE_WORDS[k] || k);
  }
  const st = model.findingsSettings || {};
  return {
    ov: ovs, groups, places, kinds: KIND_WORDS, words: SUPPORT_WORDS, dots: SUPPORT_DOTS,
    starts: st.starts || [], notes: st.words || {}, mapPlace: st.mapPlace || "",
    f: model.findings.map((f) => ({
      o: ovAt.get(f.syn), c: f.claim_id, r: f.ord, t: f.text, s: f.support, i: f.ipcc, n: f.studies, np: f.papers,
      ...(f.same_lead ? { sl: 1 } : {}), ...(f.relayed_only ? { ro: 1 } : {}), k: f.kind, pl: f.places, co: f.countries, de: f.designs,
      ps: f.passages.map((v) => { const p = model.passageById.get(v.id); return [v.id, v.verdict, v.gap, p && srcIndex.has(p.source_id) ? srcIndex.get(p.source_id) : -1]; }),
    })),
  };
}

/** The claims table, and — when a support matrix names this overview — its
 *  columns, behind a switch that starts off (1.15.0). One renderer, both shapes. */
export function claimsTableHtml(model, syn, links) {
  const claims = syn.claims || [];
  if (!claims.length) return "";
  const sup = syn._support;
  const byClaim = new Map(((sup && sup.claims) || []).map((c) => [c.claim_id, c]));
  const cell = (c) => {
    const m = byClaim.get(c.claim_id);
    if (!m) return `<td class="sup"><span class="muted">—</span></td><td class="sup"></td><td class="sup"></td>`;
    const x = (m.ext || {})["upc-corpus"] || {};
    const verdicts = (x.passages || []).map((v) => {
      const p = model.passageById.get(v.extraction_id);
      return `${p ? `<a href="${attr(links.passage(p))}">${esc(p.cite)}</a>` : esc(v.extraction_id)}: ${esc(v.verdict || "?")}${
        v.gap && v.gap !== "none" ? ` (${esc(v.gap)})` : ""}`;
    }).join("<br>");
    const studies = x.studies != null ? x.studies : x.independent;
    return `<td class="sup">${supportBadgeHtml(supportOf(x), x.ipcc || m.confidence || "")}${
      x.same_lead ? ` <span class="flag" title="Every supporting paper has the same lead author">one lead author</span>` : ""}${
      x.relayed_only ? ` <span class="flag">relayed only</span>` : ""}</td>` +
      `<td class="sup num">${studies == null ? "" : studies}${x.papers > studies ? `<br><span class="small muted">${x.papers} papers</span>` : ""}</td>` +
      `<td class="sup small">${verdicts}${m.notes ? `<br><span class="muted">${esc(m.notes)}</span>` : ""}</td>`;
  };
  return `<h2>What this says, and what backs it</h2>
${sup ? `<p class="sans small"><label><input type="checkbox" data-support> Show support for each statement</label>
<span class="muted"> — how well its passages back it, how many independent studies agree (papers by one lead author count once),
and what a check of each passage found (advisory).</span></p>` : ""}
<div class="wrap"><table${sup ? ' class="claims"' : ""}><thead><tr><th>Claim</th><th>Passages</th>${sup
    ? `<th class="sup">Support</th><th class="sup num">Studies agreeing</th><th class="sup">The check, passage by passage</th>` : ""}</tr></thead><tbody>
${claims.map((c) => `<tr><td>${esc(c.text)}</td><td>${(c.evidence_ids || []).map((id) => {
    const p = model.passageById.get(id);
    return p ? `<a href="${attr(links.passage(p))}">${esc(p.cite)}</a>` : esc(id);
  }).join("; ")}</td>${sup ? cell(c) : ""}</tr>`).join("\n")}
</tbody></table></div>`;
}

const OVERVIEW_LEDE = (model) =>
  `<p class="lede">${plural(model.syntheses.length, "short review", "short reviews")} of what this literature says,
one per theme, written from the coded passages. <strong>Start here</strong> if you want the lay of the land.</p>`;

function overviewsIndexPage(model) {
  return page({
    title: `Overviews — ${model.title}`, rel: "overviews/index.html", model, active: "overviews",
    body: `<h1>Overviews</h1>${OVERVIEW_LEDE(model)}
<div class="split">${overviewSide(model, null)}
<section class="pane"><div class="card" style="max-width:74ch">
<p>Pick a review on the left. There ${model.syntheses.length === 1 ? "is one" : `are ${model.syntheses.length}`},
one per theme, each written only from passages in this corpus. The list stays where it is while you read, so you
can work down a scheme in one sitting.</p>
<p class="small muted">Every quotation in a review links to the passage it came from, and every citation to the
paper. A review is written by a model from coded passages: the quotations in it were checked character by
character, the sentences around them were not.</p>
</div></section></div>`,
  });
}

function overviewPage(model, syn, root) {
  return page({
    title: `${syn.title || syn.synthesis_id} — ${model.title}`,
    rel: `overviews/${syn._addr}.html`, model, active: "overviews",
    body: `<h1>Overviews</h1>${OVERVIEW_LEDE(model)}
<div class="split">${overviewSide(model, syn._addr)}
<section class="pane">${overviewBodyHtml(model, syn, root)}</section></div>`,
  });
}

const FINDINGS_LEDE = (model) => `<p class="lede">Every statement of the ${plural(new Set(model.findings.map((f) => f.syn)).size, "review", "reviews")},
with how well the passages it cites support it. Pick a starting point, or filter. The ratings are advisory and made by a model${
  model.about ? `: <a href="methods.html">how</a>` : ""}.</p>`;

function findingsPage(model) {
  return page({
    title: `Findings — ${model.title}`, rel: "findings.html", model, active: "findings", data: "findings",
    body: `<h1>Findings</h1>${FINDINGS_LEDE(model)}
<div data-findings></div>
<noscript><p class="banner">This page builds its list as you filter, so it needs JavaScript. Each review's
Key findings, on its own page under <a href="overviews/">Overviews</a>, work without it.</p></noscript>`,
  });
}

function evidencePage(model) {
  return page({
    title: `Evidence map — ${model.title}`, rel: "evidence.html", model, active: "evidence", data: "findings",
    body: `<h1>Evidence map</h1>
<p class="lede">How much each review's statements rest on, at a glance. A review is marked <span class="flag">thin</span>
when none of its statements has more than limited support. Click a review to read it, or its count to see its statements.</p>
<div data-evidence></div>`,
  });
}

/** The Methods page (`--about <md>`): how this library was made, in the
 *  overviews' own grammar, so its theme links and numbers stay live. */
function methodsPage(model) {
  const md = model.about.md || "";
  const h1 = /^\s*#\s+(.*)\n/.exec(md);
  const title = h1 ? h1[1].trim() : "Methods";
  return page({
    title: `${title} — ${model.title}`, rel: "methods.html", model, active: "methods",
    body: `<h1>${esc(title)}</h1>
<div class="card" style="max-width:74ch">${renderOverviewMarkdown(md.replace(/^\s*#\s+.*\n+/, ""), model, folderLinks(""))}</div>`,
  });
}

/** The Methods page for the single file: {t, h}. */
function aboutPayload(model, links) {
  const md = model.about.md || "";
  const h1 = /^\s*#\s+(.*)\n/.exec(md);
  return { t: h1 ? h1[1].trim() : "Methods", h: renderOverviewMarkdown(md.replace(/^\s*#\s+.*\n+/, ""), model, links) };
}

/** Read `--about <md>`, or null. */
export function readAbout(file) {
  if (!file) return null;
  return { md: fs.readFileSync(path.resolve(file), "utf8").replace(/\r\n/g, "\n"), file: path.resolve(file) };
}

// --- writer ---------------------------------------------------------------

/** A PDF (or a publisher's full-text XML) over `maxBytes` (a host's per-file limit)
 *  stays out of a bundle: it is not copied and not linked, and its paper's page says
 *  why, so no link is dead. Marks those sources (`pdfOff`, `xmlOff`) and returns
 *  [{source, file, bytes}]. */
function leaveOutLarge(loaded, model, maxBytes) {
  const out = [];
  if (!(maxBytes > 0)) return out;
  for (const s of model.sources) {
    for (const [rep, off] of [[s.pdfRep, "pdfOff"], [s.xmlRep, "xmlOff"]]) {
      if (!rep) continue;
      const entry = (loaded.representations || []).find((r) => r.obj.representation_id === rep.representation_id);
      if (!entry || !entry.contained || !fs.existsSync(entry.abs)) continue;
      const bytes = fs.statSync(entry.abs).size;
      if (bytes > maxBytes) {
        s[off] = { bytes, max: maxBytes };
        out.push({ source: s.slug, file: path.basename(rep.path), bytes });
      }
    }
  }
  return out;
}

const mib = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

export function writeSite(root, opts = {}) {
  const loaded = U.loadCorpus(root);
  const model = buildSiteModel(loaded, opts);
  // Where the original PDFs travel with the site, if they do (--bundle).
  model.filesDir = opts.bundle ? "files" : null;
  const leftOut = opts.bundle ? leaveOutLarge(loaded, model, opts.maxFileBytes) : [];
  const outDir = path.resolve(opts.out || path.join(root, "site"));
  const written = [];
  const w = (rel, text) => {
    const abs = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    U.atomicWriteFile(abs, text);
    written.push(rel);
  };

  fs.mkdirSync(outDir, { recursive: true });
  w("assets/site.css", CSS + IV.AUDIO_CSS);
  // The browse engine first, then the page script that mounts it, then the player.
  w("assets/site.js", BROWSE_JS + "\n" + FINDINGS_JS + "\n" + JS + "\n" + IV.AUDIO_JS);
  // Recordings travel with the site (1.16.0): only the web copy a page plays, never the
  // recording as it was handed over; and an interviewer's notes form.
  const audioCopies = [];
  for (const s of model.sources) {
    for (const [r, key] of [[s.audioRep, "audioHref"], [s.notesRep, "notesHref"]]) {
      if (!r) continue;
      const entry = (loaded.representations || []).find((x) => x.obj.representation_id === r.representation_id);
      if (!entry || !entry.contained || !fs.existsSync(entry.abs)) continue;
      s[key] = `files/${encodeURIComponent(path.basename(r.path))}`;
      audioCopies.push([entry.abs, path.join(outDir, "files", path.basename(r.path))]);
    }
  }

  // The same compact records the single file carries, as a plain script the
  // browsing pages load with <script src> — no fetch, so `file://` still works.
  {
    const { sources, passages, codebooks, ck } = browsePayload(model);
    model.passages.forEach((p, k) => { if (p.cx) passages[k].w = 1; });   // it has sentences to open (data/ctx)
    w("data/browse.js", `window.__UPCB_DATA=${j({
      sources, passages, codebooks, ck,
      badges: BADGE_TEXT,
      files: opts.bundle ? "files" : null,
    })};\n`);
  }
  // Findings (1.15.0): the statements of the rated reviews, for findings.html and evidence.html.
  if (model.findings.length) {
    const { srcIndex } = browsePayload(model);
    const fl = folderLinks("");
    w("data/findings.js", `window.__UPCF_DATA=${j(findingsPayload(model, srcIndex, fl))};\n`);
  }
  // "In context": the sentences around each passage, one file per paper, loaded
  // the first time a reader opens one of its passages on any page.
  for (const s of model.sources) {
    const cx = {};
    for (const p of s.passages) if (p.cx) cx[p.id] = p.cx;
    if (Object.keys(cx).length) w(`data/ctx/${s.slug}.js`, `Object.assign(window.__UPC_CTX=window.__UPC_CTX||{},${j(cx)});\n`);
  }

  w("index.html", homePage(model));
  w("codes/index.html", codesIndexPage(model));
  for (const cb of model.codebooks) {
    for (const code of cb.codes || []) {
      if (!model.codeIndex.has(`${cb.codebook_id}:${code.code}`) && !opts.allCodes) continue;
      w(`codes/${cb.slug}/${code.code}.html`, codePage(model, cb, code));
    }
  }

  w("sources/index.html", sourcesIndexPage(model));
  for (const s of model.sources) {
    let info = null;
    if (s.textRep) {
      const entry = (loaded.representations || []).find((r) => r.obj.representation_id === s.textRep.representation_id);
      if (entry && entry.contained && fs.existsSync(entry.abs)) {
        const rec = U.getRepFile(entry.abs);
        if (rec.utf8ok) {
          const bytes = Buffer.byteLength(rec.text, "utf8");
          // A transcript's turns know when they were said (its timings), so a click plays from there.
          let times = null;
          if (s.timingsRep) {
            const te = (loaded.representations || []).find((r) => r.obj.representation_id === s.timingsRep.representation_id);
            try { times = IV.paraTimes(JSON.parse(fs.readFileSync(te.abs, "utf8")).segments); } catch { times = null; }
          }
          const st = structureOf(loaded, s.textRep.representation_id, rec);
          const read = () => renderReading(rec.text, s.passages, times, s.textRep.representation_id, st);
          if (bytes <= INLINE_TEXT_MAX) {
            info = { inline: read(), structured: !!st, madeBy: st ? st.made_by : "" };
          } else if (bytes <= SIDECAR_TEXT_MAX) {
            const name = `${s.textRep.representation_id}.js`;
            w(`data/text/${name}`, `window.__UPC_TEXT=${j(read())};\n`);
            info = { sidecar: name, structured: !!st, madeBy: st ? st.made_by : "" };
          } else {
            // Never a truncated copy: half a document shown as if it were whole
            // is exactly the kind of lie this projection exists to prevent.
            info = { omitted: true };
          }
        }
      }
    }
    w(`sources/${s.slug}.html`, sourcePage(model, s, info));
  }

  w("passages/index.html", passagesPage(model));

  // Interviews (1.16.0): everyone and everything named, and who was suggested.
  if (model.interviews && model.passages.some((p) => p.names.length)) {
    w("people/index.html", page({ title: `People — ${model.title}`, rel: "people/index.html", model, active: "people",
                                  body: IV.peopleBody(model, "../") }));
  }
  // Interviews (1.16.0): a page per guide question, every answer to it.
  const guide = model.interviews ? IV.guideBooks(model).qs : null;
  if (guide) {
    w("questions/index.html", page({ title: `Questions — ${model.title}`, rel: "questions/index.html", model, active: "questions",
                                     body: IV.questionsIndexBody(model, "../") }));
    for (const code of guide.codes || []) {
      w(`questions/${code.code}.html`, page({ title: `${code.label || code.code} — ${model.title}`, rel: `questions/${code.code}.html`,
                                              model, active: "questions", body: IV.questionBody(model, code, "../") }));
    }
  }

  if (model.syntheses.length) {
    w("overviews/index.html", overviewsIndexPage(model));
    for (const syn of model.syntheses) w(`overviews/${syn._addr}.html`, overviewPage(model, syn, loaded.root));
  }
  if (model.about) w("methods.html", methodsPage(model));
  if (model.findings.length) {
    w("findings.html", findingsPage(model));
    w("evidence.html", evidencePage(model));
  }
  if (model.matrix) {
    const m = matrixPage(model);
    if (m) w("matrix.html", m);
  }

  let copied = 0;
  for (const [from, to] of audioCopies) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const same = fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size;
    if (!same) fs.copyFileSync(from, to);
    copied++;
  }
  // Optional: carry the actual files, so the folder is self-contained.
  if (opts.bundle) {
    for (const s of model.sources) {
      for (const r of [s.pdfOff ? null : s.pdfRep, s.xmlOff ? null : s.xmlRep, s.textRep].filter(Boolean)) {
        const entry = (loaded.representations || []).find((x) => x.obj.representation_id === r.representation_id);
        if (!entry || !entry.contained || !fs.existsSync(entry.abs)) continue;
        const dest = path.join(outDir, "files", path.basename(r.path));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(entry.abs, dest);
        copied++;
      }
    }
  }

  return {
    status: "ok",
    out: outDir,
    pages: written.filter((f) => f.endsWith(".html")).length,
    files: written.length,
    copied,
    left_out: leftOut,
    home_summary: model.homeSummary ? model.homeSummary.synthesis_id : null,
    home_candidates: model.homeCandidates,
    counts: {
      sources: model.sources.length,
      passages: model.passages.filter((p) => p.quote).length,
      notes: model.passages.filter((p) => !p.quote).length,
      codebooks: model.codebooks.length,
      codings: model.passages.reduce((n, p) => n + p.codings.length, 0) +
               model.sources.reduce((n, s) => n + s.codings.length, 0),
      overviews: model.syntheses.length,
      failing_quotations: model.failures,
    },
  };
}


// The single-file client. Plain DOM, no framework, no fetch: everything it needs
// is in the data island above it, and every view is rendered from memory.
const CLIENT_ONE = String.raw`
(function(){
  var K="upc-site-theme";
  try{var t=localStorage.getItem(K); if(t)document.documentElement.setAttribute("data-theme",t);}catch(e){}
  window.__toggleTheme=function(){
    var cur=document.documentElement.getAttribute("data-theme");
    var next=cur==="dark"?"light":cur==="light"?"dark":
      (window.matchMedia&&window.matchMedia("(prefers-color-scheme:dark)").matches?"light":"dark");
    document.documentElement.setAttribute("data-theme",next);
    try{localStorage.setItem(K,next);}catch(e){}
  };

  var D=JSON.parse(document.getElementById("upc-data").textContent);
  var app=document.getElementById("app");
  var E=function(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");};
  var PL=function(n,a,b){return n+" "+(n===1?a:b);};

  // indexes
  var bySlug={}, codeDef={};
  D.codebooks.forEach(function(cb){ bySlug[cb.slug]=cb;
    cb.codes.forEach(function(c){ codeDef[cb.slug+":"+c.code]={cb:cb,c:c}; }); });
  var byId={}; D.passages.forEach(function(p){ byId[p.id]=p; });
  var codeIndex={};
  function touch(k){ if(!codeIndex[k]) codeIndex[k]={p:[],s:{}}; return codeIndex[k]; }
  D.passages.forEach(function(p){ p.g.forEach(function(g){
    var r=touch(g[0]+":"+g[1]); r.p.push(p.id); if(p.s>=0) r.s[p.s]=1; }); });
  D.sources.forEach(function(s){ s.g.forEach(function(g){ touch(g[0]+":"+g[1]).s[s.i]=1; }); });
  var passagesOf={}; D.passages.forEach(function(p){ (passagesOf[p.s]=passagesOf[p.s]||[]).push(p); });

  // One renderer for a passage, shared with the folder site: UPCB, defined by the
  // browse engine in the script above this one.
  UPCB.init({
    sources:D.sources, codebooks:D.codebooks, badges:D.badges, files:D.files, coderKind:D.ck,
    hrefSource:function(p){ return "#/source/"+p.s+"?ex="+encodeURIComponent(p.id); },
    hrefText:function(p){ return "#/source/"+p.s+"?text="+encodeURIComponent(p.id); },
    hrefCode:function(slug,code){ return "#/code/"+encodeURIComponent(slug)+"/"+encodeURIComponent(code); }
  });
  var badge=UPCB.badge, chip=UPCB.chip, passageCard=UPCB.card;
  if(D.findings&&window.UPCF) UPCF.init({F:D.findings, passages:D.passages, sources:D.sources,
    label:UPCB.label, card:function(p){ return passageCard(p,{context:false}); },
    placeCount:function(want){
      var n=0; D.sources.forEach(function(s){ if(s.g.some(function(g){return g[0]==="place"&&want.indexOf(g[1])>=0;})) n++; });
      return [n,D.sources.length];
    },
    hrefFindings:function(q){ return "#/findings"+(q?"?"+q:""); },
    setQuery:function(q){ try{ history.replaceState(null,"","#/findings"+(q?"?"+q:"")); }catch(e){} }});
  // "In context": a passage's sentences, joined from the text this file carries,
  // or carried as they are when the file has no texts.
  UPCB.cx=function(id){
    var p=byId[id];
    if(!p) return null;
    if(p.cx) return p.cx;
    if(p.cw&&p.o&&D.withText){ var t=textOf(p.s); if(t) return UPCB.windowText(t,p.cw,p.o[0],p.o[1]); }
    return null;
  };

  // Reading copies are parsed on demand. They are four fifths of this file, and
  // parsing all of them into memory before the first paint cost seconds for a
  // reader who may never open a single paper.
  var textCache={};
  function textOf(i){
    if(!(i in textCache)){
      var el=document.getElementById("upc-t"+i);
      textCache[i]=el?JSON.parse(el.textContent):"";
    }
    return textCache[i];
  }

  // ---- views ----
  var V={};
  // Evidence schemes (1.15.0) are kept apart from the themes: their own section on
  // Codes, not counted on the home page, chips only where a passage is opened.
  var topical=D.codebooks.filter(function(cb){return !cb.ev;}), evidence=D.codebooks.filter(function(cb){return cb.ev;});
  V.home=function(){
    var nq=D.passages.filter(function(p){return p.q;}).length;
    var tiles=[[D.sources.length,"sources","#/sources"],[nq,"passages (quoted)","#/passages"],
               [topical.length,"codebooks","#/codes"],[D.overviews.length,"overviews","#/overviews"]];
    return "<h1>"+E(D.title)+"</h1>"+
      '<p class="lede">A searchable library of what this literature actually says. Every quotation was compared '+
      "with the source text character by character when this file was built"+(D.failures?"":" — all of them matched")+".</p>"+
      (D.fh||"")+
      (D.home?(D.fh?"<h2>What the literature says</h2>":"")+'<section class="card homesum"><h2>'+E(D.home.t)+"</h2>"+(D.home.r||"")+D.home.h+"</section>":"")+
      (D.overviews.length?'<p class="lede">'+(D.home?"<strong>Go deeper:</strong> read the":"<strong>New here?</strong> Start with the")+' <a href="#/overviews">'+
        PL(D.overviews.length,"overview","overviews")+"</a> — a short review per theme, written from the coded "+
        'passages, with every quotation linked back to the paper it came from. Then browse by <a href="#/codes">theme</a>, '+
        'by <a href="#/sources">paper</a>, or search <a href="#/passages">every passage</a>.</p>':"")+
      '<div class="grid cards">'+tiles.filter(function(t){return t[0];}).map(function(t){
        return '<a class="card tile" href="'+t[2]+'"><span class="n">'+t[0]+'</span><br><span class="u">'+E(t[1])+"</span></a>";
      }).join("")+"</div>"+
      "<h2>How to read this</h2><div class=\"card\"><p class=\"small\"><strong>A passage</strong> is a span of text from one "+
      "paper, quoted exactly. <strong>A check mark</strong> means the quotation matched the paper's text when this file was "+
      "built. <strong>A code</strong> is a judgement someone made about that passage. Hover a code to see who made it and why; "+
      "where two coders disagree, both judgements are shown. Nothing is resolved for you.</p></div>";
  };
  V.codes=function(){
    return "<h1>Codes</h1><p class=\"lede\">Each codebook asks one question of the literature. Counts state what they "+
      "count: a <em>passage</em> is one quoted span; a <em>source</em> is one paper.</p>"+
      codeTables(topical)+
      (evidence.length?'<h2 id="evidence">'+E(D.evTitle)+'</h2><p class="small muted">'+E(D.evNote)+
        (D.about?' <a href="#/methods">How they were made</a>.':"")+"</p>"+codeTables(evidence):"");
  };
  function codeTables(list){
    return list.map(function(cb){
        var rows=cb.codes.map(function(c){
          var r=codeIndex[cb.slug+":"+c.code]||{p:[],s:{}};
          return {c:c,nP:r.p.length,nS:Object.keys(r.s).length};
        }).sort(function(a,b){return (b.nP-a.nP)||(b.nS-a.nS);});
        var any=rows.some(function(r){return r.nP||r.nS;});
        return "<h2>"+E(cb.title)+"</h2>"+(cb.question?'<p class="small muted">'+E(cb.question)+"</p>":"")+
          '<div class="wrap"><table><thead><tr><th>Code</th><th>What it means</th>'+
          '<th class="num">Passages</th><th class="num">Sources</th></tr></thead><tbody>'+
          rows.map(function(r){
            return "<tr><td>"+((r.nP||r.nS)?'<a href="#/code/'+encodeURIComponent(cb.slug)+"/"+encodeURIComponent(r.c.code)+'">'+E(r.c.label)+"</a>":'<span class="muted">'+E(r.c.label)+"</span>")+
              '</td><td class="muted">'+E(r.c.def)+'</td><td class="num">'+(r.nP||"")+'</td><td class="num">'+(r.nS||"")+"</td></tr>";
          }).join("")+
          (any?"":'<tr><td colspan="4" class="muted">Nothing has been coded against this scheme yet.</td></tr>')+
          "</tbody></table></div>";
      }).join("");
  }
  function codeList(a){
    var cb=bySlug[a[0]]; if(!cb) return null;
    var c=null; cb.codes.forEach(function(x){ if(x.code===a[1]) c=x; });
    if(!c) return null;
    var r=codeIndex[cb.slug+":"+c.code]||{p:[],s:{}};
    return {cb:cb, c:c, r:r, list:r.p.map(function(id){return byId[id];}).filter(Boolean)};
  }
  V.code=function(a){
    var x=codeList(a);
    if(!x) return "<h1>Unknown code</h1>";
    return '<p class="small muted" id="crumb"><a href="#/codes">Codes</a> › '+E(x.cb.title)+"</p><h1>"+E(x.c.label)+"</h1>"+
      (x.c.def?'<div class="defbox">'+E(x.c.def)+"</div>":"")+
      '<p class="lede">'+(function(){ var ps={}; x.list.forEach(function(p){ ps[p.s]=1; });
        var pp=Object.keys(ps).length, whole=Math.max(0,Object.keys(x.r.s).length-pp);
        return PL(x.list.length,"passage","passages")+" from "+PL(pp,"paper","papers")+
          (whole?", plus "+PL(whole,"paper","papers")+" coded as a whole":""); })()+
        "."+(x.list.length?" Narrow them on the left — those counts are within this code.":"")+"</p>"+
      (x.list.length?'<div id="browse"></div>':'<p class="muted">No passages carry this code yet.</p>');
  };
  V.code.mount=function(a,qs){
    var x=codeList(a); if(!x||!x.list.length) return;
    // This code's own scheme is left out: every passage here carries it, so the
    // section would hold one row reading what the heading already says.
    // ?with=<scheme>:<code> is a matrix cell: that code arrives ticked.
    var mw=/(?:^|&)with=([^&]+)/.exec(qs||"");
    UPCB.browse(document.getElementById("browse"),x.list,
      {omit:[x.cb.slug],with:mw?decodeURIComponent(mw[1]).split(","):[]});
  };
  V.sources=function(){
    var rows=D.sources.slice().sort(function(a,b){return String(a.k).localeCompare(String(b.k));});
    return "<h1>Sources</h1><p class=\"lede\">"+PL(D.sources.length,"paper","papers")+" in this corpus.</p>"+
      '<div class="filters sans small"><input type="search" data-q placeholder="Search titles, authors, journals…" style="min-width:20rem">'+
      '<span class="muted" data-count data-one="source shown" data-many="sources shown"></span></div>'+
      '<div class="wrap"><table><thead><tr><th>Author, year</th><th>Title</th><th>Published in</th>'+
      '<th class="num">Passages</th></tr></thead><tbody>'+
      rows.map(function(s){
        return '<tr data-row data-search="'+E([s.t,s.a,s.c,s.y,s.d].join(" "))+'"><td>'+E(s.k)+
          '</td><td><a href="#/source/'+s.i+'">'+E(s.t)+"</a></td>"+
          '<td class="muted">'+E(s.c||"")+'</td><td class="num">'+((passagesOf[s.i]||[]).length||"")+"</td></tr>";
      }).join("")+"</tbody></table></div>";
  };
  // One chip per code; a second coder who gave the same code is named in its tooltip (evChipsHtml).
  function mergeEv(list){
    var seen={}, out=[];
    list.forEach(function(g){
      var k=g[0]+":"+g[1], kind=D.ck[g[2]];
      if(seen[k]){ seen[k][5]=(seen[k][5]?seen[k][5]+"\n":"")+"Also coded so by "+g[2]+
        (kind?" ("+({rule:"a rule",ensemble:"a vote of model runs"}[kind]||kind)+")":""); return; }
      seen[k]=g.slice(); out.push(seen[k]);
    });
    return out;
  }
  V.source=function(a,q){
    var s=D.sources[+a[0]]; if(!s) return "<h1>Unknown source</h1>";
    var mine=passagesOf[s.i]||[];
    var bits=[s.a,s.y?String(s.y):"",s.c].filter(Boolean).join(" · ");
    var isEv=function(g){ var d=codeDef[g[0]+":"+g[1]]; return !!(d&&d.cb.ev); };
    var sTop=s.g.filter(function(g){return !isEv(g);}), sEv=s.g.filter(isEv);
    var reading="";
    if(D.withText&&textOf(s.i)){
      var text=textOf(s.i), marks=[];
      // Where the record puts it (p.o: UTF-16 offsets this build checked hold
      // the quotation), else wherever its words first occur.
      mine.forEach(function(p){ if(!p.q)return;
        if(p.o){ marks.push({a:p.o[0],b:p.o[1],id:p.id,bad:false}); return; }
        var i=text.indexOf(p.q);
        if(i>=0) marks.push({a:i,b:i+p.q.length,id:p.id,bad:p.b==="failed"}); });
      marks.sort(function(x,y){return x.a-y.a||y.b-x.b;});
      // A full-text XML's reading copy, by its structure map (reading.mjs).
      if(s.st){
        reading='<div class="reading structured" id="reading">'+upcReadingHtml(text,s.st[0],s.st[1],marks,E)+"</div>";
      } else {
      // Paragraph by paragraph, so a quotation running over a break is
      // highlighted in each paragraph it covers (only the first piece is the
      // target a link jumps to).
      var paras=[], re=/\n{2,}/g, mm, from=0;
      while((mm=re.exec(text))){ paras.push([from,mm.index]); from=mm.index+mm[0].length; }
      paras.push([from,text.length]);
      var html=[];
      paras.forEach(function(pr){
        var ps=pr[0], pe=pr[1], at=ps, h="";
        if(pe<=ps) return;
        marks.forEach(function(k){
          if(k.b<=ps||k.a>=pe) return;
          var a=Math.max(k.a,ps), b=Math.min(k.b,pe);
          if(a<at) return;
          h+=E(text.slice(at,a))+"<mark "+(a===k.a?'id="t-'+E(k.id)+'"':'data-for="t-'+E(k.id)+'"')+
             (k.bad?' style="background:var(--warn-soft)"':"")+">"+E(text.slice(a,b))+"</mark>";
          at=b;
        });
        html.push("<p>"+h+E(text.slice(at,pe))+"</p>");
      });
      reading='<div class="reading" id="reading">'+html.join("")+"</div>";
      }
    }
    return '<p class="small muted" id="crumb"><a href="#/sources">Sources</a></p><h1>'+E(s.t)+"</h1>"+
      '<p class="lede">'+E(bits)+(s.d?' · <a href="https://doi.org/'+encodeURIComponent(s.d)+'">doi:'+E(s.d)+"</a>":"")+
        ((D.files&&s.p)?' · <a href="'+E(D.files+"/"+encodeURIComponent(s.p))+'" target="_blank" rel="noopener">open the PDF ↗</a>':"")+
        ((D.files&&s.x)?' · <a href="'+E(D.files+"/"+encodeURIComponent(s.x))+'" target="_blank" rel="noopener">open the XML ↗</a>':"")+
        ((D.files&&s.po)?' · the PDF ('+E(s.po)+') is too large to include':"")+"</p>"+
      ((s.g.length||mine.some(function(p){return p.g.length;}))?'<p class="small muted">'+E(UPCB.codeNote())+"</p>":"")+
      (s.cb||"")+
      (sTop.length?'<div class="card"><div class="small muted">Judgements about this paper as a whole</div>'+
        '<div class="meta" style="margin-top:.4rem">'+sTop.map(function(g){return chip(g);}).join(" ")+"</div></div>":"")+
      (sEv.length?'<div class="card evcard"><div class="small muted">'+E(D.evTitle)+"</div>"+
        '<div class="meta" style="margin-top:.4rem">'+mergeEv(sEv).map(function(g){return chip(g);}).join(" ")+"</div></div>":"")+
      (s.cd||[]).map(function(c){ return '<details class="card evcard"><summary><strong>'+E(c[0])+"</strong></summary>"+c[1]+"</details>"; }).join("")+
      "<h2>Passages ("+mine.length+")</h2>"+
      (mine.length?'<div class="evshow">'+mine.map(function(p){return passageCard(p,{showSource:false,context:false});}).join("")+"</div>":'<p class="muted">No passages from this paper yet.</p>')+
      (reading?'<h2>The text this was checked against</h2><p class="small muted">'+(s.mf==="xml"?
        "Converted from the publisher's full-text XML, word for word in reading order. It has no page numbers, so a passage is cited by the paper's own section and paragraph"+(s.st?" (¶ in the margin)":"")+".":
        "Extracted from the PDF.")+" Highlighted spans are the passages above.</p>"+reading:"");
  };
  V.passages=function(){
    return "<h1>Passages</h1><p class=\"lede\">Every coded passage in the corpus — "+
      PL(D.passages.length,"passage","passages")+" from "+PL(D.sources.length,"paper","papers")+
      ". Tick codes on the left to narrow the list. Ticks inside one scheme widen the set; "+
      "ticks across two schemes narrow it, so <em>MLP</em> plus <em>Power</em> shows only passages carrying both.</p>"+
      '<div id="browse"></div>';
  };
  V.passages.mount=function(){
    UPCB.browse(document.getElementById("browse"),D.passages,{});
  };

  // ---- overviews: a list that never goes away, and the review beside it ----

  function ovGroups(){
    var groups={},order=[];
    D.overviews.forEach(function(o){ var k=o.grp||"";
      if(!groups[k]){groups[k]=[];order.push(k);} groups[k].push(o); });
    order.sort(function(a,b){ return (a?0:1)-(b?0:1) || groups[b].length-groups[a].length; });
    return {groups:groups,order:order};
  }
  function overviewBody(id){
    var o=null; D.overviews.forEach(function(x){ if(x.id===id) o=x; });
    if(!o) return '<div class="card" style="max-width:74ch"><p>'+
      "Pick a review on the left. There "+(D.overviews.length===1?"is one":"are "+D.overviews.length)+
      ", one per theme, each written only from passages in this corpus and each 400–700 words. "+
      "The list stays where it is while you read, so you can work down a scheme in one sitting.</p>"+
      '<p class="small muted">Every quotation in a review links to the passage it came from, and every '+
      "citation to the paper. A review is written by a model from coded passages: the quotations in it "+
      "were checked character by character, the sentences around them were not.</p></div>";
    var html=o.h||"";   // rendered at build time by renderOverviewMarkdown
    return "<h1 style=\"margin-top:0\">"+E(o.t)+"</h1>"+(o.rv||"")+(o.kf?o.kf+"<h2>The review</h2>":"")+
      '<div class="card" style="max-width:74ch">'+html+"</div>"+
      // A support matrix's columns come prerendered (claimsTableHtml, as the folder's pages).
      (o.ct?o.ct:o.cl.length?"<h2>What this says, and what backs it</h2><div class=\"wrap\"><table><thead><tr><th>Claim</th>"+
        "<th>Passages</th></tr></thead><tbody>"+o.cl.map(function(c){
          return "<tr><td>"+E(c[0])+"</td><td>"+c[1].map(function(id2){ var p=byId[id2];
            return p?'<a href="#/source/'+p.s+"?ex="+encodeURIComponent(id2)+'">'+E((D.sources[p.s]||{}).k||"")+"</a>":E(id2);
          }).join("; ")+"</td></tr>";}).join("")+"</tbody></table></div>":"");
  }
  V.findings=function(){
    if(!D.findings) return "<h1>No findings</h1>";
    return "<h1>Findings</h1>"+D.fl+'<div id="fhost"></div>';
  };
  V.findings.mount=function(a,qs){ var h=document.getElementById("fhost"); if(h) UPCF.findings(h,qs); };
  V.evidence=function(){
    if(!D.findings) return "<h1>No evidence map</h1>";
    return "<h1>Evidence map</h1><p class=\"lede\">How much each review\u2019s statements rest on, at a glance. A review is marked "+
      '<span class="flag">thin</span> when none of its statements has more than limited support. Click a review to read it, or its count to see its statements.</p>'+
      '<div id="ehost"></div>';
  };
  V.evidence.mount=function(){ var h=document.getElementById("ehost"); if(h) UPCF.map(h); };
  V.methods=function(){
    if(!D.about) return "<h1>No methods page</h1>";
    return "<h1>"+E(D.about.t)+"</h1><div class=\"card\" style=\"max-width:74ch\">"+D.about.h+"</div>";
  };
  function markOverview(id){
    [].slice.call(document.querySelectorAll("#ov-side a[data-ov]")).forEach(function(a){
      var on=a.getAttribute("data-ov")===id;
      a.className=on?"on":"";
      if(on){ var d=a.parentNode; while(d&&d.tagName!=="DETAILS") d=d.parentNode;
        if(d) d.open=true; UPCB.reveal(document.getElementById("ov-side"),a); }
    });
  }
  V.overviews=function(a){
    var sel=(a&&a[0])||"", g=ovGroups();
    return "<h1>Overviews</h1><p class=\"lede\">"+PL(D.overviews.length,"short review","short reviews")+
      " of what this literature says, one per theme, written from the coded passages. "+
      "<strong>Start here</strong> if you want the lay of the land.</p>"+
      '<div class="split" id="ov-split"><aside class="side" id="ov-side">'+
      '<input type="search" class="sidesearch" id="ovq" placeholder="Filter these reviews…">'+
      g.order.map(function(k){
        var cb=bySlug[k], items=g.groups[k];
        return '<details open data-ovg="'+E(k)+'"><summary>'+E(cb?cb.title:"Other overviews")+
          '<span class="n">'+items.length+"</span></summary>"+
          (cb&&cb.question?'<p class="small muted" style="margin:.1rem 0 .3rem">'+E(cb.question)+"</p>":"")+
          '<ul class="ovlist">'+items.map(function(o){
            return '<li><a data-ov="'+E(o.id)+'" class="'+(o.id===sel?"on":"")+'" href="#/overviews/'+
              encodeURIComponent(o.id)+'">'+E(o.t)+"</a></li>";
          }).join("")+"</ul></details>";
      }).join("")+
      '</aside><section class="pane" id="ov-pane">'+overviewBody(sel)+"</section></div>";
  };
  V.overviews.mount=function(a){
    markOverview((a&&a[0])||"");
    var q=document.getElementById("ovq"); if(!q) return;
    q.addEventListener("input",function(){
      var t=q.value.toLowerCase().trim();
      [].slice.call(document.querySelectorAll("#ov-side details[data-ovg]")).forEach(function(d){
        var any=0;
        [].slice.call(d.querySelectorAll("li")).forEach(function(li){
          var ok=!t||li.textContent.toLowerCase().indexOf(t)>=0;
          li.hidden=!ok; if(ok) any++;
        });
        d.hidden=!any; if(t&&any) d.open=true;
      });
    });
  };
  // Deep links written before the two-pane layout said #/overview/<id>.
  V.overview=function(a){ return V.overviews(a); };
  V.overview.mount=V.overviews.mount;
  V.matrix=function(){
    if(!D.matrix) return "<h1>No matrix configured</h1>";
    var A=bySlug[D.matrix[0]],B=bySlug[D.matrix[1]];
    if(!A||!B) return "<h1>No matrix configured</h1>";
    var ac=A.codes.filter(function(c){return codeIndex[A.slug+":"+c.code];});
    var bc=B.codes.filter(function(c){return codeIndex[B.slug+":"+c.code];});
    function cell(x,y){ var n=0;
      D.passages.forEach(function(p){
        var a=false,b=false;
        p.g.forEach(function(g){ if(g[0]===A.slug&&g[1]===x.code)a=true; if(g[0]===B.slug&&g[1]===y.code)b=true; });
        if(a&&b)n++; });
      return n; }
    return "<h1>"+E(A.title)+" × "+E(B.title)+"</h1><p class=\"lede\">How many passages carry both codes. Every number "+
      "is a count of passages, not of papers. Click a number to see those passages, or a heading to see all of a code's.</p>"+
      '<div class="wrap"><table><thead><tr><th></th>'+bc.map(function(y){
        return '<th class="num"><a href="#/code/'+encodeURIComponent(B.slug)+"/"+encodeURIComponent(y.code)+'">'+E(y.label)+"</a></th>";
      }).join("")+"</tr></thead><tbody>"+
      ac.map(function(x){
        return '<tr><th><a href="#/code/'+encodeURIComponent(A.slug)+"/"+encodeURIComponent(x.code)+'">'+E(x.label)+"</a></th>"+
          bc.map(function(y){var n=cell(x,y);
            // A number opens the row's code with the column's code already ticked.
            return '<td class="num">'+(n?'<a href="#/code/'+encodeURIComponent(A.slug)+"/"+encodeURIComponent(x.code)+
              "?with="+encodeURIComponent(B.slug+":"+y.code)+'" title="'+E("Passages coded both "+x.label+" and "+y.label)+'">'+n+"</a>"
              :'<span class="muted">·</span>')+"</td>";}).join("")+"</tr>";
      }).join("")+"</tbody></table></div>";
  };

  // ---- filters, export, routing ----
  function wire(){
    var sels=[].slice.call(document.querySelectorAll("[data-filter]"));
    var q=document.querySelector("[data-q]");
    function apply(){
      var terms=((q&&q.value)||"").toLowerCase().trim().split(/\s+/).filter(Boolean);
      var rows=[].slice.call(document.querySelectorAll("[data-row]")),shown=0;
      rows.forEach(function(r){
        var ok=true;
        sels.forEach(function(s){ var v=s.value; if(!v)return;
          if((r.getAttribute("data-"+s.getAttribute("data-filter"))||"").split("|").indexOf(v)<0) ok=false; });
        if(ok&&terms.length){
          var hay=((r.getAttribute("data-search")||"")+" "+r.textContent).toLowerCase();
          ok=terms.every(function(t){return hay.indexOf(t)>=0;});
        }
        r.hidden=!ok; if(ok)shown++;
      });
      var c=document.querySelector("[data-count]");
      if(c)c.textContent=shown+" "+(shown===1?c.getAttribute("data-one"):c.getAttribute("data-many"));
    }
    sels.forEach(function(s){s.addEventListener("change",apply);});
    if(q)q.addEventListener("input",apply);
    if(sels.length||q)apply();
    var dl=document.querySelector("[data-export]");
    if(dl)dl.addEventListener("click",function(){
      var rows=[].slice.call(document.querySelectorAll("[data-row]")).filter(function(r){return !r.hidden;});
      var head=["quote","source","year","doi","codes","coders","checked"],out=[head.join(",")];
      rows.forEach(function(r){
        var p=byId[r.id]; if(!p)return; var s=D.sources[p.s]||{};
        var f=[p.q||p.n, s.k+" — "+s.t, s.y||"", s.d||"",
               p.g.map(function(g){return g[0]+":"+g[1];}).join("; "),
               p.g.map(function(g){return g[2];}).join("; "),
               (D.badges[p.b]||[])[1]||""];
        out.push(f.map(function(v){return '"'+String(v==null?"":v).replace(/"/g,'""')+'"';}).join(","));
      });
      var a=document.createElement("a");
      a.href=URL.createObjectURL(new Blob([out.join("\n")],{type:"text/csv"}));
      a.download="passages.csv"; document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(a.href);
    });
  }

  var LIB=[["#/codes","Codes","codes"],["#/sources","Sources","sources"],["#/passages","Passages","passages"]];
  var NAV=[["#/","Home","home"]];
  // A rated library (1.15.0) leads with what the literature says, then how it was built.
  if(D.findings){
    NAV.push(["#/findings","Findings","findings"],["#/evidence","Evidence map","evidence"]);
    if(D.overviews.length) NAV.push(["#/overviews","Overviews","overviews"]);
    NAV=NAV.concat(LIB);
  } else {
    NAV=NAV.concat(LIB);
    if(D.overviews.length) NAV.push(["#/overviews","Overviews","overviews"]);
  }
  if(D.matrix) NAV.push(["#/matrix","Matrix","matrix"]);
  if(D.about) NAV.push(["#/methods","Methods","methods"]);

  var lastView="";
  function route(){
    var h=(location.hash||"#/").replace(/^#/,"");
    var qi=h.indexOf("?"), qs=""; if(qi>=0){qs=h.slice(qi+1); h=h.slice(0,qi);}
    var parts=h.split("/").filter(Boolean).map(decodeURIComponent);
    var view=parts.shift()||"home";
    var fn=V[view]||V.home;

    // Moving between overviews swaps only the reading pane. Re-rendering the
    // whole view would rebuild the list too, losing its scroll position, its
    // open sections and whatever the reader had typed into its filter — which
    // is the one thing this layout exists to prevent.
    if((view==="overviews"||view==="overview")&&(lastView==="overviews"||lastView==="overview")
       &&document.getElementById("ov-split")){
      document.getElementById("ov-pane").innerHTML=overviewBody(parts[0]||"");
      markOverview(parts[0]||"");
      lastView=view; window.scrollTo(0,0);
      return;
    }

    if(D.failures){
      app.innerHTML='<div class="banner"><strong>'+PL(D.failures,"quotation does","quotations do")+
        " not match the source.</strong> They are shown with a warning wherever they appear.</div>";
    } else { app.innerHTML=""; }
    app.innerHTML+=fn(parts,qs);
    var navKey=view==="overview"?"overviews":view==="code"?"codes":view==="source"?"sources":view;
    document.getElementById("nav").innerHTML=NAV.map(function(n){
      return '<a class="'+(n[2]===navKey?"on":"")+'" href="'+n[0]+'">'+n[1]+"</a>";
    }).join("");
    wire();
    if(fn.mount) fn.mount(parts,qs);
    lastView=view;
    window.scrollTo(0,0);
    // ?ex=<id> the passage's card; ?text=<id> its highlight in the paper's text.
    var m=/(?:^|&)(ex|text)=([^&]+)/.exec(qs);
    if(m){
      var id=decodeURIComponent(m[2]);
      var el=m[1]==="text"?document.getElementById("t-"+id)||document.getElementById(id)
                          :document.getElementById(id)||document.getElementById("t-"+id);
      // No text to highlight it in (the light file): its card, opened in context.
      if(el&&m[1]==="text"&&el.id===id) UPCB.open(el);
      if(el){ el.scrollIntoView({block:"center"});
        el.style.outline="2px solid var(--accent)";
        setTimeout(function(){el.style.outline="";},2400); }
    }
  }
  window.addEventListener("hashchange",route);
  route();
})();
`;

// --- one file -------------------------------------------------------------

/**
 * The compact record the browse engine reads, built once and used by both
 * shapes of the site so a passage cannot look like one thing in the file and
 * another in the folder. The keys are one letter because they repeat once per
 * passage — three thousand times in a real corpus. It used to carry 320
 * characters of context each side of every passage (half the folder's
 * data/browse.js), which no view ever showed; that is gone. The sentences shown
 * when a passage is opened "In context" travel apart from it: a file per paper
 * beside the folder's pages, or ranges of the text the single file carries.
 */
function browsePayload(model) {
  const srcIndex = new Map();
  const sources = model.sources.map((s, i) => {
    srcIndex.set(s.id, i);
    return {
      i, t: s.title, a: s.authors, y: s.year, d: s.doi, c: s.container, k: s.cite, sl: s.slug,
      p: s.pdfRep && !s.pdfOff ? path.basename(s.pdfRep.path) : "",
      ...(s.pdfOff ? { po: mib(s.pdfOff.bytes) } : {}),
      ...(s.xmlRep ? { mf: "xml", ...(s.xmlOff ? {} : { x: path.basename(s.xmlRep.path) }) } : {}),
      ...(s.audioHref ? { au: s.audioHref } : {}),
      g: s.codings.map((c) => [c.codebook_slug, c.code != null ? c.code : c.value, c.coder, c.confidence, c.rationale || ""]),
    };
  });
  const passages = model.passages.map((p) => ({
    id: p.id,
    s: srcIndex.has(p.source_id) ? srcIndex.get(p.source_id) : -1,
    q: p.quote,
    n: p.note,
    b: p.badge,
    st: p.status === "active" ? "" : p.status,
    l: p.line_range ? p.line_range.start : 0,
    pg: p.page || 0,
    ...(p.place ? { sc: p.place } : {}),
    ...(p.time ? { tm: [p.time.start, p.time.end] } : {}),
    ...(p.speakers && p.speakers.length ? { sp: p.speakers } : {}),
    act: p.badge === "failed" ? p.actual : null,
    g: p.codings.map((c) => [c.codebook_slug, c.code != null ? c.code : c.value, c.coder, c.confidence, c.rationale || ""]),
    dis: p.disagreements.length ? 1 : 0,
  }));
  const codebooks = model.codebooks.map((cb) => ({
    slug: cb.slug, title: cb.title, question: cb.question || "",
    unit: cb.unit || "passage",
    ...(isEvidence(cb) ? { ev: 1 } : {}), ...(noFacet(cb) ? { nf: 1 } : {}),
    codes: (cb.codes || []).map((c) => ({ code: c.code, label: c.label || c.code, def: c.definition || "" })),
  }));
  // coder handle -> kind (model / human), for the tooltips and the one visible note
  const ck = {};
  for (const x of [...model.passages, ...model.sources]) for (const c of x.codings) if (c.coder) ck[c.coder] = c.coder_kind || "";
  return { srcIndex, sources, passages, codebooks, ck };
}

/**
 * The same library as one self-contained HTML file.
 *
 * The multi-file site is the better artifact — real URLs, one page per source,
 * a browser that can print a single theme — but it is a *folder*, and a folder
 * is not what gets emailed, dropped in a shared drive, or opened by someone who
 * was sent "the literature review". Detached from its siblings, its index page
 * is a set of dead links.
 *
 * So this writes everything into one file: the stylesheet, the data, and a small
 * router that renders the same views from memory. No fetch, no siblings, no
 * server. Open it from a USB stick on a plane and it works.
 *
 * The one real cost is size. Reading copies dominate (17 MB of the 21 for a
 * 178-paper corpus), so `--no-text` drops them and keeps the passages and every
 * overview — about a seventh of the size, and still the thing most readers came
 * for.
 */
export function writeSingleFile(root, opts = {}) {
  const loaded = U.loadCorpus(root);
  const model = buildSiteModel(loaded, opts);
  const leftOut = opts.files ? leaveOutLarge(loaded, model, opts.maxFileBytes) : [];
  const withText = opts.withText !== false;
  const { srcIndex, sources, passages, codebooks, ck } = browsePayload(model);
  const oneLinks = {
    passage: (p) => `#/source/${srcIndex.get(p.source_id)}?ex=${encodeURIComponent(p.id)}`,
    source: (src) => `#/source/${srcIndex.get(src.id)}`,
    overview: (syn) => `#/overviews/${encodeURIComponent(syn._addr || syn.synthesis_id)}`,
    code: (slug, code) => `#/code/${encodeURIComponent(slug)}/${encodeURIComponent(code)}`,
    view: (name) => `#/${name}`,
    findings: (q) => "#/findings" + findingsQuery(q, "?"),
  };
  // A paper's cards (a rating, say), rendered here by the folder's renderer.
  model.sources.forEach((s, i) => {
    if (s.cards && s.cards.length) sources[i].cd = s.cards.map((c) => [c.card, renderOverviewMarkdown(c.md, model, oneLinks)]);
    // What the paper contributes to the reviews (1.15.0), first on its page.
    if (model.findings.length) { const cb = contributesHtml(model, s, oneLinks); if (cb) sources[i].cb = cb; }
  });

  const texts = [];
  if (withText) {
    model.sources.forEach((s, i) => {
      let body = "";
      if (s.textRep) {
        const entry = (loaded.representations || []).find((r) => r.obj.representation_id === s.textRep.representation_id);
        if (entry && entry.contained && fs.existsSync(entry.abs)) {
          const rec = U.getRepFile(entry.abs);
          if (rec.utf8ok) {
            body = rec.text;
            const st = structureOf(loaded, s.textRep.representation_id, rec);
            if (st) sources[i].st = [blocksU16(body, st.blocks), sectionsCompact(st.sections)];
          }
        }
      }
      texts.push(body);
    });
  }

  // Where each verified quotation sits in the text the file carries, so the
  // reader's highlight lands on the passage itself rather than on the first
  // place its words occur. A browser indexes strings in UTF-16 units.
  if (withText) {
    const conv = new Map();
    model.passages.forEach((p, k) => {
      if (!p.span || !U.VERIFIED_BADGES.has(p.badge)) return;
      const si = srcIndex.get(p.source_id);
      const src = model.sources[si];
      if (!src || !src.textRep || src.textRep.representation_id !== p.rep || !texts[si]) return;
      if (!conv.has(si)) conv.set(si, utf16Offsets(texts[si]));
      const f = conv.get(si);
      passages[k].o = [f(p.span[0]), f(p.span[1])];
    });
  }

  // "In context". With the texts on board, a passage's sentences are ranges of
  // the text the file already carries (the client joins them: UPCB.windowText);
  // without them — the light file — the sentences themselves.
  model.passages.forEach((p, k) => {
    if (!p.cx) return;
    const si = srcIndex.get(p.source_id);
    const src = model.sources[si];
    if (withText && passages[k].o && texts[si] && src && src.textRep && src.textRep.representation_id === p.rep) {
      passages[k].cw = [(p.context.lead ? 1 : 0) | (p.context.tail ? 2 : 0), ...p.context.segs.flat()];
    } else {
      passages[k].cx = p.cx;
    }
  });

  const overviews = model.syntheses.map((syn) => {
    let body = "";
    const outPath = syn.output && syn.output.path;
    if (outPath) {
      const { abs, contained } = U.resolveInside(loaded.root, outPath);
      if (contained && fs.existsSync(abs)) body = fs.readFileSync(abs, "utf8");
    }
    return {
      // A revision lives at the address of the overview it revises.
      id: syn._addr || syn.synthesis_id,
      t: syn.title || syn.synthesis_id,
      grp: syn._group ? syn._group.slug : "",
      ...(syn._revision ? { rv: revisionHtml(model, syn._revision, syn._addr) } : {}),
      ...(syn._support ? { ct: claimsTableHtml(model, syn, oneLinks) } : {}),
      ...(syn._support && model.findings.length ? { kf: keyFindingsHtml(model, syn, oneLinks) } : {}),
      // Rendered here, by the same function as the folder's pages.
      h: renderOverviewMarkdown(body.replace(/^\s*#\s+.*\n+/, ""), model, oneLinks),
      cl: (syn.claims || []).map((c) => [c.text, c.evidence_ids || []]),
    };
  });

  const home = homeCard(model, oneLinks);

  const payload = {
    files: opts.files || null,   // relative folder holding the PDFs, when bundled
    title: model.title,
    spec: model.specVersion || "",
    matrix: model.matrix || null,
    failures: model.failures,
    withText,
    badges: BADGE_TEXT,
    sources, passages, codebooks, overviews, ck, home,
    ...(codebooks.some((cb) => cb.ev) ? { evTitle: EVIDENCE_TITLE, evNote: EVIDENCE_NOTE } : {}),
    ...(model.about ? { about: aboutPayload(model, oneLinks) } : {}),
    ...(model.findings.length ? { findings: findingsPayload(model, srcIndex, oneLinks), fh: findingsHomeHtml(model, oneLinks),
                                  fl: FINDINGS_LEDE(model).replace(/href="methods\.html"/, 'href="#/methods"') } : {}),
  };

  // Each reading copy gets its own island, parsed only when its paper is opened.
  // They are four fifths of this file; parsing all of them into one object before
  // the first paint cost seconds and a large heap for a reader who may never open
  // a paper at all. `<` is escaped, so no copy can close the tag that holds it.
  const textIslands = texts.map((t, i) => (t
    ? `<script type="application/json" id="upc-t${i}">${j(t)}</script>`
    : "")).join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.title)}</title>
<style>${CSS}
.hidden{display:none}
nav a{cursor:pointer}
#crumb{margin:.2rem 0 .4rem}
</style>
</head><body>
<header class="top"><div class="in">
  <span class="brand">${esc(model.title)}</span>
  <nav id="nav"></nav>
  <span class="spacer"></span>
  <button class="theme" onclick="__toggleTheme()">Light / dark</button>
</div></header>
<main id="app">Loading…</main>
<footer>
  Built from a Universal Provenance Corpus (spec ${esc(model.specVersion || "")}). Every quotation here was
  compared with the source text character by character when this file was built. A <em>code</em> is somebody's
  judgement about a passage — hover it to see who made it — and is never a check mark.
</footer>
<script type="application/json" id="upc-data">${
    JSON.stringify(payload).replace(/</g, "\\u003c")
  }</script>
${textIslands}
<script>${BROWSE_JS}</script>
<script>${FINDINGS_JS}</script>
<script>var upcReadingHtml=${READING_JS};</script>
<script>${CLIENT_ONE}</script>
</body></html>
`;

  const out = path.resolve(opts.out || path.join(root, "corpus.html"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  U.atomicWriteFile(out, html);

  // The PDFs cannot go inside the file — 343 MB of them base64s to well over
  // twice that — so `--bundle` puts them in a folder beside it, named after the
  // file, and the page links resolve into it. The HTML still opens on its own;
  // without the folder it simply does not offer the PDF.
  let copied = 0;
  if (opts.files) {
    const dir = path.join(path.dirname(out), opts.files);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of model.sources) {
      for (const rep of [s.pdfOff ? null : s.pdfRep, s.xmlOff ? null : s.xmlRep]) {
        if (!rep) continue;
        const entry = (loaded.representations || []).find((r) => r.obj.representation_id === rep.representation_id);
        if (!entry || !entry.contained || !fs.existsSync(entry.abs)) continue;
        const dest = path.join(dir, path.basename(rep.path));
        if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(entry.abs).size) {
          fs.copyFileSync(entry.abs, dest);
        }
        copied++;
      }
    }
  }

  return {
    status: "ok", out, bytes: Buffer.byteLength(html, "utf8"),
    pdfs_bundled: copied, files_dir: opts.files || null, left_out: leftOut,
    home_summary: model.homeSummary ? model.homeSummary.synthesis_id : null,
    home_candidates: model.homeCandidates,
    counts: {
      sources: sources.length,
      passages: passages.filter((p) => p.q).length,
      codebooks: codebooks.length,
      overviews: overviews.length,
      reading_copies: withText ? texts.filter(Boolean).length : 0,
      failing_quotations: model.failures,
    },
  };
}
