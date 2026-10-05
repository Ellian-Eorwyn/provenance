/**
 * The sentences around a passage — what a reader sees when they open a
 * quotation "In context" on the researcher-facing site (site.mjs).
 *
 * A reading copy extracted from a PDF has no paragraphs anyone can trust. Its
 * blank lines mark layout blocks: whole columns in one paper, every printed line
 * in another. Between the paragraphs sit captions, footnotes, running heads,
 * table cells and figure labels, and a heading is as often glued to the sentence
 * after it as set apart. So a window is built from sentences, not paragraphs:
 *
 *   1. The text is split into blocks and each is classified — prose, heading,
 *      caption, footnote, label, noise, or the end matter (references,
 *      acknowledgements…) — from its own shape alone.
 *   2. From the passage outwards, prose blocks are joined into one run, skipping
 *      captions, footnotes and figure debris, and stopping at a heading, the start
 *      of the article proper, the end matter, or a jump in the text (a sentence
 *      that ends, then a block that starts in lower case: something went missing).
 *   3. The run is split into sentences, with abbreviations, initials and section
 *      numbers in mind ("et al.", "F. W. Geels", "2.2.3").
 *   4. Whole sentences are added alternately before and after the passage until
 *      the next would pass the cap. A heading glued to a sentence ends the window
 *      on that side, and its words are left out; so does a footnote set inline
 *      ("34 In 2017 Volvo …"). A numbered list item ("2. The researchers found
 *      that …") is text, and does not.
 *   5. A window that opens or closes mid-sentence says so with "…".
 *
 * Nothing is rewritten. A window is a list of ranges of the stored text, shown
 * joined by a space with runs of white space collapsed, as a browser would show
 * them anyway; what is left out is left out whole (a caption, a footnote). The
 * passage itself is never cut or skipped, whatever its blocks look like.
 *
 * Offsets here are UTF-16 indices into the string, which is how a browser
 * indexes text; a record's locator counts codepoints (utf16Offsets converts).
 */

export const CONTEXT_CAP = 1600;   // characters in a window, the passage included

