# UPC 02 — Sources & Representations

The **source** is the primary conceptual object; a **representation** is one
typed rendering of it. Treating the source (not the file) as the unit is what
lets an HTML capture, a print-to-PDF, cleaned Markdown, and three extracted
figures all be understood as *the same underlying source*.

Schemas: [`source.schema.json`](../schemas/source.schema.json),
[`representation.schema.json`](../schemas/representation.schema.json).

## Source

A source has a canonical `source_id` (§06), a `source_kind`, and at least one
representation. It carries bibliographic metadata (CSL-aligned, §below),
`retrieval` provenance, optional per-field evidence (`field_evidence`, §07), and
— because a source is a *root* of the graph — no `derived_from`.

```json
{
  "source_id": "src-a1b2c3d4e5f6",
  "aliases": { "researchassistant": "000123" },
  "source_kind": "url",
  "title": "How to migrate a WordPress site with no downtime",
  "bibliographic": {
    "item_type": "webpage",
    "title": "How to migrate a WordPress site with no downtime",
    "authors": [{ "literal": "Watchdog Studio" }],
    "issued": { "date_parts": [[2024]] },
    "url": "https://watchdogstudio.com/blog/how-to-migrate-wordpress-site-with-no-downtime/",
    "accessed": { "date_parts": [[2026, 7, 9]] }
  },
  "retrieval": {
    "original_url": "https://watchdogstudio.com/blog/how-to-migrate-wordpress-site-with-no-downtime/",
    "final_url": "https://watchdogstudio.com/blog/how-to-migrate-wordpress-site-with-no-downtime/",
    "canonical_url": "https://watchdogstudio.com/blog/how-to-migrate-wordpress-site-with-no-downtime",
    "fetch_status": "success",
    "http_status": 200,
    "content_type": "text/html; charset=UTF-8",
    "fetch_method": "http",
    "fetched_at": "2026-07-09T19:03:54Z",
    "sha256": "sha256:bce3e616af73a21a5f2e55630b3b406841be1d10937159e6950873625cdafaa5"
  },
  "representations": [ /* see below */ ],
  "provenance": {
    "produced_by": { "tool": "pi-forge", "tool_version": "0.1.0", "method": "http" },
    "created_at": "2026-07-09T19:03:55Z"
  }
}
```

`source.json` is the per-source manifest and makes the folder self-contained.

### Optional source identity (`identifiers`, `relations`)

A source MAY carry two optional arrays that enrich its identity without affecting
its canonical `src-` id. Both are **advisory** — they never gate, never change the
id recipe (§06), and are never resolved against any external registry.

- **`identifiers[]`** — external identifiers for the conceptual work, each
  `{ scheme, value, url? }`. `scheme` SHOULD be drawn from
  `vocab.json#/$defs/identifier_scheme` (`doi`, `isbn`, `issn`, `pmid`, `pmcid`,
  `arxiv`, `handle`, `ark`, `urn`, `oclc`, `wikidata`), or an `x-`-prefixed
  extension. It is a **free string** in the schema, so an unrecognized non-`x-`
  scheme is surfaced as the advisory `identifier_scheme_unknown` (§08), not a hard
  error. UPC records these; it does not verify that the identifier resolves or that
  it names this work.
- **`relations[]`** — typed relationships to other works, each `{ type, target }`.
  `type` is drawn from `vocab.json#/$defs/relation_type` (`same_work_as`,
  `is_version_of`, `has_version`, `is_capture_of`, `is_part_of`, `has_part`,
  `is_format_of`, `is_translation_of`, `supersedes`, `superseded_by`), plus an
  `x-` escape. `target` is either an intra-corpus id (`src-`/`rep-`/…) or an
  external identifier string / URL. When `target` is id-shaped but resolves to
  nothing in the corpus, the advisory `relation_dangling` is raised (§08);
  external targets are never checked.

```json
{
  "identifiers": [
    { "scheme": "doi", "value": "10.5281/zenodo.7654321", "url": "https://doi.org/10.5281/zenodo.7654321" }
  ],
  "relations": [
    { "type": "same_work_as", "target": "https://doi.org/10.5281/zenodo.7654321" }
  ]
}
```

**Supersession is separate.** Intra-corpus supersession stays on the top-level
scalar `supersedes` / `superseded_by` fields, which drive the `cites_superseded`
conformance rule (§08). A `relations[]` entry of type `supersedes` / `superseded_by`
is advisory metadata (typically pointing at an *external* work) and is **never** a
substitute for the scalar fields.

## Representations

A representation classifies bytes by `role` and points at them by corpus-relative
`path`, with a `sha256`. Roles are a closed vocabulary
(`vocab.json#/$defs/representation_role`). Key distinctions:

