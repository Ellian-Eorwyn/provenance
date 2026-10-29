/**
 * A reading copy shown by its structure map (spec/02 "Structure", spec/09).
 *
 * A full-text XML's reading copy (xmltext.py) is plain text: headings marked
 * with "#", one block per paragraph, a table's rows as lines of cells joined by
 * " | ", a caption as "Fig. 1. …". Its structure map, a `metadata`
 * representation of type application/vnd.upc.structure+json whose parent is
 * that text, says what each block is: so a reader sees headings as headings,
 * tables as tables and captions as captions, with each paragraph's number in the
 * margin, without a byte of the text changing. The map is advisory: one that
 * does not fit its text is not used (and `upc validate` says so), and nothing
 * here touches a badge.
 *
 * One renderer serves three surfaces. readingHtml is plain ES5 over UTF-16
 * indices, so the folder site calls it at build time and the single-file site
 * and the corpus browser carry its source (READING_JS) and call it in the page.
 */

import { utf16Offsets } from "./context.mjs";

export { STRUCTURE_MEDIA_TYPE } from "./upc_common.mjs";
export const STRUCTURE_KINDS = new Set(["title", "heading", "paragraph", "keywords", "caption", "row", "table_note",
  "list_item", "formula", "box", "note", "reference"]);

/** A map checked against the text it maps (codepoints, as stored): every block
 *  inside the text, in order, with nothing but white space between blocks, its
 *  section one the map lists. -> { ok, problem, sections, blocks }. */
export function checkStructure(doc, cps) {
  const bad = (problem) => ({ ok: false, problem, sections: [], blocks: [] });
  if (!doc || typeof doc !== "object" || doc.upc_structure !== 1) return bad("not a structure map (upc_structure: 1)");
  if (!Array.isArray(doc.blocks) || !Array.isArray(doc.sections)) return bad("no blocks[] or sections[]");
  const n = cps.length;
  if (doc.chars != null && doc.chars !== n) return bad(`it maps ${doc.chars} characters; the text has ${n}`);
  let prev = 0;
  for (let i = 0; i < doc.blocks.length; i++) {
    const b = doc.blocks[i];
    const at = `block ${i}`;
    if (!b || !STRUCTURE_KINDS.has(b.kind)) return bad(`${at}: unknown kind ${b && b.kind}`);
    if (!Number.isInteger(b.c0) || !Number.isInteger(b.c1) || b.c0 < prev || b.c1 <= b.c0 || b.c1 > n) {
      return bad(`${at} covers characters ${b.c0}–${b.c1}: out of order or past the text's ${n}`);
    }
    for (let k = prev; k < b.c0; k++) {
      if (!/\s/.test(cps[k])) return bad(`${at}: text between blocks at character ${k}`);
    }
    if (b.s != null && !(Number.isInteger(b.s) && b.s >= 0 && b.s < doc.sections.length)) return bad(`${at}: no section ${b.s}`);
    if (b.cells != null) {
      if (!Array.isArray(b.cells)) return bad(`${at}: cells is not a list`);
      let c = b.c0;
      for (const cell of b.cells) {
        if (!Array.isArray(cell) || !(cell[0] >= c && cell[1] >= cell[0] && cell[1] <= b.c1)) return bad(`${at}: a cell outside its row`);
        c = cell[1];
      }
    }
    prev = b.c1;
  }
  return { ok: true, problem: "", sections: doc.sections, blocks: doc.blocks };
}

/** The same blocks in UTF-16 units (how a browser indexes a string), compact:
 *  [kind, a, b, section, ¶, label, table, head, cells]. */
export function blocksU16(text, blocks) {
  const u = utf16Offsets(text);
  return blocks.map((b) => [b.kind, u(b.c0), u(b.c1), b.s == null ? -1 : b.s, b.p || 0, b.label || "",
    b.t == null ? -1 : b.t, b.head ? 1 : 0, b.cells ? b.cells.map((c) => [u(c[0]), u(c[1])]) : 0]);
}

/** The sections a renderer needs: [label, title, has a heading in the text]. */
export function sectionsCompact(sections) {
  return sections.map((s) => [s.label || "", s.title || "", s.heading === false ? 0 : 1]);
}

/**
 * The reading copy as HTML, block by block, with passages marked.
 *   text    the reading copy (a string; offsets are UTF-16)
 *   blocks  blocksU16(); sections: sectionsCompact()
 *   marks   [{a, b, id?, bad?}] sorted by a; overlapping marks keep the first.
 *           The first piece of a mark carries id="t-<id>", later pieces data-for.
 *   esc     an HTML escaper (text and attributes)
 * Kept to ES5 so it runs as written inside a page (READING_JS).
 */