const TERMINAL = /[.!?]["'”’)\]]*$/;
const BOILERPLATE = new RegExp([
  String.raw`^(©|\(c\)\s*\d{4}|copyright\b)`, String.raw`creativecommons\.org`, String.raw`open access article`,
  String.raw`all rights reserved`, String.raw`published by elsevier`, String.raw`contents lists available`,
  String.raw`journal homepage`, String.raw`^received\b.*\d{4}`, String.raw`^accepted\b.*\d{4}`, String.raw`^available online`,
  String.raw`^article history`, String.raw`^jel\b`, String.raw`^e-?mail( address(es)?)?\s*:`,
  String.raw`^\*?\s*corresponding author`, String.raw`^(https?://|doi:|www\.)\S+$`, String.raw`^downloaded from`,
  String.raw`protected by copyright`, String.raw`^(source|sources|note|notes)\s*:`,
].join("|"), "i");
// Where the article proper begins. Nothing before it — title, authors,
// affiliations, highlights — belongs in a window.
const FRONT_MARK = /^(a\s?b\s?s\s?t\s?r\s?a\s?c\s?t|abstract|a\s?r\s?t\s?i\s?c\s?l\s?e\s+i\s?n\s?f\s?o|article info|highlights|keywords?)\b/i;
const AFFILIATION = /\b(university|universit[éàäi]|institute|department|faculty|school of|college of|laborator(y|ies))\b/i;
const CAPTION = /^(fig(ure)?s?\.?|table|tab\.|box|chart|exhibit|panel|scheme|map|plate|graph)\s*[a-z]?\d+[a-z]?(\.\d+)?\s*([.:|—–-]|\n|$)/i;
// "Table 1 Parameters of monocrystalline silicon solar cells [28-30]": a title on
// its own line, with no full stop (a sentence about a table has one).
const CAPTION_TITLE = /^(fig(ure)?s?\.?|table|tab\.)\s*[a-z]?\d+[a-z]?\s+\p{Lu}/iu;
// A caption as a sentence inside a block: "33 Figure 6: UK electricity…" (a footnote number first).
const CAPTION_SENTENCE = /^(\d{1,3}\s+)?((fig(ure)?s?\.?|table|tab\.)\s*[a-z]?\d+[a-z]?(\.\d+)?\s*[.:|—–]|(source|sources|note|notes)\s*:)/i;
const END_HEADING = /^(references|bibliography|works cited|literature cited|notes|endnotes|acknowledg(e)?ments?|appendix\b.*|supplementary (material|data)|declaration of competing interest|conflicts? of interest|funding|data availability|credit authorship contribution statement)\.?$/i;
// End matter whose heading is glued to its first words: "CRediT authorship
// contribution statement Vincenzo A. Rossi: Writing…", "7. Acknowledgements This work…".
const END_START = /^(\d{1,2}\.?\s+)?(credit authorship contribution statement|declaration of (competing|conflicting) interests?|data availability( statement)?|acknowledg(e)?ments?|conflicts? of interest|references|bibliography)\s+\p{Lu}/iu;
const SECTION_WORDS = "abstract|introduction|background|literature review|theory|theoretical framework|methods?|methodology|" +
  "materials and methods|data|data and methods|results|findings|discussion|conclusions?|concluding remarks|summary|" +
  "policy implications|limitations";
const SECTION_WORD = new RegExp(`^(\\d{1,2}(\\.\\d{1,2})*\\.?\\s+)?(${SECTION_WORDS})$`, "i");
const KNOWN_HEAD = new RegExp(`^(${SECTION_WORDS})[:.]?$`, "i");
const ENUMERATED = /^(\d{1,2}(\.\d{1,2})*\.?|[IVX]{1,4}\.|[A-Z]\.)\s+\p{Lu}/u;
// a short sentence that starts with a number: a heading, a footnote or a list item
const NUMBERED_HEAD = /^\d{1,2}(\.\d{1,2})*\.?\s+\p{Lu}[^]{0,90}$/u;
const FOOTNOTE = /^(\d{1,2}|[*†‡§¶])\s?\p{Lu}/u;

const FUNCTION_WORDS = new Set(("a an the and or but nor of to in on at by for with from as into onto than that which " +
  "who whom whose is are was were be been being has have had do does did not this these those its their our his her " +
  "such both either each per via between among over under about after before during while since").split(" "));
const ABBR = new Set(("al e.g i.e cf vs viz fig figs eq eqs no nos vol vols pp p ed eds dr mr mrs ms prof st inc ltd " +
  "co corp jr sr approx ca resp ref refs sect sec ch chap tab suppl jan feb mar apr jun jul aug sep sept oct nov dec " +
  "u.s u.k e.u a.m p.m n.b op cit ibid incl esp est dept univ assoc govt natl rev proc conf trans pt para fn nr").split(" "));
// Words that open sentences. An unnumbered heading glued to a sentence is found
// only where one of these follows it ("…landscape dimension In transition
// research"), so a name inside a sentence ("studies by Geels and others") is
// never taken for the start of one.
const OPENERS = new Set(("A An The This These That Those In On At As To For From With Within Without While Whereas " +
  "Although Though However Moreover Furthermore Since Because Unlike Despite Following Given Here There It Its Our We " +
  "Such Several Many Most Some One Two First Second Third Finally Recent Previous Prior Over After Before During " +
  "Through Across Among By Building Based Drawing Using Taking Overall Thus Hence Yet Both Each Every Few New Research " +
  "Studies Scholars").split(" "));

/** Codepoint offsets → UTF-16 offsets into the same string, which is how a
 *  browser indexes it. The identity unless the text holds characters outside
 *  the Basic Multilingual Plane, each of which is two UTF-16 units. */
export function utf16Offsets(text) {
  if (!/[\uD800-\uDFFF]/.test(text)) return (i) => i;
  const map = [0];
  let u = 0;
  for (const ch of text) { u += ch.length; map.push(u); }
  return (i) => map[i];
}

function lastToken(t) {
  const m = /(\S+?)[.!?]["'”’)\]]*$/.exec(t);
  return m ? m[1].replace(/^["'“‘(\[]+/, "").toLowerCase() : "";
}

/** Most of the longer words capitalised: "Stabilization, Institutionalization, and Addressing…". */
function titleCase(t) {
  const long = t.split(/\s+/).map((w) => w.replace(/^[^\p{L}]+/u, "")).filter((w) => w.length >= 4);
  return long.length >= 2 && long.filter((w) => /^\p{Lu}/u.test(w)).length >= 0.6 * long.length;
}

/** A numbered heading the sentence splitter left as a sentence of its own ("2.4. The
 *  Pace of Transitions: Acceleration.", "3.2.7. Other Table 13 reports …"), or a
 *  footnote pdftotext set inline ("34 In 2017 Volvo announced …"). Either ends the
 *  window. A numbered list item ("2. The researchers found that …") is part of the
 *  text, and does not. */
function numberedBreak(t) {
  if (!NUMBERED_HEAD.test(t)) return false;
  if (!/^\d{1,2}\.\s/.test(t)) return true;                // "34 In 2017 …", "2.4. The Pace …"
  const rest = t.slice(t.indexOf(" ") + 1);
  const fw = rest.split(/\s+/).filter((w) => FUNCTION_WORDS.has(w)).length;   // "The" doesn't count
  return !(fw >= 3 && TERMINAL.test(rest) && !/\d\.$/.test(rest) && !titleCase(rest));
}

/** Where sentences start in s, as indices. */
function sentenceStarts(s) {
  const starts = [];
  const re = /[.!?]["'”’)\]]*\s+(?=["'“‘(\[]?[\p{Lu}\p{N}])/gu;
  let m;
  while ((m = re.exec(s))) {
    const dot = m.index;
    let k = dot;
    while (k > 0 && !/\s/.test(s[k - 1])) k--;
    const tok = s.slice(k, dot).replace(/^["'“‘(\[]+/, "");
    if (s[dot] === ".") {
      if (ABBR.has(tok.toLowerCase())) continue;
      if (/^\p{L}$/u.test(tok)) continue;                   // an initial: "F. W. Geels"
      if (/^(\p{L}\.)+\p{L}$/u.test(tok)) continue;         // "U.S", "e.g"
      if (/^\d{1,2}(\.\d{1,2})*$/.test(tok)) {               // "3." just after a full stop: a section number
        let b = k - 1;
        while (b >= 0 && /\s/.test(s[b])) b--;
        if (b < 0 || /[.!?:]/.test(s[b])) continue;
      }
    }
    starts.push(m.index + m[0].length);
  }
  const bullet = /(^|\s)[•▪◦●■]\s/g;
  while ((m = bullet.exec(s))) starts.push(m.index + m[1].length);
  return [...new Set(starts)].sort((x, y) => x - y);
}

/** A heading glued to the start of a sentence ("4.1. Politics and power To
 *  elaborate…", "Introduction Early work…"): how many characters it takes, or 0. */
function gluedHeading(s) {
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(s)) && words.length < 16) words.push({ w: m[0], at: m.index });
  if (words.length < 3) return 0;
  const num = /^\d{1,2}(\.\d{1,2})*\.?$/.test(words[0].w) ? 1 : 0;
  for (const n of [2, 1]) {
    const head = words.slice(num, num + n).map((x) => x.w).join(" ");
    const next = words[num + n];
    if (next && KNOWN_HEAD.test(head) && /^\p{Lu}/u.test(next.w)) {
      // "Results Low-carbon technology adoption In our sample…": a sub-heading may follow
      return next.at + gluedHeading(s.slice(next.at));
    }
  }
  // Where the sentence really starts: a capitalised word straight after a
  // lower-case one, with no full stop between, followed by a lower-case word.
  // Numbered headings take any such word ("…regimes A neo-Gramscian", "…power To
  // elaborate"; never an acronym: "…mass EV adoption"); unnumbered ones only a
  // word that opens sentences (OPENERS) or one ending in -ing ("…behaviour exists
  // Adding to the complexity").
  // A numbered heading can hold lower-case words itself ("2.5. Tensions between
  // Depth and Speed of Transitions."), so its split must leave a sentence, not
  // more title case.
  const sentence = (i) => !titleCase(words.slice(i, i + 6).map((x) => x.w).join(" "));
  for (let i = num + 1; i < Math.min(words.length - 1, num + 13); i++) {
    const p = words[i - 1].w, w = words[i].w, nx = words[i + 1].w;
    if (/[.;!?]$/.test(p) || /\.\S/.test(p)) return 0;
    if (!/^\p{Ll}/u.test(nx)) continue;
    // a numbered heading in title case: "6.2 Policy and Market Implications Although the…"
    if (num && OPENERS.has(w) && /^\p{Lu}/u.test(p) && sentence(i)) return words[i].at;
    if (!/^\p{Ll}/u.test(p)) continue;
    if (num ? /^(\p{Lu}\p{Ll}|[AI]$)/u.test(w) && sentence(i) : (OPENERS.has(w) || /^\p{Lu}\p{Ll}+ing$/u.test(w))) return words[i].at;
  }
  return 0;
}

/**
 * The text's blocks, split at blank lines, each with what it is. Compute it once
 * per text and pass it to every contextWindow() call on that text.
 */
export function textBlocks(text) {
  const out = [];
  const re = /\n[ \t]*\n\s*/g;
  let from = 0, m;
  const push = (a, b) => {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a) out.push({ a, b });
  };
  while ((m = re.exec(text))) { push(from, m.index); from = m.index + m[0].length; }
  push(from, text.length);

  let prevProseMid = false, prev = null;   // the last prose block ended mid-sentence
  for (const blk of out) {
    const raw = text.slice(blk.a, blk.b);
    const t = raw.replace(/\s+/g, " ");
    const letters = (t.match(/\p{L}/gu) || []).length;
    const ends = TERMINAL.test(t) && !ABBR.has(lastToken(t));
    const hasFunctionWord = t.split(/[^\p{L}]+/u).some((w) => FUNCTION_WORDS.has(w));
    let kind;
    if (letters < 3 || (letters / t.length < 0.4 && !ends)) kind = "noise";        // numbers, axes, table rows
    else if ((t.length < 100 && FRONT_MARK.test(t)) || (/^keywords?\b/i.test(t) && t.length < 600)) kind = "heading";
    else if (BOILERPLATE.test(t)) kind = "noise";
    else if (!ends && t.length < 400 && AFFILIATION.test(t)) kind = "noise";
    else if (CAPTION.test(raw)) kind = "caption";
    else if (prev && prev.kind === "caption" && !prev.ends && /^\p{Ll}/u.test(t) && t.length < 200) kind = "caption";
    else if (END_HEADING.test(t) || END_START.test(t)) kind = "end";
    else if (CAPTION_TITLE.test(t) && !ends && t.length < 200) kind = "caption";
    else if (t.length < 100 && !ends && (SECTION_WORD.test(t) || ENUMERATED.test(t))) kind = "heading";
    else if (t.length < 100 && /^\d{1,2}(\.\d{1,2})+\.?\s+\p{Lu}/u.test(t)) kind = "heading";   // "4.1.2. Charging … adoption."
    else if (FOOTNOTE.test(t) && t.length < 600 && (ends || /https?:\/\//.test(t)) &&
             !/^\d{1,2}\s+\p{Lu}\p{Ll}+\s+(19|20)\d\d/u.test(t)) kind = "footnote";
    // Table cells and figure labels: unfinished, without a single "the", "of",
    // "is"… After an unfinished sentence only the short ones ("Markets, user
    // preferences"): a line of a line-per-block text runs on without one now and
    // then ("studies (e.g., Centola et al., 2018) use simple abstract theories like").
    else if (!ends && t.length < (prevProseMid ? 40 : 200) && !hasFunctionWord) kind = "label";
    else if (prevProseMid) kind = "prose";
    else if (t.length < 120 && !ends && titleCase(t)) kind = "heading";
    else if (t.length < 60 && !/[.!?:;,]["'”’)\]]*$/.test(t)) kind = "label";
    else kind = "prose";
    blk.kind = kind;
    blk.ends = ends;
    blk.lower = /^\p{Ll}/u.test(t);
    if (kind === "prose") prevProseMid = !ends;
    else if (kind === "heading" || kind === "end") prevProseMid = false;
    prev = blk;
  }

  // Headings glued to a paragraph. At its start ("3. Hegemony and socio-technical
  // regimes A neo-Gramscian…"), a new section begins there. At its end, after the
  // last full stop and before prose that starts with a capital ("…stall niche
  // innovations. Stabilization, Institutionalization, and Addressing Unintended
  // Consequences"), the section ends before it. A caption left at a paragraph's
  // end ("…political will. 33 Figure 6: UK electricity…") is cut off, and the
  // paragraph carries on in the next block.
  out.forEach((blk, i) => {
    if (blk.kind !== "prose") return;
    const raw = text.slice(blk.a, blk.b);
    blk.headLead = gluedHeading(raw);
    // A section number left at a paragraph's end, its title the next block
    // ("…Sidi Bel Abès (Algeria). 4.2.3" + "Local project implementation").
    const num = /(^|[.!?]["'”’)\]]*\s+)(\d{1,2}\.(\d{1,2}\.?)*)$/.exec(raw);
    const after = out[i + 1];
    if (num && after && (after.kind === "label" || after.kind === "heading")) {
      blk.cut = blk.a + num.index + num[1].length;
      blk.cutKind = "heading";
      blk.ends = TERMINAL.test(text.slice(blk.a, blk.cut).trim());
      after.kind = "heading";
      return;
    }
    let next = null;      // the next prose: a caption or footnote between them is not what follows
    for (let k = i + 1; k < out.length; k++) {
      const kd = out[k].kind;
      if (kd === "prose" || kd === "heading" || kd === "end") { next = out[k]; break; }
    }
    if (blk.ends || !next || next.lower) return;
    const starts = sentenceStarts(raw);
    if (!starts.length) return;
    const last = starts[starts.length - 1];
    const frag = raw.slice(last).replace(/\s+/g, " ").trim();
    if (CAPTION_SENTENCE.test(frag) && frag.length <= 400) {
      blk.cut = blk.a + last;
      blk.cutKind = "caption";
      blk.ends = TERMINAL.test(raw.slice(0, last).trim());
      return;
    }
    // Only after a paragraph-length block (one line of a line-per-block text is
    // not one), only words that start with a capital and end with a letter, not a
    // word like "the" or "by", and only before a block that starts with a capital.
    const lastWord = (/(\p{L}+)$/u.exec(frag) || [, ""])[1].toLowerCase();
    if (raw.length >= 200 && frag.length <= 100 && frag.split(" ").length >= 2 && /^[\p{Lu}\d]/u.test(frag) &&
        lastWord && !FUNCTION_WORDS.has(lastWord) && /^\p{Lu}/u.test(text.slice(next.a, next.a + 1))) {
      blk.cut = blk.a + last;
      blk.cutKind = "heading";
    }
  });
  return out;
}

/**
 * The whole sentences around the passage at [qa, qb) — UTF-16 indices into text —
 * at most `cap` characters with the passage. Returns {segs, lead, tail}: the
 * ranges of the text to show, in order, joined by a space; and whether the
 * window opens or closes mid-sentence. Null for an empty or impossible range.
 */
export function contextWindow(text, qa, qb, { cap = CONTEXT_CAP, blocks = null } = {}) {
  blocks = blocks || textBlocks(text);
  if (!blocks.length || !(qa < qb) || qb > text.length) return null;
  const lo = qa - 2 * cap, hi = qb + 2 * cap;
  const i0 = blocks.findIndex((b) => b.b > qa);
  if (i0 < 0) return null;
  let i1 = i0;
  while (i1 + 1 < blocks.length && blocks[i1 + 1].a < qb) i1++;

  // The run of prose the window may draw on: the passage's own blocks, whatever
  // they look like, then prose either side.
  const end = (b) => (b.cut && b.cut > b.a ? b.cut : b.b);
  const pieces = [];
  for (let i = i0; i <= i1; i++) {
    pieces.push({ a: blocks[i].a, b: i === i1 ? Math.max(end(blocks[i]), qb) : blocks[i].b, blk: blocks[i] });
  }
  pieces[0].a = Math.min(pieces[0].a, qa);
  let startTrue = true, endTrue = true;    // false: the run was cut short for length, mid-sentence perhaps
  for (let i = i0 - 1; ; i--) {
    const first = pieces[0];
    if (first.a <= lo) { first.a = Math.max(first.a, lo); startTrue = false; break; }
    if (i < 0 || first.blk.headLead) break;
    const b = blocks[i];
    if (b.kind === "heading" || b.kind === "end") break;
    if (b.kind !== "prose") continue;
    if (b.cutKind === "heading") break;
    if (b.ends && first.blk.lower) break;
    pieces.unshift({ a: b.a, b: end(b), blk: b });
  }
  for (let i = i1 + 1; ; i++) {
    const last = pieces[pieces.length - 1];
    if (last.b >= hi) { last.b = Math.min(last.b, hi); endTrue = false; break; }
    if (i >= blocks.length || last.blk.cutKind === "heading") break;
    const b = blocks[i];
    if (b.kind === "heading" || b.kind === "end") break;
    if (b.kind !== "prose") continue;
    if (b.headLead) break;
    if (last.blk.ends && b.lower) break;
    pieces.push({ a: b.a, b: end(b), blk: b });
  }

  // V: the run as one string, its pieces joined by a space; its sentences.
  let V = "";
  const at = [];
  for (const p of pieces) { if (V) V += " "; at.push(V.length); V += text.slice(p.a, p.b); }
  const toV = (x) => {
    for (let k = pieces.length - 1; k >= 0; k--) if (x >= pieces[k].a) return at[k] + Math.min(x, pieces[k].b) - pieces[k].a;
    return 0;
  };
  const qaV = toV(qa), qbV = toV(qb);
  const bounds = [0, ...sentenceStarts(V).filter((x) => x > 0 && x < V.length), V.length];
  const n = bounds.length - 1;
  const whole = (k) => !((k === 0 && !startTrue) || (k === n - 1 && !endTrue));
  const sent = (k) => V.slice(bounds[k], bounds[k + 1]);
  const size = (a, b) => V.slice(a, b).replace(/\s+/g, " ").trim().length;
  let s0 = 0;
  while (s0 + 1 < n && bounds[s0 + 1] <= qaV) s0++;
  let s1 = s0;
  while (s1 + 1 < n && bounds[s1 + 1] < qbV) s1++;

  let spans = [[bounds[s0], bounds[s1 + 1]]];      // the window, as ranges of V
  let lead = !whole(s0), tail = !whole(s1);
  const total = () => spans.reduce((t, [a, b]) => t + size(a, b) + 1, -1);
  if (total() > cap) {
    // The passage's own sentences are longer than the cap: as much of them as fits, centred.
    const [ws, we] = spans[0];
    const pad = Math.max(0, Math.floor((cap - (qbV - qaV)) / 2));
    let a = Math.max(ws, qaV - pad), b = Math.min(we, qbV + pad);
    while (a > ws && a < qaV && !/\s/.test(V[a - 1])) a++;
    while (b < we && b > qbV && !/\s/.test(V[b])) b--;
    if (a > ws) lead = true;
    if (b < we) tail = true;
    spans = [[a, b]];
  } else {
    let g0 = gluedHeading(sent(s0));          // a heading glued to the passage's own first sentence
    if (g0 && bounds[s0] + g0 > qaV) g0 = 0;
    // Heading words left between there and a passage that starts a sentence:
    // "3.5. Critiques of the MLP and Proposals for Improvement 3.5.1. Critiques to MLP The MLP was…"
    const rest = V.slice(bounds[s0] + g0, qaV);
    if (/(^|\s)\d{1,2}(\.\d{1,2})*\.?\s/.test(rest) && /^\d{1,2}\./.test(V.slice(bounds[s0])) && /\p{L}{2}/u.test(rest) &&
        /^["'“‘(\[]?\p{Lu}/u.test(V.slice(qaV, qaV + 2)) && rest.length <= 160) g0 = qaV - bounds[s0];
    if (g0) spans[0][0] = bounds[s0] + g0;
    let pk = s0 - 1, nk = s1 + 1, back = !g0, fwd = true, turn = 0;
    while (back || fwd) {
      if (back && (turn % 2 === 0 || !fwd)) {
        if (pk < 0 || !whole(pk)) { back = false; continue; }
        const s = sent(pk);
        if (CAPTION_SENTENCE.test(s)) { pk--; continue; }
        const g = gluedHeading(s);
        if (!g && numberedBreak(s.trim())) { back = false; continue; }      // the section starts after it
        const from = bounds[pk] + g;
        if (size(from, bounds[pk + 1]) + 1 + total() > cap) { back = false; continue; }
        spans.unshift([from, bounds[pk + 1]]);
        pk--;
        if (g) back = false;                                              // the section starts here
      } else {
        if (nk > n - 1 || !whole(nk)) { fwd = false; turn++; continue; }
        const s = sent(nk);
        if (CAPTION_SENTENCE.test(s)) { nk++; continue; }
        const t = s.trim();
        if (gluedHeading(s) || END_START.test(t) || numberedBreak(t)) { fwd = false; turn++; continue; }   // the next section
        if (size(bounds[nk], bounds[nk + 1]) + 1 + total() > cap) { fwd = false; turn++; continue; }
        spans.push([bounds[nk], bounds[nk + 1]]);
        nk++;
      }
      turn++;
    }
  }

  // Back to ranges of the text: touching spans merged, trailing space trimmed.
  const merged = [];
  for (const [a, b] of spans) {
    if (merged.length && merged[merged.length - 1][1] === a) merged[merged.length - 1][1] = b;
    else merged.push([a, b]);
  }
  const segs = [];
  for (let [x0, y0] of merged) {
    while (y0 > x0 && /\s/.test(V[y0 - 1])) y0--;
    pieces.forEach((p, k) => {
      const va = at[k], vb = at[k] + (p.b - p.a);
      const x = Math.max(va, x0), y = Math.min(vb, y0);
      if (y > x) segs.push([p.a + (x - va), p.a + (y - va)]);
    });
  }
  // A window that opens in lower case, or closes without a full stop (the text
  // jumps elsewhere there: a page or column break), says so.
  if (segs.length) {
    const first = text.slice(segs[0][0], segs[0][1]).replace(/^["'“‘(\[]+/, "");
    const last = text.slice(segs[segs.length - 1][0], segs[segs.length - 1][1]);
    if (/^\p{Ll}/u.test(first)) lead = true;
    if (!/[.!?:;]["'”’)\]]*$/.test(last) && !/[.!?]["'”’]*\s*\([^()]*\)$/.test(last)) tail = true;
  }
  return { segs, lead, tail };
}

/**
 * The window as the reader sees it: one string, white space collapsed, "…" where
 * it opens or closes mid-sentence, and where the passage lies in it — [text,
 * from, to] in UTF-16 units. The browse engine in site.mjs builds the same
 * string from the same ranges in the browser (UPCB.windowText); a selftest holds
 * the two to it.
 */
export function windowText(text, win, qa, qb) {
  let out = "", qs = -1, qe = -1;
  win.segs.forEach(([a, b], k) => {
    if (k) out += " ";
    if (qs < 0 && qa >= a && qa <= b) qs = out.length + (qa - a);
    if (qe < 0 && qb >= a && qb <= b) qe = out.length + (qb - a);
    out += text.slice(a, b);
  });
  if (qs < 0 || qe < qs) return null;
  const norm = (s) => s.replace(/\s+/g, " ");
  let pre = norm(out.slice(0, qs)).replace(/^ /, "");
  const quote = norm(out.slice(qs, qe));
  let post = norm(out.slice(qe)).replace(/ $/, "");
  if (win.lead) pre = "…" + pre;
  if (win.tail) post += "…";
  return [pre + quote + post, pre.length, pre.length + quote.length];
}
