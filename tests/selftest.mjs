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
} from "../skill/universal-provenance/scripts/upc_common.mjs";
import { buildRoCrateGraph } from "../skill/universal-provenance/scripts/ro-crate.mjs";
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
      root: dir, corpus: { corpus_id: "cor-aaaaaaaaaaaa", upc_spec_version: "1.4.0", title: "t" },
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
    root: ".", corpus: { corpus_id: "cor-aaaaaaaaaaaa", upc_spec_version: "1.4.0" }, sections: {},
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
