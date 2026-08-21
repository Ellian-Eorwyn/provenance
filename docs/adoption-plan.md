# Adoption plan — UPC as the storage substrate for ResearchAssistant and pi-forge

**Status: phases 0–1 shipped in 1.6.0. Phase 2 in progress.**

This is the living program document for putting UPC underneath real applications.
It records not just what to build but *why the shape is what it is*, because most
of the design was forced by things measured in a real corpus rather than chosen.

| Phase | What | Status |
|---|---|---|
| 0 | Package UPC so consumers can pin a version | **done** (1.6.0) |
| 1 | UPC 1.6.0 — codes & codings, `representation_shared`, `verified-to-rewrite` | **done** (1.6.0) |
| 2 | Read-only converter for an existing RA repository | **in progress** |
| 3 | Read-only UPC projection inside RA | not started |
| 4 | The reader UI (`/read`, `/codes`) | not started |
| 5 | The LLM coding pass — the actual goal | not started |
| 6 | Dual-write, human coding | not started |
| 7 | pi-forge | not started |

## Context

UPC is a complete, tested standard with one hard promise: a quotation attributed to
a source is byte-exactly verifiable, or it is flagged. What it did not have was a
consumer.

The goal is to make UPC the way research data is actually stored and retrieved — so
provenance is tracked not just for documents but for **lines and phrases inside
them** — and to make ResearchAssistant (RA) the first app that reads, writes, and
*displays* it well. The end state a researcher should experience: an LLM finds and
codes the passages relevant to a topic, every coded passage is provably real text
from a real source, and a human browses that coded evidence in a reader that shows
**codes and sources**, never `extraction`, `representation`, `locator`, or `hop B`.

### The four measured facts that shaped this

All four were found by measuring the 679 MB test corpus at
`/Volumes/Storage/EEI/YoloVPP/2026-provenance-test` (106 sources, RA schema v5),
not by reading documentation. Each one changed the plan.

1. **RA could not be represented in UPC 1.5.0 at all.** `mintGenId` hashes
   `type + inputs + input_digest` with no label, so all 15 of RA's LLM columns
   collapsed into one `gen-` id — 14 `id_duplicate` errors × 106 sources. There was
   no honest workaround: the `input_digest` genuinely is the same bytes for every
   column.
2. **181 duplicate representation ids.** 1,639 files, 1,458 distinct hashes, 98
   duplicate groups (69 cross-source, mostly shared figures and logos). `rep-`/`img-`
   ids are pure byte hashes, so the corpus failed L1 before any coding existed.
3. **There was no way to express a "code."** `extraction.type` is a closed vocab of
   evidence *kinds* and is not in the `ext-` id recipe, so two codes on one span
   collide. Extraction-sets-per-code, `x-` types, and `ext:{}` all fail for the same
   reason or break interop.
4. **The AI-tidied copies are rewrites, and UPC would have certified them.** 68% of
   substantive lines (≥ 40 chars) in `_llm_clean.md` are not verbatim in the matching
   `_clean.md`. Source `000109` reads *"cloud-based system that integrates"*; the
   tidied copy silently grammar-corrects it to *"cloud-based systems that integrate"*.
   A quote anchored there badged plain **verified**, because the badge was decided
   from the role name and the parent's media type, never from `produced_by`.

### Decisions taken

- **Full UPC 1.6.0**, not a minimal unblock — codes must be first-class or no other
  tool can read them, which defeats the point.
- **Targeted find-and-quote coding**, not exhaustive per-sentence labelling. The
  corpus holds ~10,000 sentences; exhaustive coding against 8 codebooks would be
  ~80,000 mostly-negative model calls. Asking the model to *find and quote* the
  passages that instantiate each code yields ~2,000–4,000 coded passages, every one
  byte-anchored by construction, and makes the model commit to a span rather than to
  a label on a span it was handed.
- **Split by entity.** RA's `repository_state.json` stays authoritative for its
  existing sources and spreadsheet columns and is projected one-way into UPC. Spans,
  codebooks, and codings are corpus-native from birth — they have no RA legacy, so
  there is nothing to sync. This is what avoids inventing a two-way sync problem.
- **Sibling directory** for the corpus (`<repo>-upc/`), hardlinked, so it stays
  independently portable — half the point of UPC is being able to hand someone the
  folder.

