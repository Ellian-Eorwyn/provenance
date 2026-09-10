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
  isDerivedText, isTextualMedia, isModelRewrittenText,
  mintCbkId, mintCodId, codebookRevisionDigest, mintRepId, canonicalUrl as _cu,
  normalizeForRefind, refindSpan,
} from "../skill/universal-provenance/scripts/upc_common.mjs";
import { buildRoCrateGraph, fragmentForLocator, selectorsForLocator, buildAnnotationTargets } from "../skill/universal-provenance/scripts/ro-crate.mjs";
import { buildModel as buildBrowserModel } from "../skill/universal-provenance/scripts/build-index.mjs";
import { buildProvGraph } from "../skill/universal-provenance/scripts/prov.mjs";
import { buildVaultPlan, writeVault, loadProfile, renderCallout, serializeFrontmatter,
  stripBoilerplate, yamlScalar } from "../skill/universal-provenance/scripts/obsidian.mjs";
import { validateCorpus, anchorCmd, codeCmd, codebookCmd, batchCmd, mintBatchCmd, locateCmd, satisfiesRequirement, specVersion, addSourceCmd, addSynthesisCmd } from "../skill/universal-provenance/scripts/upc.mjs";
import { buildSiteModel, writeSite, writeSingleFile, renderOverviewMarkdown } from "../skill/universal-provenance/scripts/site.mjs";

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

// ---------------------------------------------------------------------------
// 1.6.0 — codebooks, codings, anchoring, and the model-rewrite badge (spec/12)
// ---------------------------------------------------------------------------

// --- cbk-/cod- identity recipes: what is IN the key, and what is deliberately OUT ---
{
  const cbk = { namespace: "researchassistant", slug: "org-type" };
  const id = mintCbkId(cbk);
  ok("cbk- id shape", /^cbk-[0-9a-f]{12}$/.test(id));
  eq("cbk- is deterministic", mintCbkId({ ...cbk }), id);
  // Identity is over (namespace, slug) ONLY: a codebook must keep a stable id while
  // its contents evolve, or every edit would dangle every codebook_ref.
  eq("cbk- ignores codes[]", mintCbkId({ ...cbk, codes: [{ code: "a", label: "A" }] }), id);
  eq("cbk- ignores title/revision", mintCbkId({ ...cbk, title: "Renamed", revision: 9 }), id);
  ok("cbk- differs by namespace", mintCbkId({ ...cbk, namespace: "pi-forge" }) !== id);
  ok("cbk- differs by slug", mintCbkId({ ...cbk, slug: "sector" }) !== id);

  const base = { codebook_ref: id, target: { kind: "extraction", id: "ext-10aaf6c96053" }, coder: "ra-column-v1", code: "utility" };
  const cid = mintCodId(base);
  ok("cod- id shape", /^cod-[0-9a-f]{12}$/.test(cid));
  // OUT of the key -> re-running an unchanged coding pass is idempotent.
  eq("cod- ignores confidence", mintCodId({ ...base, confidence: "high", confidence_score: 0.9 }), cid);
  eq("cod- ignores rationale/query", mintCodId({ ...base, rationale: "because", query: "q?" }), cid);
  eq("cod- ignores status", mintCodId({ ...base, status: "superseded" }), cid);
  eq("cod- ignores provenance", mintCodId({ ...base, provenance: { created_at: "2026-01-01T00:00:00Z" } }), cid);
  eq("cod- ignores codebook revision", mintCodId({ ...base, codebook_revision: 7, codebook_revision_digest: "sha256:x" }), cid);
  // IN the key -> disagreement, multi-label and re-coding are all representable.
  ok("cod- differs by coder (so agreement is computable)", mintCodId({ ...base, coder: "ellie" }) !== cid);
  ok("cod- differs by code (so multi-label is representable)", mintCodId({ ...base, code: "ngo" }) !== cid);
  ok("cod- differs by target", mintCodId({ ...base, target: { kind: "extraction", id: "ext-000000000001" } }) !== cid);
  ok("cod- differs by target kind", mintCodId({ ...base, target: { kind: "source", id: "ext-10aaf6c96053" } }) !== cid);
  ok("cod- differs by codebook", mintCodId({ ...base, codebook_ref: mintCbkId({ namespace: "demo", slug: "x" }) }) !== cid);
  // A code and a free-text value are distinct even when the strings coincide.
  const asValue = { codebook_ref: id, target: base.target, coder: base.coder, value: "utility" };
  ok("cod- code != value with the same string", mintCodId(asValue) !== cid);

  const codes = [{ code: "a", label: "A" }];
  ok("codebook revision digest shape", /^sha256:[0-9a-f]{64}$/.test(codebookRevisionDigest(codes)));
  ok("codebook revision digest changes with codes", codebookRevisionDigest(codes) !== codebookRevisionDigest(codes.concat([{ code: "b", label: "B" }])));
}

// --- isModelRewrittenText: decided by DERIVATION, never by the role name ---
{
  const md = { representation_id: "rep-aaaaaaaaaaaa", role: "clean_markdown", media_type: "text/markdown" };
  const pdf = { representation_id: "rep-bbbbbbbbbbbb", role: "document_pdf", media_type: "application/pdf" };
  const look = (id) => ({ "rep-aaaaaaaaaaaa": md, "rep-bbbbbbbbbbbb": pdf }[id]);
  const rewrite = { role: "clean_markdown", media_type: "text/markdown", produced_by: "model", parent_representation_ref: "rep-aaaaaaaaaaaa" };
  const conv = { role: "clean_markdown", media_type: "text/markdown", produced_by: "conversion", parent_representation_ref: "rep-aaaaaaaaaaaa" };
  const modelOnPdf = { role: "text", media_type: "text/plain", produced_by: "model", parent_representation_ref: "rep-bbbbbbbbbbbb" };
  ok("model rewrite of TEXT is a rewrite", isModelRewrittenText(rewrite, look));
  ok("deterministic conversion is NOT a rewrite", !isModelRewrittenText(conv, look));
  // Identical role strings, opposite answers: only the derivation separates them.
  eq("rewrite and conversion share a role", rewrite.role, conv.role);
  ok("model over a NON-text parent is derived text, not a rewrite", !isModelRewrittenText(modelOnPdf, look));
  ok("...and isDerivedText claims that case", isDerivedText(modelOnPdf, look));
  ok("a rewrite is not 'derived text'", !isDerivedText(rewrite, look));
  ok("no parent means no rewrite claim", !isModelRewrittenText({ produced_by: "model", role: "clean_markdown" }, look));
  ok("stamp-shaped produced_by is also honoured", isModelRewrittenText({ role: "text", media_type: "text/plain", provenance: { produced_by: { method: "model" } }, parent_representation_ref: "rep-aaaaaaaaaaaa" }, look));
}

// --- version requirement parsing (the packaging handshake) ---
{
  ok("^1.5 satisfied by 1.6.0", satisfiesRequirement("1.6.0", "^1.5").ok);
  ok("^1.6 satisfied by 1.6.0", satisfiesRequirement("1.6.0", "^1.6").ok);
  ok("^1.7 NOT satisfied by 1.6.0", !satisfiesRequirement("1.6.0", "^1.7").ok);
  ok("^2.0 NOT satisfied by 1.6.0", !satisfiesRequirement("1.6.0", "^2.0").ok);
  ok("~1.6 satisfied by 1.6.2", satisfiesRequirement("1.6.2", "~1.6").ok);
  ok("~1.6 NOT satisfied by 1.7.0", !satisfiesRequirement("1.7.0", "~1.6").ok);
  ok("garbage requirement is refused, not assumed ok", !satisfiesRequirement("1.6.0", "banana").ok);
  ok("VERSION file is the source of truth", /^\d+\.\d+\.\d+$/.test(specVersion()));
}

