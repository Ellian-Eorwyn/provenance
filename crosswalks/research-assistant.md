# Crosswalk: ResearchAssistant ⇄ UPC

ResearchAssistant (RA) already stores sources, per-source representations, and
citation-level evidence in a file-based repository whose layout is nearly UPC's.
Adopting UPC is mostly a **field rename + two additions**, with RA's existing
`repo_operations` engine as the ready-made import path for corpora produced by
other tools.

Field names below are verified against a real RA repository:
`…/output_run/.ra_repo/repository_state.json` (1,855 sources, 3,710 citations,
`schema_version: 2`).

## What changed in UPC 1.1.0 (good news for RA)

1. **RA's `char_offset_start/end` now match UPC exactly.** UPC's `char_range` is
   defined as **Unicode codepoints** into the representation's UTF-8-decoded text —
   which is exactly Python's `str` indexing that RA already uses. No offset
   arithmetic changes; just add `representation_ref`.
2. **But a quote must be verbatim.** A `direct_quote` is gated byte-for-byte, so a
   `citing_sentence` may be emitted as a `direct_quote` **only if it is exactly the
   representation text at those offsets**. A sentence produced by a fuzzy matcher
   (`match_method`, `match_confidence < 1`) that is not verbatim goes in `text`
   (paraphrase) with the offsets in `secondary_locators`, not as a `direct_quote`.
   Because RA's offsets index the cleaned Markdown, **any change to the cleaning
   pipeline re-mints the representation** — run `upc reanchor` to re-locate every
   quote in the successor, or flag `needs_review`.
3. **`page_in_source` is a secondary locator.** The gated primary locator is the
   `char_range`; the page goes in `secondary_locators[]` (human context, never
   gated).
4. **`field_evidence` is a source-level sibling of `bibliographic`** (not nested
   inside it), so `CitationMetadata` exports to CSL verbatim. Dates use CSL
   `date-parts`.
5. **Per-media-type repos remain readable.** RA's standalone-job layout
   (`originals/`, `markdown/`) is a permitted variant: point `corpus.json.sections`
   at those folders (including the new `generations` key) and the reference loader
   resolves it — no bytes move. Writers SHOULD emit the canonical per-source layout
   (Appendix A); a one-time `upc regen` migrates an existing repo.

## What already matches (little/no work)

- **Layout is nearly identical.** RA's `sources/<id>/`, `manifest.csv`,
  `citations.csv`, `.ra_repo/` map onto UPC's `sources/<slug>/`, `sources.csv`,
  `extractions.csv`, `.upc/`. (The sampled repo uses standalone-job mode —
  `originals/`, `markdown/` — which is the alternate layout UPC also permits via
  `sections`.)
- **Per-generation provenance already captured.** `SourcePhaseMetadata`
  (`model`, `prompt_version`, `content_digest`, `stale`) is UPC's provenance
  stamp + staleness, already populated.
- **Bibliographic is already CSL-shaped.** `CitationMetadata` maps almost 1:1 to
  UPC's CSL-aligned bibliographic object.
- **Exports are already projections.** `manifest.csv`, `citations.csv`, and the
  offline HTML bundle are UPC's `sources.csv`, `extractions.csv`, and `index.html`.

## Identity

| RA | UPC | Notes |
|---|---|---|
| `id` (`000123`, zero-padded) | `aliases["researchassistant"]` | the human/display id, kept as an alias |
| `repository_source_id` (stable FK) | `aliases["researchassistant"]` (same) | RA's cross-file key |
| — | `source.source_id` = `src-<12hex of canonical/original URL or content>` **(add)** | the tool-independent canonical id; RA already has `remap_source_ids` so display ids stay flexible |
| `citation_id` / `sentence_id` | `extraction.extraction_id` = `ext-<12hex>` | originals kept in `aliases` |

## Source & representations (`SourceManifestRow` → `source.json`)

| RA | UPC |
|---|---|
| `source_kind` (`url`/`uploaded_document`/`video`) | `source_kind` (`url`/`document`/`video`) |
| `original_url` / `final_url` / `canonical_url` | `retrieval.original_url` / `final_url` / `canonical_url` |
| `fetch_status` | `retrieval.fetch_status` |
| `fetch_verification` (`paywall`/`login_required`/`thin_content`/…) | `retrieval.fetch_verification` (values align with the richer `fetch_status` vocab) |
| `http_status` / `content_type` / `detected_type` | `retrieval.http_status` / `content_type` / (detected) |
| `fetch_method` (`http`/`playwright`/`yt_dlp`/`manual_*`) | `retrieval.fetch_method` (`http`/`playwright`/`x-yt-dlp`/`manual`) |
| `fetched_at` / `sha256` / `extraction_method` | `retrieval.fetched_at` / `.sha256` / `.extraction_method` |
| `title`, `author_names`, `publication_date/_year`, `document_type`, `organization_*` | `source.title` + `bibliographic.*` |
| `raw_file` | representation `role:"raw_html"` (or `original`) |
| `rendered_file` / `rendered_pdf_file` | `rendered_html` / `rendered_pdf` |
| `ocr_pdf_file` | `ocr_pdf` |
| `markdown_file` | `markdown` |
| `llm_cleanup_file` | `clean_markdown` (`produced_by:"model"`) |
| `metadata_file` | `metadata` representation |
| `video_file` / `audio_file` / `thumbnail_file` | `video` / `audio` / `thumbnail` |
| `markdown_char_count` | representation `char_count` |
| `discovered_from` / `discovered_source_ids` / `discovery_depth` | `source.discovery.*` |
| `sha256` | representation + `retrieval.sha256` |