---

## Phase 0 — Packaging *(shipped)*

`package.json` (`@ellian-eorwyn/upc`, `bin: upc`, zero dependencies, Node ≥ 18)
shipping scripts, schemas, vocab, spec, profiles and crosswalks. `upc version --json`
and `upc check-compat --requires "^1.6"` give an embedding tool a handshake instead
of a vendored absolute path that drifts silently. `VERSION` became the single source
of truth the CLI reads.

## Phase 1 — UPC 1.6.0 *(shipped)*

Full detail in [`spec/12-codes-and-codings.md`](../spec/12-codes-and-codings.md) and
the 1.6.0 entry in [`CHANGELOG.md`](../CHANGELOG.md). The load-bearing ideas:

**The span is not the judgement.** An extraction is content-addressed over
`(source, representation, locator, text)`, so two coders selecting the same sentence
converge on one `ext-` id — which is exactly why the verdict cannot live on it. A
`coding` puts the coder and the code in its own key, so agreement, disagreement and
multi-labelling are representable, while `created_at` / `confidence` / `rationale` /
`status` stay *out* of the key so re-running an unchanged pass writes nothing.

**A coding may never carry a locator.** A span-level coding targets an `ext-` that
has already passed hop B, so a code can never become a second, ungated way to point
at text. Every coded passage is proved real before it can be labelled.

Also shipped: the `representation_shared` demotion (fact 2), the
`verified-to-rewrite` badge (fact 4), and `upc anchor` — the first actual
implementation of the re-extraction protocol, which had been normative prose in §03
and §09 with no code behind it.

**Compatibility, stated precisely.** Codings are invisible to a 1.5.0 reader (tested
against the pinned 1.5.0 script, not asserted). The shared-representation *loosening*
is deliberately **not** forward-compatible: no previously valid corpus breaks, but a
corpus using the new laxity needs a ≥ 1.6.0 reader. That asymmetry is documented in
§00 and the CHANGELOG and pinned by a test.

---

## Phase 2 — The converter *(in progress)*

`python -m backend.upc.convert_repo --in <ra-repo> --out <new-dir>`

**Read-only by construction.** Refuse if `--out` is inside `--in`; open input files
`"rb"` only. **Do not take RA's flock** — acquiring `.ra_repo/repository.lock` is
itself a write and would race a running RA; instead snapshot `repository_state.json`'s
bytes and mtime at start, re-check at the end, and report "input changed, re-run"
rather than emitting a half-consistent corpus. **Never read
`.ra_repo/agent_tokens.json`** (plaintext tokens); a test asserts no token string
appears in any output byte. This honours the corpus's own `AGENTS.md` warning by
construction.

**Bytes: hardlink, never symlink.** §08 rule 0.3 realpath-checks containment, so a
symlink out to the RA repo fails `symlink_escape`. Hardlink on the same volume (zero
copy for 694 MB), fall back to copy across volumes. Rename to
`representations/<role>-<rep-id>.<ext>`, which also sidesteps the `#` in
`000109_ID#109-ocr.pdf` and any macOS NFD/NFC mismatch.

Hash each of the 1,639 files exactly once (1 MiB streaming chunks, thread pool, cache
keyed on `(path, size, mtime_ns)`) and reuse that hash for the `rep-` id, the
`representation.sha256`, and any `input_digest`. Resumable via
`<out>/.upc/convert-state.json`.

### Representation mapping

Key on `(field, detected_type/extension)`, **never on field name alone** — `raw_file`
is polymorphic: HTML for `url` sources, PDF for `uploaded_document`, and **the `.vtt`
transcript for 6 of the 7 videos**. (The `raw_file → raw_html` row in
[`crosswalks/research-assistant.md`](../crosswalks/research-assistant.md) is wrong on
this point and should be corrected.)

