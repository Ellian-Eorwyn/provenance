# UPC 01 — Corpus & Manifests

A corpus is a directory whose root holds `corpus.json`, the machine-owned,
regenerable manifest that describes the whole collection. Manifests are the
**indexing and interoperability layer**: software reads the manifest and
immediately understands the corpus, instead of scanning folders and guessing what
files mean.

Schema: [`schemas/corpus.schema.json`](../schemas/corpus.schema.json).

## Logical vs physical

The **logical model** (the objects and their ids) is canonical. The **physical
layout** (which file sits where) is declared by the manifest and MAY vary.

- Tools MUST resolve an object by its id through a manifest, and MUST NOT assume
  a file type lives at a fixed path.
- `corpus.json.sections` maps each object class to its location, so a tool that
  chooses a different layout stays conformant as long as its manifest is honest.

This is the property that lets a per-source layout and a per-media-type layout
both be valid UPC corpora (Appendix A). **Writers SHOULD emit the canonical
per-source layout; readers MUST honor whatever `sections` declares.**

## Root manifest (`corpus.json`)

Minimum: `upc_spec_version`, `corpus_id`, and `sections`. A fuller manifest is
self-describing so an agent that has never heard of UPC can orient from the
folder alone:

```json
{
  "upc_spec_version": "1.1.0",
  "corpus_id": "cor-3f9a1c2e7b40",
  "title": "Migration downtime research",
  "readme": "Universal Provenance Corpus. Work ONLY from ids resolved through the manifests; do not infer meaning from paths. Sources are immutable; derived objects link back via provenance.derived_from. Quotations are verified byte-for-byte — see spec/03.",
  "rules_note": "spec/00-overview.md",
  "created": "2026-08-15T18:00:00Z",
  "modified": "2026-08-15T18:20:00Z",
  "generated_by": { "tool": "pi-forge", "tool_version": "0.1.0" },
  "sections": {
    "sources": "sources/",
    "extractions": "extractions/",
    "generations": "generations/",
    "syntheses": "syntheses/",
    "provenance": "provenance/events.jsonl",
    "sources_csv": "sources.csv",
    "extractions_csv": "extractions.csv",
    "index_html": "index.html"
  },
  "counts": { "sources": 2, "representations": 5, "extractions": 4, "generations": 2, "syntheses": 1 },
  "sources": [
    { "source_id": "src-a1b2c3d4e5f6", "path": "sources/watchdog-2024-migrate-with-no-downtime/", "title": "How to migrate a WordPress site with no downtime", "primary_url": "https://watchdogstudio.com/blog/...", "sha256": "sha256:bce3e6..." }
  ],
  "syntheses": [
    { "synthesis_id": "syn-77aa22bb44cd", "path": "syntheses/syn-77aa22bb44cd/", "title": "Zero-downtime migration approaches" }
  ],
  "integrity": { "schema_hash": "sha256:2b7c..." }
}
```

### `sections`

`sections` is the resolution table. Recognized keys: `sources`, `extractions`,
`generations`, `syntheses`, `provenance`, `sources_csv`, `extractions_csv`,
`index_html`. A value ending in `/` is a directory; otherwise a file. In the
canonical per-source layout, `generations` may be omitted because generations
live inside each source folder (`<source>/generated/`); a per-media-type layout
that groups generations centrally MUST declare `generations`. Any key absent
falls back to the canonical default path for that class.

### `counts`, `sources`, `syntheses` indexes

These are **denormalized convenience indexes** derived from the objects. They are
advisory: a validator that finds `counts` or an index entry disagreeing with the
objects reports `counts_mismatch` as a warning and treats the objects as truth
(the index is stale, not the corpus wrong). `sources[].path` MAY point at either
a source *directory* (canonical) or a `source.json` *file* (alternate layouts);
either resolves to the same source.

### `integrity.schema_hash`

`schema_hash` pins the UPC schema set the corpus was written against, so a reader
can detect a version skew even within a minor version. It is computed
deterministically (so any implementation agrees):

1. For each file in `schemas/*.json` and `vocab/vocab.json`, compute
   `sha256(exact bytes)` as lowercase hex.
2. Build the object `{ "<basename>": "<hex>", ... }` keyed by filename.
3. `schema_hash = "sha256:" + sha256(JCS(object))`, where JCS is the canonical
   JSON serialization of §06.

A reader whose local schema set hashes differently MAY still read the corpus
(minor versions are compatible) but SHOULD note the skew.

## Per-section manifests

Any subtree MAY carry its own manifest so it is understandable independently:

- **Per-source** — `sources/<slug>/source.json` is the manifest for one source
  (§02). A source folder is self-contained: its `source.json` fully describes its
  representations, extractions pointer, and generations.
- **Extraction sets** — `extractions/<set-id>/manifest.json` describes a
  query-driven set and points at its `items.jsonl` (§03,
  [`extraction-set.schema.json`](../schemas/extraction-set.schema.json)).
- **Syntheses** — `syntheses/<id>/synthesis.json` is itself the manifest for one
  synthesis (§04).

A tool reading only a subtree (say, one source folder copied out of the corpus)
still has everything it needs to interpret that subtree.

## CSV mirrors (projections)

Two CSV files at the root are **projections** of the structured objects, for
humans and spreadsheets — never a second source of truth, and **regenerated by
tooling, never hand-edited** (`upc regen`). Dialect is pinned so every
implementation produces byte-identical mirrors:

- **Encoding** UTF-8, no BOM. **Line terminator** `\n` (LF) on write; a reader
  MUST also accept `\r\n`. **Quoting** RFC 4180: a field is wrapped in double
  quotes iff it contains a comma, a double quote, `\r`, or `\n`; an embedded
  double quote is doubled (`""`). A header row is required. Column order is
  fixed (below). Empty/absent values are the empty string.

`sources.csv` — one row per source, columns in this exact order:

```
source_id, title, source_kind, item_type, authors, issued, primary_url,
final_url, fetch_status, sha256, path, tags, n_representations,
n_extractions, n_generations
```

`extractions.csv` — one row per extraction, columns in this exact order:

```
extraction_id, source_id, representation_ref, type, status, direct_quote,
text, locator, query, interpretation, confidence, confidence_score, created_at
```

`authors` is rendered `Family, Given; Family, Given` (or the `literal` form).
`locator` is the extraction's locator serialized as compact JCS in a single
field (e.g. `{"type":"char_range","representation_ref":"rep-…","value":{"start":247,"end":306}}`).
Because they are regenerable, a validator treats a CSV/JSON mismatch as the CSV
being stale (`csv_stale`, a warning), not the objects being wrong.

## Regeneration

`corpus.json` (its `counts`, indexes, and `schema_hash`), the CSV mirrors, and
`index.html` are all **derived**. A tool MUST be able to regenerate them from the
source/extraction/generation/synthesis objects; the reference `upc regen` does
so. A human never hand-edits a manifest or a mirror; a tool rewrites it in place,
atomically (§10). Regeneration is also the crash-recovery story: if a run is
interrupted after the objects are written but before the projections are, a
`regen` restores consistency.