// --- end-to-end over a real corpus on disk: anchor, code, validate, locate ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upc-coding-"));
  const slug = "s1";
  fs.mkdirSync(path.join(dir, "sources", slug, "representations"), { recursive: true });
  fs.mkdirSync(path.join(dir, "provenance"), { recursive: true });
  fs.mkdirSync(path.join(dir, "codebooks"), { recursive: true });

  const cleanText = "Alpha beta gamma.\nA utility runs the plant.\nAlpha beta gamma.\n";
  const rewriteText = "Alpha beta gamma.\nA utility operates the plant.\nAlpha beta gamma.\n";
  const w = (rel, t) => { fs.writeFileSync(path.join(dir, rel), t); return { rel, sha: sha256Hex(Buffer.from(t, "utf8")), buf: Buffer.from(t, "utf8") }; };
  const A = w(`sources/${slug}/representations/clean.md`, cleanText);
  const B = w(`sources/${slug}/representations/rewrite.md`, rewriteText);
  const repA = mintRepId(A.buf), repB = mintRepId(B.buf);
  const srcId = mintSrcId({ canonicalUrl: "https://example.org/a" });
  const stamp = { produced_by: { tool: "t", method: "import" }, created_at: "2026-01-01T00:00:00Z" };
  fs.writeFileSync(path.join(dir, "sources", slug, "source.json"), JSON.stringify({
    source_id: srcId, source_kind: "url", title: "T",
    retrieval: { original_url: "https://example.org/a", fetch_status: "success" },
    extractions_path: `sources/${slug}/extractions.jsonl`,
    representations: [
      { representation_id: repA, role: "clean_markdown", media_type: "text/markdown", path: A.rel, sha256: A.sha, produced_by: "conversion", provenance: stamp },
      { representation_id: repB, role: "clean_markdown", media_type: "text/markdown", path: B.rel, sha256: B.sha, parent_representation_ref: repA, produced_by: "model", provenance: stamp },
    ],
    provenance: stamp,
  }, null, 2));
  fs.writeFileSync(path.join(dir, "sources", slug, "extractions.jsonl"), "");
  fs.writeFileSync(path.join(dir, "provenance", "events.jsonl"), "");
  fs.writeFileSync(path.join(dir, "corpus.json"), JSON.stringify({
    upc_spec_version: "1.6.0", corpus_id: "cor-000000000001",
    sections: { sources: "sources/", codebooks: "codebooks/", codings: "codings/", provenance: "provenance/events.jsonl" },
  }, null, 2));

  const codes = [
    { code: "operator", label: "Operator", definition: "Runs the plant." },
    { code: "utility", label: "Utility", definition: "A regulated utility.", parent: "operator" },
  ];
  const cbk = { codebook_id: "", namespace: "demo", slug: "actor", title: "Actor", closed: true, revision: 1, revision_digest: codebookRevisionDigest(codes), codes, provenance: stamp };
  cbk.codebook_id = mintCbkId(cbk);
  fs.writeFileSync(path.join(dir, "codebooks", cbk.codebook_id + ".json"), JSON.stringify(cbk, null, 2));
  const open = { codebook_id: "", namespace: "demo", slug: "theme", title: "Theme", closed: false, codes: [{ code: "seed", label: "Seed" }], provenance: stamp };
  open.codebook_id = mintCbkId(open);
  fs.writeFileSync(path.join(dir, "codebooks", open.codebook_id + ".json"), JSON.stringify(open, null, 2));

  // anchor: the gate is the arbiter, not the model.
  const res = anchorCmd(dir, repA, [
    { quote: "A utility runs the plant.", type: "evidence" },
    { quote: "A utility operates the plant.", type: "evidence" },   // exists only in the REWRITE
    { quote: "Alpha beta gamma.", type: "passage" },                // twice -> ambiguous
    { quote: "", type: "evidence" },
  ], { tool: "selftest" });
  eq("anchor: one byte-exact hit is anchored", res.results[0].status, "anchored");
  eq("anchor: a quote absent from the target is not_found", res.results[1].status, "not_found");
  eq("anchor: a repeated span is ambiguous, never active", res.results[2].status, "ambiguous");
  eq("anchor: an empty candidate is invalid", res.results[3].status, "invalid");
  eq("anchor: only unique hits are written", res.wrote, 1);
  const anchored = res.results[0].extraction_id;

  // Re-anchoring the same candidate must not duplicate it.
  const again = anchorCmd(dir, repA, [{ quote: "A utility runs the plant.", type: "evidence" }], { tool: "selftest" });
  eq("anchor: re-running is idempotent", again.results[0].status, "exists");
  eq("anchor: nothing new written on a repeat", again.wrote, 0);

  // The same claim anchored in the model-rewritten copy gates fine but badges differently.
  const rew = anchorCmd(dir, repB, [{ quote: "A utility operates the plant.", type: "evidence" }], { tool: "selftest" });
  eq("anchor: the rewritten wording anchors in the rewrite", rew.results[0].status, "anchored");
  clearRepCache();
  eq("locate: source text badges verified", locateCmd(anchored, dir).badge, "verified");
  eq("locate: model-rewritten text badges verified-to-rewrite", locateCmd(rew.results[0].extraction_id, dir).badge, "verified-to-rewrite");

  // code: closed/open enforcement, resolution, and supersession.
  const T = { kind: "extraction", id: anchored };
  const c1 = codeCmd(dir, "cds-1", [
    { codebook_ref: cbk.codebook_id, code: "utility", target: T, coder: "model-a", confidence: "high" },
    { codebook_ref: cbk.codebook_id, code: "operator", target: T, coder: "ellie" },
    { codebook_ref: open.codebook_id, value: "framing", target: T, coder: "model-a" },
    { codebook_ref: cbk.codebook_id, code: "nope", target: T, coder: "model-a" },
    { codebook_ref: cbk.codebook_id, code: "utility", target: { kind: "extraction", id: "ext-000000000000" }, coder: "model-a" },
    { codebook_ref: cbk.codebook_id, value: "freetext", target: T, coder: "model-a" },
    { codebook_ref: open.codebook_id, code: "seed", target: T, coder: "model-a" },
  ], { tool: "selftest" });
  eq("code: valid closed coding lands", c1.results[0].status, "coded");
  eq("code: a second coder lands separately", c1.results[1].status, "coded");
  eq("code: open codebook takes a value", c1.results[2].status, "coded");
  eq("code: unknown code is refused", c1.results[3].status, "error");
  eq("code: unresolvable target is refused", c1.results[4].status, "error");
  eq("code: a value against a CLOSED codebook is refused", c1.results[5].status, "error");
  eq("code: a code against an OPEN codebook is refused", c1.results[6].status, "error");
  eq("code: only the valid rows are written", c1.wrote, 3);

  const c2 = codeCmd(dir, "cds-1", [{ codebook_ref: cbk.codebook_id, code: "utility", target: T, coder: "model-a", confidence: "high" }], { tool: "selftest" });
  eq("code: an unchanged re-run is idempotent", c2.results[0].status, "unchanged");
  eq("code: an unchanged re-run writes nothing new", c2.wrote, 0);

  {
    clearRepCache();
    const mid = validateCorpus(dir);
    const codes0 = mid.warnings.map((x) => x.code);
    ok("validate: two coders with different codes raise coding_disagreement",
      codes0.includes("coding_disagreement") && !mid.errors.map((x) => x.code).includes("coding_disagreement"));
    eq("validate: disagreement does not fail the corpus", mid.status, "passed");
  }

  const c3 = codeCmd(dir, "cds-1", [{ codebook_ref: cbk.codebook_id, code: "operator", target: T, coder: "model-a" }], { tool: "selftest" });
  eq("code: a changed answer supersedes rather than mutating", c3.results[0].status, "coded");
  ok("code: the superseded id is linked", !!c3.results[0].supersedes);
  {
    const items = fs.readFileSync(path.join(dir, "codings", "cds-1", "items.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const old = items.find((o) => o.coding_id === c3.results[0].supersedes);
    eq("code: the old judgement is retained, not deleted", old.status, "superseded");
    eq("code: and points forward", old.superseded_by, c3.results[0].coding_id);
    const man = JSON.parse(fs.readFileSync(path.join(dir, "codings", "cds-1", "manifest.json"), "utf8"));
    ok("code: coders are declared in the set manifest", man.coders.some((c) => c.coder === "model-a") && man.coders.some((c) => c.coder === "ellie"));
    ok("code: codebook_refs are indexed", man.codebook_refs.includes(cbk.codebook_id));
  }

  clearRepCache();
  const rep1 = validateCorpus(dir);
  eq("validate: a coded corpus passes", rep1.status, "passed");
  eq("validate: codings do not change the conformance level", rep1.level, "L1");
  eq("validate: codebooks are counted", rep1.counts.codebooks, 2);
  const codeOf = (arr) => arr.map((x) => x.code);
  // model-a has since revised to "operator", so the two coders now agree and the
  // advisory must clear on its own rather than lingering as stale noise.
  ok("validate: the disagreement advisory clears once coders agree", !codeOf(rep1.warnings).includes("coding_disagreement"));
  ok("validate: an unapplied code is flagged for hygiene", codeOf(rep1.warnings).includes("codebook_code_unused"));

  // A tampered coding id must be caught, exactly like every other object id.
  {
    const f = path.join(dir, "codings", "cds-1", "items.jsonl");
    const orig = fs.readFileSync(f, "utf8");
    const lines = orig.trim().split("\n").map((l) => JSON.parse(l));
    lines[0].coding_id = "cod-000000000000";
    fs.writeFileSync(f, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
    clearRepCache();
    ok("validate: a hand-typed coding id is caught by recompute", codeOf(validateCorpus(dir).errors).includes("id_mismatch"));
    fs.writeFileSync(f, orig);
  }

  // A code on a span that later breaks is an advisory, never an error: the coding
  // remains a faithful record of a judgement; the SPAN is what broke.
  {
    const f = path.join(dir, "sources", slug, "extractions.jsonl");
    const orig = fs.readFileSync(f, "utf8");
    const lines = orig.trim().split("\n").map((l) => JSON.parse(l));
    lines[0].locator.value = { start: 0, end: 5 };   // drift the offsets, keep the quote
    fs.writeFileSync(f, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
    clearRepCache();
    const r = validateCorpus(dir);
    ok("validate: the drifted span fails its gate", codeOf(r.errors).includes("quote_gate_failed"));
    ok("validate: the coding on it is only an advisory", codeOf(r.warnings).includes("coding_targets_failed_gate"));
    ok("validate: coding_targets_failed_gate is never an error", !codeOf(r.errors).includes("coding_targets_failed_gate"));
    fs.writeFileSync(f, orig);
  }

  // Codebook hierarchy integrity.
  {
    const bad = { codebook_id: "", namespace: "demo", slug: "cycle", title: "C", closed: true, provenance: stamp,
      codes: [{ code: "a", label: "A", parent: "b" }, { code: "b", label: "B", parent: "a" }] };
    bad.codebook_id = mintCbkId(bad);
    const f = path.join(dir, "codebooks", bad.codebook_id + ".json");
    fs.writeFileSync(f, JSON.stringify(bad, null, 2));
    clearRepCache();
    ok("validate: a parent cycle is an error", codeOf(validateCorpus(dir).errors).includes("codebook_parent_cycle"));
    bad.codes = [{ code: "a", label: "A", parent: "ghost" }];
    fs.writeFileSync(f, JSON.stringify(bad, null, 2));
    clearRepCache();
    ok("validate: a dangling parent is an error", codeOf(validateCorpus(dir).errors).includes("codebook_parent_dangling"));
    bad.codes = [{ code: "a", label: "A" }, { code: "a", label: "Again" }];
    fs.writeFileSync(f, JSON.stringify(bad, null, 2));
    clearRepCache();
    ok("validate: a duplicate code token is an error", codeOf(validateCorpus(dir).errors).includes("codebook_code_duplicate"));
    fs.rmSync(f);
  }

  // batch: many reads, one corpus load.
  clearRepCache();
  {
    const out = batchCmd(dir, [
      JSON.stringify({ cmd: "locate", ext: anchored }),
      JSON.stringify({ cmd: "verify", ext: anchored }),
      JSON.stringify({ cmd: "codebook" }),
      JSON.stringify({ cmd: "nonsense" }),
    ].join("\n"));
    eq("batch: locate answers", out[0].result.badge, "verified");
    eq("batch: verify answers", out[1].result.verified, true);
    eq("batch: codebook answers", out[2].result.codebooks.length, 2);
    ok("batch: an unknown command errors per-line, not fatally", !!out[3].error);
  }
  eq("mint --batch returns one id per line", mintBatchCmd("cbk", '{"namespace":"a","slug":"b"}\n{"namespace":"a","slug":"c"}').length, 2);
  {
    const inspected = codebookCmd(dir, cbk.codebook_id);
    ok("codebook: applied counts are computed, never stored", inspected.codes.every((c) => typeof c.applied === "number"));
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- normalized re-find: the model may mistype, the corpus may not ---
//
// A model copying a span out of PDF-extracted text renders it in ordinary
// characters: straight quotes, "fi" for a ligature, a space where the page had
// a line break. The span is really there. What must never happen is that the
// model's rendering gets stored as though the document said it.
{
  const mk = (t) => ({ utf8ok: true, text: t, cps: Array.from(t) });

  // The map is indexed by UTF-16 code unit so it survives astral characters;
  // indexing it by codepoint would shift every offset after the first emoji.
  {
    const n = normalizeForRefind(Array.from("\u{1F600}a“b"));
    eq("refind: map is code-unit indexed", n.map.length, n.norm.length);
    eq("refind: astral maps back to its own codepoint", n.map[n.norm.indexOf('"')], 2);
  }

  const R = mk('A “regime shift” in the ﬁrst transi-\ntion, 1990–2000.');
  {
    const r = refindSpan(R, 'A "regime shift" in the first transition, 1990-2000.');
    eq("refind: locates a span the model retyped", r.status, "refound");
    eq("refind: stores the document's own characters", r.quote, R.cps.slice(r.start, r.end).join(""));
    ok("refind: the stored quote is not the proposal", r.quote !== 'A "regime shift" in the first transition, 1990-2000.');
    // The line break here is consumed by the hyphenation rule, not the
    // whitespace rule, so "whitespace" correctly does not appear.
    eq("refind: reports which liberties it took", r.classes.join(","), "quotes,dashes,hyphenation,ligatures");
    eq("refind: a plain line break reports whitespace",
       refindSpan(mk("regime\nshift here"), "regime shift here").classes.join(","), "whitespace");
  }

  eq("refind: soft hyphens are invisible to the search",
     refindSpan(mk("co­evolution here"), "coevolution here").status, "refound");
  eq("refind: an ellipsis character matches three dots",
     refindSpan(mk("and so… onward"), "and so... onward").status, "refound");
  eq("refind: a span occurring twice is ambiguous, never minted",
     refindSpan(mk('a “regime” and a “regime”'), 'a "regime"').status, "ambiguous");
  eq("refind: a fabricated span is not found",
     refindSpan(mk("nothing like it here"), "invented wording").status, "not_found");
  // A model quoting from mid-sentence capitalises the first letter. That one
  // character is tolerated — and the document's own casing is what gets stored.
  {
    const r = refindSpan(mk("Specifically, in the first phase, policy matters."), "In the first phase, policy matters.");
    eq("refind: a capitalised mid-sentence start is tolerated", r.status, "refound");
    eq("refind: the document's own casing is stored", r.quote, "in the first phase, policy matters.");
    ok("refind: the liberty is reported", r.classes.includes("initial-case"));
  }
  // Beyond that first character, case is NOT folded: it would let visibly
  // different text match, and the point of the gate is that what is stored is
  // what the document says. Unicode normal forms are likewise not applied.
  eq("refind: interior case is not folded", refindSpan(mk("the Regime shift"), "the regime shift").status, "not_found");
  eq("refind: a wholly different case pattern is not folded", refindSpan(mk("THE REGIME"), "the regime").status, "not_found");

  // Integration: the same thing through anchorCmd, ending in a real gate.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upc-refind-"));
  fs.mkdirSync(path.join(dir, "sources", "s1", "representations"), { recursive: true });
  fs.mkdirSync(path.join(dir, "provenance"), { recursive: true });
  const text = "Intro line.\nThe “ﬁrst” point of a transi-\ntion is simple.\nEnd.\n";
  const buf = Buffer.from(text, "utf8");
  fs.writeFileSync(path.join(dir, "sources", "s1", "representations", "clean.md"), buf);
  const rep = mintRepId(buf);
  const stamp = { produced_by: { tool: "t", method: "import" }, created_at: "2026-01-01T00:00:00Z" };
  fs.writeFileSync(path.join(dir, "sources", "s1", "source.json"), JSON.stringify({
    source_id: mintSrcId({ canonicalUrl: "https://example.org/r" }), source_kind: "url", title: "T",
    retrieval: { original_url: "https://example.org/r", fetch_status: "success" },
    extractions_path: "sources/s1/extractions.jsonl",
    representations: [{ representation_id: rep, role: "clean_markdown", media_type: "text/markdown",
      path: "sources/s1/representations/clean.md", sha256: sha256Hex(buf), produced_by: "conversion", provenance: stamp }],
    provenance: stamp,
  }, null, 2));
  fs.writeFileSync(path.join(dir, "sources", "s1", "extractions.jsonl"), "");
  fs.writeFileSync(path.join(dir, "provenance", "events.jsonl"), "");
  fs.writeFileSync(path.join(dir, "corpus.json"), JSON.stringify({
    upc_spec_version: specVersion(), corpus_id: "cor-000000000002",
    sections: { sources: "sources/", provenance: "provenance/events.jsonl" },
  }, null, 2));

  const retyped = 'The "first" point of a transition is simple.';
  clearRepCache();
  eq("anchor: without --normalize a retyped span is not found",
     anchorCmd(dir, rep, [{ quote: retyped }], { tool: "selftest", dryRun: true }).results[0].status, "not_found");

  clearRepCache();
  const res = anchorCmd(dir, rep, [{ quote: retyped }], { tool: "selftest", normalize: true });
  eq("anchor: --normalize locates it", res.results[0].status, "refound");
  eq("anchor: the refound span is written", res.wrote, 1);
  eq("anchor: tally counts refound separately from anchored", res.tally.refound, 1);

  const ext = JSON.parse(fs.readFileSync(path.join(dir, "sources", "s1", "extractions.jsonl"), "utf8").trim());
  eq("anchor: direct_quote is the representation's text", ext.direct_quote,
     Array.from(text).slice(ext.locator.value.start, ext.locator.value.end).join(""));
  eq("anchor: the model's proposal is recorded, not stored as the quote", ext.anchoring.proposed_quote, retyped);
  eq("anchor: the method is recorded", ext.anchoring.method, "normalized");
  ok("anchor: the proposal is not what got minted", ext.direct_quote !== retyped);

  // The whole point: a normalized SEARCH still yields a quotation that passes
  // the unnormalized gate. Nothing here can make a bad quote verify.
  clearRepCache();
  const { text: fileText } = { text: fs.readFileSync(path.join(dir, "sources", "s1", "representations", "clean.md"), "utf8") };
  eq("anchor: the refound extraction passes hop B",
     verifyHopB(ext, { utf8ok: true, text: fileText, cps: Array.from(fileText) }).ok, true);
  clearRepCache();
  const rep2 = validateCorpus(dir);
  eq("validate: a corpus with a refound quotation passes", rep2.status, "passed");
  ok("validate: no gate failure from normalization", !rep2.errors.map((e) => e.code).includes("quote_gate_failed"));

  // Idempotence: the id is over the STORED quote, so re-running writes nothing.
  clearRepCache();
  eq("anchor: re-running a refound candidate is idempotent",
     anchorCmd(dir, rep, [{ quote: retyped }], { tool: "selftest", normalize: true }).results[0].status, "exists");

  // An extraction SET must be declared in corpus.json, or its items are written
  // where loadCorpus will never look and every coding that targets one dangles.
  clearRepCache();
  const setRes = anchorCmd(dir, rep, [{ quote: "Intro line." }], { tool: "selftest", normalize: true, set: "exs-1" });
  eq("anchor: a set candidate is anchored", setRes.results[0].status, "anchored");
  {
    const cj = JSON.parse(fs.readFileSync(path.join(dir, "corpus.json"), "utf8"));
    ok("anchor: creating a set declares sections.extractions", !!cj.sections.extractions);
    clearRepCache();
    const loadedAgain = loadCorpus(dir);
    ok("anchor: a set's items are visible to loadCorpus",
       loadedAgain.extractions.some((e) => e.obj.extraction_id === setRes.results[0].extraction_id));
  }

  // A coding run in which nothing lands must leave nothing behind: an empty
  // `coders` array is schema-invalid and would fail an otherwise clean corpus.
  clearRepCache();
  const noneLanded = codeCmd(dir, "cds-empty", [
    { codebook_ref: "cbk-000000000000", code: "x", target: { kind: "extraction", id: "ext-000000000000" }, coder: "m" },
  ], { tool: "selftest" });
  eq("code: a coding against an unknown codebook errors", noneLanded.results[0].status, "error");
  ok("code: a run that lands nothing writes no set manifest",
     !fs.existsSync(path.join(dir, "codings", "cds-empty", "manifest.json")));
  clearRepCache();
  eq("validate: a failed coding run leaves the corpus valid", validateCorpus(dir).status, "passed");

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- `upc add`: the producer primitive, and what it refuses ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upc-add-"));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "upc-stage-"));
  fs.mkdirSync(path.join(dir, "provenance"), { recursive: true });
  fs.writeFileSync(path.join(dir, "provenance", "events.jsonl"), "");
  fs.writeFileSync(path.join(dir, "corpus.json"), JSON.stringify({
    upc_spec_version: specVersion(), corpus_id: "cor-000000000005",
    sections: { sources: "sources/", provenance: "provenance/events.jsonl" },
  }, null, 2));

  const pdfPath = path.join(stage, "paper.pdf");
  const txtPath = path.join(stage, "paper.txt");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\nnot really a pdf\n"));
  fs.writeFileSync(txtPath, "The regime resists change.\n\nA second paragraph.\n");

  const rec = {
    slug: "a-paper", title: "A paper", source_kind: "document",
    bibliographic: { item_type: "article-journal", title: "A paper", issued: { date_parts: [[2026]] } },
    aliases: { demo: "p1" },
    files: [
      { path: pdfPath, role: "document_pdf", media_type: "application/pdf", produced_by: "import" },
      { path: txtPath, role: "text", media_type: "text/plain", produced_by: "conversion", parent: 0 },
    ],
  };
  const res = addSourceCmd(dir, [rec], { tool: "selftest" });
  eq("add: a source is written", res.results[0].status, "added");
  eq("add: both files become representations", res.results[0].representation_ids.length, 2);
  ok("add: the bytes land inside the corpus",
     fs.existsSync(path.join(dir, "sources", "a-paper", "representations", "paper.txt")));
  {
    const src = JSON.parse(fs.readFileSync(path.join(dir, "sources", "a-paper", "source.json"), "utf8"));
    const txt = src.representations.find((r) => r.media_type === "text/plain");
    eq("add: a text representation records its codepoint count", txt.char_count, 48);
    eq("add: the derived text points at what it came from", txt.parent_representation_ref,
       src.representations.find((r) => r.media_type === "application/pdf").representation_id);
    eq("add: the id is the byte hash", txt.representation_id,
       mintRepId(fs.readFileSync(txtPath)));
  }
  // Re-adding the same bytes is not a second source.
  clearRepCache();
  eq("add: the same document twice is one source",
     addSourceCmd(dir, [rec], { tool: "selftest" }).results[0].status, "exists");

  // A symlink would let the corpus's bytes change from outside it.
  const linkPath = path.join(stage, "link.txt");
  fs.symlinkSync(txtPath, linkPath);
  const bad = addSourceCmd(dir, [{ ...rec, slug: "b", files: [{ path: linkPath, role: "text", media_type: "text/plain" }] }],
                           { tool: "selftest" });
  eq("add: a symlink is refused", bad.results[0].status, "error");
  ok("add: the refusal says why", /symlink/.test(bad.results[0].detail));

  clearRepCache();
  eq("add: the corpus is valid after adding", validateCorpus(dir).status, "passed");

  // A synthesis that misquotes its evidence must not be written at all.
  clearRepCache();
  const loaded2 = loadCorpus(dir);
  const textRep = loaded2.representations.find((r) => r.obj.media_type === "text/plain").obj.representation_id;
  const anch = anchorCmd(dir, textRep, [{ quote: "The regime resists change." }], { tool: "selftest" });
  const eid = anch.results[0].extraction_id;
  const sid = loaded2.sources[0].obj.source_id;
  const good = path.join(stage, "good.md");
  const bad2 = path.join(stage, "bad.md");
  fs.writeFileSync(good, `# Overview\n\nAs it says, "The regime resists change." [${eid}].\n\n## Sources\n\n- ${sid}\n`);
  fs.writeFileSync(bad2, `# Overview\n\nAs it says, "The regime WELCOMES change." [${eid}].\n\n## Sources\n\n- ${sid}\n`);
  const claims = [{ claim_id: "cl-0001", text: "Regimes resist.", evidence_ids: [eid] }];

  clearRepCache();
  const refused = addSynthesisCmd(dir, { type: "thematic", title: "Bad", claims }, { output: bad2, tool: "selftest" });
  eq("add synthesis: a misquotation is refused", refused.status, "refused");
  eq("add synthesis: nothing is written on refusal", refused.wrote, 0);

  clearRepCache();
  const okSyn = addSynthesisCmd(dir, { type: "thematic", title: "Good", claims }, { output: good, tool: "selftest" });
  eq("add synthesis: a correct quotation is written", okSyn.status, "ok");
  ok("add synthesis: it lands where loadCorpus looks",
     fs.existsSync(path.join(dir, "syntheses", okSyn.synthesis_id, "synthesis.json")));

  // The overviews list is the navigation, so it is on the page beside whatever
  // is being read — not replaced by it. Both shapes have to do this.
  {
    clearRepCache();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "upc-ov-"));
    writeSite(dir, { out });
    const idx = fs.readFileSync(path.join(out, "overviews", "index.html"), "utf8");
    const one = fs.readFileSync(path.join(out, "overviews", okSyn.synthesis_id + ".html"), "utf8");
    ok("overviews: the index is a list beside a pane", /class="split"/.test(idx) && /id="ov-side"/.test(idx));
    ok("overviews: reading one keeps the whole list on the page",
       /id="ov-side"/.test(one) && one.includes(okSyn.synthesis_id + ".html"));
    ok("overviews: the one being read is marked in that list", /<a class="on"/.test(one));
    ok("overviews: the list can be filtered without leaving the page", /data-sidefilter/.test(one));
    ok("overviews: the folder renders the list of papers as a list", /<ul class="refs"><li>/.test(one));
    ok("overviews: a bare source id becomes a link to its paper", /<ul class="refs"><li><a class="small" href="\.\.\/sources\//.test(one));

    clearRepCache();
    const file = path.join(out, "one.html");
    writeSingleFile(dir, { out: file });
    const html = fs.readFileSync(file, "utf8");
    ok("one file: reading copies are parsed on demand, not all at once",
       /id="upc-t0"/.test(html) && !/"texts":/.test(html));
    ok("one file: moving between overviews swaps the pane, not the list",
       /ov-pane"\)\.innerHTML=overviewBody/.test(html));
    ok("one file: it carries the same browse engine as the folder", /window\.UPCB=API/.test(html));
    ok("one file: overviews arrive rendered by the same function as the folder",
       html.includes('"h":"') && !html.includes('"md":') && html.includes('\\u003cul class=\\"refs\\">'));
    fs.rmSync(out, { recursive: true, force: true });
  }

  // A summary placed on the home page: gated like any synthesis, recorded as
  // drawing on the overview it names, shown on Home, never among the overviews.
  {
    clearRepCache();
    const homeMd = path.join(stage, "home.md");
    fs.writeFileSync(homeMd, `# Home\n\nAs one paper puts it, "The regime resists change." [${eid}]\n\n- The paper · \`${sid}\` · [${eid}]\n`);
    const homeObj = { type: "answer", title: "What the literature says", question: "What does it say?",
      claims: [{ claim_id: "cl-h1", text: "Regimes resist.", evidence_ids: [eid] }],
      ext: { "upc-site": { placement: "home" } },
      provenance: { produced_by: { tool: "selftest", model: "test-model", method: "model" },
                    derived_from: { synthesis_ids: [okSyn.synthesis_id] } } };
    const placed = addSynthesisCmd(dir, homeObj, { output: homeMd, tool: "selftest" });
    eq("home summary: added through the same gate", placed.status, "ok");
    const hj = JSON.parse(fs.readFileSync(path.join(dir, "syntheses", placed.synthesis_id, "synthesis.json"), "utf8"));
    ok("home summary: derived_from keeps what it cites and adds the overview it names",
       (hj.provenance.derived_from.extraction_ids || []).includes(eid) && (hj.provenance.derived_from.source_ids || []).includes(sid) &&
       JSON.stringify(hj.provenance.derived_from.synthesis_ids) === JSON.stringify([okSyn.synthesis_id]));
    clearRepCache();
    eq("home summary: the corpus still validates", validateCorpus(dir).status, "passed");
    clearRepCache();
    eq("home summary: naming an overview that does not exist is refused",
       addSynthesisCmd(dir, { ...homeObj, title: "Ghost", provenance: { produced_by: { tool: "t", method: "model" },
         derived_from: { synthesis_ids: ["syn-000000000000"] } } }, { output: homeMd, tool: "selftest" }).status, "refused");
    const themeMd = path.join(stage, "theme.md");
    fs.writeFileSync(themeMd, `Themes: [theme:nobook/nothing]. "The regime resists change." [${eid}]\n\n- The paper · \`${sid}\` · [${eid}]\n`);
    clearRepCache();
    eq("home summary: a theme link to a code that does not exist is refused",
       addSynthesisCmd(dir, { ...homeObj, title: "Bad theme", provenance: { produced_by: { tool: "t", method: "model" } } },
                       { output: themeMd, tool: "selftest" }).status, "refused");

    clearRepCache();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "upc-home-"));
    const res = writeSite(dir, { out });
    const idx = fs.readFileSync(path.join(out, "index.html"), "utf8");
    ok("home summary: the home page carries it, headed", idx.includes('<section class="card homesum"><h2>What the literature says</h2>'));
    ok("home summary: the page leads with the summary, not a paragraph about it", !/Written by/.test(idx));
    ok("home summary: who wrote it stays in its record", hj.provenance.produced_by.model === "test-model");
    ok("home summary: its quotation is linked and checked", /“The regime resists change\.”<\/a> <span class="small">✓/.test(idx));
    ok("home summary: its papers fold away", idx.includes('<details class="refs-fold"><summary>1 paper this draws on</summary><ul class="refs">'));
    ok("home summary: nothing stands between its heading and its first point",
       /<section class="card homesum"><h2>What the literature says<\/h2><p>As one paper/.test(idx));
    ok("home summary: with it above, the overviews are where to go deeper", idx.includes("<strong>Go deeper:</strong>"));
    const ovIdx = fs.readFileSync(path.join(out, "overviews", "index.html"), "utf8");
    ok("home summary: never listed among the overviews", ovIdx.includes(okSyn.synthesis_id) && !ovIdx.includes(placed.synthesis_id));
    ok("home summary: no overview page is written for it", !fs.existsSync(path.join(out, "overviews", placed.synthesis_id + ".html")));
    eq("home summary: the export says which summary it showed", res.home_summary, placed.synthesis_id);
    const file = path.join(out, "one.html");
    writeSingleFile(dir, { out: file });
    const payload = JSON.parse(fs.readFileSync(file, "utf8").match(/<script type="application\/json" id="upc-data">([\s\S]*?)<\/script>/)[1]);
    ok("one file: carries the summary, rendered, and nothing about it", payload.home && payload.home.t === "What the literature says" &&
       /✓/.test(payload.home.h) && !/Written by/.test(payload.home.h));
    ok("one file: and keeps it out of the overviews", !payload.overviews.some((o) => o.id === placed.synthesis_id));
    fs.rmSync(out, { recursive: true, force: true });
    // Leave the fixture as the tests below expect it: they count its syntheses.
    fs.rmSync(path.join(dir, "syntheses", placed.synthesis_id), { recursive: true, force: true });
  }

  // Rule 2.4: prose that never names its source is caught before writing.
  const uncited = path.join(stage, "uncited.md");
  fs.writeFileSync(uncited, `# Overview\n\nAs it says, "The regime resists change." [${eid}].\n`);
  clearRepCache();
  eq("add synthesis: prose that never cites its source is refused",
     addSynthesisCmd(dir, { type: "thematic", title: "U", claims }, { output: uncited, tool: "selftest" }).status,
     "refused");

  // ... and so is prose whose CLAIM rests on a passage the prose never marks.
  // Checking only the sources let a synthesis through that then failed validation.
  {
    const other = anchorCmd(dir, textRep, [{ quote: "A second paragraph." }], { tool: "selftest" });
    const otherId = other.results[0].extraction_id;
    const silent = path.join(stage, "silent.md");
    fs.writeFileSync(silent, `# Overview\n\nAs it says, "The regime resists change." [${eid}].\n\n## Sources\n\n- ${sid}\n`);
    clearRepCache();
    const r = addSynthesisCmd(dir, { type: "thematic", title: "S",
      claims: [{ claim_id: "cl-0001", text: "Rests on an unmarked passage.", evidence_ids: [otherId] }] },
      { output: silent, tool: "selftest" });
    eq("add synthesis: a claim citing an unmarked passage is refused", r.status, "refused");
    ok("add synthesis: the refusal names the passage", (r.failures || []).some((f) => f.marker === otherId));
  }

  clearRepCache();
  const rep2 = validateCorpus(dir);
  eq("validate: the corpus with a synthesis is valid", rep2.status, "passed");
  eq("validate: it reaches L2", rep2.level, "L2");

  // A second synthesis must be discoverable even though corpus.json now carries
  // an index naming only the first. Reading the index INSTEAD of scanning made it
  // self-perpetuating: anything a later run wrote could never be found, and regen
  // rebuilt the index from the same short list it had just failed to extend.
  {
    const good2 = path.join(stage, "good2.md");
    fs.writeFileSync(good2, `# Second\n\nAgain, "The regime resists change." [${eid}].\n\n## Sources\n\n- ${sid}\n`);
    clearRepCache();
    const two = addSynthesisCmd(dir, { type: "memo", title: "Second", claims }, { output: good2, tool: "selftest" });
    eq("add synthesis: a second one is written", two.status, "ok");
    // Simulate the state regen leaves: an index naming only what existed then.
    const cjPath = path.join(dir, "corpus.json");
    const cj = JSON.parse(fs.readFileSync(cjPath, "utf8"));
    cj.syntheses = [{ synthesis_id: okSyn.synthesis_id, path: `syntheses/${okSyn.synthesis_id}/`, title: "Good" }];
    fs.writeFileSync(cjPath, JSON.stringify(cj, null, 2));
    clearRepCache();
    eq("loadCorpus: a synthesis missing from the index is still found",
       loadCorpus(dir).syntheses.length, 2);
    clearRepCache();
    eq("validate: the corpus is still valid with both", validateCorpus(dir).status, "passed");
  }

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stage, { recursive: true, force: true });
}

// --- an overview's markdown, as a reader should see it ---
//
// Found on the live site: the list of papers each overview drew on rendered as
// one run-on line, raw source ids in backticks, each paper's citation repeated
// once per passage. The input below is the shape synthesize.py writes.
{
  const P = (id, src, citeText, slug) => [id, { id, source_id: src, cite: citeText, badge: "verified-to-transcript", source_slug: slug }];
  const model = {
    passageById: new Map([P("ext-aaaaaaaaaaaa", "src-111111111111", "Geels 2017", "s1"),
                          P("ext-bbbbbbbbbbbb", "src-111111111111", "Geels 2017", "s1"),
                          P("ext-cccccccccccc", "src-222222222222", "Mu 2026", "s2")]),
    sourceById: new Map([["src-111111111111", { id: "src-111111111111", cite: "Geels 2017", slug: "s1" }],
                         ["src-222222222222", { id: "src-222222222222", cite: "Mu 2026", slug: "s2" }]]),
  };
  const links = { passage: (p) => `P:${p.id}`, source: (x) => `S:${x.id}` };
  const md = "Regimes resist change [ext-aaaaaaaaaaaa]. Both agree [ext-bbbbbbbbbbbb] [ext-cccccccccccc].\n" +
             "*correction: [ext-23574d3b878]*\n\n## Passages this draws on\n\n" +
             "- A paper about regimes · `src-111111111111` · [ext-aaaaaaaaaaaa] [ext-bbbbbbbbbbbb]\n" +
             "- Another <b>paper</b> · `src-222222222222` · [ext-cccccccccccc]\n";
  const html = renderOverviewMarkdown(md, model, links);
  const items = html.match(/<li>[\s\S]*?<\/li>/g) || [];
  ok("overview md: the papers it drew on are a real list", /<ul class="refs">/.test(html) && items.length === 2);
  ok("overview md: no raw source id or backtick reaches the reader", !/`/.test(html) && !/>\s*src-/.test(html));
  ok("overview md: each paper links to its page", items[0].includes('href="S:src-111111111111"') && items[1].includes('href="S:src-222222222222"'));
  ok("overview md: a paper's passages are numbered links, not its citation repeated",
     /passages<\/span> <a class="pn" href="P:ext-aaaaaaaaaaaa"[^>]*>1<\/a> <a class="pn" href="P:ext-bbbbbbbbbbbb"[^>]*>2<\/a>/.test(items[0]) &&
     (items[0].match(/Geels 2017<\/a>/g) || []).length === 1);
  ok("overview md: one passage says 'passage'", /passage<\/span> <a class="pn"/.test(items[1]));
  ok("overview md: citations side by side in prose are separated", /Geels 2017<\/a>; <a class="small" href="P:ext-cccccccccccc">Mu 2026<\/a>/.test(html));
  ok("overview md: italics render, and a malformed marker stays plain text", html.includes("<em>correction: [ext-23574d3b878]</em>"));
  ok("overview md: markup in the text is escaped, never obeyed", html.includes("Another &lt;b&gt;paper&lt;/b&gt;") && !html.includes("<b>"));
  ok("overview md: the heading is a heading", html.includes("<h2>Passages this draws on</h2>"));
  eq("overview md: the prose is one paragraph", (html.match(/<p>/g) || []).length, 1);
}

// --- quotations, theme links and views in overview prose ---
//
// A quotation containing an apostrophe or an ampersand was never recognised (the
// pattern stopped at the first "&" of the escaped text), and ✓ said only that
// the passage matched its paper, not that the quoted words were the passage's.
{
  const Q = (id, quote, src = "src-111111111111") =>
    [id, { id, source_id: src, cite: "Geels 2017", badge: "verified-to-transcript", source_slug: "s1", quote }];
  const theory = { codebook_id: "cbk-000000000001", slug: "theory", title: "Theory",
    codes: [{ code: "mlp", label: "Multi-level perspective" }, { code: "tis", label: "Technological innovation systems" },
            { code: "spt", label: "Social practice theory" }] };
  const dimension = { codebook_id: "cbk-000000000002", slug: "dimension", title: "Dimension", codes: [{ code: "power", label: "Power" }] };
  const model = {
    passageById: new Map([Q("ext-aaaaaaaaaaaa", "the regime's core"), Q("ext-bbbbbbbbbbbb", "R&D matters"),
                          Q("ext-cccccccccccc", "plain words", "src-222222222222")]),
    sourceById: new Map([["src-111111111111", { id: "src-111111111111", cite: "Geels 2017", slug: "s1" }],
                         ["src-222222222222", { id: "src-222222222222", cite: "Mu 2026", slug: "s2" }]]),
    codebooks: [theory, dimension],
    codeIndex: new Map([
      ["cbk-000000000001:mlp", { passages: ["ext-aaaaaaaaaaaa", "ext-bbbbbbbbbbbb", "ext-cccccccccccc"],
                                 sources: new Set(["src-111111111111", "src-222222222222", "src-333333333333"]) }],
      ["cbk-000000000001:tis", { passages: ["ext-aaaaaaaaaaaa"], sources: new Set(["src-111111111111"]) }],
      ["cbk-000000000001:spt", { passages: [], sources: new Set(["src-111111111111", "src-222222222222"]) }],
    ]),
    overviewByCode: new Map([["theory:mlp", { synthesis_id: "syn-000000000001", title: "Multi-level perspective" }]]),
    matrix: ["theory", "dimension"],
  };
  const links = { passage: (x) => `P:${x.id}`, source: (x) => `S:${x.id}`, overview: (o) => `O:${o.synthesis_id}`,
                  code: (sl, c) => `C:${sl}/${c}`, view: (n) => `V:${n}` };
  const r = (md, o) => renderOverviewMarkdown(md, model, links, o);

  ok("prose quote: an apostrophe no longer hides a quotation",
     /<a href="P:ext-aaaaaaaaaaaa"[^>]*>“the regime&#39;s core”<\/a> <span class="small">✓/.test(r(`As they put it, "the regime's core" [ext-aaaaaaaaaaaa].`)));
  ok("prose quote: nor does an ampersand",
     /<a href="P:ext-bbbbbbbbbbbb"[^>]*>“R&amp;D matters”<\/a> <span class="small">✓/.test(r(`"R&D matters" [ext-bbbbbbbbbbbb]`)));
  const wrong = r(`"the regime's heart" [ext-aaaaaaaaaaaa]`);
  ok("prose quote: words that are not the passage's own lose the check mark",
     wrong.includes("⚠") && !wrong.includes("✓") && wrong.includes("Doesn&#39;t match the passage it cites"));
  ok("prose quote: two spaces before the marker is not a quotation, as the gate says",
     !/“plain words”/.test(r(`"plain words"  [ext-cccccccccccc]`)));

  const t = r("[theme:theory/mlp] [theme:theory/tis] [theme:theory/spt] [theme:theory/nope] [theme:nobook/x]");
  ok("theme: named, and linked to its current overview", t.includes('<a href="O:syn-000000000001">Multi-level perspective</a>'));
  ok("theme: counts say passages and the papers they come from, not a mixed total", t.includes("(3 passages from 2 papers)"));
  ok("theme: one passage from one paper reads in the singular", t.includes("(1 passage from 1 paper)"));
  ok("theme: a code with no overview links its code page", t.includes('<a href="C:theory/tis">Technological innovation systems</a>'));
  ok("theme: a code coded only on whole papers says so", t.includes("(2 papers coded as a whole)"));
  ok("theme: a code that does not exist is visibly inert, never a dead link",
     t.includes("theory/nope (not in this corpus)") && t.includes("nobook/x (not in this corpus)") && !t.includes('href="C:theory/nope"'));

  ok("view: the matrix is named from its two codebooks", r("[view:matrix]").includes('<a href="V:matrix">Theory × Dimension</a>'));
  ok("view: every passage", r("[view:passages]").includes('<a href="V:passages">every passage</a>'));
  const noMatrix = renderOverviewMarkdown("[view:matrix]", { ...model, matrix: null }, links);
  ok("view: a matrix that was not built says so rather than linking nowhere",
     noMatrix.includes("not built for this site") && !noMatrix.includes("V:matrix"));

  const refs = "Prose [ext-aaaaaaaaaaaa].\n\n- A paper · `src-111111111111` · [ext-aaaaaaaaaaaa]\n- Another · `src-222222222222` · [ext-cccccccccccc]\n";
  ok("refs: fold away under a count when asked",
     /<details class="refs-fold"><summary>2 papers this draws on<\/summary><ul class="refs">/.test(r(refs, { foldRefs: true })));
  ok("refs: stay an open list otherwise", !r(refs).includes("<details") && r(refs).includes('<ul class="refs">'));
}

// --- corpus.json is an index, not the register of what exists ---
//
// Reading the sources index *instead of* scanning made it self-perpetuating: a
// source directory written by anything else could never be found, `regen` kept
// rebuilding the index from the same short list, and `validate` reported the new
// source as an orphan no amount of regenerating could adopt. Found the day a
// corrected paper was added to a finished 178-paper corpus.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upc-index-"));
  const stamp = { produced_by: { tool: "t", method: "import" }, created_at: "2026-01-01T00:00:00Z" };
  const mk = (slug, url) => {
    fs.mkdirSync(path.join(dir, "sources", slug), { recursive: true });
    fs.writeFileSync(path.join(dir, "sources", slug, "source.json"), JSON.stringify({
      source_id: mintSrcId({ canonicalUrl: url }), source_kind: "url", title: slug,
      retrieval: { original_url: url, fetch_status: "success" },
      representations: [], provenance: stamp,
    }, null, 2));
  };
  mk("listed", "https://example.org/listed");
  mk("only-on-disk", "https://example.org/orphan");
  fs.writeFileSync(path.join(dir, "corpus.json"), JSON.stringify({
    upc_spec_version: specVersion(), corpus_id: "cor-000000000009", title: "Index fixture",
    sections: { sources: "sources/" },
    // the index names one of the two
    sources: [{ source_id: mintSrcId({ canonicalUrl: "https://example.org/listed" }),
                path: "sources/listed/", title: "listed", primary_url: "", sha256: "" }],
  }, null, 2));

  const loaded = loadCorpus(dir);
  eq("index: a source the index does not name is still found", loaded.sources.length, 2);
  ok("index: the one it does name is not read twice",
     new Set(loaded.sources.map((x) => x.dirRel)).size === 2);
  eq("index: an indexed path keeps its directory, trailing slash trimmed",
     loaded.sources.map((x) => x.dirRel).sort().join(","), "sources/listed,sources/only-on-disk");
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- the site projection: a library, and §09's code rules enforced by it ---
//
// The browser exists to check a corpus; this exists to be used. The rules below
// are not styling preferences — each is a way the projection could quietly lie.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upc-site-"));
  const slug = "s1";
  fs.mkdirSync(path.join(dir, "sources", slug, "representations"), { recursive: true });
  fs.mkdirSync(path.join(dir, "provenance"), { recursive: true });
  fs.mkdirSync(path.join(dir, "codebooks"), { recursive: true });

  const text = "Alpha line.\n\nThe regime resists change for structural reasons.\n\nOmega line.\n";
  const buf = Buffer.from(text, "utf8");
  fs.writeFileSync(path.join(dir, "sources", slug, "representations", "clean.md"), buf);
  const rep = mintRepId(buf);
  const srcId = mintSrcId({ canonicalUrl: "https://example.org/site" });
  const stamp = { produced_by: { tool: "t", method: "import" }, created_at: "2026-01-01T00:00:00Z" };
  fs.writeFileSync(path.join(dir, "sources", slug, "source.json"), JSON.stringify({
    source_id: srcId, source_kind: "url", title: "A paper about regimes",
    bibliographic: { item_type: "article-journal", title: "A paper about regimes",
      authors: [{ family: "Geels", given: "F." }], issued: { date_parts: [[2017]] } },
    retrieval: { original_url: "https://example.org/site", fetch_status: "success" },
    extractions_path: `sources/${slug}/extractions.jsonl`,
    representations: [{ representation_id: rep, role: "clean_markdown", media_type: "text/markdown",
      path: `sources/${slug}/representations/clean.md`, sha256: sha256Hex(buf),
      produced_by: "conversion", provenance: stamp }],
    provenance: stamp,
  }, null, 2));
  fs.writeFileSync(path.join(dir, "provenance", "events.jsonl"), "");
  fs.writeFileSync(path.join(dir, "corpus.json"), JSON.stringify({
    upc_spec_version: specVersion(), corpus_id: "cor-000000000004", title: "Site fixture",
    sections: { sources: "sources/", codebooks: "codebooks/", codings: "codings/",
                provenance: "provenance/events.jsonl" },
  }, null, 2));

  const codes = [{ code: "mlp", label: "Multi-level perspective", definition: "Niche, regime, landscape." },
                 { code: "spt", label: "Social practice theory", definition: "Practices, not choices." }];
  const cbk = { codebook_id: "", namespace: "demo", slug: "theory", title: "Theory",
                closed: true, multi_label: false, unit: "passage", revision: 1,
                revision_digest: codebookRevisionDigest(codes), codes, provenance: stamp };
  cbk.codebook_id = mintCbkId(cbk);
  fs.writeFileSync(path.join(dir, "codebooks", cbk.codebook_id + ".json"), JSON.stringify(cbk, null, 2));

  clearRepCache();
  const quote = "The regime resists change for structural reasons.";
  const a = anchorCmd(dir, rep, [{ quote }, { quote: "", text: "A summary in someone's own words." }],
                      { tool: "selftest" });
  const extId = a.results[0].extraction_id;
  // A paraphrase-only extraction, to prove it is never dressed as a quotation.
  {
    const f = path.join(dir, "sources", slug, "extractions.jsonl");
    const para = { source_id: srcId, representation_ref: rep, type: "evidence", status: "active",
      text: "A summary in someone's own words.",
      locator: { type: "char_range", representation_ref: rep, value: { start: 0, end: 11 } },
      provenance: stamp };
    para.extraction_id = mintExtId(para);
    fs.appendFileSync(f, JSON.stringify(para) + "\n");
  }
  // Two coders, one single-label codebook, different answers: a real disagreement.
  clearRepCache();
  codeCmd(dir, "cds-1", [
    { codebook_ref: cbk.codebook_id, code: "mlp", target: { kind: "extraction", id: extId }, coder: "model-a" },
    { codebook_ref: cbk.codebook_id, code: "spt", target: { kind: "extraction", id: extId }, coder: "ellie" },
  ], { tool: "selftest", coderKind: "model" });

  clearRepCache();
  const model = buildSiteModel(loadCorpus(dir), { matrix: null });
  const p = model.passageById.get(extId);

  eq("site: a quotation is checked against the bytes", p.badge, "verified");
  eq("site: context is read from the file, not stored", p.before, "Alpha line.\n\n");
  ok("site: a count states its unit", model.passages.length === 2 && model.sources.length === 1);
  eq("site: a code carries its coder", p.codings.map((c) => c.coder).sort().join(","), "ellie,model-a");
  ok("site: a code carries its definition", p.codings.every((c) => c.definition.length > 0));
  eq("site: disagreement is detected, not resolved", p.disagreements.length, 1);
  ok("site: both judgements survive", p.codings.length === 2);
  ok("site: a summary is not a quotation", model.passages.some((x) => !x.quote && x.note && x.badge === "paraphrase"));
  eq("site: per-code counts separate passages from sources",
     model.codeIndex.get(`${cbk.codebook_id}:mlp`).sources.size, 1);

  // --- what the two shapes of the site actually render ---
  //
  // The model tests above prove the data is right. These prove the pages built
  // from it are: a reader who cannot filter, or whose list vanishes when they
  // click, has a library they will not use.
  {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "upc-sitew-"));
    const res = writeSite(dir, { out, matrix: ["theory", "theory"] });
    const read = (rel) => fs.readFileSync(path.join(out, rel), "utf8");
    ok("site: the folder builds", res.status === "ok" && res.pages > 0);
    ok("site: Home is reachable from every page, the top-level matrix included",
       /href="index\.html">Home</.test(read("matrix.html")) && /href="\.\.\/index\.html">Home</.test(read("passages/index.html")));

    const codeHtml = read(`codes/${cbk.slug}/mlp.html`);
    ok("site: a code page mounts the browser rather than dumping every passage",
       /data-browse/.test(codeHtml));
    ok("site: a code page says how many papers its passages come from", /\d+ passages? from \d+ papers?/.test(codeHtml));
    ok("site: a code page leaves out the scheme it is already filtered by",
       /data-omit="theory"/.test(codeHtml) && /data-only="theory:mlp"/.test(codeHtml));
    ok("site: a code page still renders its passages for a reader without scripts",
       /<noscript>[\s\S]*blockquote/.test(codeHtml));
    ok("site: only the browsing pages carry the passage data",
       /data\/browse\.js/.test(codeHtml) && !/data\/browse\.js/.test(read("sources/" + slug + ".html")));

    const browse = read("data/browse.js");
    ok("site: the data island is a plain script, never a fetch", /^window\.__UPCB_DATA=/.test(browse));
    ok("site: the island carries each source's page name so links resolve", /"sl":/.test(browse));

    const passHtml = read("passages/index.html");
    ok("site: the passages page ships a mount point, not three thousand articles",
       /data-browse/.test(passHtml) && !/blockquote/.test(passHtml));

    // Who coded it: in the tooltip, with one visible sentence per view instead.
    const srcHtml = read("sources/" + slug + ".html");
    ok("site: a chip no longer prints its coder's name", !/class="who"/.test(srcHtml));
    ok("site: the coder, confidence and reason ride in the chip's tooltip", /title="[^"]*Coded by (ellie|model-a)/.test(srcHtml));
    ok("site: the source page says visibly that codes are judgements, and by whom", /Codes were assigned by /.test(srcHtml));

    const js = read("assets/site.js");
    ok("site: the browse sidebar carries the same sentence", /Hover a code to see who assigned it/.test(js));
    ok("site: the browse engine ships with the page script", /window\.UPCB=API/.test(js));
    ok("site: filtering reads the data, never the rendered DOM",
       /p\._h\.indexOf/.test(js) && /content-visibility/.test(read("assets/site.css")));

    fs.rmSync(out, { recursive: true, force: true });
  }

  // On a source page, "page N" opens the original PDF at that page when the PDFs
  // travel with the site — as it does on the passages page. It used to link only
  // to the passage in the reading copy.
  {
    const sjPath = path.join(dir, "sources", slug, "source.json");
    const exPath = path.join(dir, "sources", slug, "extractions.jsonl");
    const sjBefore = fs.readFileSync(sjPath, "utf8"), exBefore = fs.readFileSync(exPath, "utf8");
    const pdfBuf = Buffer.from("%PDF-1.4\n% selftest\n", "utf8");
    const pdfAbs = path.join(dir, "sources", slug, "representations", "paper.pdf");
    fs.writeFileSync(pdfAbs, pdfBuf);
    const sj = JSON.parse(sjBefore);
    sj.representations.push({ representation_id: mintRepId(pdfBuf), role: "document_pdf", media_type: "application/pdf",
      path: `sources/${slug}/representations/paper.pdf`, sha256: sha256Hex(pdfBuf), produced_by: "import", provenance: stamp });
    fs.writeFileSync(sjPath, JSON.stringify(sj, null, 2));
    fs.writeFileSync(exPath, exBefore.trim().split("\n").map((l) => {
      const o = JSON.parse(l);
      if (o.direct_quote) o.secondary_locators = [{ type: "page", representation_ref: rep, value: 3, unit: "page" }];
      return JSON.stringify(o);
    }).join("\n") + "\n");
    clearRepCache();
    const outB = fs.mkdtempSync(path.join(os.tmpdir(), "upc-pdf-"));
    writeSite(dir, { out: outB, bundle: true });
    const srcB = fs.readFileSync(path.join(outB, "sources", slug + ".html"), "utf8");
    ok("source page: page N opens the original PDF at that page",
       srcB.includes('href="../files/paper.pdf#page=3" target="_blank" rel="noopener" title="Open the original PDF at this page">page 3 ↗</a>'));
    ok("source page: line N still opens the passage in the reading copy", /#ex=ext-[0-9a-f]{12}">line \d+ →<\/a>/.test(srcB));
    ok("source page: and the PDF it opens travels with the site", fs.existsSync(path.join(outB, "files", "paper.pdf")));
    clearRepCache();
    const outU = fs.mkdtempSync(path.join(os.tmpdir(), "upc-nopdf-"));
    writeSite(dir, { out: outU });
    const srcU = fs.readFileSync(path.join(outU, "sources", slug + ".html"), "utf8");
    ok("source page: without the PDFs, the page number is plain text and nothing links a missing file",
       srcU.includes('<span class="muted">page 3</span>') && !srcU.includes("files/paper.pdf"));
    fs.rmSync(outB, { recursive: true, force: true });
    fs.rmSync(outU, { recursive: true, force: true });
    fs.writeFileSync(sjPath, sjBefore);
    fs.writeFileSync(exPath, exBefore);
    fs.rmSync(pdfAbs);
    clearRepCache();
  }

  // A drifted locator must surface as a failure, and its code must inherit it.
  {
    const f = path.join(dir, "sources", slug, "extractions.jsonl");
    const lines = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    lines[0].locator.value = { start: lines[0].locator.value.start + 3, end: lines[0].locator.value.end + 3 };
    fs.writeFileSync(f, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
    clearRepCache();
    const broken = buildSiteModel(loadCorpus(dir), {});
    const bp = broken.passageById.get(extId);
    eq("site: a drifted quotation is shown as failing", bp.badge, "failed");
    ok("site: the failure says what the source now reads", typeof bp.actual === "string" && bp.actual !== bp.quote);
    eq("site: the corpus-wide failure count is exposed", broken.failures, 1);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- the compatibility claim, stated as the code states it ---
// A relaxed rule is minor-safe (no previously valid corpus breaks) but it is NOT
// forward-compatible: a corpus using the new laxity needs a >= 1.6.0 reader. This
// asymmetry is documented in CHANGELOG/§00 and pinned here so it cannot drift into
// an unqualified "1.5 reads 1.6" claim.
{
  const spec = fs.readFileSync(path.join(HERE, "..", "spec", "00-overview.md"), "utf8");
  ok("§00 records that a relaxation raises the minimum reader version", /minimum reader version/.test(spec));
  const chg = fs.readFileSync(path.join(HERE, "..", "CHANGELOG.md"), "utf8");
  ok("CHANGELOG states the loosening is not forward-compatible", /not\s*\*\*?forward-compatible|is \*not\* forward-compatible/.test(chg));
}

// --- a coding never carries a locator: the schema forbids the back door ---
{
  const sch = JSON.parse(fs.readFileSync(path.join(HERE, "..", "schemas", "coding.schema.json"), "utf8"));
  ok("coding schema has no locator property", !("locator" in sch.properties) && !("secondary_locators" in sch.properties));
  ok("coding schema requires a target", sch.required.includes("target"));
  ok("coding schema requires a coder", sch.required.includes("coder"));
  ok("coding schema makes code/value exclusive", Array.isArray(sch.oneOf) && sch.oneOf.length === 2);
  const ext = JSON.parse(fs.readFileSync(path.join(HERE, "..", "schemas", "extraction.schema.json"), "utf8"));
  // Codes live beside extractions, never on them: adding a member to the extraction
  // object would trip unknown_field under --strict for every 1.5.0 reader.
  ok("extraction schema gained no codes[] member", !("codes" in ext.properties) && !("codings" in ext.properties));
}

// --- Obsidian export: rendering primitives ---
{
  eq("callout folded marker", renderCallout("provenance", "How this note was made", ["a", "", "b"]),
    "> [!provenance]- How this note was made\n> a\n>\n> b");
  eq("callout unfolded, untitled", renderCallout("summary", "", ["lead"], false), "> [!summary]\n> lead");
  // A corpus field is free text. One unsplit newline silently ends a callout and
  // spills the rest of the block into the note as loose prose.
  eq("callout splits embedded newlines", renderCallout("summary", "", ["a\nb\n\nc"], false),
    "> [!summary]\n> a\n> b\n>\n> c");
  eq("callout title cannot span lines", renderCallout("info", "Cap\ntion", ["x"], true),
    "> [!info]- Cap tion\n> x");

  eq("yaml date stays bare", yamlScalar("2024-01-01"), "2024-01-01");
  eq("yaml wikilink is quoted", yamlScalar("[[A]]", true), '"[[A]]"');
  eq("yaml bare wikilink would be a flow seq, so quoted", yamlScalar("[[A]]"), '"[[A]]"');
  eq("yaml reserved word quoted", yamlScalar("no"), '"no"');
  eq("yaml number-like quoted", yamlScalar("1.20"), '"1.20"');
  eq("yaml plain string bare", yamlScalar("website"), "website");

  const profile = loadProfile();
  const fmText = serializeFrontmatter({
    type: "source", status: "raw", domain: "d", people: ["[[A]]", "[[B]]"],
    source_kind: "website", date: "2024-01-01", subdomain: "", related: [], parent: null,
  }, profile);
  eq("frontmatter is canonical order and drops empties", fmText,
    '---\ntype: source\nstatus: raw\ndomain: d\npeople:\n  - "[[A]]"\n  - "[[B]]"\nsource_kind: website\ndate: 2024-01-01\n---\n');
}

// --- Obsidian export: boilerplate stripping ---
{
  const doc = ["# T", "", "## Page 1", "", "Acme Journal", "", "Real prose that says something substantive.", "",
    "- [Nav](https://x.example/a)", "", "1", "", "## Page 2", "", "Acme Journal", "",
    "Second page of genuine content follows on.", "", "2", "", "## Page 3", "", "Acme Journal", "",
    "Third page continues the argument here.", "", "3"].join("\n");
  const r = stripBoilerplate(doc);
  eq("strip removes page markers", r.removed.page_marker, 3);
  eq("strip removes running heads", r.removed.running_head, 3);
  eq("strip removes page numbers at boundaries", r.removed.page_number, 3);
  eq("strip removes link-only nav", r.removed.nav_line, 1);
  ok("strip keeps prose", r.text.includes("Real prose that says something substantive."));
  ok("strip keeps the heading", r.text.startsWith("# T"));

  eq("strip level none is identity", stripBoilerplate(doc, { level: "none" }).text, doc);

  // A bare number is only page furniture at a page boundary. Measured against real
  // documents, an unconditional rule eats map legends and wiring-terminal labels.
  const data = ["## Page 1", "", "Prose that opens the page and runs on a while.", "",
    "0.0", "10.5", "C", "L1", "", "Closing prose for this page here.", "", "7", "",
    "## Page 2", "", "More prose on the second page of this document.", "", "8"].join("\n");
  const d = stripBoilerplate(data);
  for (const kept of ["0.0", "10.5", "C", "L1"]) {
    ok(`strip keeps mid-page data ${JSON.stringify(kept)}`, d.text.split("\n").includes(kept));
  }
  ok("strip still removes the page foot", !d.text.split("\n").includes("7"));

  ok("strip never touches fenced code", stripBoilerplate("```\n1\n[x](https://a.example)\n```\n").text.includes("[x](https://a.example)"));

  // Most converted PDFs carry no page markers, so pagination is found by its
  // signature instead: a long ascending run of bare integers spread through the
  // document. Data numbers are what the chain steps over, never what it collects.
  const folioDoc = [];
  for (let i = 1; i <= 14; i++) {
    folioDoc.push(`Prose for page ${i} of this document, long enough to be real.`, "", `/  ${i}`, "");
    if (i === 4) folioDoc.push("2024", "2035", "600", "400", "");     // chart data
    if (i === 7) folioDoc.push("1", "2", "3", "");                     // figure labels
  }
  const folio = stripBoilerplate(folioDoc.join("\n"));
  eq("a folio run is stripped without page markers", folio.removed.page_number, 14);
  const folioKept = new Set(folio.text.split("\n").map((l) => l.trim()));
  for (const keep of ["2024", "2035", "600", "400"]) {
    ok(`folio detection steps over chart datum ${keep}`, folioKept.has(keep));
  }
  ok("folio detection leaves a short figure-label run alone", folioKept.has("3"));

  // The guards: too few, and a run that does not span the document, are both data.
  const shortRun = ["Opening prose that is long enough to count as real.", "", "1", "2", "3", "",
    "Closing prose that is also long enough to count."].join("\n");
  eq("a short ascending column is not pagination", stripBoilerplate(shortRun).removed.page_number, undefined);
  const topTable = ["1", "2", "3", "4", "5", "6", ""].concat(
    Array.from({ length: 60 }, (_, i) => `Body paragraph ${i} carrying real sentences of prose.`)).join("\n");
  eq("an ascending column that does not span the document is not pagination",
    stripBoilerplate(topTable).removed.page_number, undefined);

  const cover = stripBoilerplate(["repository", "author accepted manuscript", "terms of use", "", "Body."].join("\n"));
  eq("coversheet is detected", cover.warnings.length, 1);
  ok("coversheet is never deleted", cover.text.includes("author accepted manuscript"));
}

// --- Obsidian export: the plan over the real example corpus ---
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  const p1 = buildVaultPlan(loadCorpus(EXAMPLE));
  const p2 = buildVaultPlan(loadCorpus(EXAMPLE));
  eq("obsidian plan deterministic", JSON.stringify(p1), JSON.stringify(p2));

  eq("one note per source", p1.counts.sources, 3);
  eq("generations become notes", p1.counts.generations, 1);
  eq("syntheses become notes", p1.counts.syntheses, 1);
  eq("every image is copied", p1.counts.images, 1);
  eq("note paths are unique", new Set(p1.notes.map((n) => n.path)).size, p1.notes.length);

  const profile = loadProfile();
  const approved = new Set(profile.frontmatter.property_order.concat(profile.frontmatter.extended_properties));
  for (const n of p1.notes) {
    for (const k of Object.keys(n.frontmatter)) {
      if (n.frontmatter[k] === undefined) continue;
      ok(`frontmatter key ${k} is approved`, approved.has(k));
    }
    const h1 = (n.text.match(/^# /gm) || []).length;
    eq(`exactly one H1 in ${path.posix.basename(n.path)}`, h1, 1);
    ok(`no tags in ${path.posix.basename(n.path)}`, !/^tags:/m.test(n.text));
    ok(`no aliases in ${path.posix.basename(n.path)}`, !/^aliases:/m.test(n.text));
    ok(`no inline HTML in ${path.posix.basename(n.path)}`, !/<(span|div|font)\b/i.test(n.text));
    for (const c of n.text.match(/^> \[!([a-z-]+)\]/gm) || []) {
      const kind = /\[!([a-z-]+)\]/.exec(c)[1];
      ok(`callout ${kind} is registered`, kind in profile.callouts);
    }
    ok(`## Notes left empty in ${path.posix.basename(n.path)}`,
      !/## Notes\n\n?[^\n[]/.test(n.text));
  }

  const wp = p1.notes.find((n) => n.objectId === "src-b95bb22d8232");
  ok("source note filed by kind", wp.path.startsWith("10 Sources/10.09 Website/"));
  eq("source note frontmatter type", wp.frontmatter.type, "source");
  eq("author becomes a people wikilink", wp.frontmatter.people[0], "[[Watchdog Studio]]");
  eq("year-only date is filled to an ISO date", wp.frontmatter.date, "2024-01-01");

  // §09: an OCR-anchored quote is verified TO THE TRANSCRIPT, never plain verified.
  ok("ocr quote badged verified-to-transcript", wp.text.includes("verified to the derived text"));
  ok("clean-markdown quote badged plain verified", /— verified\[\^ext-d8129f9b7114\]/.test(wp.text));

  // §09: a paraphrase is never styled as a quotation.
  ok("paraphrase is under ## Extractions", wp.text.includes("## Extractions"));
  const paraLine = wp.text.split("\n").find((l) => l.includes("ext-3f36fb2b12e5"));
  ok("paraphrase carries no quotation marks", !/["“”]/.test(paraLine));
  ok("paraphrase is not inside a callout", !paraLine.trimStart().startsWith(">"));
  ok("bbox reading is labelled an inference", paraLine.includes("recorded not gated"));

  // Images: embedded by bare filename with a folded caption carrying §05's triple.
  ok("image embedded by bare filename", wp.text.includes("![[img-b26e480807a2.svg]]"));
  ok("caption is folded", wp.text.includes("> [!info]- Figure 1."));
  ok("caption carries the description", wp.text.includes("staging-first migration shows zero downtime"));
  ok("has_text points at the verified reading", wp.text.includes("the verified reading is `ext-e32197281015`"));
  ok("ocr_text is never rendered as a quotation", !wp.text.includes('"Downtime: staging-first = 0s" — ocr_text'));

  // Provenance: origin, body, and what the lossy step removed.
  ok("provenance names the source id", wp.text.includes("Source `src-b95bb22d8232`"));
  ok("provenance carries the original url", wp.text.includes("https://watchdogstudio.example/blog/migrate-with-no-downtime"));
  ok("provenance names the original filename", wp.text.includes("Original file: `raw.html`"));
  ok("provenance names the body representation", wp.text.includes("Body from `rep-53de3cc48d82`"));
  ok("provenance states what was stripped", wp.text.includes("Stripped at export:"));
  ok("provenance block is folded", wp.text.includes("> [!provenance]- How this note was made"));
  ok("url is in ## Sources too", /## Sources\n\n- \[[^\]]+\]\(https:\/\//.test(wp.text));

  // Extended frontmatter is opt-in.
  const ext = buildVaultPlan(loadCorpus(EXAMPLE), { frontmatter: "extended" });
  const extWp = ext.notes.find((n) => n.objectId === "src-b95bb22d8232");
  eq("extended frontmatter carries the source id", extWp.frontmatter.upc_source_id, "src-b95bb22d8232");
  ok("approved-only frontmatter has no url key", !("url" in wp.frontmatter));

  // Inbox mode never guesses a domain, and ships no scaffold.
  const inbox = buildVaultPlan(loadCorpus(EXAMPLE), { inbox: true });
  ok("inbox notes land in the inbox", inbox.notes.every((n) => n.path.startsWith("00 Inbox/")));
  ok("inbox mode guesses no domain", inbox.notes.every((n) => !("domain" in n.frontmatter)));
  eq("inbox mode ships no scaffold", inbox.scaffold.length, 0);
  // A standalone vault ships the two settings its notes depend on; a live vault's
  // config belongs to its owner and is never touched.
  ok("standalone ships a vault config", p1.scaffold.some((f) => f.path === ".obsidian/app.json"));
  ok("standalone turns the inline title off", p1.scaffold
    .find((f) => f.path === ".obsidian/app.json").text.includes('"showInlineTitle": false'));
  ok("inbox mode writes no config", !inbox.scaffold.some((f) => f.path.startsWith(".obsidian")));
}

// --- Obsidian export: writing, idempotence, and human edits ---
{
  const EXAMPLE = path.join(HERE, "..", "examples", "web-research-corpus");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upc-vault-"));
  const first = writeVault(EXAMPLE, { outDir: dir });
  eq("write reports ok", first.status, "ok");

  const snapshot = () => {
    const out = {};
    const walk = (d, rel) => {
      for (const name of fs.readdirSync(d).sort()) {
        const abs = path.join(d, name), r = rel ? rel + "/" + name : name;
        if (fs.statSync(abs).isDirectory()) walk(abs, r);
        else out[r] = fs.readFileSync(abs).toString("base64");
      }
    };
    walk(dir, "");
    return out;
  };
  const a = snapshot();
  writeVault(EXAMPLE, { outDir: dir });
  eq("re-export is byte-idempotent", JSON.stringify(snapshot()), JSON.stringify(a));

  const notePath = path.join(dir, "10 Sources", "10.09 Website", "Migration downtime research",
    "How to migrate a WordPress site with no downtime.md");
  ok("expected note exists on disk", fs.existsSync(notePath));

  fs.writeFileSync(notePath, fs.readFileSync(notePath, "utf8") + "\nhand edit\n");
  const second = writeVault(EXAMPLE, { outDir: dir });
  eq("a hand-edited note is not overwritten", second.status, "partial");
  eq("the edit is reported", second.skipped[0].reason, "modified_since_export");
  ok("the hand edit survives", fs.readFileSync(notePath, "utf8").includes("hand edit"));

  fs.writeFileSync(notePath, fs.readFileSync(notePath, "utf8").replace("## Notes\n", "## Notes\n\nMy annotation.\n"));
  writeVault(EXAMPLE, { outDir: dir, force: true });
  const forced = fs.readFileSync(notePath, "utf8");
  ok("--force carries ## Notes across", forced.includes("My annotation."));
  ok("--force discards the stray edit outside ## Notes", !forced.includes("\nhand edit\n"));

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Obsidian export: codes are judgements, not gate results ---
{
  const src = path.join(HERE, "..", "examples", "web-research-corpus");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upc-coded-"));
  fs.cpSync(src, dir, { recursive: true });

  const cbk = { codebook_id: "cbk-000000000001", namespace: "test", slug: "stance", title: "Stance",
    closed: true, revision: 1,
    codes: [{ code: "for", label: "In favour", definition: "Argues for the approach." },
            { code: "against", label: "Against", definition: "Argues against it." }] };
  fs.mkdirSync(path.join(dir, "codebooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "codebooks", cbk.codebook_id + ".json"), JSON.stringify(cbk, null, 2));

  const coding = (id, coder, code) => ({
    coding_id: id, codebook_ref: cbk.codebook_id, coder, code, status: "active",
    target: { kind: "source", id: "src-b95bb22d8232" },
    provenance: { produced_by: { tool: "t", method: "model" }, created_at: "2026-01-01T00:00:00Z" },
  });
  fs.mkdirSync(path.join(dir, "codings", "cds-test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "codings", "cds-test", "manifest.json"),
    JSON.stringify({ set_id: "cds-test", items_path: "codings/cds-test/items.jsonl" }, null, 2));
  fs.writeFileSync(path.join(dir, "codings", "cds-test", "items.jsonl"),
    [coding("cod-000000000001", "model-a", "for"), coding("cod-000000000002", "model-b", "against")]
      .map((c) => JSON.stringify(c)).join("\n") + "\n");

  const corpusFile = path.join(dir, "corpus.json");
  const corpus = JSON.parse(fs.readFileSync(corpusFile, "utf8"));
  corpus.sections.codebooks = "codebooks/";
  corpus.sections.codings = "codings/";
  fs.writeFileSync(corpusFile, JSON.stringify(corpus, null, 2));

  const plan = buildVaultPlan(loadCorpus(dir));
  eq("a codebook becomes its own note", plan.counts.codebooks, 1);
  const book = plan.notes.find((n) => n.kind === "codebook");
  ok("the codebook note defines each code", book.text.includes("## for") && book.text.includes("Argues for the approach."));

  const note = plan.notes.find((n) => n.objectId === "src-b95bb22d8232");
  ok("source-level codes get their own section", note.text.includes("## Codes"));
  ok("a code names its coder", note.text.includes("coder `model-a`") && note.text.includes("coder `model-b`"));
  ok("both sides of a disagreement are shown", note.text.includes("#for]]") && note.text.includes("#against]]"));
  ok("a disagreement is labelled, not resolved", note.text.includes("coders disagree; both judgements stand"));
  ok("a code links to its definition", note.text.includes("[[Stance#for]]"));
  // A chip must not be able to borrow a gate badge's authority.
  const codeLine = note.text.split("\n").find((l) => l.includes("coder `model-a`"));
  ok("a code chip carries no verification badge", !/verified|GATE FAILED/.test(codeLine));
  ok("codes are stated as judgements", note.text.includes("not a verified fact"));

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Obsidian export: a failed gate is never presented as clean ---
{
  const src = path.join(HERE, "..", "examples", "web-research-corpus");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upc-tamper-"));
  fs.cpSync(src, dir, { recursive: true });
  const clean = path.join(dir, "sources", "watchdog-2024-migrate-with-no-downtime", "representations", "clean.md");
  fs.writeFileSync(clean, fs.readFileSync(clean, "utf8").replace("fully validated", "fully checked"));

  const plan = buildVaultPlan(loadCorpus(dir));
  eq("the drifted quote is counted as failed", plan.counts.quotes_failed, 1);
  const note = plan.notes.find((n) => n.objectId === "src-b95bb22d8232");
  ok("a failed gate raises a caution block", note.text.includes("> [!caution] Failed quotation gates"));
  ok("the failed quote's text is not shown", !note.text.includes('**"cut over DNS only after'));
  ok("the failed quote is named by id", note.text.includes("`ext-d8129f9b7114`"));
  ok("the report banners the failure", plan.report.text.includes("quotation gate failure"));
  ok("a clean corpus does not banner", !buildVaultPlan(loadCorpus(src)).report.text.includes("gate failure"));

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
