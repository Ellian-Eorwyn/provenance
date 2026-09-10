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
  const syntheses = (loaded.syntheses || []).map((s) => {
    const o = s.obj;
    const declared = ((o.ext || {})["upc-corpus"] || {}).codebook;
    const owner = declared
      ? { cb: codebooks.find((c) => c.slug === declared), code: null }
      : labelOwner.get(String(o.title || "").toLowerCase());
    return { ...o, _group: owner && owner.cb ? owner.cb : null };
  });

  return {
    title: (loaded.corpus && loaded.corpus.title) || "Research corpus",
    specVersion: loaded.corpus && loaded.corpus.upc_spec_version,
    sources, sourceById, passages, passageById,
    codebooks, cbkById, codeIndex, syntheses,
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

function page({ title, rel, body, model, active, extraHead = "" }) {
  const up = rel.split("/").length - 1;
  const base = up ? "../".repeat(up) : "";
  const nav = [
    ["", "Home", "home"],
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
  A <em>code</em> is somebody's judgement about a passage — always shown with who made it — and is never a check mark.
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

function chipHtml(c, base, detached, terse) {
  const label = esc(c.label || c.code || c.value);
  const who = esc(c.coder) + (c.coder_kind ? ` (${esc(c.coder_kind)})` : "");
  const title = [c.definition ? `${c.label}: ${c.definition}` : c.label,
                 c.rationale ? `Why: ${c.rationale}` : "",
                 c.confidence ? `Confidence: ${c.confidence}` : ""].filter(Boolean).join("\n");
  const href = c.code != null ? `${base}codes/${encodeURIComponent(c.codebook_slug)}/${encodeURIComponent(c.code)}.html` : null;
  const inner = `${label} <span class="who">${who}</span>`;
  // On a page that lists the whole corpus, the definition rides on the code page
  // one click away rather than in every row's title attribute — that tooltip is
  // the single largest thing in a row, and §09 asks only that a definition be at
  // most one interaction away.
  return `<span class="chip${detached ? " detached" : ""}" data-id="${attr(c.coding_id)}"${
    terse ? "" : ` title="${attr(title)}"`}>${href ? `<a href="${href}">${inner}</a>` : inner}</span>`;
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
${model.syntheses.length ? `<p class="lede"><strong>New here?</strong> Start with the
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
Codes always show who made them, and where two coders disagree both judgements are shown. Nothing is resolved for you.</p>
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

function codePage(model, cb, code) {
  const rec = model.codeIndex.get(`${cb.codebook_id}:${code.code}`);
  const passages = rec ? rec.passages.map((id) => model.passageById.get(id)).filter(Boolean) : [];
  const sourcesCoded = rec ? [...rec.sources] : [];
  const base = "../../";
  const years = [...new Set(passages.map((p) => p.year).filter(Boolean))].sort();
  const coders = [...new Set(passages.flatMap((p) => p.codings.map((c) => c.coder)))].sort();
  const otherBooks = model.codebooks.filter((b) => b.codebook_id !== cb.codebook_id);
  return page({
    title: `${code.label || code.code} — ${cb.title}`, rel: `codes/${cb.slug}/${code.code}.html`, model, active: "codes",
    body: `<p class="small muted"><a href="${base}codes/">Codes</a> › ${esc(cb.title)}</p>
<h1>${esc(code.label || code.code)}</h1>
${code.definition ? `<div class="defbox">${esc(code.definition)}${
  (code.examples || []).length ? `<div class="small muted" style="margin-top:.4rem">For example: “${esc(code.examples[0])}”</div>` : ""}</div>` : ""}
<p class="lede">${plural(passages.length, "passage", "passages")} in ${plural(sourcesCoded.length, "source", "sources")}.</p>
<div class="filters sans small">
  <input type="search" data-q placeholder="Search these passages…" style="min-width:16rem">
  ${otherBooks.map((b) => {
    const opts = (b.codes || []).filter((c) => model.codeIndex.has(`${b.codebook_id}:${c.code}`));
    return opts.length ? `<select data-filter="code"><option value="">Any ${esc(b.title.toLowerCase())}</option>
      ${opts.map((c) => `<option value="${attr(b.slug + ":" + c.code)}">${esc(c.label || c.code)}</option>`).join("")}
    </select>` : "";
  }).join("")}
  ${years.length > 1 ? `<select data-filter="year"><option value="">Any year</option>${years.map((y) => `<option>${esc(y)}</option>`).join("")}</select>` : ""}
  ${coders.length > 1 ? `<select data-filter="coder"><option value="">Any coder</option>${coders.map((c) => `<option>${esc(c)}</option>`).join("")}</select>` : ""}
  <span class="muted" data-count data-one="passage shown" data-many="passages shown"></span>
  <button class="btn" data-export>Download CSV</button>
</div>
${passages.length ? passages.map((p) => passageHtml(p, model, base)).join("\n")
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
  const withQuote = model.passages;
  const books = model.codebooks;
  return page({
    title: `Passages — ${model.title}`, rel: "passages/index.html", model, active: "passages",
    body: `<h1>Passages</h1>
<p class="lede">Every coded passage in the corpus. Search the words, or narrow by code, coder or year.</p>
<div class="filters sans small">
  <input type="search" data-q placeholder="Search every passage…" style="min-width:22rem">
  ${books.map((b) => {
    const opts = (b.codes || []).filter((c) => model.codeIndex.has(`${b.codebook_id}:${c.code}`));
    return opts.length ? `<select data-filter="code"><option value="">Any ${esc(b.title.toLowerCase())}</option>
      ${opts.map((c) => `<option value="${attr(b.slug + ":" + c.code)}">${esc(c.label || c.code)}</option>`).join("")}
    </select>` : "";
  }).join("")}
  <span class="muted" data-count data-one="passage shown" data-many="passages shown"></span>
</div>
<p class="small muted">Searching matches the quotation itself as well as its codes, source and coder.
To download a set of passages as a spreadsheet, open the code page for it.</p>
${withQuote.map((p) => passageHtml(p, model, "../", { context: false, compact: true })).join("\n")}`,
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

function overviewsIndexPage(model) {
  const groups = new Map();
  for (const s of model.syntheses) {
    const key = s._group ? s._group.slug : "";
    if (!groups.has(key)) groups.set(key, { cb: s._group, items: [] });
    groups.get(key).items.push(s);
  }
  // Biggest scheme first, ungrouped last: a reader scanning for orientation wants
  // the theories before the odds and ends.
  const ordered = [...groups.values()].sort((a, b) =>
    (a.cb ? 0 : 1) - (b.cb ? 0 : 1) || b.items.length - a.items.length);
  const section = (g) => `
<h2>${g.cb ? esc(g.cb.title) : "Other overviews"}</h2>
${g.cb && g.cb.question ? `<p class="small muted">${esc(g.cb.question)}</p>` : ""}
<ul class="plain">
${g.items.map((s) => `<li><a href="${encodeURIComponent(s.synthesis_id)}.html">${esc(s.title || s.synthesis_id)}</a>
  <span class="small muted">${s.claims ? `— ${plural(s.claims.length, "claim", "claims")}` : ""}</span></li>`).join("\n")}
</ul>`;
  return page({
    title: `Overviews — ${model.title}`, rel: "overviews/index.html", model, active: "overviews",
    body: `<h1>Overviews</h1>
<p class="lede">${plural(model.syntheses.length, "short review", "short reviews")} of what this literature says,
one per theme, written from the coded passages. Every quotation links back to the passage it came from and was
re-checked against the source when this page was built. <strong>Start here</strong> if you want the lay of the land.</p>
${ordered.map(section).join("\n")}`,
  });
}

function overviewPage(model, syn, root) {
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
  const rendered = esc(body)
    .replace(/&quot;([^&]*?)&quot;\s*\[(ext-[0-9a-f]{12})\]/g, (m, q, id) => {
      const p = model.passageById.get(id);
      if (!p) return m;
      const ok = U.VERIFIED_BADGES.has(p.badge);
      return `<a href="${base}sources/${encodeURIComponent(p.source_slug)}.html#ex=${encodeURIComponent(id)}"
        title="${attr((BADGE_TEXT[p.badge] || [])[1] || "")}">“${q}”</a> <span class="small">${ok ? "✓" : "⚠"} ${esc(p.cite)}</span>`;
    })
    .replace(/\[(ext-[0-9a-f]{12})\]/g, (m, id) => {
      const p = model.passageById.get(id);
      return p ? `<a class="small" href="${base}sources/${encodeURIComponent(p.source_slug)}.html#ex=${encodeURIComponent(id)}">${esc(p.cite)}</a>` : m;
    })
    .replace(/^#{1,6}\s*(.+)$/gm, (m, t) => `<h2>${t}</h2>`)
    .replace(/\n{2,}/g, "\n<p></p>\n");
  const claims = syn.claims || [];
  return page({
    title: `${syn.title || syn.synthesis_id} — ${model.title}`, rel: `overviews/${syn.synthesis_id}.html`, model, active: "overviews",
    body: `<p class="small muted"><a href="${base}overviews/">Overviews</a></p>
<h1>${esc(syn.title || syn.synthesis_id)}</h1>
<div class="card" style="max-width:74ch">${rendered || `<p class="muted">No text.</p>`}</div>
${claims.length ? `<h2>What this says, and what backs it</h2>
<div class="wrap"><table><thead><tr><th>Claim</th><th>Passages</th></tr></thead><tbody>
${claims.map((c) => `<tr><td>${esc(c.text)}</td><td>${(c.evidence_ids || []).map((id) => {
    const p = model.passageById.get(id);
    return p ? `<a href="${base}sources/${encodeURIComponent(p.source_slug)}.html#ex=${encodeURIComponent(id)}">${esc(p.cite)}</a>` : esc(id);
  }).join("; ")}</td></tr>`).join("\n")}
</tbody></table></div>` : ""}`,
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
  w("assets/site.js", JS);

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

  function badge(b,terse){
    var t=D.badges[b]||D.badges.unverifiable;
    var cls=b==="failed"?"badge bad":(b==="paraphrase"||b==="unverifiable")?"badge plain":"badge";
    return '<span class="'+cls+'"'+(terse?"":' title="'+E(t[2])+'"')+'>'+t[0]+" "+E(t[1])+"</span>";
  }
  function chip(g,terse){
    var d=codeDef[g[0]+":"+g[1]], lbl=d?d.c.label:g[1];
    var tip=d&&d.c.def?d.c.label+": "+d.c.def:lbl;
    if(g[4]) tip+="\nWhy: "+g[4];
    if(g[3]) tip+="\nConfidence: "+g[3];
    return '<span class="chip"'+(terse?"":' title="'+E(tip)+'"')+'>'+
      '<a href="#/code/'+encodeURIComponent(g[0])+"/"+encodeURIComponent(g[1])+'">'+
      E(lbl)+' <span class="who">'+E(g[2])+"</span></a></span>";
  }
  function passageCard(p,opts){
    opts=opts||{};
    var s=D.sources[p.s]||{}, bad=p.b==="failed";
    var body;
    if(p.q){
      var q="<mark>"+E(p.q)+"</mark>";
      body=(opts.context!==false&&(p.x||p.y))
        ? '<blockquote class="ctx">…'+E((p.x||"").slice(-220))+q+E((p.y||"").slice(0,220))+"…</blockquote>"
        : "<blockquote>"+q+"</blockquote>";
      if(bad&&p.act) body+='<p class="small" style="color:var(--warn)">The source now reads: “'+E(p.act.slice(0,240))+'”</p>';
    } else { body='<p class="note">'+E(p.n)+"</p>"; }
    var where=[p.l?"line "+p.l:""].filter(Boolean).join(" · ");
    return '<article class="passage'+(bad?" bad":"")+'" id="'+E(p.id)+'" data-row'+
      ' data-code="'+E(p.g.map(function(g){return g[0]+":"+g[1];}).join("|"))+'"'+
      ' data-coder="'+E(p.g.map(function(g){return g[2];}).join("|"))+'"'+
      ' data-year="'+E(s.y||"")+'"'+
      ' data-search="'+E([s.t,s.k].concat(p.g.map(function(g){var d=codeDef[g[0]+":"+g[1]];return (d?d.c.label:g[1])+" "+g[2];})).join(" "))+'">'+
      body+
      (p.dis?'<div class="disagree">Coders disagree here — both judgements are kept and shown.</div>':"")+
      '<div class="meta">'+badge(p.b,!!opts.terse)+
      (p.st?'<span class="badge plain">'+E(p.st)+"</span>":"")+
      p.g.map(function(g){return chip(g,!!opts.terse);}).join(" ")+
      '<span class="spacer"></span><a class="muted" href="#/source/'+p.s+"?ex="+encodeURIComponent(p.id)+'">'+
      (opts.showSource===false?E(where||"in context"):E(s.k||"")+(where?" · "+E(where):""))+" →</a></div></article>";
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
      (D.overviews.length?'<p class="lede"><strong>New here?</strong> Start with the <a href="#/overviews">'+
        PL(D.overviews.length,"overview","overviews")+"</a> — a short review per theme, written from the coded "+
        'passages, with every quotation linked back to the paper it came from. Then browse by <a href="#/codes">theme</a>, '+
        'by <a href="#/sources">paper</a>, or search <a href="#/passages">every passage</a>.</p>':"")+
      '<div class="grid cards">'+tiles.filter(function(t){return t[0];}).map(function(t){
        return '<a class="card tile" href="'+t[2]+'"><span class="n">'+t[0]+'</span><br><span class="u">'+E(t[1])+"</span></a>";
      }).join("")+"</div>"+
      "<h2>How to read this</h2><div class=\"card\"><p class=\"small\"><strong>A passage</strong> is a span of text from one "+
      "paper, quoted exactly. <strong>A check mark</strong> means the quotation matched the paper's text when this file was "+
      "built. <strong>A code</strong> is a judgement someone made about that passage. Codes always show who made them, and "+
      "where two coders disagree both judgements are shown. Nothing is resolved for you.</p></div>";
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
  V.code=function(a){
    var cb=bySlug[a[0]]; if(!cb) return "<h1>Unknown scheme</h1>";
    var c=null; cb.codes.forEach(function(x){ if(x.code===a[1]) c=x; });
    if(!c) return "<h1>Unknown code</h1>";
    var r=codeIndex[cb.slug+":"+c.code]||{p:[],s:{}};
    var list=r.p.map(function(id){return byId[id];}).filter(Boolean);
    var others=D.codebooks.filter(function(x){return x.slug!==cb.slug;});
    var years={}; list.forEach(function(p){var y=(D.sources[p.s]||{}).y; if(y)years[y]=1;});
    var coders={}; list.forEach(function(p){p.g.forEach(function(g){coders[g[2]]=1;});});
    return '<p class="small muted" id="crumb"><a href="#/codes">Codes</a> › '+E(cb.title)+"</p><h1>"+E(c.label)+"</h1>"+
      (c.def?'<div class="defbox">'+E(c.def)+"</div>":"")+
      '<p class="lede">'+PL(list.length,"passage","passages")+" in "+PL(Object.keys(r.s).length,"source","sources")+".</p>"+
      '<div class="filters sans small"><input type="search" data-q placeholder="Search these passages…" style="min-width:16rem">'+
      others.map(function(b){
        var opts=b.codes.filter(function(x){return codeIndex[b.slug+":"+x.code];});
        return opts.length?'<select data-filter="code"><option value="">Any '+E(b.title.toLowerCase())+"</option>"+
          opts.map(function(x){return '<option value="'+E(b.slug+":"+x.code)+'">'+E(x.label)+"</option>";}).join("")+"</select>":"";
      }).join("")+
      (Object.keys(coders).length>1?'<select data-filter="coder"><option value="">Any coder</option>'+
        Object.keys(coders).sort().map(function(x){return "<option>"+E(x)+"</option>";}).join("")+"</select>":"")+
      '<span class="muted" data-count data-one="passage shown" data-many="passages shown"></span>'+
      '<button class="btn" data-export>Download CSV</button></div>'+
      (list.length?list.map(function(p){return passageCard(p,{});}).join(""):'<p class="muted">No passages carry this code yet.</p>');
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
    if(D.withText&&D.texts[s.i]){
      var text=D.texts[s.i], marks=[];
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
      '<p class="lede">'+E(bits)+(s.d?' · <a href="https://doi.org/'+encodeURIComponent(s.d)+'">doi:'+E(s.d)+"</a>":"")+"</p>"+
      (s.g.length?'<div class="card"><div class="small muted">Judgements about this paper as a whole</div>'+
        '<div class="meta" style="margin-top:.4rem">'+s.g.map(function(g){return chip(g);}).join(" ")+"</div></div>":"")+
      "<h2>Passages ("+mine.length+")</h2>"+
      (mine.length?mine.map(function(p){return passageCard(p,{showSource:false,context:false});}).join(""):'<p class="muted">No passages from this paper yet.</p>')+
      (reading?'<h2>The text this was checked against</h2><p class="small muted">Extracted from the PDF. Highlighted spans are the passages above.</p>'+reading:"");
  };
  V.passages=function(){
    return "<h1>Passages</h1><p class=\"lede\">Every coded passage in the corpus. Search the words, or narrow by code.</p>"+
      '<div class="filters sans small"><input type="search" data-q placeholder="Search every passage…" style="min-width:22rem">'+
      D.codebooks.map(function(b){
        var opts=b.codes.filter(function(x){return codeIndex[b.slug+":"+x.code];});
        return opts.length?'<select data-filter="code"><option value="">Any '+E(b.title.toLowerCase())+"</option>"+
          opts.map(function(x){return '<option value="'+E(b.slug+":"+x.code)+'">'+E(x.label)+"</option>";}).join("")+"</select>":"";
      }).join("")+
      '<span class="muted" data-count data-one="passage shown" data-many="passages shown"></span>'+
      '<button class="btn" data-export>Download CSV</button></div>'+
      D.passages.map(function(p){return passageCard(p,{context:false,terse:true});}).join("");
  };
  V.overviews=function(){
    var groups={},order=[];
    D.overviews.forEach(function(o){ var k=o.grp||"";
      if(!groups[k]){groups[k]=[];order.push(k);} groups[k].push(o); });
    order.sort(function(a,b){ return (a?0:1)-(b?0:1) || groups[b].length-groups[a].length; });
    return "<h1>Overviews</h1><p class=\"lede\">"+PL(D.overviews.length,"short review","short reviews")+
      " of what this literature says, one per theme, written from the coded passages. Every quotation links back to "+
      "the passage it came from. <strong>Start here</strong> if you want the lay of the land.</p>"+
      order.map(function(k){
        var cb=bySlug[k];
        return "<h2>"+E(cb?cb.title:"Other overviews")+"</h2>"+
          (cb&&cb.question?'<p class="small muted">'+E(cb.question)+"</p>":"")+
          '<ul class="plain">'+groups[k].map(function(o){
            return '<li><a href="#/overview/'+encodeURIComponent(o.id)+'">'+E(o.t)+"</a>"+
              '<span class="small muted"> — '+PL(o.cl.length,"claim","claims")+"</span></li>";
          }).join("")+"</ul>";
      }).join("");
  };
  V.overview=function(a){
    var o=null; D.overviews.forEach(function(x){ if(x.id===a[0]) o=x; });
    if(!o) return "<h1>Unknown overview</h1>";
    var html=E(o.md)
      .replace(/&quot;([^&]*?)&quot;\s*\[(ext-[0-9a-f]{12})\]/g,function(m,q,id){
        var p=byId[id]; if(!p) return m;
        var ok=p.b.indexOf("verified")===0;
        return '<a href="#/source/'+p.s+"?ex="+encodeURIComponent(id)+'">“'+q+'”</a> <span class="small">'+
          (ok?"✓":"⚠")+" "+E((D.sources[p.s]||{}).k||"")+"</span>";})
      .replace(/\[(ext-[0-9a-f]{12})\]/g,function(m,id){
        var p=byId[id]; if(!p) return m;
        return '<a class="small" href="#/source/'+p.s+"?ex="+encodeURIComponent(id)+'">'+E((D.sources[p.s]||{}).k||"")+"</a>";})
      .replace(/^#{1,6}\s*(.+)$/gm,function(m,t){return "<h2>"+t+"</h2>";})
      .replace(/\n{2,}/g,"\n<p></p>\n");
    return '<p class="small muted" id="crumb"><a href="#/overviews">Overviews</a></p><h1>'+E(o.t)+"</h1>"+
      '<div class="card" style="max-width:74ch">'+html+"</div>"+
      (o.cl.length?"<h2>What this says, and what backs it</h2><div class=\"wrap\"><table><thead><tr><th>Claim</th>"+
        "<th>Passages</th></tr></thead><tbody>"+o.cl.map(function(c){
          return "<tr><td>"+E(c[0])+"</td><td>"+c[1].map(function(id){ var p=byId[id];
            return p?'<a href="#/source/'+p.s+"?ex="+encodeURIComponent(id)+'">'+E((D.sources[p.s]||{}).k||"")+"</a>":E(id);
          }).join("; ")+"</td></tr>";}).join("")+"</tbody></table></div>":"");
  };
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

  function route(){
    var h=(location.hash||"#/").replace(/^#/,"");
    var qi=h.indexOf("?"), qs=""; if(qi>=0){qs=h.slice(qi+1); h=h.slice(0,qi);}
    var parts=h.split("/").filter(Boolean).map(decodeURIComponent);
    var view=parts.shift()||"home";
    var fn=V[view]||V.home;
    if(D.failures){
      app.innerHTML='<div class="banner"><strong>'+PL(D.failures,"quotation does","quotations do")+
        " not match the source.</strong> They are shown with a warning wherever they appear.</div>";
    } else { app.innerHTML=""; }
    app.innerHTML+=fn(parts,qs);
    document.getElementById("nav").innerHTML=NAV.map(function(n){
      return '<a class="'+(n[2]===view||(view==="home"&&n[2]==="home")?"on":"")+'" href="'+n[0]+'">'+n[1]+"</a>";
    }).join("");
    wire();
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
export function writeSingleFile(root, opts = {}) {
  const loaded = U.loadCorpus(root);
  const model = buildSiteModel(loaded, opts);
  const withText = opts.withText !== false;

  // Compact payload. Context is recomputed from the text at render time rather
  // than stored twice, and keys are short because they repeat 3,000 times.
  const srcIndex = new Map();
  const sources = model.sources.map((s, i) => {
    srcIndex.set(s.id, i);
    return {
      i, t: s.title, a: s.authors, y: s.year, d: s.doi, c: s.container, k: s.cite,
      p: s.pdfRep ? path.basename(s.pdfRep.path) : "",
      g: s.codings.map((c) => [c.codebook_slug, c.code != null ? c.code : c.value, c.coder, c.confidence, c.rationale || ""]),
    };
  });

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

  const passages = model.passages.map((p) => ({
    id: p.id,
    s: srcIndex.has(p.source_id) ? srcIndex.get(p.source_id) : -1,
    q: p.quote,
    n: p.note,
    b: p.badge,
    st: p.status === "active" ? "" : p.status,
    l: p.line_range ? p.line_range.start : 0,
    // Offsets let the reader show the passage in place without storing context twice.
    o: (p.actual != null && p.quote) ? [p.beforeLen || 0, 0] : null,
    x: p.before, y: p.after, act: p.badge === "failed" ? p.actual : null,
    g: p.codings.map((c) => [c.codebook_slug, c.code != null ? c.code : c.value, c.coder, c.confidence, c.rationale || ""]),
    dis: p.disagreements.length ? 1 : 0,
  }));

  const codebooks = model.codebooks.map((cb) => ({
    slug: cb.slug, title: cb.title, question: cb.question || "",
    unit: cb.unit || "passage",
    codes: (cb.codes || []).map((c) => ({ code: c.code, label: c.label || c.code, def: c.definition || "" })),
  }));

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
      md: body.replace(/^\s*#\s+.*\n+/, ""),
      cl: (syn.claims || []).map((c) => [c.text, c.evidence_ids || []]),
    };
  });

  const payload = {
    title: model.title,
    spec: model.specVersion || "",
    matrix: model.matrix || null,
    failures: model.failures,
    withText,
    badges: BADGE_TEXT,
    sources, texts, passages, codebooks, overviews,
  };

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
  judgement about a passage — always shown with who made it — and is never a check mark.
</footer>
<script type="application/json" id="upc-data">${
    JSON.stringify(payload).replace(/</g, "\\u003c")
  }</script>
<script>${CLIENT_ONE}</script>
</body></html>
`;

  const out = path.resolve(opts.out || path.join(root, "corpus.html"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  U.atomicWriteFile(out, html);
  return {
    status: "ok", out, bytes: Buffer.byteLength(html, "utf8"),
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