## Provenance & staleness (`SourcePhaseMetadata` → provenance stamp)

| RA | UPC |
|---|---|
| `model` | `provenance.produced_by.model` |
| `prompt_version` | `provenance.produced_by.prompt_version` |
| `profile_name` | `provenance.produced_by.prompt_version` (profile) or a note |
| `content_digest` | `input_digest` |
| `stale` | `stale` |
| `status` | `status` / provenance |

## Extractions (`ExportRow` / `citations.csv` → `extraction`, type `in_text_citation`)

| RA citation | UPC extraction |
|---|---|
| `repository_source_id` | `source_id` (resolve alias → canonical `src-`) |
| `document_sha256` / `document_repository_path` | the representation the citation was read from → `representation_ref` **(bind)** |
| `citing_sentence` | `direct_quote` **only if byte-exact** at the offsets; otherwise `text` (paraphrase) |
| `citing_paragraph` | context / notes (advisory) |
| `context_before` / `context_after` | `context_before` / `context_after` (advisory) |
| `citation_raw` (`[4]`) | recorded in `rationale` (raw marker) |
| `page_in_source` | `secondary_locators[]` `{type:"page"}` (never the gated primary locator) |
| `InTextCitation.char_offset_start/end` | `locator` `{type:"char_range", value:{start,end}, representation_ref}` — codepoints, matches Python indexing exactly **(add representation_ref)** |
| `research_purpose` | `query` |
| `match_confidence` | `confidence_score` |
| `match_method` | `rationale` / provenance |
| `cited_authors/title/year/source/volume/issue/pages/doi/url/raw_entry` | `resolves_to` (CSL bibliographic) |
| `warnings` | notes |

## Bibliographic (`CitationMetadata` → CSL-aligned)

| RA | UPC |
|---|---|
| `item_type` | `bibliographic.item_type` |
| `authors[]` (`family`/`given`/`literal`) | `bibliographic.authors[]` (same) |
| `issued`, `container_title`, `volume`, `issue`, `pages`, `doi`, `url`, `report_number`, `language`, `accessed` | same-named `bibliographic.*` |
| `field_evidence{field: CitationFieldEvidence}` | source-level `field_evidence{}` (a sibling of `bibliographic`; value/origin/evidence/confidence/locator/manual_override) |

## Generations

| RA | UPC generation |
|---|---|
| `summary_file` | `type:"summary"`, `output.path` |
| `rating.json` (`overall_relevance`/`depth_score`/`rationale`/`confidence`) | `type:"rating"`, `output.value` |
| `catalog.json` | `type:"catalog"` + `source.bibliographic` |
| custom LLM columns (`RepositoryColumnConfig`) | `type:"classification"`/`"note"` or `x-<column>` |

Each generation's stamp comes from the matching `SourcePhaseMetadata`.

## Import / export directions

- **UPC → RA (import).** RA's transactional `repo_operations` engine is the
  writer: for each UPC source → `create_sources` (id from `aliases` or new, url,
  title) + `attach_files` (raw/rendered/markdown from UPC representations); UPC
  extractions → citation rows; UPC generations → columns/values. This closes RA's
  current gap (rich export, thin import).
- **RA → UPC (export).** Add a `to-upc` emitter beside the existing exporters; it
  is a projection, like the current `manifest.csv`/HTML-bundle exporters.

## Gaps RA must close

1. Mint a content-addressed `source_id` by the §06 recipe (keep `000123` as an
   alias); the validator recomputes ids.
2. Add `representation_ref` to citation locators (bind the codepoint offsets to the
   `<id>_clean.md` representation they index) and emit a `direct_quote` only when
   the span is byte-exact; otherwise emit `text` + `secondary_locators`.
3. Wire `upc reanchor` into the cleaning pipeline: when `<id>_clean.md` is
   regenerated (new `rep-` id), re-locate every quote in the successor instead of
   leaving stale offsets.
4. Emit `provenance/events.jsonl` (RA already logs every model call in
   `data/llm_call_logs/session-*.jsonl` — map those).
5. Serialize the provenance stamp shape (all the pieces already exist in
   `SourcePhaseMetadata`); put per-field provenance in the source-level
   `field_evidence`.

## Dry-run result (read-only, no backend)

Mapped a real `repository_state.json` source (`id 000001`, a Stanford
Encyclopedia entry: `raw_file:"originals/000001_source.html"`,
`markdown_file:"markdown/000001_clean.md"`, `sha256`, `fetch_status:"success"`)
through the Source table: every UPC required field resolves —
`id`→alias, url→retrieval, `raw_file`/`markdown_file`→two representations with
`role`/`path`/`sha256`. Mapped a real citation row (all 28 `ExportRow` columns
present) through the Extraction table: `citing_sentence`, `context_*`,
`page_in_source`, `research_purpose`, `match_confidence`, and every `cited_*`
field have UPC targets; the only additions are the canonical `src-` id and
`representation_ref` (gaps #1–2). **Coverage confirmed.**