| RA field | Condition | UPC role | Notes |
|---|---|---|---|
| `raw_file` | `detected_type == html` | `raw_html` | |
| `raw_file` | `detected_type == pdf` | `document_pdf` | native upload, not a render |
| `raw_file` | `.vtt` | `transcript` | **not** `raw_html` |
| `rendered_file` | | `rendered_html` | skip when byte-identical to `raw_file` (28 cases) |
| `rendered_pdf_file` | | `rendered_pdf` | |
| `ocr_pdf_file` | | `ocr_pdf` | derived text per §05 |
| `markdown_file` | | `clean_markdown` | `produced_by: conversion` |
| `llm_cleanup_file` | | `clean_markdown` | parent = the `_clean.md` rep, `produced_by: model` → badges `verified-to-rewrite` |
| `metadata_file` | | `metadata` | **required** — `000182`/`000183` are failed fetches whose only bytes are this JSON, and rule 0.4 demands ≥ 1 representation |
| `audio_file` / `thumbnail_file` | | `audio` / `thumbnail` | |
| `images/<id>_images.json` | | `image` reps | carry `description` and dimensions |

Same-source dedup: group by sha256, emit one representation per distinct hash, pick
role by fixed priority, record suppressed roles in `ext.researchassistant.also[]`.
**Do not set `has_text` on images** — the index has no such field, and inferring it
from `category` would manufacture a claim §05 says must be an indication, not a guess.
No OCR representations exist, so there are no gated image quotations; say so plainly
rather than inventing them.

`catalog_file`, `summary_file`, `rating_file`, `image_descriptions_file` become
**generations**, one per source so `mintGenId` cannot collide.

### Columns → codebooks, codings, and metadata

"`allowed_values` non-empty → codebook" is right for the closed half and
over-produces junk on the rest. The real triage of RA's 15 columns:

| Class | Count | UPC target |
|---|---|---|
| Closed codebook (Org Type, Location, Sector, Source Type, Includes static visual, Includes media/video) | 6 | codebook + codings with `code` |
| Open codebook (Assoc. Orgs, VPP Definitions) | 2 | codebook `closed:false` + codings with `value` |
| Bibliographic (Citation, Year Published) | 2 | `source.bibliographic` + `field_evidence` |
| Reference (Video link, embedded-video source ID, Source PDF) | 3 | `source.relations[]` / representation refs — coding a document *with a URL* is a category error |
| RA workflow (Flag for deletion, Flag as duplicate) | 2 | `ext.researchassistant` — never a shared coding |

### Provenance and identity

`SourcePhaseMetadata` → provenance stamps and `provenance/events.jsonl` with **real
timestamps** from `started_at` / `completed_at`, so the journal is chronological
rather than a wall of "now". `model` → `produced_by.model`, `prompt_version` →
`produced_by.prompt_version`, and **`profile_name` → `ext`, not `prompt_version`**
(the crosswalk suggests overloading them; two distinct things must not share a field).
`content_digest` is `""` for almost every phase in the test corpus — **do not copy the
empty string into `input_digest`**; compute it from the actual input bytes.

Source ids: URL sources from `canonicalUrl(original_url)`, uploaded documents from
`row.sha256`, `aliases["researchassistant"] = row.id`.

### Phases and expected output

`P0 --plan` writes nothing and prints every anomaly (3 sha-less rows, 28 raw≡rendered
pairs, 145 duplicate `img-` ids, 12 unavoidable cross-source shared images, 6 URLs
whose identity depends on ad params UPC deliberately does not strip, the
53,579-codepoint single line in `000250`) — run it first, every time. Then `P1`
sources + representations, `P2` generations, `P3` codebooks + codings (~900
source-level, `coder: "ra-column-v1"`), `P4` extractions, `P5` journal, `P6` regen +
build-index + validate.

**P4 is where the honesty lives.** Of the 50 distinct evidence strings in the 15
catalogs: 10 anchor uniquely in `_clean.md`, 19 only in `_llm_clean.md`, 3 only in raw
HTML, 15 multi-match, 3 nowhere. Rules: only strings ≥ 24 codepoints are extraction
candidates (minting a `needs_review` extraction for the word `"Home"` is noise — short
values become `field_evidence` with no locator); route by origin with fallback order
`_clean.md` → raw HTML → rendered HTML, and an HTML-only hit is a metadata value
minted as `type:"entity"` with a `css_selector` secondary, **never** as a `quote`;
**`_llm_clean.md` is not an anchor target by default** (requires
`--allow-rewrite-anchors`, and anything anchored there badges `verified-to-rewrite`);
multi-match and not-found are never `active`.

