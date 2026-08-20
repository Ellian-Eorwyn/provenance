# Changelog

All notable changes to the Universal Provenance Corpus (UPC) standard.
Versioning is semantic (§00 Versioning policy).

## 1.2.0 — 2026-08-18

**Backward-compatible (additive) minor release: interoperability + epistemic
precision.** Every 1.1.0 corpus remains valid, and a 1.2.0 validator accepts a
1.1.0 corpus. No object field, id recipe, or quotation gate changed; the schema
`$id`s bump to `1.2.0` (which changes `integrity.schema_hash` — regenerate
projections with `upc regen`).

### Added — epistemic framing

- **§11 Guarantees & Non-Guarantees** — a normative guarantee/non-guarantee
  matrix stating exactly what a passing corpus mechanically proves (fixity,
  codepoint-exact quotation at each hop, content-addressed identity, referential
  integrity) and what it deliberately does **not** (source truth/authority, OCR/
  transcript fidelity, paraphrase faithfulness, synthesis soundness).
- **Rule classes** in §08 — a `Class` column tags every rule **mechanical
  invariant** / **producer obligation** / **advisory semantic**, so "the validator
  passed" is never over-read. No rule number, code, severity, or hop changed.
- **"byte-for-byte" reconciled** with the normative algorithm in §03: the slogan
  denotes codepoint-exact equality over the hash-fixed UTF-8 bytes (the two
  coincide for valid UTF-8). The slogan is retained.

### Added — RO-Crate interoperability (export projection)

- **`upc export … --format ro-crate`** — a deterministic, zero-dependency
  [RO-Crate 1.3](crosswalks/ro-crate.md) flattened-JSON-LD projection. Zero-copy
  by default (writes `ro-crate-metadata.json` into the corpus root); `--copy -o
  <dir>` emits a detached, self-contained crate. Like `index.html`/CSV, it is a
  regenerable view — the UPC objects stay canonical.
- **UPC RO-Crate profile** (`profiles/ro-crate/`, id
  `https://provenance.dev/upc/1.2.0/profiles/ro-crate`), declared in exported
  crates via `conformsTo`. Content-addressed ids are preserved in `identifier` /
  `upc:*Id` and never overloaded onto `@id`.
- Gated extractions carry a companion **W3C Web Annotation** (`TextPositionSelector`
  + `TextQuoteSelector`) flagged `upc:interopOnly: true`; the UPC `char_range`
  stays `upc:gateAuthoritative: true`. The codepoint-vs-UTF-16 / normalization
  divergence is documented in [crosswalks/web-annotation.md](crosswalks/web-annotation.md).
- **Crosswalk documents** — RO-Crate, Web Annotation, and W3C PROV (each row
  tagged exact/partial/incompatible/UPC-only), plus deferral notes for
  nanopublications, BagIt, and WARC/Memento.

### Notes

- Deferred to a later release: source `identifiers[]`/`relations[]` enrichment, a
  PROV-O export, an RO-Crate importer / round-trip, and the packaging/capture
  standards above. The quote gate is unchanged and remains the authority on any
  cross-standard conflict.

## 1.1.0 — 2026-08-17

**Supersedes 1.0.0 wholesale.** UPC 1.0.0 was a draft with no adopters, so this
release makes breaking changes freely to lock in best practices before any tool
depends on the standard. There is no 1.0 → 1.1 migration tooling because nothing
was written against 1.0.

### Added — byte-exact quotation gates (the headline)

- A three-hop verification chain, output quote → extraction → original source,
  with an **exact-match gate at each hop** and no normalization at verification
  time (§03 hop A/B, §04 hop C). Failures are flagged, never absorbed.
- `char_range` defined normatively as **Unicode codepoints** (0-based,
  end-exclusive) into the representation's UTF-8-decoded bytes (§03).
- A **citation-marker grammar** (`"…" [ext-<id>]` inline, ```` ```quote ext-<id> ````
  block, bare `[ext-<id>]` paraphrase) so quotations in generated output are
  machine-verifiable (§04).
- Extraction lifecycle: `status` (active/needs_review/superseded/retracted),
  `supersedes`/`superseded_by`, and advisory `secondary_locators[]` for coarse
  context that never gates (§03).
- The trust boundary for non-text media: quote→transcript is gated; transcript→
  original is recorded provenance, labeled as inference (§05).

### Added — storage, durability, and the human layer

- New **§10 Storage & Durability**: atomic writes (temp+rename+fsync), JSONL
  rules (torn-tail tolerance, atomic whole-file edits, append-only journal),
  removal/tombstone semantics, an advisory `.upc/lock`, and portable-filename
  rules.
- New **Appendix A**: the per-source vs per-media-type layout decision record;
  per-source is canonical for writers, per-media-type stays readable via
  `sections`.
- First-class **modify / re-anchor / re-extraction** workflows and **verified
  browser display** — context read from the representation at the locator,
  per-quote badges, paraphrases never styled as quotes, a gate-failure banner,
  extraction deep links (§09).
- **Export** mappings: CSL-JSON authoritative → BibTeX/RIS field tables (§09).

### Changed — identity, schemas, conformance

- Identifier recipes fully specified and reproducible in any language: **JCS
  (RFC 8785)** for JSON in id keys; the `ext-` key uses the exact `direct_quote`
  (or `text`); a **closed** URL-normalization algorithm; a specified slug
  algorithm (§06). `rel=canonical`/`og:url` no longer feed identity.
- Validators MUST **recompute every content-addressed id** (`id_mismatch`) and
  detect duplicates (`id_duplicate`).
- §08 rewritten as a **numbered rule registry** with a normative error-code
  table; conformance **level is computed from rules passed, not object counts**.
  L1 now guarantees "no unverified quotations in the corpus."
- All object schemas flip to `additionalProperties: true` with a **must-ignore-
  unknown** rule and an open per-tool `ext` extension object, resolving the
  additive-minor-version contradiction. `$id`s embed the minor version.
- `input_digest` has a single home (`provenance.input_digest`) with a specified
  multi-input recipe; generations/syntheses gain `output.sha256`.
- `field_evidence` moved to a source-level sibling of `bibliographic` so CSL
  exports round-trip; bibliographic dates use CSL `date-parts`; `editors`/
  `translators` added.
- Provenance stamp gains `produced_by.method`, `produced_by.person`,
  `modified_at`, and `derived_from.synthesis_ids`.

### Added — schemas and fixtures

- New schemas: `event.schema.json`, `extraction-set.schema.json`.
- New vocab: `extraction_status`; `activity_type` gains `modify`, `reanchor`,
  `retract`, `remove`, `redact`.
- `tests/conformance/` fixtures (a passing corpus per level, a failing corpus per
  error code) so independent implementations self-test against the registry
  without this repo's code.
- Examples and fixtures are **regenerated by committed scripts**
  (`examples/build-examples.mjs`) with true content-addressed ids and byte-exact
  quotes — the 1.0 examples had hand-typed placeholder ids and quotes that were
  not byte-exact.

### Fixed — spec now matches implementation

- The reference validator implements the §08 registry exactly (1.0's validator
  computed level from counts and never ran a real quote check).
- Removed all normative delegation to external tool source files; every algorithm
  is written out in the spec.
- The reference browser no longer reconstructs quote context from the extraction
  record (self-confirming), no longer presents a paraphrase as a quotation, and
  writes atomically.

## 1.0.0 — 2026-08-15

Initial draft: five-object provenance graph, content-addressed ids, CSL-JSON
bibliography, conformance levels L0/L1/L2, file-based corpus with CSV mirrors and
an HTML browser. Superseded by 1.1.0.
