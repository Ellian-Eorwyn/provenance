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

  const syntheses = (loaded.syntheses || []).map((s) => s.obj);

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
source text character by character when this page was built${verified === nPass && nPass ? " — all of them matched" : ""}.
Browse by <a href="codes/">theme</a>, by <a href="sources/">paper</a>, or search <a href="passages/">every passage</a>.</p>
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
  <td><a href="${encodeURIComponent(cb.slug)}/${encodeURIComponent(r.code)}.html">${esc(r.label || r.code)}</a></td>
  <td class="muted">${esc(r.definition || "")}</td>
  <td class="num">${r.nP || ""}</td><td class="num">${r.nS || ""}</td>
</tr>`).join("\n")}
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
  return page({
    title: `Overviews — ${model.title}`, rel: "overviews/index.html", model, active: "overviews",
    body: `<h1>Overviews</h1>
<p class="lede">Written from the coded passages. Every quotation in them links back to the passage it came from,
and was re-checked against the source when this page was built.</p>
<ul class="plain">
${model.syntheses.map((s) => `<li><a href="${encodeURIComponent(s.synthesis_id)}.html">${esc(s.title || s.synthesis_id)}</a>
  <span class="small muted">— ${esc(s.type || "")}${s.claims ? ` · ${plural(s.claims.length, "claim", "claims")}` : ""}</span></li>`).join("\n")}
</ul>`,
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
