# Changelog

All notable changes to the Universal Provenance Corpus (UPC) standard.
Versioning is semantic (§00 Versioning policy).

## 1.5.0 — 2026-08-21

**Backward-compatible (additive) minor release: anchored context navigation and
structured image info.** No id recipe and no quotation gate changed; hop B is
still codepoint-exact, `char_range`-only, and unnormalized. The schema `$id`s bump
to `1.5.0` (which changes `integrity.schema_hash` — regenerate projections with
`upc regen`). Every 1.4.0 corpus remains valid.

### Added — select-to-source navigation

- **`upc locate <ext-id> --corpus <dir> [--format json|web-annotation]`** — a
  read-only command that resolves an extraction's **primary and every secondary**
  locator into a structured *context bundle*: the verified span with its
  surrounding text, its derived 1-based line number, and each advisory
  presentation locator with its representation, reference frame, and trust label.
  This is the backend call a reading surface makes to bring a quotation's source
  up in place.
- **`resolveLocator` / `charToLine` / `lineRangeForCharRange` / `textLines`** in
  `upc_common.mjs` — pure, zero-dependency helpers behind the command.
- **Advisory locator metadata**, all optional and all *siblings* of `value` so
  they stay outside the `ext-` identity recipe: `conforms_to`, `unit`,
  `reference` (a bbox's `{width, height}` frame), and `quote_hint`
  (`{exact, prefix?, suffix?}`, a content-based re-find aid that is **never** a
  verification path).
- **`secondary_locators[]` is now formalized** (§03) as the home for presentation
  *and cross-representation* locators. A secondary locator MAY address a
  different representation of the same source; `locator_rep_mismatch` constrains
  only the primary locator, which is what makes that expressible.
- **`line_range` is normatively 1-based and inclusive** (§03). The schema keeps
  `minimum: 0` so no existing corpus can be invalidated; the bound is enforced by
  a new advisory instead.
- Four new **advisory** rules, warnings only and inert to the conformance level:
  `secondary_locator_dangling`, `secondary_locator_cross_source`,
  `bbox_out_of_bounds`, `line_range_out_of_bounds`.

### Added — structured image info

- **`ocr` joins the `representation_role` vocabulary.** §05 has referenced this
  role since 1.0.0, but the closed enum only had `ocr_pdf`, so no producer could
  actually emit it. The mechanism §05 prescribes is now expressible.
- **`has_text`** (optional boolean) on a representation — the text-presence
  indication of the image triple: `description` says what the image *is*,
  `has_text` says whether it *says* anything, and the findable, gate-verified
  quotation of that text lives in a companion `ocr`-role textual representation.
- `ocr_text` is documented as what it always was: an advisory blob, never
  verified and never quotable.
- The web-research example now exercises the whole path end to end — an image
  with `has_text`, a companion `ocr` representation, a `direct_quote` that
  **passes the codepoint gate** against it, and a secondary `bbox` carrying that
  verified text back to a region on the picture.
- It also carries a **real native PDF** (`document_pdf`, 2 pages, generated
  deterministically with no dependencies) plus its extracted text layer, a
  quotation gated against that layer, and a secondary `page` locator producing a
  `paper.pdf#page=2` deep link — so the `page` presentation locator is exercised
  against actual PDF bytes rather than only unit-tested.

### Added — reference browser

- Images render inline with their description, text flag, caption, and
  dimensions; a `bbox` is drawn as an overlay positioned in **percent of its
  reference frame**, so it stays correct at any display scale.
- Quotations show their derived line number and an RFC 5147 `#line=` link to the
  source file; `page` locators deep-link with `#page=N`.
- The cross-representation case is rendered in full: an OCR quotation is shown
  verified *and* highlighted on the image it was read from.
- **An in-page source viewer.** A sticky pane beside the evidence list (and an
  inline one under a source's representations) shows the representation itself,
  positioned at the locator: numbered lines with the quoted span marked, the PDF
  at its page, the image with its region highlighted. Position chips drive the
  pane instead of opening a new tab; an "open externally" link remains in the
  pane header. Textual representations are **embedded at build time** — the same
  bytes the gate ran against — because `fetch` is unavailable from a `file:`
  origin and an iframe of a text file cannot be annotated cross-origin, so
  embedding is the only way the offline browser can show and mark up a source.
  Embedding is budgeted (512 KiB per representation, 8 MiB per corpus, with
  representations that extractions point into served first); anything over budget
  is **omitted entirely and offered as a link**, never truncated, because half a
  document shown as if it were whole is the exact failure this browser exists to
  prevent.
- **§09 deep links are now actually implemented.** The hash carries the view, the
  selected extraction, the active search, and the sort key/direction
  (`#/evidence/<ext-id>?q=…&sort=…&dir=…`), so a filtered view is shareable and
  reloads identically. The `#ex=<ext-id>` shorthand addresses one extraction
  directly. Evidence columns are sortable. Typing updates the hash in place
  without re-routing, so focus is never lost.

### Added — Web Annotation emission

- Presentation locators now project to `FragmentSelector`s: `line_range` → RFC
  5147 `#line=`, `page` → `#page=`, `bbox` → Media Fragments `#xywh=pixel:`,
  `timestamp_range` → `#t=`, each tagged `upc:conformsTo` and `upc:unit`, and
  each paired with a `TextQuoteSelector` re-find hint.
- A locator addressing a **different representation** becomes an **additional
  `target`**, not another selector on the existing one — an OA selector is only
  meaningful against its own `target.source`. An annotation with a single target
  keeps the 1.4.0 bare-object shape, so existing exports are byte-identical.
- New `upc:` terms: `upc:conformsTo`, `upc:reference`.

### Fixed — the trust boundary now follows the bytes, not the role name

- **A text layer extracted from a PDF is derived text.** §05 has always said a
  quotation of PDF text "lands on the trust boundary", but the badge was decided
  from the role *string* (`transcript`, `ocr*`), so a `role: "text"` layer whose
  parent is a PDF was badged plain **verified** — claiming the quote had been
  checked against the document when it had only been checked against a rendering
  of it. `isDerivedText` now decides from the derivation: a textual
  representation is derived text when the bytes it came from were not themselves
  text. A text-to-text conversion (raw HTML → cleaned Markdown) is unaffected and
  still badges **verified**, matching §11's "exact in the cleaned representation".
- The badge label broadens from "≈ to transcript" to **"≈ to derived text"**,
  which is accurate for transcripts, OCR, and extracted text layers alike. The
  badge *identifier* (`verified-to-transcript`) is unchanged.
- The `TEXTUAL` media predicate, previously duplicated in two scripts, is now the
  shared `isTextualMedia`.

### Fixed — browser

- A line position no longer renders twice when an extraction carries both a
  derived line number and an explicit `line_range` secondary for the same place.
- The source metadata grid sized its key column at a fixed `130px`, so a long key
  (`alias:researchassistant`) overlapped its value. It now sizes to content,
  cannot starve the value column, and stacks below 560px.
- `line_range` resolution now returns `path`, so its RFC 5147 link is emitted.
- A new selftest **parse-checks every generated `index.html`**. The client is
  emitted from a template literal, where a single lost backslash produces a page
  that looks fine on disk and dies on load; nothing caught that before.

### Not weakened (the point of the release)

- **The gate is untouched.** `verifyHopB` still keys on the primary `char_range`
  alone, over codepoints, with no normalization. Presentation locators are never
  verified and can never carry a `direct_quote`.
- **Identity is untouched.** `mintExtId` still hashes only
  `{type, representation_ref, value}` of the primary locator. Selftests assert the
  `ext-` id is unchanged by adding `secondary_locators` or locator metadata, and
  still changes when `locator.value` does.
- **The trust boundary is louder, not blurrier.** A region drawn on an image is
  *recorded, not gated*, and §09 now **requires** a conforming surface to say so
  wherever it draws one.

### Compatibility

- **The new optional members are invisible to a 1.4.0 reader.** `has_text` sits on
  a representation and the locator metadata sits on a locator; both schemas are
  `additionalProperties: true`, and the `unknown_field` advisory scans only the
  *top level* of source / extraction / generation / synthesis objects. So a 1.4.0
  validator accepts them silently — it does not even warn, unlike the
  `identifiers`/`relations` case in 1.3.0, which added top-level members.
- **`role: "ocr"` is the one genuine forward-incompatibility.**
  `representation_role` is a closed enum with no `x-` escape, so a 1.4.0
  validator raises `schema_invalid` (an L0 error) on a corpus that uses it. A
  producer targeting mixed readers should keep emitting `transcript` until its
  readers are on 1.5.0.
- Existing RO-Crate exports are unchanged: an extraction with no
  cross-representation locator still emits the 1.4.0 annotation shape byte for
  byte.

## 1.4.0 — 2026-08-20

**Backward-compatible (additive) minor release: W3C PROV-O export.** No object
field, vocabulary, id recipe, or quotation gate changed; the schema `$id`s bump to
`1.4.0` (which changes `integrity.schema_hash` — regenerate projections with
`upc regen`). Every 1.3.0 corpus remains valid.

### Added — PROV-O export

- **`upc export <corpus> --format prov`** — a deterministic, zero-dependency
  **W3C PROV-O** projection as flattened JSON-LD (streamed to stdout or `-o
  <file>`). Reuses the RO-Crate exporter's agent/entity machinery and realizes the
  [crosswalks/prov.md](crosswalks/prov.md) mapping: derived objects → `prov:Entity`,
  events → `prov:Activity`, tools/people → `prov:SoftwareAgent`/`prov:Person`,
  `derived_from` → `prov:wasDerivedFrom`, event inputs → `prov:used`, production →
  `prov:wasGeneratedBy`, `supersedes` → `prov:wasRevisionOf`, `direct_quote` →
  `prov:wasQuotedFrom`.
- Like `index.html` / CSV / RO-Crate, the PROV output is a **regenerable,
  non-canonical** view; the UPC objects stay the single source of truth.

### Not carried into PROV (by design)

- The **hop-B/C quotation gate is UPC-only.** `prov:wasQuotedFrom` records where a
  quotation came from but carries **none** of UPC's mechanical guarantee (§11).
- A source is a captured resource, **not** a claimed primary source: the export
  **never** emits `prov:hadPrimarySource`. A representation's `duplicate_of` is
  **not** a revision, so it is never mapped to `prov:wasRevisionOf`.

## 1.3.0 — 2026-08-20

**Backward-compatible (additive) minor release: optional source identity
enrichment.** Every 1.2.0 corpus remains valid, and a 1.3.0 validator accepts a
1.2.0 corpus. No object field was removed or renamed, and no id recipe or
quotation gate changed; the schema `$id`s bump to `1.3.0` (which changes
`integrity.schema_hash` — regenerate projections with `upc regen`).

### Added — optional source identity

- **`source.identifiers[]`** — optional external identifiers for the conceptual
  work, each `{ scheme, value, url? }`. `scheme` is a free string; recommended
  values live in the new `vocab/identifier_scheme` vocabulary (`doi`, `isbn`,
  `issn`, `pmid`, `pmcid`, `arxiv`, `handle`, `ark`, `urn`, `oclc`, `wikidata`,
  plus an `x-` escape). Never feeds the `src-` id recipe; UPC never resolves an
  identifier against an external registry.
- **`source.relations[]`** — optional typed links to other works, each
  `{ type, target }`, with `type` from the new `vocab/relation_type` vocabulary
  (`same_work_as`, `is_version_of`, `has_version`, `is_capture_of`, `is_part_of`,
  `has_part`, `is_format_of`, `is_translation_of`, `supersedes`, `superseded_by`,
  plus an `x-` escape). Intra-corpus supersession stays on the scalar
  `supersedes`/`superseded_by` fields; these relations never substitute for them.
- **Two advisory rules** (§08, Class `Advis`, warnings only):
  `identifier_scheme_unknown` (a non-`x-` scheme outside the recommended
  vocabulary) and `relation_dangling` (an intra-corpus, id-shaped relation target
  that does not resolve). Neither is ever a hard error; external identifiers and
  URLs are never checked.
- **RO-Crate export** surfaces both fields as `upc:` terms (`upc:identifiers` /
  `upc:relations`, with nested `upc:identifierScheme` / `upc:relationType` /
  `upc:relationTarget`); the `profiles/ro-crate/` term set is extended to match.

### Compatibility

- `identifiers[]` / `relations[]` are additive optional fields and **recipe-inert**
  (the `src-` recipe reads only URL/bytes). A 1.2.0 reader ignores them
  (must-ignore-unknown); a **1.2.0 validator under `--strict`** will
  `unknown_field`-flag them — expected minor-version forward-compat behavior.

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
