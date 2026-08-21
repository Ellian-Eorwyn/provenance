#!/usr/bin/env node
// Regenerates both example corpora deterministically, with true content-addressed
// ids and byte-exact quotations. Fixtures must never lie: every id and every
// quote here is computed from the bytes on disk, then `upc regen` builds the
// manifests, CSV mirrors, and browser. Re-running is byte-idempotent (except the
// browser until Phase 6). Uses fixed timestamps so nothing depends on the clock.
//
//   node examples/build-examples.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  sha256Hex, mintRepId, mintImgId, mintSrcId, mintExtId, mintGenId, mintSynId,
  canonicalUrl, computeInputDigest, codepointLength, atomicWriteFile,
} from "../skill/universal-provenance/scripts/upc_common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPC = path.join(HERE, "..", "skill", "universal-provenance", "scripts", "upc.mjs");
const TS = "2026-08-17T12:00:00Z";

// ---- helpers ----
function anchor(text, substr) {
  const idx = text.indexOf(substr);
  if (idx < 0) throw new Error(`quote substring not found in representation: ${JSON.stringify(substr)}`);
  const start = codepointLength(text.slice(0, idx));
  return { type: "char_range", value: { start, end: start + codepointLength(substr) } };
}
function sha(content) { return "sha256:" + sha256Hex(Buffer.from(content, "utf8")); }
function writeText(abs, content) { fs.mkdirSync(path.dirname(abs), { recursive: true }); atomicWriteFile(abs, content); }
function writeJSON(abs, obj) { writeText(abs, JSON.stringify(obj, null, 2) + "\n"); }
function writeJSONL(abs, arr) { writeText(abs, arr.map((o) => JSON.stringify(o)).join("\n") + "\n"); }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

