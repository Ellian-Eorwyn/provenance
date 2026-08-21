#!/usr/bin/env node
// UPC static browser generator (spec/09). Writes a self-contained, offline
// index.html built purely from the manifests — and, crucially, a TRUTHFUL one:
//
//  * quotation context is read from the representation bytes AT THE LOCATOR at
//    build time (never reconstructed from the extraction's own stored strings),
//    so a drifted quote is visible, not self-confirmed;
//  * every quotation carries a verification badge computed by running the hop-B
//    gate at build time (verified / failed / verified-to-transcript /
//    verified-to-rewrite / unverifiable);
//  * a paraphrase (text-only extraction) is labeled and never styled as a quote;
//  * a banner surfaces any gate failure so a broken corpus never looks clean.
//
// Read-only. Written atomically to the sections.index_html path (default index.html).
//
//   node build-index.mjs <corpus-dir>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus, getRepFile, verifyHopB, bareHash, atomicWriteFile,
  resolveLocator, lineRangeForCharRange, isDerivedText, isModelRewrittenText, textLines, isTextualMedia as U_TEXTUAL } from "./upc_common.mjs";

const TEXTUAL = U_TEXTUAL; // shared predicate (upc_common), kept as a local alias
const CTX = 90; // codepoints of context on each side

export function buildModel(loaded) {
  const repById = new Map();
  for (const r of loaded.representations) repById.set(r.obj.representation_id, r);
  const srcById = new Map();
  for (const s of loaded.sources) if (s.obj) srcById.set(s.obj.source_id, s);

  // resolve a representation_ref to its record, for the §05 trust-boundary test
  const lookupRep = (id) => { const r = repById.get(id); return r ? r.obj : null; };

  let failCount = 0, hashFailCount = 0;

  // representation hash status (hop A)
  const repStatus = new Map();
  for (const r of loaded.representations) {
    let ok = null;
    if (r.contained && fs.existsSync(r.abs)) ok = getRepFile(r.abs).sha256 === bareHash(r.obj.sha256);
    if (ok === false) hashFailCount++;
    repStatus.set(r.obj.representation_id, ok);
  }

  // Codes (spec/12). A code is a JUDGEMENT, so it travels with its coder and its
  // definition: §09 forbids showing one without the other, and forbids a surface
  // resolving a disagreement on the reader's behalf.
  const cbkById = new Map((loaded.codebooks || []).map((c) => [c.obj.codebook_id, c.obj]));
  const codebooks = (loaded.codebooks || []).map((c) => ({
    id: c.obj.codebook_id, namespace: c.obj.namespace, slug: c.obj.slug,
    title: c.obj.title || c.obj.slug, question: c.obj.question || "",
    closed: c.obj.closed !== false, unit: c.obj.unit || "", multi_label: c.obj.multi_label === true,
    codes: (c.obj.codes || []).map((cd) => ({
      code: cd.code, label: cd.label || cd.code, definition: cd.definition || "",
      parent: cd.parent || null, deprecated: !!cd.deprecated,
    })),
  }));
  const coderKind = new Map();
  for (const cs of loaded.codingSets || []) {
    for (const c of cs.obj.coders || []) if (c && c.coder) coderKind.set(c.coder, c.kind || "");
  }
  const codingsByTarget = new Map();
  for (const c of loaded.codings || []) {
    const o = c.obj, t = o.target || {};
    if (!t.id) continue;
    const cbk = cbkById.get(o.codebook_ref);
    const cd = cbk && (cbk.codes || []).find((x) => x && x.code === o.code);
    const rec = {
      id: o.coding_id, codebook_ref: o.codebook_ref,
      codebook_title: cbk ? (cbk.title || cbk.slug) : o.codebook_ref,
      code: o.code || "", value: o.value || "",
      label: cd ? (cd.label || cd.code) : (o.code || ""),
      definition: cd ? (cd.definition || "") : "",
      open: !!(cbk && cbk.closed === false),
      coder: o.coder || "", coder_kind: coderKind.get(o.coder) || "",
      status: o.status || "active", confidence: o.confidence || "", rationale: o.rationale || "",
      target_kind: t.kind || "",
    };
    if (!codingsByTarget.has(t.id)) codingsByTarget.set(t.id, []);
    codingsByTarget.get(t.id).push(rec);
  }
  const codingsFor = (id) => codingsByTarget.get(id) || [];

  const extractions = loaded.extractions.map((e) => {
    const o = e.obj;
    const rep = repById.get(o.representation_ref);
    const src = srcById.get(o.source_id);
    let badge = "unverifiable", contextBefore = "", contextAfter = "", shownQuote = o.direct_quote || "", actualSpan = null, verified = false;
    if (o.direct_quote == null) {
      badge = "paraphrase";
    } else if (rep && rep.contained && fs.existsSync(rep.abs) && TEXTUAL(rep.obj.media_type) && o.locator && o.locator.type === "char_range") {
      const repRec = getRepFile(rep.abs);
      const res = verifyHopB(o, repRec);
      if (res.ok) {
        verified = true;
        badge = isDerivedText(rep.obj, lookupRep)
          ? "verified-to-transcript"
          : isModelRewrittenText(rep.obj, lookupRep) ? "verified-to-rewrite" : "verified";
        const v = o.locator.value;
        const len = repRec.cps.length;
        contextBefore = repRec.cps.slice(Math.max(0, v.start - CTX), v.start).join("");
        contextAfter = repRec.cps.slice(v.end, Math.min(len, v.end + CTX)).join("");
      } else {
        badge = "failed"; failCount++;
        // reveal drift: show what is ACTUALLY at the recorded offsets
        if (repRec.cps && o.locator.value && Number.isInteger(o.locator.value.start)) {
          const v = o.locator.value;
          actualSpan = repRec.cps.slice(v.start, Math.min(repRec.cps.length, v.end)).join("");
          contextBefore = repRec.cps.slice(Math.max(0, v.start - CTX), v.start).join("");
          contextAfter = repRec.cps.slice(Math.min(repRec.cps.length, v.end), Math.min(repRec.cps.length, v.end + CTX)).join("");
        }
      }
    }
    // Presentation anchors: the primary locator plus every secondary, resolved
    // at BUILD time against the bytes (spec/09: context comes from the
    // representation, never from the record). `context` is dropped because the
    // verified reader above already carries it.
    const slim = (r, isPrimary) => {
      const { context, ...rest } = r;
      rest.primary = !!isPrimary;
      if (!isPrimary) rest.advisory = true;
      return rest;
    };
    const anchors = [slim(resolveLocator(loaded, o.locator, { context: 0 }), true)];
    for (const sec of o.secondary_locators || []) {
      const r = slim(resolveLocator(loaded, sec, { context: 0 }), false);
      if (sec && sec.representation_ref && sec.representation_ref !== o.representation_ref) r.cross_representation = true;
      anchors.push(r);
    }
    let lineRange = null;
    if (o.locator && o.locator.type === "char_range" && rep && rep.contained && fs.existsSync(rep.abs)) {
      const rr = getRepFile(rep.abs);
      if (rr.utf8ok && o.locator.value && Number.isInteger(o.locator.value.start)) {
        lineRange = lineRangeForCharRange(rr.text, o.locator.value.start, o.locator.value.end);
      }
    }
    return {
      id: o.extraction_id, source_id: o.source_id, source_title: src ? (src.obj.title || (src.obj.bibliographic && src.obj.bibliographic.title) || o.source_id) : o.source_id,
      representation_ref: o.representation_ref, type: o.type, status: o.status || "active",
      rep_role: rep ? rep.obj.role : "", rep_path: rep ? rep.obj.path : "",
      quote: shownQuote, text: o.text || "", paraphrase: o.direct_quote == null,
      badge, verified, contextBefore, contextAfter, actualSpan,
      locator: o.locator, lineRange, anchors,
      query: o.query || "", interpretation: o.interpretation || "", confidence: o.confidence || "", confidence_score: o.confidence_score,
      codings: codingsFor(o.extraction_id),
    };
  });

  const sources = loaded.sources.filter((s) => s.obj).map((s) => {
    const o = s.obj, bib = o.bibliographic || {};
    return {
      id: o.source_id, title: o.title || bib.title || o.source_id, kind: o.source_kind || "",
      item_type: bib.item_type || "", authors: (bib.authors || []).map((a) => a.literal || [a.family, a.given].filter(Boolean).join(" ")).join(", "),
      year: dateYear(bib.issued), url: (o.retrieval && o.retrieval.original_url) || bib.url || "",
      fetch_status: (o.retrieval && o.retrieval.fetch_status) || "", tags: o.tags || [], dir: s.dirRel,
      representations: (o.representations || []).map((r) => ({
        id: r.representation_id, role: r.role, media_type: r.media_type, path: r.path,
        hashOk: repStatus.get(r.representation_id),
        // structured image info (spec/05): the summary, the text flag, the frame
        description: r.description, ocr_text: r.ocr_text, caption: r.caption,
        has_text: r.has_text, dimensions: r.dimensions,
        parent_representation_ref: r.parent_representation_ref,
        isImage: /^image\//.test(r.media_type || ""),
      })),
      aliases: o.aliases || {}, provenance: o.provenance || {},
      codings: codingsFor(o.source_id),
    };
  });

  // --- Source viewer payload -------------------------------------------------
  // The in-page viewer shows the representation itself, so it needs the bytes.
  // fetch() is blocked on file:// (opaque origin), and an iframe of a text file
  // cannot be annotated cross-origin, so the text is embedded at BUILD time --
  // which is also what §09 already requires of the context reader: these are the
  // exact bytes the gate was run against, not a re-fetch that could have drifted.
  //
  // Budgeted, never truncated: a representation is embedded whole or not at all,
  // because half a document shown as if it were whole is exactly the kind of lie
  // this browser exists to prevent.
  const EMBED_MAX_REP = 512 * 1024;   // bytes, per representation
  const EMBED_BUDGET = 8 * 1024 * 1024; // bytes, whole corpus
  const targeted = new Set();
  for (const e of loaded.extractions) {
    const o = e.obj;
    if (o.locator && o.locator.representation_ref) targeted.add(o.locator.representation_ref);
    for (const sec of o.secondary_locators || []) if (sec && sec.representation_ref) targeted.add(sec.representation_ref);
  }
  let spent = 0, embedded = 0, skipped = 0;
  const reps = {};
  // Representations an extraction actually points into get the budget first.
  const ordered = loaded.representations.slice().sort((a, b) =>
    (targeted.has(b.obj.representation_id) ? 1 : 0) - (targeted.has(a.obj.representation_id) ? 1 : 0));
  for (const r of ordered) {
    const o = r.obj;
    const rec = {
      id: o.representation_id, role: o.role, media_type: o.media_type, path: o.path,
      isImage: /^image\//.test(o.media_type || ""), isPdf: o.media_type === "application/pdf",
      textual: TEXTUAL(o.media_type),
      hashOk: repStatus.get(o.representation_id),
    };
    if (o.dimensions) rec.dimensions = o.dimensions;
    if (o.description != null) rec.description = o.description;
    if (o.caption != null) rec.caption = o.caption;
    if (o.has_text != null) rec.has_text = o.has_text;
    if (o.page_count != null) rec.page_count = o.page_count;
    if (o.parent_representation_ref) rec.parent_representation_ref = o.parent_representation_ref;
    if (rec.textual && r.contained && fs.existsSync(r.abs)) {
      const size = fs.statSync(r.abs).size;
      if (size > EMBED_MAX_REP || spent + size > EMBED_BUDGET) { rec.tooLarge = true; skipped++; }
      else {
        const rr = getRepFile(r.abs);
        if (rr.utf8ok) { rec.text = rr.text; rec.lineCount = textLines(rr.text).length; spent += size; embedded++; }
        else rec.notUtf8 = true;
      }
    }
    reps[o.representation_id] = rec;
  }

  const generations = loaded.generations.map((g) => ({ id: g.obj.generation_id, type: g.obj.type, title: g.obj.title || g.obj.type, output: g.obj.output || {}, derived_from: (g.obj.provenance && g.obj.provenance.derived_from) || {}, provenance: g.obj.provenance || {} }));
  const syntheses = loaded.syntheses.map((y) => ({ id: y.obj.synthesis_id, type: y.obj.type, title: y.obj.title || y.obj.type, question: y.obj.question || "", claims: y.obj.claims || [], output: y.obj.output || {}, derived_from: (y.obj.provenance && y.obj.provenance.derived_from) || {} }));

  return {
    title: loaded.corpus.title || "UPC corpus", spec: loaded.corpus.upc_spec_version || "",
    counts: { sources: sources.length, representations: loaded.representations.length, extractions: extractions.length, generations: generations.length, syntheses: syntheses.length, codebooks: codebooks.length, codings: (loaded.codings || []).length },
    failCount, hashFailCount, sources, extractions, generations, syntheses, reps, codebooks,
    embed: { embedded, skipped, bytes: spent },
  };
}

