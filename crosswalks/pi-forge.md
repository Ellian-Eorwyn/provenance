# Crosswalk: pi-forge ⇄ UPC

pi-forge already implements a PROV-inspired JSON/JSONL provenance format. Adopting
UPC is a **projection**, not a rewrite: pi-forge gains a deterministic `to-upc`
emitter (a sibling of its existing report generator) that writes a UPC corpus
from its run artifacts, and a UPC reader for corpora produced by other tools.

## What changed in UPC 1.1.0 (affects the pi-forge emitter)

1. **A `direct_quote` now requires a byte-anchored `char_range` locator into a
   textual representation, and is verified byte-for-byte** (the hop-B gate).
   pi-forge's native `locator: {type:"section", value:"…"}` **cannot carry a
   quotation** — it is a coarse locator. The emitter must, for each quoted
   evidence item, **byte-exact-search the chosen text representation** and emit a
   `char_range` locator (the reference `upc reanchor` / re-extraction search does
   exactly this), keeping the section string as a `secondary_locators[]` entry.
   Evidence with no findable verbatim span is emitted as `text`-only (a
   paraphrase), never as a `direct_quote`.
2. **`direct_quotes[]` is no longer lossy.** In 1.0 the emitter kept the first
   quote; in 1.1 emit **one UPC extraction per quote** (each independently
   anchored and gated), so no evidence is dropped.
3. **Identity recipes are exact** (spec §06): keys are UTF-8 strings with JCS
   (RFC 8785) for any embedded JSON, and the validator **recomputes every id**.
   Compute ids with the reference `mint*` helpers (or `upc mint`) rather than
   reusing per-run ids; the validator now rejects hand-formed ids (`id_mismatch`).
4. **`field_evidence` moved** to a source-level sibling of `bibliographic` (so CSL
   exports round-trip); `input_digest` lives only in the provenance stamp.

The tables below are the field bridge; apply the four changes above on top.

Field names below are verified against real on-disk output:
`~/Documents/BSO/WebServices/forge-output/web-collection/bsv-migration-downtime/web_manifest.json`
and `~/Documents/EEI/ITO/Generated/Project-Extraction/evidence_items.jsonl`.

## What already matches (no work)

- **Shared enums, verbatim.** `interpretation` = explicit/inferred/unclear and
  `confidence` = high/medium/low are identical in both. `status` maps directly.
- **Content-addressed ids.** pi-forge already mints `src-<12hex>` (deep research)
  and `sha256:<hash>` `resourceId` (web-collection). `rep-`/`ext-` follow the
  same rule.
- **Typed locators.** Real `evidence_items.jsonl` already stores
  `locator: {type:"section", value:"…"}` — UPC's locator shape, minus the
  `representation_ref` (the one field to add).
- **Generated-from-structured Markdown.** `deep_research_report.md` is generated
  from `claim_register.jsonl`; that is exactly UPC's synthesis rule.

## Identity

| pi-forge | UPC | Notes |
|---|---|---|
| `sourceId` (`src-<12hex>`, deep) | `source.source_id` | direct — same scheme |
| `resourceId` (`sha256:<64>`, web-collection) | `source.source_id` = `src-` + first 12 of the hash; keep full hash in `retrieval.sha256` | plus `aliases["pi-forge"] = resourceId` |
| `evidenceId` (`ev-0001` or `ev-<12hex>`) | `extraction.extraction_id` = `ext-<12hex>` (content-addressed) | keep the original in `aliases["pi-forge"]`; resolves the sequential-vs-hash inconsistency |
| `claimId` (`cl-0001`) | `synthesis.claims[].claim_id` | kept as-is inside the synthesis |

## Source & representations

`web_manifest.json` resource + deep `source_index.json` entry → one UPC `source`
with `representations[]`.

| pi-forge | UPC |
|---|---|
| `sourceUrl` | `retrieval.original_url` |
| `finalUrl` | `retrieval.final_url` |
| canonical URL (deep) | `retrieval.canonical_url` |
| `accessDate` | `retrieval.fetched_at` |
| `status` | `retrieval.fetch_status` |
| `httpStatus` | `retrieval.http_status` |
| `contentType` | `retrieval.content_type` |
| acquisition strategy / extraction method (deep) | `retrieval.fetch_method`, `retrieval.extraction_method` |
| `title` | `source.title`, `bibliographic.title` |
| `sha256` | `retrieval.sha256` and the primary representation's `sha256` |
| `filename` / `outputPath` (`downloads/…html`) | representation `role:"raw_html"`, `path` |
| `archive/extracted/*`, `downloads/<source-id>.txt` | representation `role:"text"`/`"clean_markdown"`, `path` |
| `captureArtifacts` (`rendered.html`, `page.pdf`, `screenshot.png`, `snapshot.mhtml`) | representations `rendered_html` / `rendered_pdf` / `image` |
| `byteSize` | representation `bytes` |
| `rendered` (bool) | presence of a `rendered_*` representation |
| `duplicate_of` | representation/source `duplicate_of` relation |
| search origins (deep) | `source.discovery` |