Expect ~106 sources, ~380 non-image + ~716 image representations, ~75 generations,
8 codebooks, ~900 codings, and **~10 gate-passing extractions**. That number is small
on purpose, and it is exactly why the coding pass in phase 5 is a separate
deliverable: converting alone does not demonstrate the goal.

**Contractual bar: L1, status `passed`, zero errors.** Accept and document
`representation_shared` (~181) and a few `stale_input`; `output_quote_uncited`
warnings from double-quoted spans inside legacy catalog JSONs are correct warnings on
legacy artifacts, not bugs — do not chase them.

---

## Phase 3 — Read-only projection in RA

All new code under `backend/upc/`; `backend/storage/attached_repository.py` (12,694
lines) is **untouched through phase 5** and gains exactly one hook method in phase 6.

```
backend/upc/node_bridge.py   # the ONLY place that spawns node; version handshake + batch calls
backend/upc/model.py         # Pydantic mirrors of the UPC schemas (a test asserts parity)
backend/upc/reader.py        # pure Python: load_corpus, get_rep_text, verify_hop_b, locate()
backend/upc/projector.py     # pure functions, NO I/O — shared by the converter AND the projection
backend/upc/writer.py        # atomic corpus writes, batch minting, event append
backend/upc/service.py       # UpcProjectionService — owns the corpus dir; never mutates RA state
backend/upc/convert_repo.py  # the standalone converter CLI, reusing projector.py
backend/routers/upc.py       # /api/upc/*
backend/vendor/upc/          # pinned copy of the package + a VERSION file
```

**The single most important rule: the converter and the live projector share
`projector.py`.** If they don't, they drift, and you get a corpus that validates
offline and fails when refreshed in-app.

**Node/Python split.** Node owns anything where bit-identical output matters: JCS,
`canonicalUrl` + `mintSrcId`, every mint, `computeInputDigest`, `slugify`, `validate`,
`anchor`, `regen`, `build-index`. Python owns reading JSON/JSONL, `verify_hop_b`
(`text[start:end] == quote` — Python `str` *is* codepoint-indexed), `locate()` bundle
assembly, file hashing, badge classification, and serving the UI. This split is
measured, not stylistic: running the real `canonicalUrl` over the corpus's 101 URLs,
**36 change**, and RA's own `dedupe_url_key`
(`backend/pipeline/source_downloader.py:8389`) strips a much smaller set — a Python
port would mint ≥ 36 wrong `src-` ids, every one an `id_mismatch`.
`test_upc_mint_parity.py` asserts Python never mints; `test_upc_locate_parity.py`
asserts Python's `locate()` is byte-identical to `upc locate`.

**Zero edits to `attached_repository.py`**: `current_state_fingerprint()` already
exists at line 9559, so `UpcProjectionService` compares it against the one stamped in
`.upc/projection-state.json` and refreshes on difference.

---

## Phase 4 — The reader UI

Not more spreadsheet. Keep `/browser` exactly as it is; add `/read` (source list |
document | evidence rail) and `/codes` (codebooks, definitions, per-code passage
lists) to `frontend/src/appRouteConfig.ts`.

**Reuse `upc locate`'s bundle shape as the contract, but not its process.** The bundle
already carries what a reader needs — `badge`, `direct_quote`, `text`,
`primary.context.{before,exact,after}` read from bytes, `line_range`, and
`secondary[]` flagged `advisory` / `cross_representation`. Freeze it, implement it in
`reader.py`, enforce equality with the parity test. Shelling out per passage is
impossible: `locate` is O(whole corpus) per call, which is what `upc batch` exists to
fix.

**Plain English, §09 honoured.** Keep *Code* and *Codebook* — those are the
researcher's own words. Translate the rest:

| UPC | User-facing |
|---|---|
| representation | **Copy** — tabs: *Original page* / *Reading copy* / *AI-tidied copy* / *Transcript* / *PDF* / *Images* |
| extraction with `direct_quote` | **Passage** |
| extraction, `text` only | **Note** (never in quotation marks) |
| `verified` | ✓ **Checked against the original** |
| `verified-to-transcript` | ✓ **Checked against the transcript** |
| `verified-to-rewrite` | ✓ **Checked against the AI-tidied copy** — *wording may differ from the original* |
| `failed` | ⚠ **Doesn't match the original** |
| `char_range` | never shown — show the line and scroll position |
| `secondary_locators` | "Also on page 7" / "at 12:04", always styled as navigation |
| `bbox` | "Where we think this text sits (not checked)" |
| `needs_review` / `superseded` / `retracted` | Needs a look / Replaced / Withdrawn |

