// UPC library self-test. Zero-dep unit checks for the correctness-critical
// helpers: JCS (RFC 8785), codepoint gates, URL normalization, slugs, markers.
// Run: node tests/selftest.mjs   (exit 0 = all pass)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  jcs, codepointLength, codepointSlice, decodeUtf8Strict, verifyHopB,
  canonicalUrl, slugify, slugifyWithCollision, checkFilename,
  parseQuoteMarkers, findUncitedQuotes, mintExtId, mintSrcId, computeInputDigest,
  writeCsv, parseCsv,
  loadCorpus, clearRepCache, sha256Hex, bareHash,
  charToLine, lineRangeForCharRange, textLines, resolveLocator, isTranscriptRole,
  isDerivedText, isTextualMedia,
} from "../skill/universal-provenance/scripts/upc_common.mjs";
import { buildRoCrateGraph, fragmentForLocator, selectorsForLocator, buildAnnotationTargets } from "../skill/universal-provenance/scripts/ro-crate.mjs";
import { buildModel as buildBrowserModel } from "../skill/universal-provenance/scripts/build-index.mjs";
import { buildProvGraph } from "../skill/universal-provenance/scripts/prov.mjs";
import { validateCorpus } from "../skill/universal-provenance/scripts/upc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = typeof got === "string" ? got : JSON.stringify(got);
  const w = typeof want === "string" ? want : JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); };
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL ${name}`); } };
const getRepFileForTest = (abs) => { const t = fs.readFileSync(abs, "utf8"); return { utf8ok: true, text: t, cps: Array.from(t) }; };

// --- JCS / RFC 8785 ---
eq("jcs empty object", jcs({}), "{}");
eq("jcs key sort", jcs({ b: 1, a: 2, c: 3 }), '{"a":2,"b":1,"c":3}');
eq("jcs nested sort", jcs({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
eq("jcs integers", jcs([0, -5, 42, 306]), "[0,-5,42,306]");
eq("jcs string escapes", jcs('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
eq("jcs unicode literal (café)", jcs("café"), '"café"');
eq("jcs astral literal (emoji)", jcs("\u{1F600}"), '"\u{1F600}"');
eq("jcs C1 not escaped", jcs(""), '""');
eq("jcs control escaped", jcs(""), '"\\u0001"');
// The UPC locator vector — what ext- identity actually hashes.
eq(
  "jcs locator canonical",
  jcs({ type: "char_range", value: { end: 306, start: 247 }, representation_ref: "rep-5e4a2d156536" }),
  '{"representation_ref":"rep-5e4a2d156536","type":"char_range","value":{"end":306,"start":247}}'
);
// RFC 8785 weird-key object: assert sorted key order + parse round-trip.
{
  const weird = {
    "€": "Euro", "\r": "CR", "\n": "NL", "1": "One", "": "Ctrl",
    "ö": "o-diaeresis", "➕": "plus", '"': "quote", "\\": "solidus", "\u{1F600}": "smiley",
  };
  const out = jcs(weird);
  // keys in UTF-16 code-unit order: \n \r " 1 \  ö € ➕ 😀
  const order = out.match(/"(?:[^"\\]|\\.)*":/g).map((s) => s);
  ok("jcs RFC weird first key is \\n", order[0] === '"\\n":');
  ok("jcs RFC weird second key is \\r", order[1] === '"\\r":');
  ok("jcs RFC round-trips", JSON.stringify(JSON.parse(out)) !== "" && JSON.parse(out)["1"] === "One");
}

// --- Codepoints & UTF-8 ---
eq("codepointLength astral", codepointLength("a\u{1F600}b"), 3);
eq("codepointSlice astral keeps emoji whole", codepointSlice("a\u{1F600}b", 0, 2), "a\u{1F600}");
ok("plain UTF-16 slice would break emoji", "a\u{1F600}b".slice(0, 2) !== "a\u{1F600}");
ok("NFC != NFD (gate is exact, no folding)", "café" !== "café");
eq("NFC length 4", codepointLength("café"), 4);
eq("NFD length 5", codepointLength("café"), 5);
ok("decodeUtf8Strict good", decodeUtf8Strict(Buffer.from("héllo", "utf8")).ok === true);
ok("decodeUtf8Strict rejects invalid", decodeUtf8Strict(Buffer.from([0xff, 0xfe, 0x00])).ok === false);

// --- Hop B gate ---
{
  const text = "For production sites, cut over DNS only after the staging copy is fully validated.";
  const cps = Array.from(text);
  const repRec = { utf8ok: true, text, cps, sha256: "x" };
  const good = { extraction_id: "ext-x", direct_quote: "cut over DNS only after the staging copy is fully validated",
    locator: { type: "char_range", value: { start: 22, end: 81 } } };
  eq("hopB pass", verifyHopB(good, repRec).ok, true);
  const drift = { extraction_id: "ext-x", direct_quote: good.direct_quote,
    locator: { type: "char_range", value: { start: 0, end: 10 } } };
  const dr = verifyHopB(drift, repRec);
  eq("hopB drift code", dr.code, "quote_gate_failed");
  ok("hopB drift gives reanchor hint", /reanchor/.test(dr.hint || ""));
  const fab = { extraction_id: "ext-x", direct_quote: "this text is nowhere in the representation at all",
    locator: { type: "char_range", value: { start: 0, end: 5 } } };
  eq("hopB fabricated code", verifyHopB(fab, repRec).code, "quote_gate_failed");
  const coarse = { extraction_id: "ext-x", direct_quote: "x", locator: { type: "section", value: "Intro" } };
  eq("hopB coarse locator rejected", verifyHopB(coarse, repRec).code, "quote_locator_missing");
  const oor = { extraction_id: "ext-x", direct_quote: "x", locator: { type: "char_range", value: { start: 0, end: 9999 } } };
  eq("hopB out-of-range", verifyHopB(oor, repRec).code, "locator_range_invalid");
  const badutf = { extraction_id: "ext-x", direct_quote: "x", locator: { type: "char_range", value: { start: 0, end: 1 } } };
  eq("hopB invalid utf8", verifyHopB(badutf, { utf8ok: false, text: null, cps: null }).code, "invalid_utf8");
}

// --- ext- id determinism ---
{
  const e = { source_id: "src-a1b2c3d4e5f6", representation_ref: "rep-5e4a2d156536",
    locator: { type: "char_range", representation_ref: "rep-5e4a2d156536", value: { start: 247, end: 306 } },
    direct_quote: "cut over DNS only after the staging copy is fully validated" };
  const id1 = mintExtId(e);
  // reordering locator keys / adding context must not change the id
  const e2 = { ...e, context_before: "x", locator: { value: { end: 306, start: 247 }, type: "char_range", representation_ref: "rep-5e4a2d156536" } };
  eq("ext id stable under locator key order + context", mintExtId(e2), id1);
  ok("ext id shape", /^ext-[0-9a-f]{12}$/.test(id1));
}

// --- src- id invariance to new source fields (identifiers[]/relations[]) ---
// The src- recipe reads only {canonicalUrl, primaryBytesSha256}; enrichment
// fields have no channel to reach it. Assert that structurally.
{
  const urlId = mintSrcId({ canonicalUrl: canonicalUrl("https://x.example/a") });
  const byteId = mintSrcId({ primaryBytesSha256: "sha256:" + "a".repeat(64) });
  // A source object gaining identifiers[]/relations[] cannot change either id:
  // the recipe never receives the source object, only the two named inputs.
  const enrich = {
    identifiers: [{ scheme: "doi", value: "10.1/x" }, { scheme: "x-foo", value: "y" }],
    relations: [{ type: "same_work_as", target: "https://x.example/a" }, { type: "supersedes", target: "src-000000000000" }],
  };
  eq("src id (url) invariant to identifiers/relations",
    mintSrcId({ canonicalUrl: canonicalUrl("https://x.example/a"), ...enrich }), urlId);
  eq("src id (bytes) invariant to identifiers/relations",
    mintSrcId({ primaryBytesSha256: "sha256:" + "a".repeat(64), ...enrich }), byteId);
  ok("src id shape", /^src-[0-9a-f]{12}$/.test(urlId) && /^src-[0-9a-f]{12}$/.test(byteId));
}

// --- input_digest ---
{
  const single = computeInputDigest([{ id: "rep-1", sha256: "sha256:abcd" }]);
  eq("single input digest", single, "sha256:abcd");
  const multi = computeInputDigest([{ id: "rep-2", sha256: "bb" }, { id: "rep-1", sha256: "aa" }]);
  ok("multi input digest is a sha256", /^sha256:[0-9a-f]{64}$/.test(multi));
  // order independence
  const multi2 = computeInputDigest([{ id: "rep-1", sha256: "aa" }, { id: "rep-2", sha256: "bb" }]);
  eq("multi input digest order-independent", multi, multi2);
}

// --- URL normalization ---
eq("url lowercase+port+trailing", canonicalUrl("HTTP://Example.COM:80/Path/"), "http://example.com/Path");
eq("url drop 443 keep root slash", canonicalUrl("https://x.com:443/"), "https://x.com/");
eq("url drop fragment", canonicalUrl("https://x.com/a#frag"), "https://x.com/a");
eq("url sort + strip utm", canonicalUrl("https://x.com/a?utm_source=z&b=2&a=1"), "https://x.com/a?a=1&b=2");
eq("url decode unreserved pct", canonicalUrl("https://x.com/%7Euser"), "https://x.com/~user");
eq("url keep ref param", canonicalUrl("https://x.com/a?ref=abc"), "https://x.com/a?ref=abc");
eq("url invalid -> null", canonicalUrl("not a url"), null);

// --- Slugs & filenames ---
eq("slug basic", slugify("Suits — The Grasshopper: Games & Utopia"), "suits-the-grasshopper-games-utopia");
eq("slug diacritics", slugify("Café Society"), "cafe-society");
eq("slug empty -> untitled", slugify("   "), "untitled");
eq("slug non-latin -> untitled", slugify("测试"), "untitled");
eq("slug reserved gets suffix", slugifyWithCollision("CON", "src-abcdef123456", new Set()), "con--abcdef");
eq("slug collision gets suffix", slugifyWithCollision("Report", "src-abcdef123456", new Set(["report"])), "report--abcdef");
ok("filename ok", checkFilename("sources/x/representations/clean.md").ok);
ok("filename rejects ..", !checkFilename("sources/../etc/passwd").ok);
ok("filename rejects backslash", !checkFilename("sources\\x\\y").ok);
ok("filename rejects colon", !checkFilename("sources/a:b/c").ok);
ok("filename rejects reserved", !checkFilename("sources/con/x.md").ok);

// --- Citation markers ---
{
  const inline = parseQuoteMarkers('The doc says "cut over DNS only after" [ext-10aaf6c96053] clearly.');
  eq("inline marker count", inline.length, 1);
  eq("inline marker quote", inline[0].quote, "cut over DNS only after");
  eq("inline marker id", inline[0].extId, "ext-10aaf6c96053");
  const block = parseQuoteMarkers("```quote ext-10aaf6c96053\nline one\nline two\n```");
  eq("block marker count", block.length, 1);
  eq("block marker quote", block[0].quote, "line one\nline two");
  const bare = parseQuoteMarkers("This is a paraphrase [ext-10aaf6c96053].");
  eq("bare paraphrase not gated", bare.length, 0);
  const uncited = findUncitedQuotes('He said "this is a sufficiently long uncited quotation" today.');
  eq("uncited long quote flagged", uncited.length, 1);
  const short = findUncitedQuotes('He said "brief" today.');
  eq("short quote not flagged", short.length, 0);
  const cited = findUncitedQuotes('He said "this is a sufficiently long uncited quotation" [ext-10aaf6c96053].');
  eq("cited long quote not flagged", cited.length, 0);
}

// --- CSV round-trip (RFC 4180) ---
{
  const rows = [["a", "b,c", 'quote"x"', "line\nbreak"], ["1", "2", "3", "4"]];
  const csv = writeCsv(rows);
  const back = parseCsv(csv);
  eq("csv round-trips embedded comma/quote/newline", back, rows.map((r) => r.map(String)));
}

// --- RO-Crate export: structure, determinism, identity (real example corpus) ---
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  clearRepCache();
  const loaded = loadCorpus(EXAMPLE);
  const g1 = buildRoCrateGraph(loaded);
  clearRepCache();
  const g2 = buildRoCrateGraph(loadCorpus(EXAMPLE));
  eq("ro-crate deterministic (byte-identical rebuild)", JSON.stringify(g1), JSON.stringify(g2));

  const graph = g1["@graph"];
  ok("ro-crate has @context with upc namespace",
    Array.isArray(g1["@context"]) && g1["@context"].some((c) => c && c.upc === "https://provenance.dev/upc/terms#"));

  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const descriptor = byId.get("ro-crate-metadata.json");
  ok("ro-crate metadata descriptor about ./", descriptor && descriptor.about && descriptor.about["@id"] === "./");
  const root = byId.get("./");
  ok("ro-crate root is a Dataset", root && root["@type"] === "Dataset");
  ok("ro-crate root conformsTo the UPC profile",
    root && Array.isArray(root.conformsTo) && root.conformsTo.some((c) => /profiles\/ro-crate$/.test(c["@id"])));

  // @id uniqueness across the whole graph
  const ids = graph.map((e) => e["@id"]);
  eq("ro-crate @id unique across @graph", new Set(ids).size, ids.length);

  // every abstract UPC entity carries identifier + a typed upc:*Id
  const isAbstract = (e) => {
    const t = [].concat(e["@type"]);
    return t.includes("upc:Source") || t.includes("upc:Extraction") ||
      t.includes("upc:Generation") || t.includes("upc:Synthesis") || t.includes("CreateAction");
  };
  ok("every abstract entity carries identifier", graph.filter(isAbstract).every((e) => typeof e.identifier === "string" && e.identifier.length));

  // every File @id resolves to a real path whose bytes hash to upc:sha256
  const files = graph.filter((e) => e["@type"] === "File");
  ok("ro-crate emits File entities", files.length > 0);
  let filesOk = true;
  const seenPaths = new Set();
  for (const f of files) {
    if (seenPaths.has(f["@id"])) filesOk = false; // single File per physical path
    seenPaths.add(f["@id"]);
    const abs = path.join(loaded.root, f["@id"]);
    if (!fs.existsSync(abs)) { filesOk = false; continue; }
    if (f["upc:sha256"] && sha256Hex(fs.readFileSync(abs)) !== bareHash(f["upc:sha256"])) filesOk = false;
  }
  ok("every File @id resolves and hashes to upc:sha256 (one File per path)", filesOk);

  // gated extraction -> gateAuthoritative + companion interop-only Annotation
  const ext = graph.find((e) => [].concat(e["@type"]).includes("upc:Extraction") && e["upc:gateAuthoritative"]);
  ok("a gated extraction is upc:gateAuthoritative", !!ext);
  const anno = ext && byId.get(ext["upc:annotation"]["@id"]);
  ok("companion annotation is upc:interopOnly", anno && anno["upc:interopOnly"] === true);
  const posSel = anno && anno.target.selector.find((s) => s["@type"] === "TextPositionSelector");
  ok("position selector declares codepoint unit", posSel && posSel["upc:unit"] === "codepoint");
  const quoteSel = anno && anno.target.selector.find((s) => s["@type"] === "TextQuoteSelector");
  ok("quote selector exact == direct_quote", quoteSel && quoteSel.exact === ext["upc:directQuote"]);

  // source identity enrichment surfaced as upc: terms (the cloudlore source carries a doi + same_work_as)
  const enriched = graph.find((e) => [].concat(e["@type"]).includes("upc:Source") && e["upc:identifiers"]);
  ok("ro-crate surfaces upc:identifiers on an enriched source", !!enriched);
  ok("upc:identifiers carries upc:identifierScheme + value",
    enriched && enriched["upc:identifiers"].some((i) => i["upc:identifierScheme"] === "doi" && typeof i.value === "string"));
  ok("ro-crate surfaces upc:relations with typed scheme/target",
    enriched && Array.isArray(enriched["upc:relations"]) &&
    enriched["upc:relations"].every((r) => typeof r["upc:relationType"] === "string" && typeof r["upc:relationTarget"] === "string"));
}

// --- Web Annotation selector edge cases (synthetic corpora on a temp dir) ---
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "upc-rc-"));
  let counter = 0;
  // Build a one-extraction synthetic `loaded` whose direct_quote is the given
  // occurrence of `quote` in `repText`, located by codepoint offsets (as reanchor does).
  const synth = (repText, quote, occurrence = 1) => {
    const dir = path.join(tmpRoot, "c" + counter++);
    const rel = "sources/s/representations/clean.md";
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, repText); // UTF-8
    let idx = -1;
    for (let k = 0; k < occurrence; k++) idx = repText.indexOf(quote, idx + 1);
    const start = codepointLength(repText.slice(0, idx));
    const end = start + codepointLength(quote);
    const repId = "rep-aaaaaaaaaaaa";
    const repObj = { representation_id: repId, role: "clean_markdown", media_type: "text/markdown", path: rel, sha256: "sha256:" + sha256Hex(fs.readFileSync(abs)) };
    const srcObj = { source_id: "src-aaaaaaaaaaaa", source_kind: "url", title: "t", representations: [repObj] };
    const ext = {
      extraction_id: "ext-000000000001", source_id: srcObj.source_id, representation_ref: repId,
      type: "quote", status: "active", direct_quote: quote,
      locator: { type: "char_range", representation_ref: repId, value: { start, end } },
    };
    clearRepCache();
    const loaded = {
      root: dir, corpus: { corpus_id: "cor-aaaaaaaaaaaa", upc_spec_version: "1.5.0", title: "t" },
      sections: {}, sources: [{ obj: srcObj, dirRel: "sources/s" }],
      representations: [{ obj: repObj, sourceId: srcObj.source_id, abs, contained: true }],
      extractions: [{ obj: ext }], generations: [], syntheses: [], events: [], extractionSets: [], diagnostics: [],
    };
    const g = buildRoCrateGraph(loaded);
    const byId = new Map(g["@graph"].map((e) => [e["@id"], e]));
    const anno = byId.get("#ext-000000000001-anno");
    const extEnt = byId.get("#ext-000000000001");
    const pos = anno && anno.target.selector.find((s) => s["@type"] === "TextPositionSelector");
    const qs = anno && anno.target.selector.find((s) => s["@type"] === "TextQuoteSelector");
    return { anno, extEnt, pos, qs, start, end };
  };

  // (a) astral: codepoint offsets != UTF-16 offsets; gate authoritative, interop-only flagged
  {
    const text = "\u{1F600} abcdef ghij"; // emoji is 1 codepoint / 2 UTF-16 units
    const r = synth(text, "abcdef");
    eq("astral: position selector uses codepoint start", r.pos.start, 2);
    ok("astral: codepoint start != naive UTF-16 index", r.pos.start !== text.indexOf("abcdef"));
    eq("astral: extraction charRange matches (codepoint)", JSON.stringify(r.extEnt["upc:charRange"]), JSON.stringify({ start: 2, end: 8 }));
    ok("astral: annotation is interop-only", r.anno["upc:interopOnly"] === true);
    ok("astral: extraction stays gate-authoritative", r.extEnt["upc:gateAuthoritative"] === true);
    eq("astral: quote exact preserved", r.qs.exact, "abcdef");
  }
  // (b) pure BMP control: codepoint == UTF-16, offsets coincide
  {
    const text = "hello world here";
    const r = synth(text, "world");
    eq("bmp: position start coincides with UTF-16", r.pos.start, text.indexOf("world"));
    eq("bmp: charRange end", r.extEnt["upc:charRange"].end, text.indexOf("world") + 5);
  }
  // (c) CRLF counted as two codepoints; exact quote preserves \r\n
  {
    const text = "line1\r\nline2 tail";
    const r = synth(text, "line1\r\nline2");
    eq("crlf: charRange counts CR and LF (end=12)", r.extEnt["upc:charRange"].end, 12);
    ok("crlf: annotation body preserves CRLF", r.anno.body.value.includes("\r\n"));
    eq("crlf: quote exact preserves CRLF", r.qs.exact, "line1\r\nline2");
  }
  // (d) repeated quote: prefix/suffix disambiguate the chosen occurrence
  {
    const text = "AA target BB target CC";
    const r = synth(text, "target", 2); // the SECOND occurrence
    ok("repeated: prefix present", typeof r.qs.prefix === "string" && r.qs.prefix.length > 0);
    ok("repeated: prefix identifies the 2nd occurrence (contains BB)", /BB/.test(r.qs.prefix));
    ok("repeated: suffix present", typeof r.qs.suffix === "string");
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// --- source identity advisories: identifier_scheme_unknown + relation_dangling ---
// End-to-end through validateCorpus on a copy of the real example: inject a bad
// scheme and a dangling relation, and assert both fire as WARNINGS only, with no
// new errors and no change in conformance level (enrichment is inert to gates).
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  clearRepCache();
  const base = validateCorpus(EXAMPLE);
  ok("baseline example raises no identity advisories",
    !base.warnings.some((w) => w.code === "identifier_scheme_unknown" || w.code === "relation_dangling"));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upc-enrich-"));
  const dst = path.join(tmp, "corpus");
  fs.cpSync(EXAMPLE, dst, { recursive: true });
  const sfile = path.join(dst, "sources", "cloudlore-2023-blue-green-deploys", "source.json");
  const sobj = JSON.parse(fs.readFileSync(sfile, "utf8"));
  const srcId = sobj.source_id, repId = sobj.representations[0].representation_id;
  sobj.identifiers = [
    { scheme: "doi", value: "10.1/x" },        // known scheme -> no warning
    { scheme: "x-internal", value: "42" },      // x- escape hatch -> no warning
    { scheme: "frobnicate", value: "99" },      // unknown non-x -> identifier_scheme_unknown
  ];
  sobj.relations = [
    { type: "same_work_as", target: "https://example.org/o" }, // external -> never checked
    { type: "is_version_of", target: repId },                   // resolvable id -> no warning
    { type: "is_version_of", target: srcId },                   // resolvable id (self) -> no warning
    { type: "supersedes", target: "src-000000000000" },         // id-shaped, unresolved -> relation_dangling
  ];
  fs.writeFileSync(sfile, JSON.stringify(sobj, null, 2) + "\n");
  clearRepCache();
  const rep = validateCorpus(dst);
  const wc = (code) => rep.warnings.filter((w) => w.code === code).length;
  eq("enriched: exactly one identifier_scheme_unknown (only the non-x unknown scheme)", wc("identifier_scheme_unknown"), 1);
  eq("enriched: exactly one relation_dangling (only the unresolved id-shaped target)", wc("relation_dangling"), 1);
  eq("enriched: enrichment adds no errors",
    JSON.stringify(rep.errors.map((e) => e.code).sort()), JSON.stringify(base.errors.map((e) => e.code).sort()));
  ok("enriched: conformance level unchanged", rep.level === base.level);
  ok("enriched: src- id unchanged by enrichment (recipe-inert on disk)",
    JSON.parse(fs.readFileSync(sfile, "utf8")).source_id === srcId);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- line derivation: 1-based inclusive, astral- and CRLF-correct ---
{
  const t = "alpha\nbeta\ngamma";
  eq("charToLine: first codepoint is line 1", charToLine(t, 0), 1);
  eq("charToLine: after the first \\n is line 2", charToLine(t, 6), 2);
  eq("charToLine: past the end clamps to the last line", charToLine(t, 999), 3);

  // one astral codepoint is TWO UTF-16 units; line math must count codepoints
  const astral = "a\u{1F600}b\ncd";
  eq("charToLine: astral char does not shift the line", charToLine(astral, 3), 1);
  eq("charToLine: codepoint after the break is line 2", charToLine(astral, 4), 2);

  // CRLF numbers identically to LF: the \r rides on the preceding line
  const crlf = "one\r\ntwo\r\nthree";
  eq("charToLine: CRLF line 2", charToLine(crlf, 5), 2);
  eq("lineRangeForCharRange: CRLF span stays on line 2", lineRangeForCharRange(crlf, 5, 8), { start: 2, end: 2 });

  eq("lineRangeForCharRange: single line span", lineRangeForCharRange(t, 0, 5), { start: 1, end: 1 });
  eq("lineRangeForCharRange: multi-line span is inclusive", lineRangeForCharRange(t, 0, 10), { start: 1, end: 2 });
  eq("lineRangeForCharRange: span reaching line 3", lineRangeForCharRange(t, 0, 12), { start: 1, end: 3 });
  eq("lineRangeForCharRange: empty span reports its own line", lineRangeForCharRange(t, 7, 7), { start: 2, end: 2 });
  // a span ending exactly ON a newline still belongs to the line it terminates
  eq("lineRangeForCharRange: span ending at the break stays on that line", lineRangeForCharRange(t, 0, 6), { start: 1, end: 1 });

  eq("textLines: trailing newline does not add a line", textLines("a\nb\n").length, 2);
  eq("textLines: no trailing newline", textLines("a\nb").length, 2);
  eq("textLines: a blank final line counts", textLines("a\n\n").length, 2);

  ok("isTranscriptRole: ocr is a derived text", isTranscriptRole("ocr"));
  ok("isTranscriptRole: ocr_pdf is a derived text", isTranscriptRole("ocr_pdf"));
  ok("isTranscriptRole: transcript is a derived text", isTranscriptRole("transcript"));
  ok("isTranscriptRole: clean_markdown is NOT a derived text", !isTranscriptRole("clean_markdown"));
}

// --- ext- id is INERT to secondary_locators and to advisory locator metadata ---
// The single most important invariant of this release: presentation metadata
// must never reach the identity recipe. canonicalLocator keeps exactly
// {type, representation_ref, value}, so anything else is free.
{
  const baseExt = {
    source_id: "src-aaaaaaaaaaaa", representation_ref: "rep-aaaaaaaaaaaa",
    direct_quote: "hello", type: "quote",
    locator: { type: "char_range", representation_ref: "rep-aaaaaaaaaaaa", value: { start: 0, end: 5 } },
  };
  const id0 = mintExtId(baseExt);

  const withSecondary = { ...baseExt, secondary_locators: [
    { type: "bbox", representation_ref: "img-bbbbbbbbbbbb", value: [1, 2, 3, 4], reference: { width: 9, height: 9 } },
    { type: "page", representation_ref: "rep-cccccccccccc", value: 7 },
  ] };
  eq("ext id: unchanged by adding secondary_locators", mintExtId(withSecondary), id0);

  const withMeta = { ...baseExt, locator: { ...baseExt.locator,
    conforms_to: "rfc5147", unit: "codepoint",
    reference: { width: 240, height: 120 },
    quote_hint: { exact: "hello", prefix: "say ", suffix: " there" } } };
  eq("ext id: unchanged by advisory metadata on the primary locator", mintExtId(withMeta), id0);

  const both = { ...withMeta, secondary_locators: withSecondary.secondary_locators };
  eq("ext id: unchanged by metadata AND secondary_locators together", mintExtId(both), id0);

  // control: the id MUST still move when something inside value changes
  const moved = { ...baseExt, locator: { ...baseExt.locator, value: { start: 0, end: 4 } } };
  ok("ext id: DOES change when locator.value changes (control)", mintExtId(moved) !== id0);
}

// --- resolveLocator: one shape per locator type, gate flag never lies ---
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  clearRepCache();
  const loaded = loadCorpus(EXAMPLE);
  const ext = loaded.extractions.find((e) => e.obj.direct_quote != null).obj;
  const repId = ext.representation_ref;

  const pr = resolveLocator(loaded, ext.locator, { context: 10 });
  ok("resolveLocator: char_range resolves", pr.resolved === true);
  ok("resolveLocator: char_range is the only gate-bearing kind", pr.gate_bearing === true);
  eq("resolveLocator: exact span equals the direct_quote", pr.context.exact, ext.direct_quote);
  eq("resolveLocator: context window honours opts.context", Array.from(pr.context.before).length, 10);
  eq("resolveLocator: unit is codepoints", pr.unit, "codepoint");
  ok("resolveLocator: char_range derives a line_range", Number.isInteger(pr.line_range.start));
  ok("resolveLocator: a gate-bearing locator carries no recorded_not_gated trust", pr.trust === undefined);

  const mk = (o) => resolveLocator(loaded, { representation_ref: repId, ...o });
  for (const [kind, loc] of [
    ["page", { type: "page", value: 7 }],
    ["bbox", { type: "bbox", value: [1, 2, 3, 4] }],
    ["timestamp_range", { type: "timestamp_range", value: { start: 1, end: 2 } }],
    ["line_range", { type: "line_range", value: { start: 1, end: 1 } }],
    ["section", { type: "section", value: "x" }],
  ]) {
    const r = mk(loc);
    ok(`resolveLocator: ${kind} resolves`, r.resolved === true);
    ok(`resolveLocator: ${kind} is NOT gate-bearing`, r.gate_bearing === false);
    eq(`resolveLocator: ${kind} is labelled recorded_not_gated`, r.trust, "recorded_not_gated");
  }
  eq("resolveLocator: page emits a PDF fragment", mk({ type: "page", value: 7 }).fragment, "#page=7");
  eq("resolveLocator: bbox emits a media fragment", mk({ type: "bbox", value: [1, 2, 3, 4] }).fragment, "#xywh=pixel:1,2,3,4");
  eq("resolveLocator: timestamp emits an NPT fragment", mk({ type: "timestamp_range", value: { start: 1, end: 2 } }).fragment, "#t=1,2");
  eq("resolveLocator: line_range returns the line text", mk({ type: "line_range", value: { start: 1, end: 1 } }).lines.length, 1);

  eq("resolveLocator: line 0 is rejected (lines are 1-based)",
    mk({ type: "line_range", value: { start: 0, end: 1 } }).reason, "locator_range_invalid");
  eq("resolveLocator: dangling representation is reported, not thrown",
    resolveLocator(loaded, { type: "page", representation_ref: "rep-ffffffffffff", value: 1 }).reason, "dangling_representation");
  eq("resolveLocator: an out-of-range char_range is reported, not thrown",
    resolveLocator(loaded, { type: "char_range", representation_ref: repId, value: { start: 0, end: 10 ** 9 } }).reason, "locator_range_invalid");
}

// --- secondary_locators advisories: fire correctly, and NEVER move the level ---
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  clearRepCache();
  const base = validateCorpus(EXAMPLE);
  const SEC_CODES = ["secondary_locator_dangling", "secondary_locator_cross_source", "bbox_out_of_bounds", "line_range_out_of_bounds"];
  ok("baseline example raises no secondary-locator advisories",
    !base.warnings.some((w) => SEC_CODES.includes(w.code)));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upc-seclos-"));
  const dst = path.join(tmp, "corpus");
  fs.cpSync(EXAMPLE, dst, { recursive: true });
  const sdir = path.join(dst, "sources", "watchdog-2024-migrate-with-no-downtime");
  const sobj = JSON.parse(fs.readFileSync(path.join(sdir, "source.json"), "utf8"));
  const img = sobj.representations.find((r) => r.role === "image");
  const other = JSON.parse(fs.readFileSync(path.join(dst, "sources", "cloudlore-2023-blue-green-deploys", "source.json"), "utf8"));
  const xfile = path.join(sdir, "extractions.jsonl");
  const recs = fs.readFileSync(xfile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const target = recs[0];
  const own = target.representation_ref;
  target.secondary_locators = [
    { type: "section", representation_ref: own, value: "x" },                                  // same rep -> silent
    { type: "bbox", representation_ref: img.representation_id, value: [0, 0, 10, 10] },         // cross-REP, in bounds -> silent
    { type: "bbox", representation_ref: img.representation_id, value: [200, 100, 100, 100] },   // -> bbox_out_of_bounds
    { type: "line_range", representation_ref: own, value: { start: 0, end: 2 } },               // -> line_range_out_of_bounds
    { type: "line_range", representation_ref: own, value: { start: 1, end: 99999 } },           // -> line_range_out_of_bounds
    { type: "page", representation_ref: "rep-ffffffffffff", value: 3 },                         // -> secondary_locator_dangling
    { type: "section", representation_ref: other.representations[0].representation_id, value: "x" }, // -> cross_source
  ];
  fs.writeFileSync(xfile, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  clearRepCache();
  const rep = validateCorpus(dst);
  const wc = (code) => rep.warnings.filter((w) => w.code === code).length;
  eq("secondary: exactly one dangling", wc("secondary_locator_dangling"), 1);
  eq("secondary: exactly one cross-source (crossing representations is legitimate)", wc("secondary_locator_cross_source"), 1);
  eq("secondary: exactly one bbox_out_of_bounds (the in-bounds one stays silent)", wc("bbox_out_of_bounds"), 1);
  eq("secondary: two line_range_out_of_bounds (start<1 and end past EOF)", wc("line_range_out_of_bounds"), 2);
  eq("secondary: advisories add no errors",
    JSON.stringify(rep.errors.map((e) => e.code).sort()), JSON.stringify(base.errors.map((e) => e.code).sort()));
  ok("secondary: conformance level unchanged (advisories are gate-inert)", rep.level === base.level);
  eq("secondary: ext- id on disk unchanged by adding secondary_locators",
    JSON.parse(fs.readFileSync(xfile, "utf8").trim().split("\n")[0]).extraction_id, recs[0].extraction_id);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- structured image info: description + has_text + a findable, gated quote ---
// The three connected pieces of spec/05, exercised end-to-end on the real example.
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  clearRepCache();
  const loaded = loadCorpus(EXAMPLE);
  const img = loaded.representations.find((r) => r.obj.role === "image");
  const ocr = loaded.representations.find((r) => r.obj.role === "ocr");

  ok("image: the example carries an image representation", !!img);
  ok("image: (1) description is the summary", typeof img.obj.description === "string" && img.obj.description.length > 0);
  eq("image: (2) has_text flags text presence", img.obj.has_text, true);
  ok("image: dimensions are recorded (a pixel bbox is meaningless without them)",
    img.obj.dimensions && img.obj.dimensions.width > 0 && img.obj.dimensions.height > 0);

  ok("ocr: (3) a companion ocr-role representation exists", !!ocr);
  ok("ocr: the companion is a TEXTUAL media type (the image itself is not)", /^text\//.test(ocr.obj.media_type));
  eq("ocr: the companion points back at the image", ocr.obj.parent_representation_ref, img.obj.representation_id);
  ok("ocr: image/svg+xml is NOT textual, so the image cannot be quoted directly",
    !/^text\//.test(img.obj.media_type));

  // the vocabulary actually admits the role the spec has always referenced
  const vocab = JSON.parse(fs.readFileSync(path.join(HERE, "..", "vocab", "vocab.json"), "utf8"));
  ok("vocab: representation_role admits 'ocr'", vocab.$defs.representation_role.enum.includes("ocr"));

  // the quote into the OCR text is GATED, and labelled as derived text
  const q = loaded.extractions.map((e) => e.obj).find((o) => o.representation_ref === ocr.obj.representation_id);
  ok("ocr quote: exists", !!q);
  ok("ocr quote: is anchored by char_range", q.locator.type === "char_range");
  const rec = { utf8ok: true, text: fs.readFileSync(ocr.abs, "utf8"), cps: Array.from(fs.readFileSync(ocr.abs, "utf8")) };
  ok("ocr quote: PASSES the codepoint gate", verifyHopB(q, rec).ok === true);
  ok("ocr quote: its role is derived text -> verified-to-transcript", isTranscriptRole(ocr.obj.role));

  // the cross-representation region: resolvable, in bounds, and never gated
  const sec = (q.secondary_locators || []).find((l) => l.type === "bbox");
  ok("ocr quote: carries a secondary bbox into the image", !!sec);
  eq("ocr quote: the bbox targets the image, not the text", sec.representation_ref, img.obj.representation_id);
  const r = resolveLocator(loaded, sec);
  ok("region: resolves", r.resolved === true);
  ok("region: is NOT gate-bearing", r.gate_bearing === false);
  eq("region: is labelled recorded_not_gated", r.trust, "recorded_not_gated");
  const [x, y, w, h] = sec.value;
  ok("region: bbox lies inside the image dimensions",
    x + w <= img.obj.dimensions.width && y + h <= img.obj.dimensions.height);

  // and the ungated region reading is a separate, non-quoting extraction
  const region = loaded.extractions.map((e) => e.obj).find((o) => o.type === "image_region");
  ok("image_region: exists as its own extraction", !!region);
  ok("image_region: carries NO direct_quote (a bbox can never gate one)", region.direct_quote == null);
  ok("image_region: is anchored by bbox", region.locator.type === "bbox");
}

// --- Web Annotation: presentation selectors + the multi-target cross-rep shape ---
{
  const R = "rep-aaaaaaaaaaaa";
  // RFC 5147 is 0-based half-open; UPC line_range is 1-based inclusive.
  eq("fragment: line_range 3-5 exports as RFC 5147 #line=2,5",
    fragmentForLocator({ type: "line_range", representation_ref: R, value: { start: 3, end: 5 } }), "#line=2,5");
  eq("fragment: a single line still shifts only the start",
    fragmentForLocator({ type: "line_range", representation_ref: R, value: { start: 1, end: 1 } }), "#line=0,1");
  eq("fragment: page -> PDF open parameters",
    fragmentForLocator({ type: "page", representation_ref: R, value: 7 }), "#page=7");
  eq("fragment: bbox -> Media Fragments pixel",
    fragmentForLocator({ type: "bbox", representation_ref: R, value: [12, 52, 200, 18] }), "#xywh=pixel:12,52,200,18");
  eq("fragment: bbox honours unit percent",
    fragmentForLocator({ type: "bbox", representation_ref: R, value: [5, 10, 20, 30], unit: "percent" }), "#xywh=percent:5,10,20,30");
  eq("fragment: timestamp_range -> NPT",
    fragmentForLocator({ type: "timestamp_range", representation_ref: R, value: { start: 10, end: 12.5 } }), "#t=10,12.5");
  eq("fragment: char_range has NO fragment form (it is the gate, not a projection)",
    fragmentForLocator({ type: "char_range", representation_ref: R, value: { start: 0, end: 5 } }), null);
  eq("fragment: section has no unambiguous syntax, so none is invented",
    fragmentForLocator({ type: "section", representation_ref: R, value: "Cutover" }), null);

  const bboxSel = selectorsForLocator({ type: "bbox", representation_ref: R, value: [12, 52, 200, 18], reference: { width: 240, height: 120 } });
  eq("selector: bbox emits one FragmentSelector", bboxSel.length, 1);
  eq("selector: bbox carries upc:unit", bboxSel[0]["upc:unit"], "pixel");
  eq("selector: bbox carries upc:conformsTo", bboxSel[0]["upc:conformsTo"], "media-frags");
  eq("selector: bbox carries its reference frame (pixels are resolution-dependent)",
    JSON.stringify(bboxSel[0]["upc:reference"]), JSON.stringify({ width: 240, height: 120 }));
  ok("selector: a presentation selector is NEVER gate-authoritative",
    bboxSel.every((x) => x["upc:gateAuthoritative"] === undefined));

  const cr = selectorsForLocator({ type: "char_range", representation_ref: R, value: { start: 0, end: 5 } }, { quote: "hello" });
  eq("selector: char_range emits position + quote", cr.map((x) => x["@type"]).join("+"), "TextPositionSelector+TextQuoteSelector");
  eq("selector: char_range positions are codepoints", cr[0]["upc:unit"], "codepoint");

  const hinted = selectorsForLocator({ type: "page", representation_ref: R, value: 3, quote_hint: { exact: "Q", prefix: "a", suffix: "b" } });
  eq("selector: quote_hint becomes a TextQuoteSelector re-find hint",
    hinted.map((x) => x["@type"]).join("+"), "FragmentSelector+TextQuoteSelector");

  // cross-representation -> two targets, each selector bound to its own source
  const lookup = (id) => ({ ref: { "@id": id + ".file" }, rec: null });
  const ext = {
    representation_ref: R, direct_quote: "hello",
    locator: { type: "char_range", representation_ref: R, value: { start: 0, end: 5 } },
    secondary_locators: [
      { type: "section", representation_ref: R, value: "same rep, no fragment" },
      { type: "bbox", representation_ref: "img-bbbbbbbbbbbb", value: [1, 2, 3, 4] },
    ],
  };
  const t = buildAnnotationTargets(ext, lookup);
  ok("annotation: a cross-representation locator makes target an ARRAY", Array.isArray(t));
  eq("annotation: exactly two targets (text + image)", t.length, 2);
  eq("annotation: target 1 is the text representation", t[0].source["@id"], R + ".file");
  eq("annotation: target 2 is the image", t[1].source["@id"], "img-bbbbbbbbbbbb.file");
  eq("annotation: the image target carries the FragmentSelector", t[1].selector[0]["@type"], "FragmentSelector");
  ok("annotation: the image fragment is NOT on the text target",
    !JSON.stringify(t[0]).includes("FragmentSelector"));

  // same-representation only -> the 1.5.0 bare-object shape is preserved
  const t1 = buildAnnotationTargets({ ...ext, secondary_locators: [ext.secondary_locators[0]] }, lookup);
  ok("annotation: a single target keeps the bare-object shape (1.5.0 compatible)", !Array.isArray(t1));
  eq("annotation: a section secondary contributes no selector", t1.selector.length, 2);
}

// --- the real example: multi-target annotation + RO-Crate determinism ---
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  clearRepCache();
  const g1 = buildRoCrateGraph(loadCorpus(EXAMPLE));
  clearRepCache();
  const g2 = buildRoCrateGraph(loadCorpus(EXAMPLE));
  eq("ro-crate: still byte-identical across rebuilds with presentation selectors",
    JSON.stringify(g1), JSON.stringify(g2));

  const annos = g1["@graph"].filter((n) => n["@type"] === "Annotation");
  const multi = annos.filter((a) => Array.isArray(a.target));
  // two cross-representation quotes: OCR text -> image, PDF text layer -> PDF
  eq("ro-crate: two multi-target annotations (the OCR quote and the PDF quote)", multi.length, 2);
  const targets = multi.flatMap((a) => a.target);
  const img = targets.find((t) => String(t.source["@id"]).endsWith(".svg"));
  ok("ro-crate: the image target exists", !!img);
  eq("ro-crate: it carries the media fragment", img.selector[0].value, "#xywh=pixel:12,52,200,18");
  const pdf = targets.find((t) => String(t.source["@id"]).endsWith(".pdf"));
  ok("ro-crate: the PDF target exists", !!pdf);
  eq("ro-crate: it carries the PDF open-parameters fragment", pdf.selector[0].value, "#page=2");
  eq("ro-crate: tagged with the PDF fragment standard", pdf.selector[0]["upc:conformsTo"], "pdf-open-params");
  ok("ro-crate: every annotation is flagged interop-only",
    annos.every((a) => a["upc:interopOnly"] === true));
  ok("ro-crate: no annotation claims gate authority",
    !JSON.stringify(annos).includes("gateAuthoritative"));
}

// --- browser model: image info, anchors, and derived line numbers survive ---
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  clearRepCache();
  const m = buildBrowserModel(loadCorpus(EXAMPLE));

  const img = m.sources.flatMap((s) => s.representations).find((r) => r.isImage);
  ok("browser: the image representation is recognised as an image", !!img);
  ok("browser: description reaches the view model", !!img.description);
  eq("browser: has_text reaches the view model", img.has_text, true);
  ok("browser: dimensions reach the view model", img.dimensions && img.dimensions.width === 240);
  ok("browser: caption reaches the view model", !!img.caption);

  // pick the OCR quote specifically: it is the one carrying a region anchor
  const q = m.extractions.find((e) => (e.anchors || []).some((a) => a.kind === "bbox" && !a.primary));
  ok("browser: the OCR quote is badged verified-to-transcript", q.badge === "verified-to-transcript");
  eq("browser: a char_range quote derives its line number", JSON.stringify(q.lineRange), JSON.stringify({ start: 1, end: 1 }));
  const bbox = (q.anchors || []).find((a) => a.kind === "bbox");
  ok("browser: the cross-rep region anchor is present", !!bbox);
  ok("browser: it is flagged cross_representation", bbox.cross_representation === true);
  eq("browser: it is labelled recorded_not_gated", bbox.trust, "recorded_not_gated");
  ok("browser: it resolves to the image file", /figure\.svg$/.test(bbox.representation.path));
  ok("browser: it carries the reference frame the overlay scales against",
    bbox.reference && bbox.reference.width === 240 && bbox.reference.height === 120);

  const text = m.extractions.find((e) => e.badge === "verified");
  ok("browser: an ordinary text quote also derives a line number", text.lineRange && text.lineRange.start >= 1);

  // the PDF path: a page anchor into the original document, and its deep link
  const pdfQ = m.extractions.find((e) => (e.anchors || []).some((a) => a.kind === "page"));
  ok("browser: the PDF-text quote is present", !!pdfQ);
  const page = pdfQ.anchors.find((a) => a.kind === "page");
  eq("browser: the page anchor resolves to page 2", page.page, 2);
  eq("browser: it emits a PDF open-parameters fragment", page.fragment, "#page=2");
  ok("browser: it is flagged cross_representation (text layer -> the PDF)", page.cross_representation === true);
  eq("browser: it is labelled recorded_not_gated", page.trust, "recorded_not_gated");
  ok("browser: it resolves to the .pdf file", /\.pdf$/.test(page.path));
  const lr = pdfQ.anchors.find((a) => a.kind === "line_range");
  ok("browser: the line_range anchor carries a path for its RFC 5147 link", !!(lr && lr.path));

  const region = m.extractions.find((e) => e.type === "image_region");
  ok("browser: the ungated region reading stays ungated", region.verified === false);

  // the whole point: presentation anchors never move a badge
  ok("browser: every anchor except the primary char_range is non-gate-bearing",
    m.extractions.every((e) => (e.anchors || []).every((a) => a.gate_bearing === (a.primary && a.kind === "char_range"))));
}

// --- the §05 trust boundary follows the BYTES, not the role name ---
// A text layer pulled out of a PDF is derived text even though its role is the
// generic "text": the bytes it came from are not text. Badging it plain
// "verified" would claim the quote was checked against the document itself.
{
  ok("textual: text/plain", isTextualMedia("text/plain"));
  ok("textual: text/markdown", isTextualMedia("text/markdown"));
  ok("textual: application/json", isTextualMedia("application/json"));
  ok("textual: application/pdf is NOT text", !isTextualMedia("application/pdf"));
  ok("textual: image/svg+xml is NOT text", !isTextualMedia("image/svg+xml"));
  ok("textual: audio/mpeg is NOT text", !isTextualMedia("audio/mpeg"));

  const reps = {
    "rep-pdf": { representation_id: "rep-pdf", role: "document_pdf", media_type: "application/pdf" },
    "rep-html": { representation_id: "rep-html", role: "raw_html", media_type: "text/html" },
    "img-1": { representation_id: "img-1", role: "image", media_type: "image/png" },
    "rep-audio": { representation_id: "rep-audio", role: "audio", media_type: "audio/mpeg" },
  };
  const look = (id) => reps[id] || null;

  ok("derived: a text layer extracted from a PDF IS derived text",
    isDerivedText({ role: "text", media_type: "text/plain", parent_representation_ref: "rep-pdf" }, look));
  ok("derived: cleaned Markdown from raw HTML is NOT derived text (text -> text)",
    !isDerivedText({ role: "clean_markdown", media_type: "text/markdown", parent_representation_ref: "rep-html" }, look));
  ok("derived: OCR text from an image IS derived text",
    isDerivedText({ role: "ocr", media_type: "text/plain", parent_representation_ref: "img-1" }, look));
  ok("derived: a transcript is derived text by role alone, with no parent",
    isDerivedText({ role: "transcript", media_type: "text/plain" }, look));
  ok("derived: a transcript of audio is derived text",
    isDerivedText({ role: "transcript", media_type: "text/plain", parent_representation_ref: "rep-audio" }, look));
  ok("derived: a captured source text with no parent is NOT derived",
    !isDerivedText({ role: "text", media_type: "text/plain" }, look));
  ok("derived: an unresolvable parent is not assumed to be non-text",
    !isDerivedText({ role: "text", media_type: "text/plain", parent_representation_ref: "rep-nope" }, look));
  ok("derived: null representation is handled", !isDerivedText(null, look));
}

// --- the PDF example: a real document, a gated text layer, a page deep link ---
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  clearRepCache();
  const loaded = loadCorpus(EXAMPLE);
  const pdf = loaded.representations.find((r) => r.obj.role === "document_pdf");
  ok("pdf: the example carries a native document_pdf representation", !!pdf);
  eq("pdf: its media type is application/pdf", pdf.obj.media_type, "application/pdf");
  eq("pdf: page_count is recorded", pdf.obj.page_count, 2);

  // the bytes on disk are a real, structurally valid PDF
  const bytes = fs.readFileSync(pdf.abs);
  ok("pdf: starts with a PDF header", bytes.subarray(0, 8).toString("latin1").startsWith("%PDF-1."));
  ok("pdf: ends with %%EOF", bytes.subarray(-8).toString("latin1").includes("%%EOF"));
  eq("pdf: declares the same page count in its page tree",
    (bytes.toString("latin1").match(/\/Count (\d+)/) || [])[1], String(pdf.obj.page_count));
  ok("pdf: bytes hash to the recorded sha256", "sha256:" + sha256Hex(bytes) === bareHash(pdf.obj.sha256).replace(/^/, "sha256:"));
  // every xref offset must point at the object it claims, or no reader can open it
  const txt = bytes.toString("latin1");
  const sx = Number((txt.match(/startxref\s+(\d+)/) || [])[1]);
  ok("pdf: startxref points at the xref table", txt.slice(sx, sx + 4) === "xref");
  const rows = [...txt.slice(sx).matchAll(/(\d{10}) (\d{5}) ([nf])/g)];
  ok("pdf: every in-use xref offset points at its object",
    rows.every((m, i) => m[3] === "f" || txt.startsWith(i + " 0 obj", Number(m[1]))));

  // the text layer is derived text, and its quote is gated against IT
  const layer = loaded.representations.find((r) => r.obj.parent_representation_ref === pdf.obj.representation_id);
  ok("pdf: a text layer hangs off the PDF", !!layer);
  eq("pdf: the layer's role is the generic text", layer.obj.role, "text");
  ok("pdf: yet it counts as derived text (its parent is not text)",
    isDerivedText(layer.obj, (id) => { const r = loaded.representations.find((x) => x.obj.representation_id === id); return r ? r.obj : null; }));

  const q = loaded.extractions.map((e) => e.obj).find((o) => o.representation_ref === layer.obj.representation_id);
  ok("pdf: a quotation is anchored into the text layer", !!q);
  const rec = getRepFileForTest(layer.abs);
  ok("pdf: the quotation PASSES the codepoint gate", verifyHopB(q, rec).ok === true);
  ok("pdf: the quoted text really appears in the PDF's own content stream",
    txt.includes(q.direct_quote));

  const page = (q.secondary_locators || []).find((l) => l.type === "page");
  ok("pdf: it carries a secondary page locator", !!page);
  eq("pdf: pointing into the PDF itself", page.representation_ref, pdf.obj.representation_id);
  eq("pdf: at page 2", page.value, 2);
  const r = resolveLocator(loaded, page);
  eq("pdf: which resolves to a #page= deep link", r.fragment, "#page=2");
  eq("pdf: labelled recorded_not_gated", r.trust, "recorded_not_gated");
  ok("pdf: and is never gate-bearing", r.gate_bearing === false);
}

// --- the generated browser must actually PARSE ---
// The client is emitted from a template literal, so every backslash in it is an
// escaping hazard; a broken regex there produces an index.html that looks fine on
// disk and dies on load. Parse-check the emitted script instead of trusting it.
{
  for (const name of ["web-research-corpus", "minimal-corpus"]) {
    const html = fs.readFileSync(path.join(HERE, "..", "examples", name, "index.html"), "utf8");
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    ok(`browser(${name}): has an inline client script`, blocks.length >= 1);
    for (let i = 0; i < blocks.length; i++) {
      let parsed = true, err = "";
      try { new Function(blocks[i]); } catch (e) { parsed = false; err = e.message; }
      ok(`browser(${name}): inline script ${i} parses as JavaScript${parsed ? "" : " — " + err}`, parsed);
    }
    // the embedded data island must be valid JSON too
    const data = /<script type="application\/json" id="upc-data">([\s\S]*?)<\/script>/.exec(html);
    ok(`browser(${name}): the data island is present`, !!data);
    let jsonOk = true;
    try { JSON.parse(data[1].replace(/\\u003c/g, "<")); } catch { jsonOk = false; }
    ok(`browser(${name}): the data island is valid JSON`, jsonOk);
  }
}

// --- the in-page source viewer: bytes embedded at build time, never truncated ---
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  clearRepCache();
  const loaded = loadCorpus(EXAMPLE);
  const m = buildBrowserModel(loaded);

  ok("viewer: the model carries a representation map", !!m.reps);
  ok("viewer: it reports what it embedded", m.embed && typeof m.embed.embedded === "number");
  eq("viewer: nothing was skipped in this corpus", m.embed.skipped, 0);

  // every TEXTUAL representation is embedded, and byte-exactly
  for (const r of loaded.representations) {
    const rec = m.reps[r.obj.representation_id];
    ok(`viewer: ${r.obj.role} is in the map`, !!rec);
    if (!isTextualMedia(r.obj.media_type)) {
      ok(`viewer: ${r.obj.role} (non-text) carries no embedded text`, rec.text === undefined);
      continue;
    }
    eq(`viewer: ${r.obj.role} text is byte-exact`, rec.text, fs.readFileSync(r.abs, "utf8"));
    eq(`viewer: ${r.obj.role} line count matches`, rec.lineCount, textLines(fs.readFileSync(r.abs, "utf8")).length);
  }

  // the viewer must be able to place a quotation: its rep is embedded, and the
  // char_range lands inside the embedded text
  for (const e of m.extractions.filter((x) => x.badge === "verified" || x.badge === "verified-to-transcript")) {
    const rec = m.reps[e.representation_ref];
    ok(`viewer: ${e.id} has its source embedded`, typeof rec.text === "string");
    const cps = Array.from(rec.text);
    const v = e.locator.value;
    eq(`viewer: ${e.id} span in the embedded text equals the quote`, cps.slice(v.start, v.end).join(""), e.quote);
    ok(`viewer: ${e.id} derived line is within the document`, e.lineRange.end <= rec.lineCount);
  }

  // a PDF is referenced, never inlined (binary would bloat the page)
  const pdf = Object.values(m.reps).find((r) => r.isPdf);
  ok("viewer: the PDF is in the map", !!pdf);
  ok("viewer: the PDF carries no embedded text", pdf.text === undefined);
  ok("viewer: the PDF knows its page count, for the pane's caption", pdf.page_count === 2);

  // an image is referenced by path, with the frame the overlay needs
  const img = Object.values(m.reps).find((r) => r.isImage);
  ok("viewer: the image is in the map", !!img);
  ok("viewer: with its dimensions", img.dimensions && img.dimensions.width === 240);

  const html = fs.readFileSync(path.join(EXAMPLE, "index.html"), "utf8");
  ok("viewer: the pane is mounted in the page", /class="viewer/.test(html) || /viewerShell/.test(html));
  ok("viewer: position chips drive the pane instead of a new tab", /openSource\(/.test(html));
  ok("viewer: an external link is still offered", /open externally/.test(html));
  ok("viewer: oversized representations are refused, not truncated", /too large to embed/.test(html));
}

// --- §09 deep links: #ex=, and search/sort carried in the hash ---
{
  const html = fs.readFileSync(path.join(HERE, "..", "examples", "web-research-corpus", "index.html"), "utf8");
  ok("deep links: the #ex=<ext-id> shorthand is implemented", /\^ex=/.test(html));
  ok("deep links: the hash carries a search parameter", /params?\.|URLSearchParams/.test(html) && /"q"/.test(html));
  ok("deep links: the hash carries sort and direction", /"sort"/.test(html) && /"dir"/.test(html));
  ok("deep links: sorting is wired to the column headers", /toggleSort/.test(html));
  ok("deep links: in-place updates do not re-route (focus would be lost)", /selfNav/.test(html));
}

// --- PROV-O export: structure, determinism, cautions (real example corpus) ---
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  const loaded = loadCorpus(EXAMPLE);
  const g1 = buildProvGraph(loaded);
  const g2 = buildProvGraph(loadCorpus(EXAMPLE));
  eq("prov deterministic (byte-identical rebuild)", JSON.stringify(g1), JSON.stringify(g2));

  const graph = g1["@graph"];
  ok("prov @context binds prov namespace", g1["@context"] && g1["@context"].prov === "http://www.w3.org/ns/prov#");

  const entities = graph.filter((n) => n["@type"] === "prov:Entity");
  const nObjs = loaded.sources.filter((s) => s.obj).length + loaded.representations.length +
    loaded.extractions.length + loaded.generations.length + loaded.syntheses.length;
  eq("prov: one prov:Entity per UPC object", entities.length, nObjs);

  const activities = graph.filter((n) => n["@type"] === "prov:Activity");
  eq("prov: one prov:Activity per event", activities.length, loaded.events.length);

  const agents = graph.filter((n) => [].concat(n["@type"]).includes("prov:Agent"));
  ok("prov: emits agents (SoftwareAgent/Person)", agents.length > 0 &&
    agents.every((a) => [].concat(a["@type"]).some((t) => t === "prov:SoftwareAgent" || t === "prov:Person")));

  ok("prov: has a wasDerivedFrom edge", graph.some((n) => n["prov:wasDerivedFrom"]));
  ok("prov: has a wasGeneratedBy edge", graph.some((n) => n["prov:wasGeneratedBy"]));
  ok("prov: NEVER emits hadPrimarySource (source is not a claimed primary source)",
    !JSON.stringify(g1).includes("hadPrimarySource"));

  const ids = graph.map((n) => n["@id"]);
  eq("prov: @id unique across @graph", new Set(ids).size, ids.length);
}

// --- PROV-O cautions: wasRevisionOf (supersedes, NOT duplicate_of) + wasQuotedFrom ---
{
  const loaded = {
    root: ".", corpus: { corpus_id: "cor-aaaaaaaaaaaa", upc_spec_version: "1.5.0" }, sections: {},
    sources: [{ obj: { source_id: "src-aaaaaaaaaaaa", source_kind: "url", supersedes: "src-bbbbbbbbbbbb", representations: [] } }],
    representations: [{ obj: { representation_id: "rep-aaaaaaaaaaaa", role: "clean_markdown", media_type: "text/markdown", path: "x.md", sha256: "sha256:00", duplicate_of: "rep-cccccccccccc" }, sourceId: "src-aaaaaaaaaaaa" }],
    extractions: [{ obj: { extraction_id: "ext-000000000001", source_id: "src-aaaaaaaaaaaa", representation_ref: "rep-aaaaaaaaaaaa", type: "quote", status: "active", direct_quote: "hi", supersedes: "ext-000000000002", locator: { type: "char_range", representation_ref: "rep-aaaaaaaaaaaa", value: { start: 0, end: 2 } } } }],
    generations: [], syntheses: [], events: [], extractionSets: [], diagnostics: [],
  };
  const byId = new Map(buildProvGraph(loaded)["@graph"].map((n) => [n["@id"], n]));
  const src = byId.get("#src-aaaaaaaaaaaa"), rep = byId.get("#rep-aaaaaaaaaaaa"), ext = byId.get("#ext-000000000001");
  eq("prov: source supersedes -> wasRevisionOf", src["prov:wasRevisionOf"] && src["prov:wasRevisionOf"]["@id"], "#src-bbbbbbbbbbbb");
  eq("prov: extraction supersedes -> wasRevisionOf", ext["prov:wasRevisionOf"] && ext["prov:wasRevisionOf"]["@id"], "#ext-000000000002");
  eq("prov: direct_quote -> wasQuotedFrom the representation", ext["prov:wasQuotedFrom"] && ext["prov:wasQuotedFrom"]["@id"], "#rep-aaaaaaaaaaaa");
  ok("prov: representation duplicate_of is NOT a wasRevisionOf", !rep["prov:wasRevisionOf"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