## Extractions (`evidence_items.jsonl` → `extraction`)

| pi-forge evidence | UPC extraction |
|---|---|
| `evidence_id` | `extraction_id` (→ `ext-<12hex>`, original in `aliases`) |
| `source_id` | `source_id` |
| — (bind to the extracted-text representation) | `representation_ref` **(add)** |
| `text` / `description` | `text` (a paraphrase; never gated) |
| `directQuote` / `direct_quotes[]` | one `direct_quote` **per quote** — each becomes its own extraction, byte-anchored (no longer "first only") |
| `locator` (`{type,value}` or string) | for a quote: a **`char_range`** found by byte-exact search + `locator.representation_ref`; the original section string → `secondary_locators[]` |
| `interpretation` | `interpretation` (identical enum) |
| `confidence` | `confidence` (identical enum) |
| `item_type` (literature/project vocab) | `type` (see mapping below) |
| `notes` | `rationale` / notes |
| the prompting query | `query` |
| `extractedAt` | `provenance.created_at` |
| `source_revision` (content hash at extraction time) | `provenance.input_digest` |

`item_type` mapping: `claim`/`finding`/`method`/`limitation`/`definition` →
same-named `extraction.type`; `citation`/`quoted_evidence` →
`in_text_citation`/`quote`; `author`/`technology`/`policy`/`population` →
`entity`; `connection`/`data_source`/`variable`/`research_gap`/`action_item` →
`x-connection` / `x-data-source` / `x-variable` / `x-research-gap` /
`x-action-item` (the `x-` escape hatch).

## Synthesis (`claim_register.jsonl` → `synthesis`)

| pi-forge | UPC |
|---|---|
| a deep-research run answering a question | one `synthesis` (`type:"answer"`/`"literature_review"`) |
| `claimId` / `text` | `claims[].claim_id` / `text` |
| `evidenceIds` / `sourceIds` | `claims[].evidence_ids` / `source_ids` |
| `confidence` / `notes` | `claims[].confidence` / `notes` |
| `deep_research_report.md` | `synthesis.output.path` (`synthesis.md`) |
| `gap_log.jsonl` | synthesis notes / `x-gap` extractions |

pi-forge's `validate` rule "the report must cite every claim/evidence/source id"
becomes UPC's `uncited_in_output` check — the same guarantee.

## Bibliographic & activity

- Academic `works.jsonl` (canonical Work) → `source.bibliographic` (CSL-aligned,
  dates as CSL `date-parts`); `field_provenance.jsonl` → the source-level
  `field_evidence` (a sibling of `bibliographic`, not nested inside it); `works.ris`
  becomes a RIS **export projection** (`upc export --format ris`), not the
  canonical form.
- `run_events.jsonl` + `model_calls.jsonl` + `acquisition_log.jsonl` →
  `provenance/events.jsonl` (`activity_type` fetch/search/extract/generate/
  synthesize; `status` from the shared enum).

## Gaps pi-forge must close

1. **Byte-anchor every quote.** Bind each quoted evidence item to a textual
   representation and emit a `char_range` locator found by byte-exact search, so it
   passes the hop-B gate; keep the section string in `secondary_locators`. This is
   the single largest change — pi-forge's real evidence has no offsets today.
2. Emit `source.json` per source (pi-forge's run-dir is per-run; the emitter
   groups artifacts by source).
3. Mint content-addressed ids by the exact §06 recipes (the validator recomputes
   them); keep per-run `ev-000N` in `aliases`.
4. Emit CSL bibliographic (dates as `date-parts`) for web sources; put per-field
   provenance in the source-level `field_evidence`.
5. Mark quotations in `deep_research_report.md` with `"…" [ext-id]` so the report
   passes the hop-C output gate.

## Dry-run result (read-only, no backend)

Mapped the real `web_manifest.json` resource (the watchdogstudio migration
article) through the Source table: every UPC required source field
(`source_id`, `source_kind`, ≥1 representation with `role`/`path`/`sha256`) has a
pi-forge origin — `resourceId`→id+hash, `sourceUrl`→retrieval, `outputPath`→raw
representation, `byteSize`→bytes. Mapped a real `evidence_items.jsonl` record
through the Extraction table: `evidence_id`/`source_id`/`direct_quotes`/`locator`/
`interpretation`/`confidence` all have direct UPC targets; the only field with no
existing value is `representation_ref` (gap #1). **Coverage confirmed.**
