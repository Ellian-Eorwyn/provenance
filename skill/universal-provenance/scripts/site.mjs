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

const CTX = 320;                 // codepoints of context each side of a passage
const INLINE_TEXT_MAX = 2_000_000;   // a reading copy embedded straight into its page
const SIDECAR_TEXT_MAX = 8_000_000;  // ... or loaded from data/text/<rep>.js

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
export function buildSiteModel(loaded, opts = {}) {
  const repById = new Map();
  for (const r of loaded.representations) repById.set(r.obj.representation_id, r);
  const lookupRep = (id) => (repById.get(id) ? repById.get(id).obj : null);

  const srcById = new Map();
  for (const s of loaded.sources) srcById.set(s.obj.source_id, s.obj);

  // codebooks
  const codebooks = (loaded.codebooks || []).map((c) => c.obj);
  const cbkById = new Map(codebooks.map((c) => [c.codebook_id, c]));
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
    });
  }

  // passages
  const passages = [];
  let failures = 0;
  for (const e of loaded.extractions) {
    const o = e.obj;
    const repEntry = repById.get(o.representation_ref);
    const repObj = repEntry ? repEntry.obj : null;
    let repRec = null;
    if (repEntry && repEntry.contained && fs.existsSync(repEntry.abs)) {
      const rec = U.getRepFile(repEntry.abs);
      if (rec.utf8ok) repRec = rec;
    }
    const { badge } = U.badgeForExtraction(o, repObj, repRec, lookupRep);
    if (badge === "failed") failures++;

    let before = "", after = "", lineRange = null, actual = null;
    if (repRec && o.locator && o.locator.type === "char_range") {
      const v = o.locator.value || {};
      const cps = repRec.cps;
      if (Number.isInteger(v.start) && Number.isInteger(v.end) && v.start <= v.end && v.end <= cps.length) {
        before = cps.slice(Math.max(0, v.start - CTX), v.start).join("");
        after = cps.slice(v.end, Math.min(cps.length, v.end + CTX)).join("");
        actual = cps.slice(v.start, v.end).join("");
        lineRange = U.lineRangeForCharRange(repRec.text, v.start, v.end);
      }
    }
    const secondaryPage = (o.secondary_locators || []).find((s) => s.type === "page");
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
      before, after, actual,
      line_range: lineRange,
      page: secondaryPage ? secondaryPage.value : null,
      codings: codingsByTarget.get(`extraction:${o.extraction_id}`) || [],
    });
  }
  const passageById = new Map(passages.map((p) => [p.id, p]));

  // sources
  const sources = loaded.sources.map((s) => {
    const o = s.obj;
    const mine = passages.filter((p) => p.source_id === o.source_id);
    const texts = (o.representations || []).filter((r) => U.isTextualMedia(r.media_type));
    const pdfs = (o.representations || []).filter((r) => /pdf$/.test(r.media_type));
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
      textRep: texts[0] || null,
      pdfRep: pdfs[0] || null,
      codings: codingsByTarget.get(`source:${o.source_id}`) || [],
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
  const syntheses = allSyn.filter((o) => !isHome(o)).map((o) => {
    const declared = ((o.ext || {})["upc-corpus"] || {}).codebook;
    const title = String(o.title || "").toLowerCase();
    let owner = null;
    if (declared) {
      const cb = codebooks.find((c) => c.slug === declared);
      owner = cb ? { cb, code: (cb.codes || []).find((c) => (c.label || c.code).toLowerCase() === title) || null } : null;
    } else {
      owner = labelOwner.get(title) || null;
    }
    return { ...o, _group: owner && owner.cb ? owner.cb : null, _code: owner && owner.code ? owner.code.code : null };
  });
  // The overview written for each code. A link that names a theme resolves
  // through this, not through an overview id: ids are content hashes (spec/06),
  // so re-running an overview mints a new one and a hard-coded link would die.
  const overviewByCode = new Map();
  for (const x of syntheses) if (x._group && x._code) overviewByCode.set(`${x._group.slug}:${x._code}`, x);
  // Newest placed summary wins; its prose is read here so either shape can render it.
  let homeSummary = null;
  const homes = allSyn.filter(isHome).sort((a, b) =>
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
                    _changed: !!(want && md && "sha256:" + U.sha256Hex(Buffer.from(md, "utf8")) !== want) };
  }

  return {
    title: (loaded.corpus && loaded.corpus.title) || "Research corpus",
    specVersion: loaded.corpus && loaded.corpus.upc_spec_version,
    sources, sourceById, passages, passageById,
    codebooks, cbkById, codeIndex, syntheses, homeSummary, overviewByCode, homeCandidates: homes.length,
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
  --maxw:min(1180px,94vw);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#12151a; --panel:#181d24; --ink:#e7ebf0; --muted:#9aa6b2; --line:#28303a;
  --accent:#5fd0ae; --accent-soft:#122a24; --warn:#ff9d86; --warn-soft:#2e1a16;
  --chip:#212a34; --chip-ink:#cbd5e0; --mark:#4a4020;
}}
:root[data-theme="dark"]{
  --bg:#12151a; --panel:#181d24; --ink:#e7ebf0; --muted:#9aa6b2; --line:#28303a;
  --accent:#5fd0ae; --accent-soft:#122a24; --warn:#ff9d86; --warn-soft:#2e1a16;
  --chip:#212a34; --chip-ink:#cbd5e0; --mark:#4a4020;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.55 ui-serif,Georgia,"Iowan Old Style",Palatino,serif;}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header.top{border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:10}
header.top .in{max-width:var(--maxw);margin:0 auto;padding:.7rem 1rem;display:flex;gap:1.1rem;align-items:baseline;flex-wrap:wrap}
header.top .brand{font-weight:700;letter-spacing:-.01em}
header.top nav{display:flex;gap:.9rem;flex-wrap:wrap;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.86rem}
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
.passage .note{margin:0;font-style:italic;color:var(--ink);background:var(--chip);
  border-radius:8px;padding:.5rem .7rem}
.passage .meta{margin-top:.55rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;
  font-family:ui-sans-serif,system-ui,sans-serif;font-size:.8rem}
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
@media (max-width:860px){
  .split{grid-template-columns:1fr}
  .side{position:static;max-height:20rem}
}
@media print{.side{display:none}.split{display:block}}
footer{max-width:var(--maxw);margin:0 auto;padding:1.5rem 1rem 3rem;color:var(--muted);font-size:.8rem;
  font-family:ui-sans-serif,system-ui,sans-serif;border-top:1px solid var(--line)}
@media print{
  header.top,.filters,button,.btn,footer nav{display:none!important}
  body{background:#fff}
  .passage{break-inside:avoid;border:1px solid #ccc}
  .reading{max-height:none;overflow:visible}
  a{color:inherit;text-decoration:none}
}
`;

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
  // Deep links: #ex=<id> / #coding=<id> scroll to and flash the thing named.
  function jump(){
    var h=location.hash||"";
    var m=/^#(?:ex|coding|code)=(.+)$/.exec(h);
    if(!m)return;
    var el=document.getElementById(m[1])||document.querySelector('[data-id="'+CSS.escape(m[1])+'"]');
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
    // data/browse.js as a <script src>, so this still works from file://.
    var host=document.querySelector("[data-browse]");
    if(host&&window.UPCB&&window.__UPCB_DATA){
      var B=window.__UPCB_DATA, base=host.getAttribute("data-base")||"";
      UPCB.init({
        sources:B.sources, codebooks:B.codebooks, badges:B.badges, coderKind:B.ck,
        files:B.files?base+B.files:null,
        hrefSource:function(p){
          var src=B.sources[p.s]||{};
          return base+"sources/"+encodeURIComponent(src.sl||"")+".html#ex="+encodeURIComponent(p.id);
        },
        hrefCode:function(slug,code){
          return base+"codes/"+encodeURIComponent(slug)+"/"+encodeURIComponent(code)+".html";
        }
      });
      var only=host.getAttribute("data-only"), omit=host.getAttribute("data-omit");
      var items=B.passages;
      if(only) items=items.filter(function(p){
        for(var i=0;i<p.g.length;i++) if(p.g[i][0]+":"+p.g[i][1]===only) return true;
        return false;
      });
      host.innerHTML="";
      UPCB.browse(host,items,{omit:omit?[omit]:[]});
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
  function chip(g){
    var d=codeDef[g[0]+":"+g[1]], lbl=d?d.c.label:g[1];
    var kind=(X.coderKind||{})[g[2]];
    var tip=(d&&d.c.def?d.c.label+": "+d.c.def+"\n":"")+"Coded by "+g[2]+(kind?" ("+kind+")":"")+
      (g[3]?" · confidence "+g[3]:"")+(g[4]?"\nWhy: "+g[4]:"");
    return '<span class="chip" title="'+E(tip)+'">'+
      '<a href="'+E(X.hrefCode(g[0],g[1]))+'">'+E(lbl)+"</a></span>";
  }
  function codeNote(){
    var k={}, ck=X.coderKind||{};
    Object.keys(ck).forEach(function(c){ k[ck[c]||"other"]=1; });
    var who=k.model&&k.human?"a language model and by people":k.human?"people":k.model?"a language model":"";
    return (who?"Codes were assigned by "+who+". ":"Codes are judgements, not checks. ")+
      "Hover a code to see who assigned it, how sure they were, and why.";
  }
  function card(p,opts){
    opts=opts||{};
    var s=X.sources[p.s]||{}, bad=p.b==="failed";
    var body;
    if(p.q){
      var q="<mark>"+E(p.q)+"</mark>";
      body=(opts.context!==false&&(p.x||p.y))
        ? '<blockquote class="ctx">…'+E((p.x||"").slice(-220))+q+E((p.y||"").slice(0,220))+"…</blockquote>"
        : "<blockquote>"+q+"</blockquote>";
      if(bad&&p.act) body+='<p class="small" style="color:var(--warn)">The source now reads: “'+E(p.act.slice(0,240))+'”</p>';
    } else { body='<p class="note">'+E(p.n)+"</p>"; }
    var where=[p.l?"line "+p.l:"",""].filter(Boolean).join(" · ");
    var pdfLink=(X.files&&s.p&&p.pg)
      ? ' <a class="muted" href="'+X.files+"/"+encodeURI(s.p)+"#page="+p.pg+'" target="_blank" rel="noopener"'+
        ' title="Open the original PDF at this page">page '+p.pg+" ↗</a>"
      : (p.pg?' <span class="muted">page '+p.pg+"</span>":"");
    return '<article class="passage'+(bad?" bad":"")+'" id="'+E(p.id)+'" data-row'+
      ' data-code="'+E(p.g.map(function(g){return g[0]+":"+g[1];}).join("|"))+'"'+
      ' data-coder="'+E(p.g.map(function(g){return g[2];}).join("|"))+'"'+
      ' data-year="'+E(s.y||"")+'"'+
      ' data-search="'+E([s.t,s.k].concat(p.g.map(function(g){return label(g[0],g[1])+" "+g[2];})).join(" "))+'">'+
      body+
      (p.dis?'<div class="disagree">Coders disagree here — both judgements are kept and shown.</div>':"")+
      '<div class="meta">'+badge(p.b,!!opts.terse)+
      (p.st?'<span class="badge plain">'+E(p.st)+"</span>":"")+
      p.g.map(function(g){return chip(g,!!opts.terse);}).join(" ")+
      '<span class="spacer"></span><a class="muted" href="'+E(X.hrefSource(p))+'">'+
      (opts.showSource===false?E(where||"in context"):E(s.k||"")+(where?" · "+E(where):""))+" →</a>"+pdfLink+
      "</div></article>";
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
      p._h=((p.q||"")+" "+(p.n||"")+" "+(s.t||"")+" "+(s.k||"")+" "+(s.a||"")+" "+(s.y||"")+" "+
            p.g.map(function(g){return label(g[0],g[1])+" "+g[2];}).join(" ")).toLowerCase();
    });
    items.__prepped=1;
  }

  function browse(host,items,opts){
    opts=opts||{};
    prep(items);

    // groups: one per codebook that anything is coded against, plus the coders
    var omit=opts.omit||[], groups=[];
    X.codebooks.forEach(function(cb){
      if(omit.indexOf(cb.slug)>=0) return;
      var codes=[];
      cb.codes.forEach(function(c){
        var key=cb.slug+":"+c.code, n=0;
        items.forEach(function(p){ if(p._c.indexOf(key)>=0) n++; });
        if(n) codes.push({key:key,label:c.label,def:c.def,n:n});
      });
      codes.sort(function(a,b){return b.n-a.n;});
      if(codes.length) groups.push({id:cb.slug,title:cb.title,question:cb.question||"",kind:"code",codes:codes});
    });
    // The scheme that covers most of the list goes first, and is the one opened:
    // a sidebar whose first section is a scheme almost nothing was coded against
    // teaches the reader that the sidebar is not worth opening.
    groups.forEach(function(g){
      g.total=items.filter(function(p){
        for(var i=0;i<p._c.length;i++) if(p._c[i].indexOf(g.id+":")===0) return true;
        return false; }).length;
    });
    groups.sort(function(a,b){return b.total-a.total;});
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
        '<p class="small muted" style="margin:0 0 .5rem">'+E(codeNote())+"</p>"+
        '<p class="small" style="margin:0 0 .5rem"><button class="btn" id="pclear">Clear all</button> '+
        '<button class="btn" id="pcsv">Download CSV</button></p>'+
        groups.map(function(g,i){
          return '<details'+(i===0?" open":"")+' data-g="'+E(g.id)+'"><summary>'+E(g.title)+
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

    function keep(p,skip){
      for(var i=0;i<groups.length;i++){
        var g=groups[i]; if(g.id===skip) continue;
        var want=sel[g.id]; if(!want.length) continue;
        var have=g.kind==="coder"?p._k:p._c, ok=false;
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
          var have=g.kind==="coder"?p._k:p._c;
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
      var head=["quote","source","year","doi","page","codes","coders","checked"],out=[head.join(",")];
      matches.forEach(function(p){
        var s=X.sources[p.s]||{};
        var f=[p.q||p.n, (s.k||"")+" — "+(s.t||""), s.y||"", s.d||"", p.pg||"",
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

  var API={init:init,card:card,chip:chip,badge:badge,browse:browse,label:label,reveal:reveal,codeNote:codeNote,esc:E,plural:PL};
  window.UPCB=API;
  // Printing includes everything: open whatever the reader left folded.
  window.addEventListener("beforeprint",function(){
    [].slice.call(document.querySelectorAll("details")).forEach(function(d){ d.open=true; });
  });
})();
`;

function page({ title, rel, body, model, active, extraHead = "", data = false }) {
  const up = rel.split("/").length - 1;
  const base = up ? "../".repeat(up) : "";
  const nav = [
    // Not "": on a top-level page (the matrix) an empty link is *this* page.
    ["index.html", "Home", "home"],
    ["codes/", "Codes", "codes"],
    ["sources/", "Sources", "sources"],
    ["passages/", "Passages", "passages"],
    ...(model.syntheses.length ? [["overviews/", "Overviews", "overviews"]] : []),
    ...(model.matrix ? [["matrix.html", "Matrix", "matrix"]] : []),
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
  Every quotation here was compared with the source text character by character when this page was built.
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
                 `Coded by ${c.coder}${c.coder_kind ? ` (${c.coder_kind})` : ""}${c.confidence ? ` · confidence ${c.confidence}` : ""}`,
                 c.rationale ? `Why: ${c.rationale}` : ""].filter(Boolean).join("\n");
  const href = c.code != null ? `${base}codes/${encodeURIComponent(c.codebook_slug)}/${encodeURIComponent(c.code)}.html` : null;
  return `<span class="chip${detached ? " detached" : ""}" data-id="${attr(c.coding_id)}" title="${attr(title)}">${
    href ? `<a href="${href}">${label}</a>` : label}</span>`;
}

/** Who made this corpus's codes: "a language model", "people", both, or "". */
function codedBy(model) {
  const kinds = new Set();
  for (const x of [...model.passages, ...model.sources]) for (const c of x.codings) kinds.add(c.coder_kind || "other");
  return kinds.has("model") && kinds.has("human") ? "a language model and by people"
       : kinds.has("human") ? "people" : kinds.has("model") ? "a language model" : "";
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
  let body;
  if (p.quote) {
    const q = `<mark>${esc(p.quote)}</mark>`;
    body = context && (p.before || p.after)
      ? `<blockquote class="ctx">…${esc(p.before.slice(-220))}${q}${esc(p.after.slice(0, 220))}…</blockquote>`
      : `<blockquote>${q}</blockquote>`;
    if (bad && p.actual != null) {
      body += `<p class="small" style="color:var(--warn)">The source now reads: “${esc(p.actual.slice(0, 240))}”</p>`;
    }
  } else {
    // A summary is never dressed as a quotation (spec/09).
    body = `<p class="note">${esc(p.note)}</p>`;
  }
  const chips = p.codings.map((c) => chipHtml(c, base, bad, compact)).join(" ");
  const dis = p.disagreements.length
    ? `<div class="disagree">Coders disagree here — both judgements are kept and shown.</div>` : "";
  const where = [p.line_range ? `line ${p.line_range.start}` : "", p.page ? `page ${p.page}` : ""].filter(Boolean).join(" · ");
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
  return `<article class="passage${bad ? " bad" : ""}" id="${attr(p.id)}" data-row
   data-code="${attr(p.codings.map((c) => `${c.codebook_slug}:${c.code != null ? c.code : c.value}`).join("|"))}"
   data-coder="${attr([...new Set(p.codings.map((c) => c.coder))].join("|"))}"
   data-source="${attr(p.source_id)}" data-year="${attr(p.year)}"
   data-search="${attr(searchable)}"${compact ? "" : ` data-csv="${attr(csv)}"`}>
  ${body}${dis}
  <div class="meta">
    ${badgeHtml(p.badge, compact)}
    ${status ? `<span class="badge plain">${esc(status)}</span>` : ""}
    ${chips}
    <span class="spacer"></span>
    ${showSource ? `<a class="muted" href="${srcHref}">${esc(p.cite)}${where ? ` · ${esc(where)}` : ""} →</a>`
                 : `<a class="muted" href="${srcHref}">${esc(where || "in context")} →</a>`}
  </div>
</article>`;
}

// --- pages ----------------------------------------------------------------

function homePage(model) {
  const hc = homeCard(model, folderLinks(""));
  const nPass = model.passages.filter((p) => p.quote).length;
  const nNote = model.passages.length - nPass;
  const verified = model.passages.filter((p) => U.VERIFIED_BADGES.has(p.badge)).length;
  const tiles = [
    [model.sources.length, "sources", "sources/"],
    [nPass, "passages (quoted)", "passages/"],
    [model.codebooks.length, "codebooks", "codes/"],
    [model.syntheses.length, "overviews", "overviews/"],
  ].filter(([n, , href]) => n || href === "sources/");
  return page({
    title: model.title, rel: "index.html", model, active: "home",
    body: `<h1>${esc(model.title)}</h1>
<p class="lede">A searchable library of what this literature actually says. Every quotation was compared with the
source text character by character when this page was built${verified === nPass && nPass ? " — all of them matched" : ""}.</p>
${hc ? `<section class="card homesum"><h2>${esc(hc.t)}</h2>${hc.h}</section>` : ""}
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
  const byBook = model.codebooks.map((cb) => {
    const rows = (cb.codes || []).map((c) => {
      const rec = model.codeIndex.get(`${cb.codebook_id}:${c.code}`);
      return { ...c, nP: rec ? rec.passages.length : 0, nS: rec ? rec.sources.size : 0 };
    }).sort((a, b) => (b.nP - a.nP) || (b.nS - a.nS) || a.code.localeCompare(b.code));
    return { cb, rows };
  });
  return page({
    title: `Codes — ${model.title}`, rel: "codes/index.html", model, active: "codes",
    body: `<h1>Codes</h1>
<p class="lede">Each codebook asks one question of the literature. Counts state what they count:
a <em>passage</em> is one quoted span; a <em>source</em> is one paper.</p>
${byBook.map(({ cb, rows }) => `
<h2>${esc(cb.title)}</h2>
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
</tbody></table></div>`).join("\n")}`,
  });
}

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
<p class="lede">${countsLede(passages, sourcesCoded)}${
  passages.length ? ". Narrow them on the left — those counts are within this code." : ""}.</p>
${passages.length
  ? `<div data-browse data-base="${base}" data-only="${attr(cb.slug + ":" + code.code)}" data-omit="${attr(cb.slug)}"></div>
<noscript>${passages.map((p) => passageHtml(p, model, base)).join("\n")}</noscript>`
  : `<p class="muted">No passages carry this code yet.</p>`}`,
  });
}

function sourcesIndexPage(model) {
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
  const pdfHref = s.pdfRep ? `${base}files/${encodeURIComponent(path.basename(s.pdfRep.path))}` : null;
  const marks = s.passages.filter((p) => p.quote && p.line_range).sort((a, b2) => (a.line_range.start - b2.line_range.start));
  return page({
    title: `${s.cite} — ${s.title}`, rel: `sources/${s.slug}.html`, model, active: "sources",
    extraHead: textInfo && textInfo.sidecar ? `<script src="${base}data/text/${encodeURIComponent(textInfo.sidecar)}" defer></script>` : "",
    body: `<p class="small muted"><a href="${base}sources/">Sources</a></p>
<h1>${esc(s.title)}</h1>
<p class="lede">${esc(bits)}${s.doi ? ` · <a href="https://doi.org/${encodeURIComponent(s.doi)}">doi:${esc(s.doi)}</a>` : ""}</p>
${s.codings.length || s.passages.some((p) => p.codings.length) ? `<p class="small muted">${esc(codeNote(model))}</p>` : ""}
${s.codings.length ? `<div class="card"><div class="small muted">Judgements about this paper as a whole</div>
  <div class="meta" style="margin-top:.4rem">${s.codings.map((c) => chipHtml(c, base, false)).join(" ")}</div></div>` : ""}

<h2>Passages (${s.passages.length})</h2>
${s.passages.length ? s.passages.map((p) => passageHtml(p, model, base, { showSource: false, context: false })).join("\n")
  : `<p class="muted">No passages have been coded from this paper yet.</p>`}

<h2>The text this was checked against</h2>
<p class="small muted">Extracted from the PDF${pdfHref ? ` — <a href="${pdfHref}">open the PDF</a>` : ""}.
Highlighted spans are the passages above.${textInfo && textInfo.omitted ? " The full text is too large to show here." : ""}</p>
${textInfo && textInfo.inline != null
  ? `<div class="reading" id="reading">${textInfo.inline}</div>`
  : textInfo && textInfo.sidecar
    ? `<div class="reading" id="reading">Loading…</div>
       <script>document.addEventListener("DOMContentLoaded",function(){
         var el=document.getElementById("reading");
         if(window.__UPC_TEXT)el.innerHTML=window.__UPC_TEXT; else el.textContent="The text could not be loaded.";});</script>`
    : `<p class="muted">Not available.</p>`}
${marks.length ? `<p class="small muted">${plural(marks.length, "highlight", "highlights")} in the text above.</p>` : ""}`,
  });
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
function renderReading(text, passages) {
  const cps = Array.from(text);
  const marks = [];
  for (const p of passages) {
    if (!p.quote) continue;
    const idx = text.indexOf(p.quote);
    if (idx < 0) continue;
    const start = U.codepointLength(text.slice(0, idx));
    marks.push({ start, end: start + U.codepointLength(p.quote), id: p.id, bad: p.badge === "failed" });
  }
  marks.sort((a, b) => a.start - b.start || b.end - a.end);

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
      if (m.start < at) continue;               // overlapping passages: keep the first
      const a = Math.max(m.start, ps), b = Math.min(m.end, pe);
      html += esc(cps.slice(at, a).join(""));
      html += `<mark id="t-${attr(m.id)}"${m.bad ? ' style="background:var(--warn-soft)"' : ""}>` +
              esc(cps.slice(a, b).join("")) + `</mark>`;
      at = b;
    }
    html += esc(cps.slice(at, pe).join(""));
    out.push(`<p>${html}</p>`);
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
Click a row or column heading to see its passages.</p>
<div class="wrap"><table>
<thead><tr><th></th>${bCodes.map((bc) =>
  `<th class="num"><a href="codes/${encodeURIComponent(B.slug)}/${encodeURIComponent(bc.code)}.html">${esc(bc.label || bc.code)}</a></th>`).join("")}</tr></thead>
<tbody>
${aCodes.map((ac) => `<tr>
  <th><a href="codes/${encodeURIComponent(A.slug)}/${encodeURIComponent(ac.code)}.html">${esc(ac.label || ac.code)}</a></th>
  ${bCodes.map((bc) => { const n = cell(ac, bc); return `<td class="num">${n || `<span class="muted">·</span>`}</td>`; }).join("")}
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
<ul class="ovlist">${g.items.map((s) => `<li><a class="${s.synthesis_id === selectedId ? "on" : ""}"
  href="${encodeURIComponent(s.synthesis_id)}.html">${esc(s.title || s.synthesis_id)}</a></li>`).join("")}</ul>
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
      const ids = run.match(/ext-[0-9a-f]{12}/g);
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
    .replace(/\[view:(matrix|passages|overviews|codes|sources)\]/g, (m, name) => {
      let text = { passages: "every passage", overviews: "the overviews", codes: "the codes", sources: "the papers" }[name];
      if (name === "matrix") {
        const [a, b] = model.matrix || [];
        const A = model.codebooks.find((c) => c.slug === a), B = model.codebooks.find((c) => c.slug === b);
        if (!A || !B) return "the comparison table (not built for this site)";
        text = `${A.title} × ${B.title}`;
      }
      return links.view ? `<a href="${attr(links.view(name))}">${esc(text)}</a>` : esc(text);
    })
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
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

/** Where every kind of link points, for a folder page `base` levels deep. */
function folderLinks(base) {
  const e = encodeURIComponent;
  return {
    passage: (p) => `${base}sources/${e(p.source_slug)}.html#ex=${e(p.id)}`,
    source: (src) => `${base}sources/${e(src.slug)}.html`,
    overview: (syn) => `${base}overviews/${e(syn.synthesis_id)}.html`,
    code: (slug, code) => `${base}codes/${e(slug)}/${e(code)}.html`,
    view: (name) => base + ({ matrix: "matrix.html", passages: "passages/", overviews: "overviews/",
                              codes: "codes/", sources: "sources/" }[name] || ""),
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
  const claims = syn.claims || [];
  return `<h1 style="margin-top:0">${esc(syn.title || syn.synthesis_id)}</h1>
<div class="card" style="max-width:74ch">${rendered || `<p class="muted">No text.</p>`}</div>
${claims.length ? `<h2>What this says, and what backs it</h2>
<div class="wrap"><table><thead><tr><th>Claim</th><th>Passages</th></tr></thead><tbody>
${claims.map((c) => `<tr><td>${esc(c.text)}</td><td>${(c.evidence_ids || []).map((id) => {
    const p = model.passageById.get(id);
    return p ? `<a href="${base}sources/${encodeURIComponent(p.source_slug)}.html#ex=${encodeURIComponent(id)}">${esc(p.cite)}</a>` : esc(id);
  }).join("; ")}</td></tr>`).join("\n")}
</tbody></table></div>` : ""}`;
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
    rel: `overviews/${syn.synthesis_id}.html`, model, active: "overviews",
    body: `<h1>Overviews</h1>${OVERVIEW_LEDE(model)}
<div class="split">${overviewSide(model, syn.synthesis_id)}
<section class="pane">${overviewBodyHtml(model, syn, root)}</section></div>`,
  });
}

// --- writer ---------------------------------------------------------------

export function writeSite(root, opts = {}) {
  const loaded = U.loadCorpus(root);
  const model = buildSiteModel(loaded, opts);
  const outDir = path.resolve(opts.out || path.join(root, "site"));
  const written = [];
  const w = (rel, text) => {
    const abs = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    U.atomicWriteFile(abs, text);
    written.push(rel);
  };

  fs.mkdirSync(outDir, { recursive: true });
  w("assets/site.css", CSS);
  // The browse engine first, then the page script that mounts it.
  w("assets/site.js", BROWSE_JS + "\n" + JS);

  // The same compact records the single file carries, as a plain script the
  // browsing pages load with <script src> — no fetch, so `file://` still works.
  {
    const { sources, passages, codebooks, ck } = browsePayload(model);
    w("data/browse.js", `window.__UPCB_DATA=${j({
      sources, passages, codebooks, ck,
      badges: BADGE_TEXT,
      files: opts.bundle ? "files" : null,
    })};\n`);
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
          if (bytes <= INLINE_TEXT_MAX) {
            info = { inline: renderReading(rec.text, s.passages) };
          } else if (bytes <= SIDECAR_TEXT_MAX) {
            const name = `${s.textRep.representation_id}.js`;
            w(`data/text/${name}`, `window.__UPC_TEXT=${j(renderReading(rec.text, s.passages))};\n`);
            info = { sidecar: name };
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

  if (model.syntheses.length) {
    w("overviews/index.html", overviewsIndexPage(model));
    for (const syn of model.syntheses) w(`overviews/${syn.synthesis_id}.html`, overviewPage(model, syn, loaded.root));
  }
  if (model.matrix) {
    const m = matrixPage(model);
    if (m) w("matrix.html", m);
  }

  // Optional: carry the actual files, so the folder is self-contained.
  let copied = 0;
  if (opts.bundle) {
    for (const s of model.sources) {
      for (const r of [s.pdfRep, s.textRep].filter(Boolean)) {
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
    hrefCode:function(slug,code){ return "#/code/"+encodeURIComponent(slug)+"/"+encodeURIComponent(code); }
  });
  var badge=UPCB.badge, chip=UPCB.chip, passageCard=UPCB.card;

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
  V.home=function(){
    var nq=D.passages.filter(function(p){return p.q;}).length;
    var tiles=[[D.sources.length,"sources","#/sources"],[nq,"passages (quoted)","#/passages"],
               [D.codebooks.length,"codebooks","#/codes"],[D.overviews.length,"overviews","#/overviews"]];
    return "<h1>"+E(D.title)+"</h1>"+
      '<p class="lede">A searchable library of what this literature actually says. Every quotation was compared '+
      "with the source text character by character when this file was built"+(D.failures?"":" — all of them matched")+".</p>"+
      (D.home?'<section class="card homesum"><h2>'+E(D.home.t)+"</h2>"+D.home.h+"</section>":"")+
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
      D.codebooks.map(function(cb){
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
  };
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
        (x.list.length?". Narrow them on the left — those counts are within this code.":"")+"</p>"+
      (x.list.length?'<div id="browse"></div>':'<p class="muted">No passages carry this code yet.</p>');
  };
  V.code.mount=function(a){
    var x=codeList(a); if(!x||!x.list.length) return;
    // This code's own scheme is left out: every passage here carries it, so the
    // section would hold one row reading what the heading already says.
    UPCB.browse(document.getElementById("browse"),x.list,{omit:[x.cb.slug]});
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
  V.source=function(a,q){
    var s=D.sources[+a[0]]; if(!s) return "<h1>Unknown source</h1>";
    var mine=passagesOf[s.i]||[];
    var bits=[s.a,s.y?String(s.y):"",s.c].filter(Boolean).join(" · ");
    var reading="";
    if(D.withText&&textOf(s.i)){
      var text=textOf(s.i), marks=[];
      mine.forEach(function(p){ if(!p.q)return; var i=text.indexOf(p.q);
        if(i>=0) marks.push({a:i,b:i+p.q.length,id:p.id,bad:p.b==="failed"}); });
      marks.sort(function(x,y){return x.a-y.a;});
      var out="",cur=0;
      marks.forEach(function(m){ if(m.a<cur)return;
        out+=E(text.slice(cur,m.a))+'<mark id="t-'+E(m.id)+'"'+(m.bad?' style="background:var(--warn-soft)"':"")+">"+
             E(text.slice(m.a,m.b))+"</mark>"; cur=m.b; });
      out+=E(text.slice(cur));
      reading='<div class="reading" id="reading">'+out.split(/\n{2,}/).map(function(x){return "<p>"+x+"</p>";}).join("")+"</div>";
    }
    return '<p class="small muted" id="crumb"><a href="#/sources">Sources</a></p><h1>'+E(s.t)+"</h1>"+
      '<p class="lede">'+E(bits)+(s.d?' · <a href="https://doi.org/'+encodeURIComponent(s.d)+'">doi:'+E(s.d)+"</a>":"")+
        ((D.files&&s.p)?' · <a href="'+D.files+"/"+encodeURI(s.p)+'" target="_blank" rel="noopener">open the PDF ↗</a>':"")+"</p>"+
      ((s.g.length||mine.some(function(p){return p.g.length;}))?'<p class="small muted">'+E(UPCB.codeNote())+"</p>":"")+
      (s.g.length?'<div class="card"><div class="small muted">Judgements about this paper as a whole</div>'+
        '<div class="meta" style="margin-top:.4rem">'+s.g.map(function(g){return chip(g);}).join(" ")+"</div></div>":"")+
      "<h2>Passages ("+mine.length+")</h2>"+
      (mine.length?mine.map(function(p){return passageCard(p,{showSource:false,context:false});}).join(""):'<p class="muted">No passages from this paper yet.</p>')+
      (reading?'<h2>The text this was checked against</h2><p class="small muted">Extracted from the PDF. Highlighted spans are the passages above.</p>'+reading:"");
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
    return "<h1 style=\"margin-top:0\">"+E(o.t)+"</h1>"+
      '<div class="card" style="max-width:74ch">'+html+"</div>"+
      (o.cl.length?"<h2>What this says, and what backs it</h2><div class=\"wrap\"><table><thead><tr><th>Claim</th>"+
        "<th>Passages</th></tr></thead><tbody>"+o.cl.map(function(c){
          return "<tr><td>"+E(c[0])+"</td><td>"+c[1].map(function(id2){ var p=byId[id2];
            return p?'<a href="#/source/'+p.s+"?ex="+encodeURIComponent(id2)+'">'+E((D.sources[p.s]||{}).k||"")+"</a>":E(id2);
          }).join("; ")+"</td></tr>";}).join("")+"</tbody></table></div>":"");
  }
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
      "is a count of passages, not of papers. Click a heading to see its passages.</p>"+
      '<div class="wrap"><table><thead><tr><th></th>'+bc.map(function(y){
        return '<th class="num"><a href="#/code/'+encodeURIComponent(B.slug)+"/"+encodeURIComponent(y.code)+'">'+E(y.label)+"</a></th>";
      }).join("")+"</tr></thead><tbody>"+
      ac.map(function(x){
        return '<tr><th><a href="#/code/'+encodeURIComponent(A.slug)+"/"+encodeURIComponent(x.code)+'">'+E(x.label)+"</a></th>"+
          bc.map(function(y){var n=cell(x,y);return '<td class="num">'+(n||'<span class="muted">·</span>')+"</td>";}).join("")+"</tr>";
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

  var NAV=[["#/","Home","home"],["#/codes","Codes","codes"],["#/sources","Sources","sources"],
           ["#/passages","Passages","passages"]];
  if(D.overviews.length) NAV.push(["#/overviews","Overviews","overviews"]);
  if(D.matrix) NAV.push(["#/matrix","Matrix","matrix"]);

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
    var m=/(?:^|&)ex=([^&]+)/.exec(qs);
    if(m){
      var id=decodeURIComponent(m[1]);
      var el=document.getElementById(id)||document.getElementById("t-"+id);
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
 * 178-paper corpus), so `--no-text` drops them and keeps the passages, their
 * context and every overview — about a fifth of the size, and still the thing
 * most readers came for.
 */
/**
 * The compact record the browse engine reads, built once and used by both
 * shapes of the site so a passage cannot look like one thing in the file and
 * another in the folder. Context is recomputed from the text at render time
 * rather than stored twice, and the keys are one letter because they repeat
 * once per passage — three thousand times in a real corpus.
 */
function browsePayload(model) {
  const srcIndex = new Map();
  const sources = model.sources.map((s, i) => {
    srcIndex.set(s.id, i);
    return {
      i, t: s.title, a: s.authors, y: s.year, d: s.doi, c: s.container, k: s.cite, sl: s.slug,
      p: s.pdfRep ? path.basename(s.pdfRep.path) : "",
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
    x: p.before, y: p.after, act: p.badge === "failed" ? p.actual : null,
    g: p.codings.map((c) => [c.codebook_slug, c.code != null ? c.code : c.value, c.coder, c.confidence, c.rationale || ""]),
    dis: p.disagreements.length ? 1 : 0,
  }));
  const codebooks = model.codebooks.map((cb) => ({
    slug: cb.slug, title: cb.title, question: cb.question || "",
    unit: cb.unit || "passage",
    codes: (cb.codes || []).map((c) => ({ code: c.code, label: c.label || c.code, def: c.definition || "" })),
  }));
  // coder handle -> kind (model / human), for the tooltips and the one visible note
  const ck = {};
  for (const x of [...model.passages, ...model.sources]) for (const c of x.codings) if (c.coder) ck[c.coder] = c.coder_kind || "";
  return { srcIndex, sources, passages, codebooks, ck };
}

export function writeSingleFile(root, opts = {}) {
  const loaded = U.loadCorpus(root);
  const model = buildSiteModel(loaded, opts);
  const withText = opts.withText !== false;
  const { srcIndex, sources, passages, codebooks, ck } = browsePayload(model);
  const oneLinks = {
    passage: (p) => `#/source/${srcIndex.get(p.source_id)}?ex=${encodeURIComponent(p.id)}`,
    source: (src) => `#/source/${srcIndex.get(src.id)}`,
    overview: (syn) => `#/overviews/${encodeURIComponent(syn.synthesis_id)}`,
    code: (slug, code) => `#/code/${encodeURIComponent(slug)}/${encodeURIComponent(code)}`,
    view: (name) => `#/${name}`,
  };

  const texts = [];
  if (withText) {
    for (const s of model.sources) {
      let body = "";
      if (s.textRep) {
        const entry = (loaded.representations || []).find((r) => r.obj.representation_id === s.textRep.representation_id);
        if (entry && entry.contained && fs.existsSync(entry.abs)) {
          const rec = U.getRepFile(entry.abs);
          if (rec.utf8ok) body = rec.text;
        }
      }
      texts.push(body);
    }
  }

  const overviews = model.syntheses.map((syn) => {
    let body = "";
    const outPath = syn.output && syn.output.path;
    if (outPath) {
      const { abs, contained } = U.resolveInside(loaded.root, outPath);
      if (contained && fs.existsSync(abs)) body = fs.readFileSync(abs, "utf8");
    }
    return {
      id: syn.synthesis_id,
      t: syn.title || syn.synthesis_id,
      grp: syn._group ? syn._group.slug : "",
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
      if (!s.pdfRep) continue;
      const entry = (loaded.representations || []).find((r) => r.obj.representation_id === s.pdfRep.representation_id);
      if (!entry || !entry.contained || !fs.existsSync(entry.abs)) continue;
      const dest = path.join(dir, path.basename(s.pdfRep.path));
      if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(entry.abs).size) {
        fs.copyFileSync(entry.abs, dest);
      }
      copied++;
    }
  }

  return {
    status: "ok", out, bytes: Buffer.byteLength(html, "utf8"),
    pdfs_bundled: copied, files_dir: opts.files || null,
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