// A minimal, deterministic, dependency-free PDF: enough of ISO 32000 to be a real
// openable document with selectable text on numbered pages, so the `page` locator
// and its `#page=N` deep link can be exercised against actual PDF bytes.
// Deliberately pure ASCII: byte length then equals string length, which is what
// the xref offsets below are computed from, and what sha() hashes.
function buildPdf(pages, title) {
  const escPdf = (t) => t.replace(/([\\()])/g, "\\$1");
  const objs = [];
  const FONT = 3 + pages.length * 2;
  const INFO = FONT + 1;
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  pages.forEach((lines, i) => {
    const pageNo = 3 + i * 2;
    objs[pageNo] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${FONT} 0 R >> >> /Contents ${pageNo + 1} 0 R >>`;
    objs[pageNo + 1] = { stream: lines.map((ln, k) => `BT /F1 13 Tf 72 ${720 - k * 22} Td (${escPdf(ln)}) Tj ET`).join("\n") };
  });
  objs[FONT] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[INFO] = `<< /Title (${escPdf(title)}) /Producer (upc-examples) >>`;

  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = out.length;
    const o = objs[n];
    const body = typeof o === "string" ? o : `<< /Length ${o.stream.length} >>\nstream\n${o.stream}\nendstream`;
    out += `${n} 0 obj\n${body}\nendobj\n`;
  }
  const startxref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${INFO} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  if (/[^\x00-\x7F]/.test(out)) throw new Error("PDF must stay ASCII: xref offsets are computed from string length");
  return out;
}
function repStamp(method) { return { produced_by: { tool: "pi-forge", tool_version: "0.2.0", method }, created_at: TS }; }

// ===========================================================================
// minimal-corpus — one note, one quotation. Reaches L1.
// ===========================================================================
function buildMinimal() {
  const root = path.join(HERE, "minimal-corpus");
  rmrf(root);
  const slug = "note-2026-hello-provenance";
  const srcDir = path.join(root, "sources", slug);

  const clean = [
    "# Hello, Provenance",
    "This note exists so the corpus is never empty. The point of a provenance corpus is simple: every claim can be traced back to its evidence, and every quotation is verified byte for byte against the source it came from.",
  ].join("\n\n") + "\n";
  writeText(path.join(srcDir, "representations", "clean.md"), clean);
  const repId = mintRepId(Buffer.from(clean, "utf8"));
  const srcId = mintSrcId({ primaryBytesSha256: sha(clean) });

  const rep = {
    representation_id: repId, role: "clean_markdown", media_type: "text/markdown",
    path: `sources/${slug}/representations/clean.md`, sha256: sha(clean),
    char_count: codepointLength(clean), produced_by: "manual", provenance: repStamp("manual"),
  };
  const quote = "every claim can be traced back to its evidence";
  const loc = anchor(clean, quote);
  const ext = {
    source_id: srcId, representation_ref: repId, type: "evidence", status: "active",
    text: "Every claim in a provenance corpus is traceable to its evidence.",
    direct_quote: quote,
    locator: { type: "char_range", representation_ref: repId, value: loc.value },
    query: "What is the point of a provenance corpus?",
    interpretation: "explicit", confidence: "high", confidence_score: 0.95,
    provenance: {
      produced_by: { tool: "pi-forge", tool_version: "0.2.0", model: "local-llm", method: "model", prompt_version: "note/evidence@1" },
      created_at: TS, derived_from: { source_ids: [srcId], representation_refs: [repId] }, input_digest: sha(clean),
    },
  };
  ext.extraction_id = mintExtId(ext);

  const source = {
    source_id: srcId, source_kind: "document", title: "Hello, Provenance",
    bibliographic: { item_type: "document", title: "Hello, Provenance", authors: [{ literal: "UPC" }], issued: { date_parts: [[2026]] } },
    representations: [rep], extractions_path: `sources/${slug}/extractions.jsonl`,
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", method: "manual" }, created_at: TS },
  };
  writeJSON(path.join(srcDir, "source.json"), source);
  writeJSONL(path.join(srcDir, "extractions.jsonl"), [ext]);

  writeJSON(path.join(root, "corpus.json"), {
    upc_spec_version: "1.5.0", corpus_id: "cor-" + sha256Hex(Buffer.from("corpus\nminimal", "utf8")).slice(0, 12),
    title: "Minimal UPC corpus", readme: "Universal Provenance Corpus. Work only from ids resolved through the manifests. Quotations are verified byte-for-byte (spec/03).",
    rules_note: "spec/00-overview.md", created: TS, modified: TS, generated_by: { tool: "pi-forge", tool_version: "0.2.0" },
    sections: { sources: "sources/", provenance: "provenance/events.jsonl", sources_csv: "sources.csv", extractions_csv: "extractions.csv", index_html: "index.html" },
  });
  execFileSync(process.execPath, [UPC, "regen", root], { stdio: "ignore" });
  execFileSync(process.execPath, [UPC, "export", root, "--format", "ro-crate"], { stdio: "ignore" });
  return root;
}

// ===========================================================================
// web-research-corpus — two sources, a generation, a synthesis, an extraction
// set, a journal. Non-ASCII content exercises codepoint offsets. Reaches L2.
// ===========================================================================
function buildWebResearch() {
  const root = path.join(HERE, "web-research-corpus");
  rmrf(root);

  // ---- Source 1: watchdog ----
  const wSlug = "watchdog-2024-migrate-with-no-downtime";
  const wDir = path.join(root, "sources", wSlug);
  const wUrl = "https://watchdogstudio.example/blog/migrate-with-no-downtime";
  const wRaw = "<!doctype html><html><head><title>How to migrate a WordPress site with no downtime</title></head><body><article><h1>How to migrate a WordPress site with no downtime</h1><p>Build the new environment on a staging host, then cut over DNS only after the staging copy is fully validated.</p></article></body></html>\n";
  const wClean = [
    "# How to migrate a WordPress site with no downtime",
    "Migrating a live WordPress site is mostly about sequencing. Build the new environment on a staging host, then cut over DNS only after the staging copy is fully validated, so no visitor ever hits a broken page.",
    "During DNS propagation, both hosts should serve identical content, so nobody sees downtime.",
  ].join("\n\n") + "\n";
  // a tiny SVG figure
  const wSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#f4e9dd"/><text x="12" y="64" font-size="14">Downtime: staging-first = 0s</text></svg>\n';

  writeText(path.join(wDir, "representations", "raw.html"), wRaw);
  writeText(path.join(wDir, "representations", "clean.md"), wClean);
  writeText(path.join(wDir, "representations", "images", "figure.svg"), wSvg);
  // The figure's visible text, OCR'd into its OWN textual representation. This is
  // what makes the text separately findable AND gate-verifiable: the SVG itself is
  // image/svg+xml, which is not a textual media type, so nothing can be quoted
  // from it directly (spec/05).
  const wOcr = "Downtime: staging-first = 0s\n";
  writeText(path.join(wDir, "representations", "ocr", "figure.txt"), wOcr);
  const wRawId = mintRepId(Buffer.from(wRaw, "utf8"));
  const wCleanId = mintRepId(Buffer.from(wClean, "utf8"));
  const wImgId = mintImgId(Buffer.from(wSvg, "utf8"));
  const wOcrId = mintRepId(Buffer.from(wOcr, "utf8"));
  const wSrcId = mintSrcId({ canonicalUrl: canonicalUrl(wUrl) });

  const wReps = [
    { representation_id: wRawId, role: "raw_html", media_type: "text/html", path: `sources/${wSlug}/representations/raw.html`, sha256: sha(wRaw), bytes: Buffer.byteLength(wRaw), produced_by: "http", provenance: repStamp("http") },
    { representation_id: wCleanId, role: "clean_markdown", media_type: "text/markdown", path: `sources/${wSlug}/representations/clean.md`, sha256: sha(wClean), char_count: codepointLength(wClean), parent_representation_ref: wRawId, produced_by: "readability", provenance: repStamp("readability") },
    { representation_id: wImgId, role: "image", media_type: "image/svg+xml", path: `sources/${wSlug}/representations/images/figure.svg`, sha256: sha(wSvg), parent_representation_ref: wCleanId, description: "Bar note: staging-first migration shows zero downtime.", has_text: true, ocr_text: "Downtime: staging-first = 0s", caption: "Figure 1. Downtime by cutover strategy.", produced_by: "conversion", dimensions: { width: 240, height: 120 }, provenance: repStamp("conversion") },
    { representation_id: wOcrId, role: "ocr", media_type: "text/plain", path: `sources/${wSlug}/representations/ocr/figure.txt`, sha256: sha(wOcr), bytes: Buffer.byteLength(wOcr), char_count: codepointLength(wOcr), parent_representation_ref: wImgId, produced_by: "ocr", provenance: repStamp("ocr") },
  ];
  const wQuote = "cut over DNS only after the staging copy is fully validated";
  const wExt = {
    source_id: wSrcId, representation_ref: wCleanId, type: "evidence", status: "active",
    text: "Cut over DNS only after the staging copy is validated.",
    direct_quote: wQuote,
    locator: { type: "char_range", representation_ref: wCleanId, value: anchor(wClean, wQuote).value },
    secondary_locators: [{ type: "section", representation_ref: wCleanId, value: "How to migrate a WordPress site with no downtime" }],
    query: "How do you migrate a WordPress site without downtime?",
    interpretation: "explicit", confidence: "high", confidence_score: 0.9,
    rationale: "Directly answers the cutover-timing part of the question.",
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", model: "local-llm", method: "model", prompt_version: "web-research/evidence@3" }, created_at: TS, derived_from: { source_ids: [wSrcId], representation_refs: [wCleanId] }, input_digest: sha(wClean) },
  };
  wExt.extraction_id = mintExtId(wExt);

  // A VERIFIED quotation of the text visible in the figure. It is anchored by
  // char_range into the OCR representation (so hop B gates it, badge
  // "verified-to-transcript"), and carries a SECONDARY bbox into the image so a
  // reader can be shown where on the figure that text sits. That second step is
  // recorded, not gated (spec/05 trust boundary).
  const wFigQuote = "Downtime: staging-first = 0s";
  const wOcrExt = {
    source_id: wSrcId, representation_ref: wOcrId, type: "quote", status: "active",
    text: "The figure states that the staging-first strategy has zero downtime.",
    direct_quote: wFigQuote,
    locator: { type: "char_range", representation_ref: wOcrId, value: anchor(wOcr, wFigQuote).value, unit: "codepoint" },
    secondary_locators: [
      {
        type: "bbox", representation_ref: wImgId, value: [12, 52, 200, 18],
        unit: "pixel", reference: { width: 240, height: 120 }, conforms_to: "media-frags",
        quote_hint: { exact: wFigQuote },
      },
    ],
    query: "What does the figure claim about staging-first downtime?",
    interpretation: "explicit", confidence: "high", confidence_score: 0.9,
    rationale: "The figure's own label, read by OCR and quoted from the OCR text.",
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", method: "ocr" }, created_at: TS, derived_from: { source_ids: [wSrcId], representation_refs: [wOcrId, wImgId] }, input_digest: sha(wOcr) },
  };
  wOcrExt.extraction_id = mintExtId(wOcrExt);

  // The region itself, as an UNGATED reading of the image (spec/05): a bbox is
  // never gate-bearing, so this carries `text` and no direct_quote.
  const wRegionExt = {
    source_id: wSrcId, representation_ref: wImgId, type: "image_region", status: "active",
    text: "Figure label reporting zero downtime for the staging-first strategy.",
    locator: { type: "bbox", representation_ref: wImgId, value: [12, 52, 200, 18], unit: "pixel", reference: { width: 240, height: 120 } },
    query: "What does the figure claim about staging-first downtime?",
    interpretation: "explicit", confidence: "medium", confidence_score: 0.6,
    rationale: "Region reading; the verified text of this region is ext " + wOcrExt.extraction_id + ".",
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", method: "vision" }, created_at: TS, derived_from: { source_ids: [wSrcId], representation_refs: [wImgId] }, input_digest: sha(wSvg) },
  };
  wRegionExt.extraction_id = mintExtId(wRegionExt);

  // ---- Source 2: cloudlore (non-ASCII: astral emoji, em-dash, é) ----
  const cSlug = "cloudlore-2023-blue-green-deploys";
  const cDir = path.join(root, "sources", cSlug);
  const cUrl = "https://cloudlore.example/blog/blue-green";
  const cRaw = "<!doctype html><html><head><title>Blue-green deployments explained</title></head><body><article><h1>Blue-green deployments explained</h1><p>Switching is instant because it only redirects the router.</p></article></body></html>\n";
  const cClean = [
    "# \u{1F680} Blue-green deployments explained",
    "Blue-green keeps a spare environment warm — like a café keeping a second pot ready — so switching is instant because it only redirects the router between two identical environments.",
    "Rollback is just as fast: point the router back at the environment that still works.",
  ].join("\n\n") + "\n";
  writeText(path.join(cDir, "representations", "raw.html"), cRaw);
  writeText(path.join(cDir, "representations", "clean.md"), cClean);
  const cRawId = mintRepId(Buffer.from(cRaw, "utf8"));
  const cCleanId = mintRepId(Buffer.from(cClean, "utf8"));
  const cSrcId = mintSrcId({ canonicalUrl: canonicalUrl(cUrl) });
  const cReps = [
    { representation_id: cRawId, role: "raw_html", media_type: "text/html", path: `sources/${cSlug}/representations/raw.html`, sha256: sha(cRaw), bytes: Buffer.byteLength(cRaw), produced_by: "http", provenance: repStamp("http") },
    { representation_id: cCleanId, role: "clean_markdown", media_type: "text/markdown", path: `sources/${cSlug}/representations/clean.md`, sha256: sha(cClean), char_count: codepointLength(cClean), parent_representation_ref: cRawId, produced_by: "readability", provenance: repStamp("readability") },
  ];
  // ASCII quote, but positioned AFTER the astral emoji so its codepoint start != UTF-16 index.
  const cQuote = "switching is instant because it only redirects the router";
  const cExt = {
    source_id: cSrcId, representation_ref: cCleanId, type: "evidence", status: "active",
    text: "Blue-green switching is instant because it only redirects the router.",
    direct_quote: cQuote,
    locator: { type: "char_range", representation_ref: cCleanId, value: anchor(cClean, cQuote).value },
    query: "How do you migrate a WordPress site without downtime?",
    interpretation: "explicit", confidence: "medium", confidence_score: 0.6,
    rationale: "An alternative zero-downtime cutover strategy.",
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", model: "local-llm", method: "model", prompt_version: "web-research/evidence@3" }, created_at: TS, derived_from: { source_ids: [cSrcId], representation_refs: [cCleanId] }, input_digest: sha(cClean) },
  };
  cExt.extraction_id = mintExtId(cExt);

  // ---- Extraction set: a non-ASCII quote (em-dash + é), different query ----
  const setQuote = "a spare environment warm — like a café keeping a second pot ready";
  const setExt = {
    source_id: cSrcId, representation_ref: cCleanId, type: "passage", status: "active",
    text: "Blue-green keeps a spare environment ready.",
    direct_quote: setQuote,
    locator: { type: "char_range", representation_ref: cCleanId, value: anchor(cClean, setQuote).value },
    query: "How does blue-green keep a spare environment ready?",
    interpretation: "explicit", confidence: "high", confidence_score: 0.8,
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", model: "local-llm", method: "model", prompt_version: "web-research/evidence@3" }, created_at: TS, derived_from: { source_ids: [cSrcId], representation_refs: [cCleanId] }, input_digest: sha(cClean) },
  };
  setExt.extraction_id = mintExtId(setExt);

  // ---- Source 3: a native PDF whitepaper (document_pdf + its text layer) ----
  // Exercises the `page` presentation locator end to end: a quotation gated
  // against the extracted text layer, carrying a secondary `page` locator back
  // into the PDF it was extracted from (spec/05).
  const pSlug = "fieldnotes-2025-migration-downtime-study";
  const pDir = path.join(root, "sources", pSlug);
  const pTitle = "Migration downtime: a field study";
  const pdfPages = [
    [pTitle, "", "Staging-first cutover eliminates visitor-facing downtime", "in every trial we ran."],
    ["Results", "", "Measured downtime by strategy: direct 42s, blue-green 9s,", "staging-first 0s.", "", "A staging-first cutover reported zero seconds of downtime."],
  ];
  const pPdf = buildPdf(pdfPages, pTitle);
  // The text layer an extractor would produce, page order preserved, pages
  // separated by a blank line. Derived from the SAME source of truth as the PDF
  // bytes, so the two can never drift apart.
  const pText = pdfPages.map((lines) => lines.join("\n")).join("\n\n") + "\n";
  writeText(path.join(pDir, "representations", "paper.pdf"), pPdf);
  writeText(path.join(pDir, "representations", "paper.txt"), pText);
  const pPdfId = mintRepId(Buffer.from(pPdf, "utf8"));
  const pTxtId = mintRepId(Buffer.from(pText, "utf8"));
  const pSrcId = mintSrcId({ primaryBytesSha256: sha(pPdf) });

  const pReps = [
    { representation_id: pPdfId, role: "document_pdf", media_type: "application/pdf", path: `sources/${pSlug}/representations/paper.pdf`, sha256: sha(pPdf), bytes: Buffer.byteLength(pPdf), page_count: pdfPages.length, produced_by: "import", provenance: repStamp("import") },
    { representation_id: pTxtId, role: "text", media_type: "text/plain", path: `sources/${pSlug}/representations/paper.txt`, sha256: sha(pText), bytes: Buffer.byteLength(pText), char_count: codepointLength(pText), parent_representation_ref: pPdfId, produced_by: "conversion", provenance: repStamp("conversion") },
  ];

  const pQuote = "A staging-first cutover reported zero seconds of downtime.";
  const pQuoteLine = pText.split("\n").findIndex((l) => l.includes(pQuote)) + 1; // 1-based
  const pExt = {
    source_id: pSrcId, representation_ref: pTxtId, type: "evidence", status: "active",
    text: "The field study measured zero downtime for the staging-first strategy.",
    direct_quote: pQuote,
    locator: { type: "char_range", representation_ref: pTxtId, value: anchor(pText, pQuote).value, unit: "codepoint" },
    secondary_locators: [
      // where it sits in the ORIGINAL PDF -- cross-representation, advisory
      { type: "page", representation_ref: pPdfId, value: 2, conforms_to: "pdf-open-params", quote_hint: { exact: pQuote } },
      // and where it sits in the extracted text, for a line-addressed reader
      { type: "line_range", representation_ref: pTxtId, value: { start: pQuoteLine, end: pQuoteLine }, conforms_to: "rfc5147" },
    ],
    query: "How much downtime does a staging-first cutover cause?",
    interpretation: "explicit", confidence: "high", confidence_score: 0.9,
    rationale: "The study's own result sentence, quoted from the PDF's text layer.",
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", method: "conversion" }, created_at: TS, derived_from: { source_ids: [pSrcId], representation_refs: [pTxtId, pPdfId] }, input_digest: sha(pText) },
  };
  pExt.extraction_id = mintExtId(pExt);

  // ---- Generation: watchdog summary with a cited quotation ----
  const summaryMd = [
    "# Summary",
    `The article recommends sequencing the migration so downtime never occurs: "${wQuote}" [${wExt.extraction_id}]. During DNS propagation both hosts serve identical content, so nobody sees downtime.`,
  ].join("\n\n") + "\n";
  const gen = {
    type: "summary", title: "Summary",
    output: { path: `sources/${wSlug}/generated/PLACEHOLDER.md`, media_type: "text/markdown", sha256: sha(summaryMd) },
    stale: false,
    provenance: { produced_by: { tool: "researchassistant", tool_version: "1.0.0", model: "some-model", method: "model", prompt_version: "summarize@2" }, created_at: TS, derived_from: { source_ids: [wSrcId], representation_refs: [wCleanId], extraction_ids: [wExt.extraction_id] }, input_digest: sha(wClean), activity_ref: "evt-000004" },
  };
  gen.generation_id = mintGenId(gen);
  gen.output.path = `sources/${wSlug}/generated/${gen.generation_id}.md`;
  writeText(path.join(wDir, "generated", `${gen.generation_id}.md`), summaryMd);
  writeJSON(path.join(wDir, "generated", `${gen.generation_id}.json`), gen);

  // ---- Synthesis: answer citing both sources ----
  const question = "How do you migrate a WordPress site without downtime?";
  const syn = {
    type: "answer", title: "Zero-downtime migration approaches", question,
    claims: [
      { claim_id: "cl-0001", text: "Cutting over DNS only after validating a staging copy avoids visitor-facing downtime.", evidence_ids: [wExt.extraction_id], source_ids: [wSrcId], confidence: "high", notes: null },
      { claim_id: "cl-0002", text: "Blue-green routing makes switchover and rollback instant.", evidence_ids: [cExt.extraction_id], source_ids: [cSrcId], confidence: "medium", notes: null },
    ],
    output: { path: "syntheses/PLACEHOLDER/synthesis.md", media_type: "text/markdown" },
    stale: false,
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", model: "local-llm", method: "model", prompt_version: "deep-research/report@1" }, created_at: TS, derived_from: { source_ids: [wSrcId, cSrcId], extraction_ids: [wExt.extraction_id, cExt.extraction_id] }, input_digest: computeInputDigest([{ id: wCleanId, sha256: sha(wClean) }, { id: cCleanId, sha256: sha(cClean) }]), activity_ref: "evt-000005" },
  };
  syn.synthesis_id = mintSynId(syn);
  const synMd = [
    "# Zero-downtime migration approaches",
    "Two complementary strategies answer the question.",
    `First, DNS cutover after staging validation: "${wQuote}" [${wExt.extraction_id}]. This is the low-infrastructure path (\`${wExt.extraction_id}\`, \`${wSrcId}\`).`,
    `Second, blue-green routing: "${cQuote}" [${cExt.extraction_id}]. Rollback is symmetric (\`${cExt.extraction_id}\`, \`${cSrcId}\`).`,
    `Sources: \`${wSrcId}\`, \`${cSrcId}\`.`,
  ].join("\n\n") + "\n";
  syn.output = { path: `syntheses/${syn.synthesis_id}/synthesis.md`, media_type: "text/markdown", sha256: sha(synMd) };
  writeText(path.join(root, "syntheses", syn.synthesis_id, "synthesis.md"), synMd);
  writeJSON(path.join(root, "syntheses", syn.synthesis_id, "synthesis.json"), syn);

  // ---- write sources, extractions, set, journal ----
  writeJSON(path.join(wDir, "source.json"), {
    source_id: wSrcId, aliases: { researchassistant: "000123" }, source_kind: "url", title: "How to migrate a WordPress site with no downtime",
    bibliographic: { item_type: "webpage", title: "How to migrate a WordPress site with no downtime", authors: [{ literal: "Watchdog Studio" }], issued: { date_parts: [[2024]] }, url: wUrl },
    retrieval: { original_url: wUrl, final_url: wUrl, fetch_status: "success", http_status: 200, content_type: "text/html; charset=UTF-8", fetch_method: "http", fetched_at: TS, sha256: sha(wRaw) },
    representations: wReps, extractions_path: `sources/${wSlug}/extractions.jsonl`, generations: [gen.generation_id],
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", method: "http" }, created_at: TS },
  });
  writeJSONL(path.join(wDir, "extractions.jsonl"), [wExt, wOcrExt, wRegionExt]);

  writeJSON(path.join(cDir, "source.json"), {
    source_id: cSrcId, source_kind: "url", title: "Blue-green deployments explained",
    bibliographic: { item_type: "webpage", title: "Blue-green deployments explained", authors: [{ literal: "CloudLore" }], issued: { date_parts: [[2023]] }, url: cUrl },
    retrieval: { original_url: cUrl, final_url: cUrl, fetch_status: "success", http_status: 200, content_type: "text/html; charset=UTF-8", fetch_method: "http", fetched_at: TS, sha256: sha(cRaw) },
    identifiers: [{ scheme: "doi", value: "10.5281/zenodo.7654321", url: "https://doi.org/10.5281/zenodo.7654321" }],
    relations: [{ type: "same_work_as", target: "https://doi.org/10.5281/zenodo.7654321" }],
    representations: cReps, extractions_path: `sources/${cSlug}/extractions.jsonl`,
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", method: "http" }, created_at: TS },
  });
  writeJSONL(path.join(cDir, "extractions.jsonl"), [cExt]);

  writeJSON(path.join(pDir, "source.json"), {
    source_id: pSrcId, source_kind: "document", title: pTitle,
    bibliographic: { item_type: "report", title: pTitle, authors: [{ literal: "Fieldnotes Collective" }], issued: { date_parts: [[2025]] } },
    representations: pReps, extractions_path: `sources/${pSlug}/extractions.jsonl`,
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", method: "import" }, created_at: TS },
  });
  writeJSONL(path.join(pDir, "extractions.jsonl"), [pExt]);

  const setId = "set-blue-green-metaphors";
  writeJSON(path.join(root, "extractions", setId, "manifest.json"), {
    set_id: setId, title: "Blue-green metaphors", query: "How does blue-green keep a spare environment ready?",
    items_path: `extractions/${setId}/items.jsonl`, source_ids: [cSrcId],
    provenance: { produced_by: { tool: "pi-forge", tool_version: "0.2.0", method: "model" }, created_at: TS },
  });
  writeJSONL(path.join(root, "extractions", setId, "items.jsonl"), [setExt]);

  writeJSONL(path.join(root, "provenance", "events.jsonl"), [
    { event_id: "evt-000001", activity_type: "fetch", tool: "pi-forge", started_at: TS, ended_at: TS, inputs: {}, outputs: { source_ids: [wSrcId], representation_refs: [wRawId] }, status: "success", notes: null },
    { event_id: "evt-000002", activity_type: "fetch", tool: "pi-forge", started_at: TS, ended_at: TS, inputs: {}, outputs: { source_ids: [cSrcId], representation_refs: [cRawId] }, status: "success", notes: null },
    { event_id: "evt-000006", activity_type: "import", tool: "pi-forge", started_at: TS, ended_at: TS, inputs: {}, outputs: { source_ids: [pSrcId], representation_refs: [pPdfId, pTxtId] }, status: "success", notes: null },
    { event_id: "evt-000003", activity_type: "extract", tool: "pi-forge", model: "local-llm", started_at: TS, ended_at: TS, inputs: { representation_refs: [wCleanId, cCleanId] }, outputs: { extraction_ids: [wExt.extraction_id, wOcrExt.extraction_id, wRegionExt.extraction_id, cExt.extraction_id, pExt.extraction_id, setExt.extraction_id] }, status: "success", notes: null },
    { event_id: "evt-000004", activity_type: "generate", tool: "researchassistant", model: "some-model", started_at: TS, ended_at: TS, inputs: { representation_refs: [wCleanId], extraction_ids: [wExt.extraction_id] }, outputs: { generation_ids: [gen.generation_id] }, status: "success", notes: null },
    { event_id: "evt-000005", activity_type: "synthesize", tool: "pi-forge", model: "local-llm", started_at: TS, ended_at: TS, inputs: { extraction_ids: [wExt.extraction_id, cExt.extraction_id] }, outputs: { synthesis_ids: [syn.synthesis_id] }, status: "success", notes: null },
  ]);

  writeJSON(path.join(root, "corpus.json"), {
    upc_spec_version: "1.5.0", corpus_id: "cor-" + sha256Hex(Buffer.from("corpus\nweb-research", "utf8")).slice(0, 12),
    title: "Migration downtime research", readme: "Universal Provenance Corpus. Work only from ids resolved through the manifests; sources are immutable; derived objects link back via provenance.derived_from. Quotations are verified byte-for-byte (spec/03).",
    rules_note: "spec/00-overview.md", created: TS, modified: TS, generated_by: { tool: "pi-forge", tool_version: "0.2.0" },
    sections: { sources: "sources/", extractions: "extractions/", syntheses: "syntheses/", provenance: "provenance/events.jsonl", sources_csv: "sources.csv", extractions_csv: "extractions.csv", index_html: "index.html" },
  });
  execFileSync(process.execPath, [UPC, "regen", root], { stdio: "ignore" });
  execFileSync(process.execPath, [UPC, "export", root, "--format", "ro-crate"], { stdio: "ignore" });
  return root;
}

const m = buildMinimal();
const w = buildWebResearch();
console.log(JSON.stringify({ status: "ok", built: [path.basename(m), path.basename(w)] }));