export function readingHtml(text, blocks, sections, marks, esc) {
  var kept = [], end = -1, i, k;
  for (i = 0; i < marks.length; i++) { if (marks[i].a >= end && marks[i].b > marks[i].a) { kept.push(marks[i]); end = marks[i].b; } }
  var mi = 0;
  function seg(x, y) {
    var out = "", at = x;
    while (mi < kept.length && kept[mi].b <= x) mi++;
    for (var j = mi; j < kept.length && kept[j].a < y; j++) {
      var m = kept[j], a = Math.max(m.a, x), b = Math.min(m.b, y);
      if (b <= a) continue;
      out += esc(text.slice(at, a));
      var name = m.id ? (a === m.a ? ' id="t-' + esc(m.id) + '"' : ' data-for="t-' + esc(m.id) + '"') : "";
      out += "<mark" + name + (m.bad ? ' style="background:var(--warn-soft)"' : "") + ">" + esc(text.slice(a, b)) + "</mark>";
      at = b;
    }
    return out + esc(text.slice(at, y));
  }
  var CLS = { title: "r-title", paragraph: "r-p", keywords: "r-kw", caption: "r-cap", table_note: "r-tnote",
    list_item: "r-li", formula: "r-f", box: "r-box", note: "r-note", reference: "r-ref" };
  var html = [], part = -1;
  for (i = 0; i < blocks.length; i++) {
    var bl = blocks[i], kind = bl[0], a0 = bl[1], b0 = bl[2], s = bl[3], sec = s >= 0 ? sections[s] : null;
    // A section whose heading the text leaves out (acknowledgements, a declaration) is named outside it.
    if (sec && !sec[2] && s !== part) {
      html.push('<div class="r-part" data-label="' + esc([sec[0], sec[1]].filter(Boolean).join(" ")) + '"></div>');
    }
    part = s;
    if (kind === "heading") {
      var hm = /^#+ /.exec(text.slice(a0, Math.min(b0, a0 + 8)));
      var lv = hm ? hm[0].length - 1 : 2;
      var h = Math.min(6, lv + 1);
      html.push("<h" + h + ' class="r-h">' + seg(a0 + (hm ? hm[0].length : 0), b0) + "</h" + h + ">");
    } else if (kind === "row") {
      var rows = [], t = bl[6];
      for (k = i; k < blocks.length && blocks[k][0] === "row" && blocks[k][6] === t; k++) {
        var r = blocks[k], cells = r[8] || [[r[1], r[2]]], tag = r[7] ? "th" : "td", tr = "";
        for (var c = 0; c < cells.length; c++) tr += "<" + tag + ">" + seg(cells[c][0], cells[c][1]) + "</" + tag + ">";
        rows.push("<tr>" + tr + "</tr>");
      }
      i = k - 1;
      html.push('<div class="r-table"><table>' + rows.join("") + "</table></div>");
    } else if (kind === "title") {
      html.push('<p class="r-title">' + seg(a0 + (text.slice(a0, a0 + 2) === "# " ? 2 : 0), b0) + "</p>");
    } else {
      var num = kind === "paragraph" && bl[4] ? ' data-p="' + bl[4] + '"' : "";
      html.push('<p class="' + (CLS[kind] || "r-p") + '"' + num + ">" + seg(a0, b0) + "</p>");
    }
  }
  return html.join("\n");
}

export const READING_JS = readingHtml.toString();

/** Styles for a structured reading copy; the page's own --muted, --line and
 *  --chip colours, so light and dark both work. */
export const READING_CSS = `
.reading.structured{padding-left:3.1rem}
.reading .r-title{font-size:1.15rem;font-weight:650;line-height:1.35;margin:.6rem 0 .8rem}
.reading .r-h{margin:1.2rem 0 .35rem;line-height:1.3}
.reading h2.r-h{font-size:1.12rem}.reading h3.r-h{font-size:1.04rem}.reading h4.r-h,.reading h5.r-h,.reading h6.r-h{font-size:.97rem}
.reading .r-p{position:relative}
.reading .r-p[data-p]::before{content:"¶" attr(data-p);position:absolute;left:-3rem;width:2.5rem;text-align:right;
  color:var(--muted);font-size:.72rem;font-variant-numeric:tabular-nums;user-select:none;-webkit-user-select:none;pointer-events:none}
.reading .r-cap{font-size:.88rem;border-left:3px solid var(--line);padding-left:.65rem}
.reading .r-table{overflow-x:auto;margin:.3rem 0 .6rem}
.reading .r-table table{border-collapse:collapse;font-size:.82rem;width:auto;max-width:none}
.reading .r-table td,.reading .r-table th{border:1px solid var(--line);padding:.18rem .45rem;vertical-align:top;text-align:left;position:static}
.reading .r-table th{background:var(--chip);font-weight:600}
.reading .r-tnote{font-size:.8rem;color:var(--muted)}
.reading .r-li{padding-left:1.3rem}
.reading .r-f{font-size:.86rem;overflow-x:auto}
.reading .r-kw{font-size:.88rem}
.reading .r-box{border-left:3px solid var(--line);background:var(--chip);padding:.3rem .65rem}
.reading .r-ref,.reading .r-note{font-size:.82rem;padding-left:1.3rem;text-indent:-1.3rem}
.reading .r-part::before{content:attr(data-label);display:block;margin-top:1.1rem;padding-top:.4rem;border-top:1px solid var(--line);
  font-size:.72rem;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);user-select:none;-webkit-user-select:none}
`;