function dateYear(d) {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 4);
  if (d.date_parts && d.date_parts[0]) return String(d.date_parts[0][0]);
  if (d.raw) return String(d.raw).slice(0, 4);
  return "";
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------
function renderHtml(model) {
  const json = JSON.stringify(model).replace(/\u003c/g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.title)} — UPC browser</title>
<style>${CSS}</style>
</head>
<body>
<script type="application/json" id="upc-data">${json}</script>
<header>
  <div class="brand"><span class="mark">◆</span> <b>${esc(model.title)}</b> <span class="spec">UPC ${esc(model.spec)}</span></div>
  <nav>
    <a href="#/overview" data-view="overview">Overview</a>
    <a href="#/sources" data-view="sources">Sources</a>
    <a href="#/evidence" data-view="evidence">Evidence</a>
    <a href="#/syntheses" data-view="syntheses">Syntheses</a>
  </nav>
  <button id="theme" title="Toggle theme">☾</button>
</header>
<div id="banner"></div>
<main id="app"></main>
<footer>Read-only projection of the structured objects. Regenerate with <code>upc regen</code>. Quotations verified byte-for-byte at build time (spec/03).</footer>
<script>${CLIENT}</script>
</body>
</html>
`;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSS = `
:root{--bg:#faf6f0;--panel:#fff;--ink:#2a2320;--muted:#7a6f66;--line:#e4d9cc;--copper:#a4552b;--ember:#c6712f;--ok:#2f7d4f;--bad:#b23b2e;--warn:#9a6a12;--chip:#f0e7db;--serif:"Iowan Old Style",Palatino,"EB Garamond",Georgia,serif;--mono:"SF Mono",ui-monospace,Menlo,Consolas,monospace}
:root[data-theme=dark],:root:not([data-theme=light]) @media (prefers-color-scheme:dark){}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#1b1613;--panel:#241d18;--ink:#ece3d8;--muted:#a99a8c;--line:#3a2f27;--copper:#d98a52;--ember:#e0975a;--chip:#2c231d}}
:root[data-theme=dark]{--bg:#1b1613;--panel:#241d18;--ink:#ece3d8;--muted:#a99a8c;--line:#3a2f27;--copper:#d98a52;--ember:#e0975a;--chip:#2c231d}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font-family:var(--serif);line-height:1.5}
header{display:flex;align-items:center;gap:20px;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5;flex-wrap:wrap}
.brand{font-size:18px}.mark{color:var(--copper)}.spec{color:var(--muted);font-size:12px;font-family:var(--mono)}
nav{display:flex;gap:4px;margin-left:auto}nav a{padding:6px 12px;border-radius:6px;text-decoration:none;color:var(--ink);font-size:14px}
nav a.active{background:var(--copper);color:#fff}nav a:hover{background:var(--chip)}
#theme{background:none;border:1px solid var(--line);border-radius:6px;color:var(--ink);cursor:pointer;padding:6px 10px}
main{max-width:1080px;margin:0 auto;padding:24px 20px}
footer{max-width:1080px;margin:0 auto;padding:24px 20px;color:var(--muted);font-size:12px}
#banner:not(:empty){max-width:1080px;margin:16px auto 0;padding:12px 16px;border-radius:8px;background:#fbe9e6;color:var(--bad);border:1px solid var(--bad);font-family:var(--mono);font-size:13px}
:root[data-theme=dark] #banner:not(:empty){background:#3a201c}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:8px 0 24px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}.tile b{font-size:28px;display:block;font-family:var(--mono)}.tile span{color:var(--muted);font-size:13px}
.layout{display:grid;grid-template-columns:320px 1fr;gap:20px}@media(max-width:820px){.layout{grid-template-columns:1fr}}
input.search{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font-family:var(--serif);margin-bottom:12px}
.list{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
.row{padding:11px 14px;border-bottom:1px solid var(--line);cursor:pointer}.row:last-child{border-bottom:0}.row:hover{background:var(--chip)}.row.sel{background:var(--chip);border-left:3px solid var(--copper)}
.row .t{font-weight:600}.row .m{color:var(--muted);font-size:12px;font-family:var(--mono)}
.detail{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px}
h1,h2,h3{font-weight:600}h2{margin-top:0}h3{color:var(--copper);font-size:14px;text-transform:uppercase;letter-spacing:.05em;margin:22px 0 8px}
.chip{display:inline-block;background:var(--chip);border-radius:20px;padding:2px 10px;font-size:12px;font-family:var(--mono);margin:2px 4px 2px 0}
.badge{display:inline-block;border-radius:6px;padding:1px 8px;font-size:11px;font-family:var(--mono);font-weight:600;white-space:nowrap}
.badge.verified{background:#e0f0e6;color:var(--ok)}.badge.failed{background:#fbe1de;color:var(--bad)}.badge.paraphrase{background:var(--chip);color:var(--muted)}.badge.unverifiable{background:#f3ecdd;color:var(--warn)}.badge.transcript{background:#eef0e0;color:var(--warn)}.badge.rewrite{background:#f0eae0;color:var(--warn)}
.code{display:inline-block;border:1px dashed var(--line);border-radius:10px;padding:1px 8px;margin:0 2px;font-size:12px;background:transparent}
.code.open{font-style:italic}
.coder{color:var(--muted);margin-right:10px;font-size:11px}
.codes{margin-top:8px}
.disagree{color:var(--warn);margin-top:4px}
:root[data-theme=dark] .badge.verified{background:#1e3a2a}:root[data-theme=dark] .badge.failed{background:#3a201c}
blockquote{margin:0;padding:12px 16px;border-left:3px solid var(--copper);background:var(--chip);border-radius:0 8px 8px 0;font-size:16px}
.reader{font-size:15px;line-height:1.7}.reader .ctx{color:var(--muted)}.reader mark{background:#f6e0b6;color:inherit;padding:0 2px;border-radius:3px}
:root[data-theme=dark] .reader mark{background:#5a4a1e}
.reader mark.bad{background:#f3b4ac}:root[data-theme=dark] .reader mark.bad{background:#5a2a24}
.para{padding:12px 16px;background:var(--chip);border-radius:8px;color:var(--muted);font-style:italic}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;cursor:pointer}
tr.clickable{cursor:pointer}tr.clickable:hover{background:var(--chip)}
a.link{color:var(--copper);text-decoration:none;cursor:pointer}a.link:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:.9em;background:var(--chip);padding:1px 5px;border-radius:4px}
.kv{display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:4px 12px;font-size:13px}.kv .k{color:var(--muted);font-family:var(--mono);overflow-wrap:anywhere}@media(max-width:560px){.kv{grid-template-columns:1fr;gap:0}.kv .k{margin-top:8px}}
.muted{color:var(--muted)}.mono{font-family:var(--mono)}.small{font-size:12px}
.figure{position:relative;display:inline-block;max-width:100%;margin:10px 0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel);line-height:0}
.figure img{display:block;max-width:100%;height:auto}
.region{position:absolute;border:2px solid var(--copper);background:rgba(184,115,51,.16);border-radius:2px;pointer-events:none;box-shadow:0 0 0 9999px rgba(0,0,0,.04)}
.trust{font-size:12px;color:var(--warn);background:#f3ecdd;border:1px solid #e2d4b4;border-radius:6px;padding:6px 10px;display:block;margin:8px 0;line-height:1.5}
:root[data-theme=dark] .trust{background:#3a3320;border-color:#5a4a1e}
.anchors{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px}
.anchor{display:inline-block;background:var(--chip);border-radius:6px;padding:2px 8px;font-size:11.5px;font-family:var(--mono)}
.anchor.adv{border:1px dashed var(--line)}
.figcap{line-height:1.5;font-size:12px;color:var(--muted);margin-top:4px}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,440px);gap:20px;align-items:start}
@media(max-width:1000px){.split{grid-template-columns:minmax(0,1fr)}.split .viewer{position:static;max-height:none}.split .vbody{max-height:60vh}}
.viewer{position:sticky;top:14px;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;max-height:calc(100vh - 28px)}
.viewer.inline{position:static;max-height:none;margin-top:10px}
.vhead{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--line);font-size:12px;flex-wrap:wrap}
.vhead .vt{font-family:var(--mono);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}
.vhead .sp{margin-left:auto}
.vbody{overflow:auto;flex:1;min-height:180px}
.viewer.inline .vbody{max-height:60vh}
.vempty{padding:20px;color:var(--muted);font-size:13px;line-height:1.6}
.srcline{display:flex;font-family:var(--mono);font-size:12.5px;line-height:1.65}
.srcline .n{flex:0 0 3.4em;text-align:right;padding:0 10px 0 6px;color:var(--muted);user-select:none;border-right:1px solid var(--line);background:var(--bg)}
.srcline .c{padding:0 10px;white-space:pre-wrap;overflow-wrap:anywhere;flex:1;min-width:0}
.srcline.hit{background:var(--chip)}
.srcline.hit .n{color:var(--copper);font-weight:600}
.vbody iframe{display:block;width:100%;height:62vh;border:0;background:#fff}
button.anchor{cursor:pointer;border:1px solid transparent;font:inherit;font-size:11.5px;font-family:var(--mono);color:inherit}
button.anchor:hover{border-color:var(--copper)}
button.anchor.on{background:var(--copper);color:#fff}
`;

const CLIENT = `
const DATA = JSON.parse(document.getElementById("upc-data").textContent);
const $ = (s,r=document)=>r.querySelector(s);
const el = (t,a={},...k)=>{const n=document.createElement(t);for(const[x,v]of Object.entries(a)){if(x==="class")n.className=v;else if(x==="html")n.innerHTML=v;else if(x.startsWith("on"))n.addEventListener(x.slice(2),v);else n.setAttribute(x,v);}for(const c of k.flat())n.append(c?.nodeType?c:document.createTextNode(c??""));return n;};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const BADGE=b=>'<span class="badge '+(b==="verified-to-transcript"?"transcript":b==="verified-to-rewrite"?"rewrite":b)+'">'+ (b==="verified"?"✓ verified":b==="failed"?"✗ gate failed":b==="verified-to-transcript"?"≈ to derived text":b==="verified-to-rewrite"?"≈ to AI-rewritten text":b==="paraphrase"?"paraphrase":"unverifiable")+'</span>';
const FRAG=a=>a&&a.fragment?a.fragment:"";
// A region overlay positioned in PERCENT of its reference frame, so it stays
// correct however the image is scaled (a pixel bbox is resolution-dependent).
function figureFor(a){
  const rep=a.representation||{}; const ref=a.reference||rep.dimensions;
  if(!rep.path) return null;
  const box=el("div",{class:"figure"});
  const attrs={src:rep.path,alt:rep.description||rep.caption||"figure"};
  // intrinsic dimensions up front: the box must exist before the bytes arrive,
  // otherwise a percent-positioned overlay has nothing to resolve against
  const d=rep.dimensions;
  if(d&&d.width>0&&d.height>0){attrs.width=d.width;attrs.height=d.height;}
  box.append(el("img",attrs));
  const b=a.bbox;
  if(ref&&ref.width>0&&ref.height>0&&Array.isArray(b)&&b.length===4){
    box.append(el("div",{class:"region",style:"left:"+(100*b[0]/ref.width)+"%;top:"+(100*b[1]/ref.height)+"%;width:"+(100*b[2]/ref.width)+"%;height:"+(100*b[3]/ref.height)+"%"}));
  }
  return box;
}
// The §05 trust boundary, stated wherever a region is drawn on an image.
function trustNote(a,badge){
  const verifiedTo=badge==="verified-to-transcript"?"verified to the derived text (OCR / transcript / extracted layer)":badge==="verified-to-rewrite"?"verified to a model-rewritten copy — the wording may differ from the source":badge==="verified"?"verified to the source text":"not gated";
  return el("div",{class:"trust",html:"<b>Recorded, not gated.</b> The quotation is "+esc(verifiedTo)+
    "; the region drawn on the image is an <i>inference</i> from that text back to the picture, not something UPC verifies (\u00a705)."});
}
function anchorChips(e){
  const wrap=el("div",{class:"anchors"});
  const seen=new Set();
  const once=k=>{if(seen.has(k))return false;seen.add(k);return true;};
  const chip=(label,repId,focus,key,adv)=>wrap.append(el("button",{
    class:"anchor"+(adv?" adv":""),"data-key":key,title:"Show this position in the source pane",
    onclick:()=>openSource(repId,focus,key)},label));
  (e.anchors||[]).forEach((a,i)=>{
    const key=e.id+":"+i;
    if(a.primary&&a.kind==="char_range"){
      const lr=e.lineRange,cr=a.char_range||{start:0,end:0};
      if(lr&&once("line:"+e.representation_ref+":"+lr.start+"-"+lr.end))
        chip(lr.start===lr.end?("line "+lr.start):("lines "+lr.start+"\u2013"+lr.end),
          e.representation_ref,{kind:"char_range",start:cr.start,end:cr.end,line:lr},key);
      return;
    }
    if(!a.resolved){wrap.append(el("span",{class:"anchor adv"},a.kind+" \u2014 "+(a.reason||"unresolved")));return;}
    if(a.kind==="page")chip("page "+a.page,a.representation_ref,{kind:"page",page:a.page},key,true);
    else if(a.kind==="bbox")chip("region "+(a.fragment||""),a.representation_ref,{kind:"bbox",bbox:a.bbox,reference:a.reference},key,true);
    else if(a.kind==="line_range"){const r=a.line_range||{};
      if(!once("line:"+a.representation_ref+":"+r.start+"-"+r.end))return;
      chip(r.start===r.end?("line "+r.start):("lines "+r.start+"\u2013"+r.end),
        a.representation_ref,{kind:"line_range",start:r.start,end:r.end},key,true);}
    else if(a.kind==="timestamp_range")wrap.append(el("span",{class:"anchor adv"},"time "+(a.fragment||"")));
    else if(a.value!=null)wrap.append(el("span",{class:"anchor adv"},a.kind+": "+String(a.value).slice(0,60)));
    if(a.cross_representation&&a.representation)wrap.append(el("span",{class:"anchor adv"},"\u2192 "+a.representation.role+" "+a.representation.id));
  });
  return wrap.childNodes.length?wrap:null;
}

// ---- Source viewer -------------------------------------------------------
// Shows the representation itself, in place. The bytes were embedded at build
// time (\u00a709: context comes from the representation, never from the record), so
// this works identically offline from file:// and served over http.
let VIEW=null;               // {repId, focus, key}
const VIEWERS=new Set();     // mounted viewer shells to repaint
const repOf=id=>(DATA.reps||{})[id];

function externalHref(r,focus){
  if(!r)return "#";
  if(r.isPdf&&focus&&focus.kind==="page")return r.path+"#page="+focus.page;
  if(focus&&focus.kind==="line_range")return r.path+"#line="+((focus.start||1)-1)+","+focus.end;
  if(focus&&focus.kind==="char_range"&&focus.line)return r.path+"#line="+((focus.line.start||1)-1)+","+focus.line.end;
  return r.path;
}
function viewerShell(inline){
  const head=el("div",{class:"vhead"}),body=el("div",{class:"vbody"});
  const box=el("div",{class:"viewer"+(inline?" inline":"")},head,body);
  box._head=head;box._body=body;VIEWERS.add(box);
  paintViewer(box);
  return box;
}
function openSource(repId,focus,key){
  VIEW={repId,focus,key:key||""};
  for(const b of [...VIEWERS]){if(b.isConnected)paintViewer(b);else VIEWERS.delete(b);}
  document.querySelectorAll("button.anchor").forEach(b=>b.classList.toggle("on",b.dataset.key===VIEW.key));
}
function paintViewer(box){
  const head=box._head,body=box._body;head.innerHTML="";body.innerHTML="";
  const r=VIEW&&repOf(VIEW.repId);
  if(!r){
    head.append(el("span",{class:"muted"},"Source"));
    body.append(el("div",{class:"vempty"},VIEW?("Representation "+VIEW.repId+" is not part of this corpus."):
      "Pick a position chip on any quotation \u2014 line, page, or region \u2014 and the source opens here, at that spot."));
    return;
  }
  const focus=VIEW.focus;
  head.append(el("span",{class:"muted"},"Source"),
    el("span",{class:"vt",title:r.path},r.path.split("/").pop()),
    el("span",{class:"chip"},r.role),
    el("a",{class:"link small sp",href:externalHref(r,focus),target:"_blank",rel:"noopener"},"open externally \u2197"));
  if(r.isPdf)return paintPdf(body,r,focus);
  if(r.isImage)return paintImage(body,r,focus);
  if(r.textual)return paintText(body,r,focus);
  body.append(el("div",{class:"vempty"},"No in-page view for "+r.media_type+"."));
}
function paintPdf(body,r,focus){
  const page=focus&&focus.kind==="page"?focus.page:1;
  body.append(el("iframe",{src:r.path+"#page="+page,title:r.path}));
  body.append(el("div",{class:"vempty",style:"padding:9px 12px;border-top:1px solid var(--line)"},
    "Page "+page+(r.page_count?" of "+r.page_count:"")+". A PDF page is a coarse, ungated position (\u00a705). "+
    "If nothing renders above, this browser has no inline PDF viewer \u2014 use \u201copen externally\u201d."));
}
function paintImage(body,r,focus){
  const a={representation:r,bbox:focus&&focus.kind==="bbox"?focus.bbox:null,reference:focus&&focus.reference};
  const fig=figureFor(a);
  if(fig)body.append(el("div",{style:"padding:12px"},fig));
  const meta=[];
  if(r.description)meta.push("Description: "+r.description);
  if(r.has_text===true)meta.push("Contains text: yes");
  if(meta.length)body.append(el("div",{class:"vempty",style:"padding:0 12px 12px"},meta.join(" \u00b7 ")));
}
function paintText(body,r,focus){
  if(r.tooLarge){body.append(el("div",{class:"vempty"},"This representation is too large to embed in the browser. Nothing is shown rather than a truncated document \u2014 use \u201copen externally\u201d."));return;}
  if(r.notUtf8){body.append(el("div",{class:"vempty"},"This representation is not valid UTF-8, so it has no text rendering."));return;}
  if(r.text==null){body.append(el("div",{class:"vempty"},"This representation was not embedded \u2014 use \u201copen externally\u201d."));return;}
  const cps=Array.from(r.text);
  const lines=[];let st=0;
  for(let i=0;i<cps.length;i++)if(cps[i]==="\\n"){lines.push([st,i]);st=i+1;}
  lines.push([st,cps.length]);
  if(lines.length>1&&lines[lines.length-1][0]===lines[lines.length-1][1])lines.pop();
  const hit=new Set();
  if(focus&&focus.kind==="line_range")for(let n=focus.start;n<=focus.end;n++)hit.add(n);
  if(focus&&focus.kind==="char_range")lines.forEach(([a,b],i)=>{if(b>focus.start&&a<focus.end)hit.add(i+1);});
  let first=null;
  const frag=document.createDocumentFragment();
  lines.forEach(([a,b],i)=>{
    const no=i+1,isHit=hit.has(no);
    const row=el("div",{class:"srcline"+(isHit?" hit":"")});
    row.append(el("span",{class:"n"},String(no)));
    const c=el("span",{class:"c"});
    if(focus&&focus.kind==="char_range"&&b>focus.start&&a<focus.end){
      const ms=Math.max(a,focus.start),me=Math.min(b,focus.end);
      c.append(document.createTextNode(cps.slice(a,ms).join("")));
      c.append(el("mark",{},cps.slice(ms,me).join("")));
      c.append(document.createTextNode(cps.slice(me,b).join("")));
    }else c.textContent=cps.slice(a,b).join("");
    row.append(c);
    if(isHit&&!first)first=row;
    frag.append(row);
  });
  body.append(frag);
  if(first)setTimeout(()=>{first.scrollIntoView({block:"center"});},0);
}

function banner(){const b=$("#banner");b.innerHTML="";const parts=[];if(DATA.failCount)parts.push(DATA.failCount+" quotation gate failure(s)");if(DATA.hashFailCount)parts.push(DATA.hashFailCount+" representation hash mismatch(es)");if(parts.length)b.textContent="⚠ "+parts.join(" · ")+" — this corpus does not verify. Run \`upc validate\`.";}

// Hash routing (\u00a709 deep links). Canonical form:
//   #/<view>/<arg>?q=<search>&sort=<key>&dir=<asc|desc>
// plus the shorthand #ex=<ext-id>, which addresses one extraction directly. The
// active search and sort ride in the hash so a filtered view is shareable.
function parseHash(){
  const raw=location.hash.replace(/^#/,"");
  const [pathPart,queryPart]=raw.split("?");
  const p=new URLSearchParams(queryPart||"");
  const state={q:p.get("q")||"",sort:p.get("sort")||"",dir:p.get("dir")==="desc"?"desc":"asc"};
  const ex=/^ex=(.+)$/.exec(pathPart);
  if(ex) return {view:"evidence",arg:decodeURIComponent(ex[1]),...state};
  const [view,...rest]=pathPart.replace(/^\\//,"").split("/");
  return {view:view||"overview",arg:decodeURIComponent(rest.join("/")||""),...state};
}
function buildHash(view,arg,st){
  const p=new URLSearchParams();
  if(st&&st.q)p.set("q",st.q);
  if(st&&st.sort){p.set("sort",st.sort);if(st.dir==="desc")p.set("dir","desc");}
  const qs=p.toString();
  return "#/"+view+(arg?"/"+encodeURIComponent(arg):"")+(qs?"?"+qs:"");
}
// A hash we write ourselves after re-rendering in place (typing, sorting) must
// not trigger a full re-route -- that would rebuild the DOM and drop focus.
let selfNav=false;
function syncHash(view,arg,st){
  const h=buildHash(view,arg,st);
  if(location.hash===h)return;
  selfNav=true;location.hash=h;
}
function go(view,arg,st){location.hash=buildHash(view,arg,st||{});}

function overview(){
  const c=DATA.counts;const tiles=[["sources",c.sources],["representations",c.representations],["extractions",c.extractions],["generations",c.generations],["syntheses",c.syntheses]];
  const vq=DATA.extractions.filter(e=>!e.paraphrase);const ok=vq.filter(e=>e.verified).length;
  const app=$("#app");app.innerHTML="";
  app.append(el("h2",{},"Overview"));
  const grid=el("div",{class:"tiles"});for(const[k,v]of tiles)grid.append(el("div",{class:"tile"},el("b",{},String(v)),el("span",{},k)));app.append(grid);
  app.append(el("div",{class:"detail"},
    el("h3",{},"Quotation integrity"),
    el("p",{html:vq.length? (ok+" of "+vq.length+" quotations verified byte-for-byte against their source. "+(DATA.failCount?'<b style="color:var(--bad)">'+DATA.failCount+" failed.</b>":"All good.")) : "No direct quotations in this corpus."}),
    el("p",{class:"small muted",html:"Every ✓ verified quote was compared codepoint-for-codepoint to the representation at its locator when this page was built."})));
}

function sources(sel,st){
  st=st||{q:""};
  const state={q:st.q||"",sort:st.sort||"",dir:st.dir||"asc"};
  const app=$("#app");app.innerHTML="";
  const wrap=el("div",{class:"layout"});
  const left=el("div",{});
  const search=el("input",{class:"search",placeholder:"Search sources…",value:state.q,
    oninput:()=>{state.q=search.value;syncHash("sources",sel,state);renderList();}});
  const list=el("div",{class:"list"});left.append(search,list);
  const right=el("div",{});wrap.append(left,right);app.append(wrap);
  function renderList(){list.innerHTML="";const ql=state.q.toLowerCase();let n=0;
    for(const s of DATA.sources){if(ql&&!(s.title+" "+s.authors+" "+s.url+" "+s.id).toLowerCase().includes(ql))continue;n++;
      list.append(el("div",{class:"row"+(s.id===sel?" sel":""),onclick:()=>go("sources",s.id,state)},el("div",{class:"t"},s.title),el("div",{class:"m"},[s.kind,s.year,s.id].filter(Boolean).join(" · "))));}
    if(!n)list.append(el("div",{class:"row muted"},"No sources match."));}
  renderList();
  const s=DATA.sources.find(x=>x.id===sel)||DATA.sources[0];
  if(!s){right.append(el("div",{class:"detail muted"},"No sources."));return;}
  const evs=DATA.extractions.filter(e=>e.source_id===s.id);
  const d=el("div",{class:"detail"});
  d.append(el("h2",{},s.title));
  const kv=el("div",{class:"kv"});
  const add=(k,v)=>{if(v)kv.append(el("div",{class:"k"},k),el("div",{},v));};
  add("id",s.id);add("kind",s.kind);add("authors",s.authors);add("year",s.year);add("item type",s.item_type);
  if(s.url)kv.append(el("div",{class:"k"},"url"),el("div",{},el("a",{class:"link",href:s.url,target:"_blank"},s.url)));
  for(const[ns,lid]of Object.entries(s.aliases||{}))add("alias:"+ns,lid);
  d.append(kv);
  d.append(el("h3",{},"Representations"));
  const rt=el("div",{});for(const r of s.representations){const badge=r.hashOk===false?' <span class="badge failed">✗ hash</span>':r.hashOk===true?' <span class="badge verified">✓ hash</span>':"";
    const row=el("div",{class:"small",html:'<code>'+esc(r.role)+'</code> <span class="muted mono">'+esc(r.id)+'</span>'+badge});
    row.insertBefore(el("button",{class:"anchor","data-key":"src:"+r.id,style:"margin-right:6px",
      title:"Show this representation in the pane below",onclick:()=>openSource(r.id,null,"src:"+r.id)},r.path.split("/").pop()),row.childNodes[1]||null);
    rt.append(row);
    // Images are first-class: show the picture and the three pieces it carries
    // (\u00a705) rather than only naming the file.
    if(r.isImage){
      rt.append(figureFor({representation:r}));
      const meta=[];
      if(r.description)meta.push("Description: "+r.description);
      if(r.has_text===true)meta.push("Contains text: yes \u2014 quotable via its ocr representation");
      else if(r.has_text===false)meta.push("Contains text: no");
      if(r.caption)meta.push("Caption: "+r.caption);
      if(r.dimensions&&r.dimensions.width)meta.push(r.dimensions.width+"\u00d7"+r.dimensions.height);
      if(meta.length)rt.append(el("div",{class:"figcap"},meta.join(" \u00b7 ")));
      if(r.ocr_text)rt.append(el("div",{class:"figcap"},"ocr_text (advisory, never quotable): \u201c"+r.ocr_text+"\u201d"));
    }}
  rt.append(viewerShell(true));
  d.append(rt);
  d.append(el("h3",{},"Evidence ("+evs.length+")"));
  for(const e of evs)d.append(evidenceCard(e));
  const citedBy=DATA.syntheses.filter(y=>(y.claims||[]).some(c=>(c.source_ids||[]).includes(s.id)));
  if(citedBy.length){d.append(el("h3",{},"Cited by syntheses"));for(const y of citedBy)d.append(el("div",{},el("a",{class:"link",onclick:()=>go("syntheses",y.id)},y.title)));}
  right.append(d);
}

// Codes are judgements, not gate results (§09): they get their own visual channel,
// they always name their coder, their definition is one hover away, and when two
// coders disagree BOTH are shown — the surface never picks a winner.
function codeChips(codings){
  const act=(codings||[]).filter(c=>c.status==="active");
  if(!act.length)return null;
  const wrap=el("div",{class:"codes"});
  const byBook=new Map();
  for(const c of act){if(!byBook.has(c.codebook_ref))byBook.set(c.codebook_ref,[]);byBook.get(c.codebook_ref).push(c);}
  for(const [,group] of byBook){
    const row=el("div",{style:"margin-top:6px"});
    row.append(el("span",{class:"small muted"},group[0].codebook_title+": "));
    const labels=new Set(group.map(c=>c.open?"value:"+c.value:"code:"+c.code));
    const coders=new Set(group.map(c=>c.coder));
    for(const c of group){
      const chip=el("span",{class:"code"+(c.open?" open":""),title:c.definition||(c.open?"Free-text label (open codebook) \u2014 not a quotation":"")},
        c.open?c.value:c.label);
      row.append(chip);
      row.append(el("span",{class:"coder small",title:c.coder_kind?("coder kind: "+c.coder_kind):""},c.coder));
      if(c.rationale)row.append(el("span",{class:"small muted"}," "+c.rationale));
    }
    if(labels.size>1&&coders.size>1)
      row.append(el("div",{class:"small disagree"},"\u26a0 Coders disagree \u2014 both judgements are shown; neither has been adjudicated."));
    wrap.append(row);
  }
  return wrap;
}

function evidenceCard(e){
  const c=el("div",{style:"margin:14px 0;padding-bottom:14px;border-bottom:1px solid var(--line)"});
  c.append(el("div",{html:BADGE(e.badge)+' <span class="chip">'+esc(e.type)+'</span>'+(e.status!=="active"?' <span class="chip">'+esc(e.status)+'</span>':"")+(e.confidence?' <span class="muted small">'+esc(e.confidence)+'</span>':"")}));
  if(e.paraphrase){c.append(el("div",{class:"para"},e.text||"(no text)"));c.append(el("div",{class:"small muted",html:e.type==="image_region"?"Ungated reading of an image region — a bbox can never carry a verified quotation (§05).":"Paraphrase — not a verbatim quotation, not gated."}));}
  else if(e.badge==="failed"){
    c.append(el("div",{class:"reader"},el("div",{class:"small",html:'<b style="color:var(--bad)">Stored quote does not match the source at its locator:</b>'}),
      el("blockquote",{style:"border-color:var(--bad)"},e.quote),
      el("div",{class:"small muted",style:"margin-top:8px"},"What the source actually says at those offsets:"),
      el("div",{class:"reader",html:'<span class="ctx">'+esc(e.contextBefore)+'</span><mark class="bad">'+esc(e.actualSpan||"")+'</mark><span class="ctx">'+esc(e.contextAfter)+'</span>'})));
  } else {
    c.append(el("div",{class:"reader",html:'<span class="ctx">'+esc(e.contextBefore)+'</span><mark>'+esc(e.quote)+'</mark><span class="ctx">'+esc(e.contextAfter)+'</span>'}));
    c.append(el("div",{class:"small muted mono",style:"margin-top:6px"},"context read from "+e.representation_ref+" at "+(e.locator&&e.locator.value?JSON.stringify(e.locator.value):"")));
  }
  // Cross-representation / region anchors: draw the picture with the region on
  // it, and say plainly what is and is not gated (\u00a705, \u00a709).
  for(const a of (e.anchors||[]).filter(a=>a.resolved&&a.kind==="bbox"&&a.representation&&a.representation.path)){
    const fig=figureFor(a);
    if(!fig)continue;
    c.append(fig);
    const rep=a.representation||{};
    const meta=[];
    if(rep.description)meta.push("Description: "+rep.description);
    if(rep.has_text===true)meta.push("Contains text: yes");
    else if(rep.has_text===false)meta.push("Contains text: no");
    if(a.reference&&a.reference.width)meta.push("frame "+a.reference.width+"\u00d7"+a.reference.height);
    if(meta.length)c.append(el("div",{class:"figcap"},meta.join(" \u00b7 ")));
    c.append(trustNote(a,e.badge));
  }
  const codes=codeChips(e.codings);
  if(codes)c.append(codes);
  const chips=anchorChips(e);
  if(chips)c.append(chips);
  if(e.query)c.append(el("div",{class:"small muted",style:"margin-top:6px"},"query: "+e.query));
  c.append(el("div",{class:"small mono muted"},e.id));
  return c;
}

const EV_COLS=[["badge","Status",e=>e.badge],["quote","Quote / text",e=>e.quote||e.text],["type","Type",e=>e.type],["source","Source",e=>e.source_title]];
function evidence(sel,st){
  st=st||{q:"",sort:"",dir:"asc"};
  const state={q:st.q||"",sort:st.sort||"",dir:st.dir||"asc"};
  const app=$("#app");app.innerHTML="";app.append(el("h2",{},"Evidence"));
  const search=el("input",{class:"search",placeholder:"Filter quotations…",value:state.q,
    oninput:()=>{state.q=search.value;syncHash("evidence",sel,state);draw();}});
  app.append(search);
  const holder=el("div",{});
  app.append(el("div",{class:"split"},holder,viewerShell(false)));
  function sortRows(rows){
    if(!state.sort)return rows;
    const col=EV_COLS.find(c=>c[0]===state.sort);if(!col)return rows;
    const k=col[2],sgn=state.dir==="desc"?-1:1;
    return rows.slice().sort((a,b)=>sgn*String(k(a)??"").localeCompare(String(k(b)??"")));
  }
  function toggleSort(key){
    if(state.sort===key)state.dir=state.dir==="asc"?"desc":"asc";else{state.sort=key;state.dir="asc";}
    syncHash("evidence",sel,state);draw();
  }
  function draw(){holder.innerHTML="";const ql=state.q.toLowerCase();
    const rows=sortRows(DATA.extractions.filter(e=>!ql||((e.quote+" "+e.text+" "+e.source_title+" "+e.query+" "+e.id).toLowerCase().includes(ql))));
    const hr=el("tr",{});
    for(const[key,label]of EV_COLS)hr.append(el("th",{title:"Sort by "+label,onclick:()=>toggleSort(key)},
      label+(state.sort===key?(state.dir==="asc"?" \u25b2":" \u25bc"):"")));
    const tbl=el("table",{},el("thead",{},hr));
    const tb=el("tbody",{});
    for(const e of rows){const tr=el("tr",{class:"clickable"+(e.id===sel?" sel":""),onclick:()=>go("evidence",e.id,state)},
      el("td",{html:BADGE(e.badge)}),
      el("td",{},el("div",{html:(e.paraphrase?'<span class="muted" style="font-style:italic">':'“')+esc((e.quote||e.text).slice(0,140))+(e.paraphrase?'</span>':'”')}),el("div",{class:"small mono muted"},e.id)),
      el("td",{},e.type),
      el("td",{},el("a",{class:"link",onclick:ev=>{ev.stopPropagation();go("sources",e.source_id)}},e.source_title)));
      tb.append(tr);if(e.id===sel){const c=el("tr",{},el("td",{colspan:4},evidenceCard(e)));tb.append(c);}}
    tbl.append(tb);holder.append(tbl);
    if(!rows.length)holder.append(el("div",{class:"detail muted"},"No extractions match \u201c"+state.q+"\u201d."));}
  draw();
  if(sel){const e=DATA.extractions.find(x=>x.id===sel);
    if(e){
      // selecting a quotation shows the source it was gated against
      const pa=(e.anchors||[]).find(a=>a.primary&&a.resolved);
      if(pa&&pa.kind==="char_range"){const cr=pa.char_range||{start:0,end:0};
        openSource(e.representation_ref,{kind:"char_range",start:cr.start,end:cr.end,line:e.lineRange},e.id+":0");}
      else if(pa)openSource(e.representation_ref,{kind:pa.kind,page:pa.page,bbox:pa.bbox,reference:pa.reference},e.id+":0");
      setTimeout(()=>{const s=document.querySelector("tr.sel");if(s)s.scrollIntoView({block:"center"});},0);
    }}
}

function syntheses(sel){
  const app=$("#app");app.innerHTML="";app.append(el("h2",{},"Syntheses"));
  if(!DATA.syntheses.length){app.append(el("div",{class:"detail muted"},"No syntheses."));return;}
  for(const y of DATA.syntheses){
    const d=el("div",{class:"detail",style:"margin-bottom:16px"});
    d.append(el("h3",{},y.title),y.question?el("p",{class:"muted"},y.question):"");
    for(const c of y.claims||[]){
      d.append(el("p",{},c.text));
      const line=el("div",{class:"small"});
      for(const xid of c.evidence_ids||[]){const e=DATA.extractions.find(x=>x.id===xid);line.append(el("a",{class:"link",onclick:()=>go("evidence",xid)},xid),e?el("span",{html:" "+BADGE(e.badge)+" "}):" ");}
      for(const sid of c.source_ids||[])line.append(el("a",{class:"link",onclick:()=>go("sources",sid)},sid)," ");
      d.append(line);
    }
    if(y.output&&y.output.path)d.append(el("div",{class:"small muted",style:"margin-top:8px",html:"output: <a class=link href='"+esc(y.output.path)+"' target=_blank>"+esc(y.output.path)+"</a>"}));
    app.append(d);
  }
}

function route(){const st=parseHash();document.querySelectorAll("nav a").forEach(a=>a.classList.toggle("active",a.dataset.view===st.view));
  ({overview,sources,evidence,syntheses}[st.view]||overview)(st.arg,st);window.scrollTo(0,0);}
window.addEventListener("hashchange",()=>{if(selfNav){selfNav=false;return;}route();});
$("#theme").addEventListener("click",()=>{const r=document.documentElement;const cur=r.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");const next=cur==="dark"?"light":"dark";r.setAttribute("data-theme",next);try{localStorage.setItem("upc-theme",next)}catch{}});
try{const t=localStorage.getItem("upc-theme");if(t)document.documentElement.setAttribute("data-theme",t)}catch{}
banner();route();
`;

// ---------------------------------------------------------------------------
export function buildIndexFile(dir) {
  const loaded = loadCorpus(dir);
  const model = buildModel(loaded);
  const html = renderHtml(model);
  const rel = (loaded.sections && loaded.sections.index_html) || "index.html";
  const abs = path.join(loaded.root, rel);
  atomicWriteFile(abs, html);
  return { status: "ok", wrote: rel, counts: model.counts, failures: model.failCount + model.hashFailCount };
}

const _isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (_isDirect) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write("usage: node build-index.mjs <corpus-dir>\n"); process.exit(2); }
  try { process.stdout.write(JSON.stringify(buildIndexFile(dir)) + "\n"); }
  catch (e) { process.stderr.write("build-index failed: " + e.message + "\n"); process.exit(1); }
}
