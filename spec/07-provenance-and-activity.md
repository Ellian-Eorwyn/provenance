# UPC 07 — Provenance, Stamps & Activity

Provenance is not a sidecar in UPC; it is carried on every derived object and,
optionally, in an append-only activity journal. The model is **inspired by W3C
PROV** (entities, activities, derivation) but stays plain JSON/JSONL — no RDF,
PROV-N, or WARC required.

Schema: [`provenance-stamp.schema.json`](../schemas/provenance-stamp.schema.json).

## The provenance stamp

Every **derived** object (representation, extraction, generation, synthesis)
embeds a `provenance` stamp:

```json
"provenance": {
  "produced_by": {
    "tool": "pi-forge",
    "tool_version": "0.1.0",
    "model": "local-llm-name",
    "method": "model",
    "prompt_version": "web-research/evidence@3",
    "person": null
  },
  "created_at": "2026-08-15T18:00:00Z",
  "modified_at": null,
  "derived_from": {
    "source_ids": ["src-a1b2c3d4e5f6"],
    "representation_refs": ["rep-9f8e7d6c5b4a"],
    "extraction_ids": [],
    "generation_ids": [],
    "synthesis_ids": []
  },
  "input_digest": "sha256:…",
  "activity_ref": "evt-000042"
}
```

Field notes:

- `produced_by.tool` / `tool_version` — the software that created the object.
  `model` / `prompt_version` are present when a model produced it (absent for
  purely deterministic steps like an HTTP fetch or a Readability extraction).
  `method` is from the `produced_by_method` vocabulary (`http`, `readability`,
  `ocr`, `conversion`, `vision`, `model`, `manual`, `import`, …) and states *how*
  the object was produced — this is what §05's trust boundary and the browser's
  badges read.
- `person` — set when a human produced or edited the object (see human edits
  below); otherwise absent/`null`.
- `created_at` — RFC 3339 / ISO-8601 UTC. `modified_at` — set when the object is
  later corrected in place by an allowed edit (below); absent until then.
- `derived_from` — the inputs this object depends on: `source_ids`,
  `representation_refs`, `extraction_ids`, `generation_ids`, `synthesis_ids`.
  A representation derives from its source; an extraction from a source +
  representation; a generation from sources (± representations, extractions); a
  synthesis from sources + extractions (± generations, and other syntheses for a
  synthesis-of-syntheses). These are the **backward links** that make the graph
  traversable.
- `input_digest` — the **single home** for the consumed-input digest (there is no
  duplicate top-level copy on generations/syntheses). See staleness below.
- `activity_ref` — optional link into the activity journal.

Sources themselves carry a lighter `retrieval` provenance (URLs, fetch method,
timestamp, hash) rather than a `derived_from`, since a source is a root.

## Human edits and attribution

Corpora are worked in by people, not only tools. When a human corrects a derived
object — fixing a mis-anchored locator, editing bibliographic metadata, retracting
a bad extraction — the edit is stamped like any other production:

- `produced_by` records `{ "tool": "manual", "method": "manual", "person":
  "<name or handle>" }` (a tool acting on a human's behalf MAY instead keep its
  own `tool` and set `person`).
- `modified_at` is set to the edit time; the original `created_at` is preserved.
- The change is logged as a `modify` (or `retract` / `reanchor`) event in the
  journal.

This gives every correction the same traceability as every automated step, and is
what makes the human-facing modify workflow (§09) first-class rather than an
out-of-band hack.

## Field-level provenance

Bibliographic metadata (and any other field a tool wants to justify) may carry
per-field evidence in a source-level `field_evidence` object — a **sibling of
`bibliographic`**, not nested inside it, so a CSL export is the `bibliographic`
object verbatim:

```json
"field_evidence": {
  "title": {
    "value": "The Grasshopper: Games, Life and Utopia",
    "origin": "embedded_metadata",
    "evidence": "<title> and og:title agreed",
    "confidence": 0.98,
    "locator": { "type": "css_selector", "representation_ref": "rep-…", "value": "meta[property='og:title']" },
    "manual_override": false
  }
}
```

`origin` is from the `field_origin` vocabulary. `manual_override: true` records a
human correction and MUST be preserved across regeneration.

## Staleness

A derived object records `input_digest` = `sha256` of the **exact bytes it
consumed** (e.g. the cleaned Markdown a summary was written from). For a
single-input object this is the sha256 of that one representation's stored bytes.
For a **multi-input** object it is computed deterministically so any tool agrees:

```
input_digest = "sha256:" + sha256(JCS({
  "inputs": [ {"id": "<ref>", "sha256": "<hex of that input's bytes>"}, … ]
}))
```

with the `inputs` array **sorted by `id`** and JCS the canonical serialization of
§06.

- An object is **stale** when the current digest of its input(s) no longer
  matches its stored `input_digest`.
- Producers SHOULD set a boolean `stale` on generations/syntheses when detected;
  the validator also computes it. Staleness is *informational*, not an error — it
  is the normal state of a corpus being actively worked in (`stale_input`, a
  warning).
- Changing a *derived* object never rewrites its source. Sources are immutable
  once captured (re-capturing produces a new representation, not a mutation).

## Relating objects across time

Beyond `derived_from`, objects MAY carry weak relations:

- `supersedes` / `superseded_by` — a newer capture, edition, or re-anchored
  extraction replaces an older one. Both ids remain in the corpus.
- `duplicate_of` — a representation determined to be a byte-or-content duplicate
  of another.

These are advisory links, not part of the core derivation graph, and are never
required by conformance.

## Activity journal (optional, required at L2)

`provenance/events.jsonl` is an **append-only** journal of the activities that
produced the corpus. One JSON object per line (§10 JSONL rules), and — uniquely —
append-only rather than rewritten:

```json
{"event_id":"evt-000042","activity_type":"generate","tool":"pi-forge","model":"local-llm","prompt_version":"summary@2","started_at":"…","ended_at":"…","inputs":{"source_ids":["src-…"],"representation_refs":["rep-…"]},"outputs":{"generation_ids":["gen-…"]},"status":"success","notes":null}
```

Schema: [`event.schema.json`](../schemas/event.schema.json).

- `activity_type` is from the `activity_type` vocabulary, which includes the
  production steps (`search`, `fetch`, `render`, `extract`, `embed`, `generate`,
  `synthesize`, `validate`, `import`, `export`) and the correction/removal steps
  (`modify`, `reanchor`, `retract`, `remove`, `redact`).
- `status` is from the `status` vocabulary.
- `event_id` is sequential per journal (`evt-` + a zero-padded counter);
  monotonic within one corpus.
- Records are never rewritten or deleted; a correction or removal is a **new
  event** (this is what lets the journal double as an audit and removal log,
  §10).
- An object's `provenance.activity_ref` MAY point at the event that produced it.

The journal is what lets a reviewer replay *how* a corpus came to be, and lets a
tool resume an interrupted run. At L0/L1 it is optional; at L2 a corpus MUST
carry a journal covering its generations and syntheses.

## What UPC deliberately excludes (v1)

No RDF, PROV-N, or WARC export; no cryptographic signing; no external provenance
registry; no Merkle/fixity rollup beyond per-file sha256. The JSON/JSONL
manifests and the sha256 hashes are the source of truth. These may be added in a
later minor version as optional projections without changing the core.