The clean-UI test: a researcher gets from **code chip → passage → highlighted position
in the document → the copy it was checked against** in three clicks, and never sees
*extraction*, *representation*, *locator*, or *hop*.

---

## Phase 5 — The coding pass *(the actual goal)*

`POST /api/upc/coding-runs` orchestrating: per codebook per source, the model proposes
`{quote, code, rationale}` → `upc anchor` byte-anchors each quote → `upc code` mints
codings against the resulting `ext-` ids. Prompts live beside the existing column
prompts.

Checkpoints: every minted extraction passes hop B *by construction* (assert `validate`
finds zero `quote_gate_failed`); zero codings target a missing or failed span; a second
run with the same coder is fully idempotent; a second *coder* produces visible
disagreements in the reader.

## Phase 6 — Dual-write

One `_after_state_saved_locked()` hook at the end of `_save_state_locked`
(`attached_repository.py:9098`) that *enqueues* a refresh. **Never run the projection
inside `_writer_lock`** — regenerating 1,600 files while holding RA's flock would
stall the UI. Human codings route by `codebook.origin`: `ra_column` writes
`custom_fields` and re-projects, `corpus` writes the corpus.

## Phase 7 — pi-forge

The seam is `forge/lib/run-state.mjs` / `run_state.py`, which already have
`atomicWriteJson` / `appendJsonlFsync` / `withRunLock` — the same primitives §10
requires. Add `forge/lib/upc-emit.mjs` + `upc_emit.py` mirroring RA's `projector.py`.
`evidence_items.jsonl` → one extraction per quote, byte-anchored against
`archive/extracted/*` via `upc anchor` (which by then exists, so pi-forge inherits the
whole gate for free); `claim_register.jsonl` → synthesis; `document-ingest`'s
`source_map.json` line ranges → advisory `secondary_locators`.

**pi-forge's `ITEM_TYPES` are evidence kinds, not codes** — map them to
`extraction.type`. If pi-forge later wants topical labels it declares a codebook with
`namespace: "pi-forge"`, and RA's reader displays them with no changes. That is the
whole point of putting codes in the standard rather than in one app.

---

## Verification

- **Spec:** `npm test` (selftest + conformance). Every pre-existing fixture must still
  reproduce its `expected.json`.
- **Backward compatibility:** run the *pinned* previous-minor `upc.mjs` against a
  current-minor corpus and assert the documented result. This is the promise in §00 and
  it must be tested, not asserted.
- **Converter:** `--plan`, then `find <in> -newer <stamp>` before and after; `upc
  validate --strict <out>`; run twice and diff.
- **RA backend:** `PYTHONPATH=. pytest -q` (all 54 existing files unchanged) plus
  `test_upc_locate_parity.py`, `test_upc_mint_parity.py`, `test_upc_version_handshake.py`,
  and the no-tokens-in-output test.
- **RA frontend:** `npm test` (one vitest per §09 normative rule) and `npm run build`.
- **End to end:** attach the converted corpus, open `/read`, filter by a code, click a
  passage, confirm the highlight lands on the right span in the right copy, and confirm
  the badge matches what `upc verify <ext-id>` reports from the CLI.

## Risks

| Risk | Mitigation |
|---|---|
| One bad edit to the 12,694-line `attached_repository.py` costs weeks | Zero edits through phase 5; one hook method in phase 6; all logic in `backend/upc/` |
| Two id implementations diverge (36/101 URLs already would) | Node-only minting, enforced by `test_upc_mint_parity.py` |
| Anchoring into `_llm_clean.md` would let UPC certify sentences the source never wrote | Default off; `verified-to-rewrite` badge; `000109` is a worked example in §11 |
| The converter and the live projector drift | They share `projector.py`; the phase 3 checkpoint asserts byte-identical output |
| 1.7.0 scope creep | Deferred and named: `upc agreement`, `x-` escapes for the closed enums, hierarchy queries |
