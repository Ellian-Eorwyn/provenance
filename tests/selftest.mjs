// UPC library self-test. Zero-dep unit checks for the correctness-critical
// helpers: JCS (RFC 8785), codepoint gates, URL normalization, slugs, markers.
// Run: node tests/selftest.mjs   (exit 0 = all pass)

import {
  jcs, codepointLength, codepointSlice, decodeUtf8Strict, verifyHopB,
  canonicalUrl, slugify, slugifyWithCollision, checkFilename,
  parseQuoteMarkers, findUncitedQuotes, mintExtId, computeInputDigest,
  writeCsv, parseCsv,
} from "../skill/universal-provenance/scripts/upc_common.mjs";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