- `raw_html` — the raw HTTP response body.
- `rendered_html` — post-JavaScript DOM (browser render).
- `rendered_pdf` — a print-to-PDF *of a web page*.
- `document_pdf` — a **native PDF preserved as a PDF** (not a web render).
- `clean_markdown` / `markdown` / `text` — extracted, readable text.
- `image` — an extracted figure (see §05); id prefix `img-`.
- `audio` / `video` / `transcript` — audiovisual material and its transcript.
- `metadata` — a metadata sidecar.

```json
"representations": [
  { "representation_id": "rep-1111aaaa2222", "role": "raw_html", "media_type": "text/html", "path": "sources/watchdog-2024-migrate-with-no-downtime/representations/raw.html", "sha256": "sha256:bce3e6...", "bytes": 503022, "produced_by": "http" },
  { "representation_id": "rep-3333bbbb4444", "role": "clean_markdown", "media_type": "text/markdown", "path": "sources/watchdog-2024-migrate-with-no-downtime/representations/clean.md", "sha256": "sha256:77aa...", "char_count": 8140, "produced_by": "readability" }
]
```

`char_count`, where present, is the number of **Unicode codepoints** in the
representation's UTF-8-decoded text (the same unit `char_range` locators use,
§03).

A source is understood through its representations, so a locator into "the text"
must name *which* representation it indexes (§03). Representations are immutable:
re-rendering produces a *new* representation (new bytes → new `rep-` id), not a
mutation of the old one. A representation extracted from another (an image pulled
from a PDF, a transcript of an audio file) SHOULD set `parent_representation_ref`.

### Textual representations (the substrate the quote gates run against)

A representation is **textual** iff its `media_type` is `text/*`,
`application/json`, or `application/xml`. Only textual representations can carry
verified quotations (§03). To make byte-for-byte verification deterministic
across tools and platforms:

- **Encoding.** A textual representation *produced by a tool* (`clean_markdown`,
  `markdown`, `text`, `transcript`) MUST be UTF-8 with no BOM. A *raw capture*
  (`raw_html` and the like) is stored **as captured** — its bytes are the
  evidence — and its true encoding is recorded in `retrieval.content_type` /
  `representation.encoding`; if it is not UTF-8, it cannot carry a `char_range`
  quotation directly (extract into a cleaned UTF-8 representation instead).
- **Line endings.** A tool-produced textual representation MUST use LF (`\n`) at
  creation. Line endings count as stored: a gate compares exactly, so a stray CR
  is a real difference, not something the gate forgives.
- **Soft wrapping (SHOULD).** A tool-produced clean text representation SHOULD be
  *soft-wrapped* — one line per paragraph, no hard line breaks inside a
  paragraph. Rationale: a verified `direct_quote` contains the representation's
  bytes exactly, newlines included; hard-wrapping a paragraph forces a `\n` into
  the middle of almost every multi-line quote, which then cannot use the tidy
  inline citation form (§04) and reads badly everywhere. Soft-wrapped clean text
  keeps quotations single-line and legible. (Raw captures are never rewrapped.)
- **Hashing.** `sha256` is always computed over the **exact stored bytes** of the
  file, whatever they are. Normalization is a property of how a tool *creates* a
  representation, never something applied at hash or verify time.

## Bibliographic metadata (CSL-aligned)

Bibliographic data is CSL-JSON-aligned (snake_cased) so it round-trips with a CSL
processor and exports cleanly to RIS or BibTeX as projections (§09). Dates use
CSL `date-parts` (`{"date_parts": [[2024]]}` or `[[2024, 7, 9]]`) or a `{"raw":
"…"}` fallback; contributors carry `authors`, and optionally `editors` /
`translators`, each entry `{family, given}` or `{literal}`. See
[`bibliographic.schema.json`](../schemas/bibliographic.schema.json). Per-field
provenance lives in the source-level `field_evidence` (§07), a sibling of
`bibliographic` — so a CSL export is the `bibliographic` object verbatim, with no
UPC-only members to strip.

## Retrieval provenance

`retrieval` records how the source bytes were obtained: the requested, final, and
canonical URLs; `fetch_status` and `fetch_verification` (paywall, login, thin
content); HTTP status; content type; fetch method; timestamp; and the sha256 of
the acquired bytes. This is the source's equivalent of a derivation stamp and is
what a validator checks the primary representation's hash against.

`canonical_url` is **metadata only** — a record of what the page declared about
itself. It does **not** participate in the source's identity: a page must not be
able to dictate its own corpus id by advertising a `rel=canonical` (§06).

## Immutability

Source bytes are never modified in place. A corrected capture is a new
representation; a moved URL is a new source related by `supersedes` /
`superseded_by` (§07). This immutability is what makes content-addressed ids
stable and hashes meaningful. Correcting *derived* material (a mis-anchored
extraction, a stale summary) is a first-class human/agent workflow — see §03
(extraction lifecycle), §09 (the modify path), and §10 (removal).
