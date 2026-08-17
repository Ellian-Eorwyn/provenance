# UPC 04 — Generated & Synthesized Material

UPC distinguishes material **extracted** from a source (§03) from material
**generated** or **synthesized** from evidence. Generations are single-source;
syntheses combine multiple sources. Both retain machine-readable links to the
source material and extractions that support them, so any analysis is inspectable
backward to the original bytes — and any quotation they contain is verified
against an extraction (the hop-C gate, below).

Schemas: [`generation.schema.json`](../schemas/generation.schema.json),
[`synthesis.schema.json`](../schemas/synthesis.schema.json).

## Generation (single-source)

A generation is derived from one source (± its extractions): a summary, rating,
classification, translation, description, or note.

```json
{
  "generation_id": "gen-74f854dd9272",
  "type": "summary",
  "title": "Summary",
  "output": { "path": "sources/watchdog-2024-migrate-with-no-downtime/generated/summary.md", "media_type": "text/markdown", "sha256": "sha256:1f2e…" },
  "stale": false,
  "provenance": {
    "produced_by": { "tool": "researchassistant", "tool_version": "1.0.0", "model": "some-model", "method": "model", "prompt_version": "summarize@2" },
    "created_at": "2026-08-15T18:10:00Z",
    "derived_from": { "source_ids": ["src-a1b2c3d4e5f6"], "representation_refs": ["rep-3333bbbb4444"], "extraction_ids": ["ext-10aaf6c96053"] },
    "input_digest": "sha256:77aa…"
  }
}
```

- **Inputs live in `provenance.derived_from`** — the single source of truth for
  the graph edges. There is no duplicate top-level input list. A generation that
  quotes its source SHOULD list the supporting `extraction_ids`, so hop C has
  something to check its quotations against.
- `output.path` points at the rendered artifact (Markdown, JSON), and
  `output.sha256` pins its exact bytes (required at L2, rule
  `output_hash_mismatch`); `output.value` holds the artifact inline when it is
  small structured data (e.g. a rating object), in which case there is no file to
  hash.
- `input_digest` lives in the provenance stamp only (§07) and is the sha256 of the
  exact bytes the generation consumed; when the input's current digest no longer
  matches, the generation is **stale** (§07). Staleness is informational, not an
  error.

A rating generation stores its rubric result inline and has no prose to gate:

```json
{ "generation_id": "gen-…", "type": "rating", "output": { "value": { "overall_relevance": 4, "depth_score": 3, "rationale": "…", "confidence": 0.8 } }, "provenance": { "…": "…" } }
```

## Synthesis (multi-source)

A synthesis combines evidence across sources to answer a question: a literature
review, comparative analysis, thematic synthesis, memo, answer, or evidence
matrix. It is built from a **claim register** where each claim cites the evidence
and sources that support it.

```json
{
  "synthesis_id": "syn-c3aee52b8fa4",
  "type": "answer",
  "title": "Zero-downtime migration approaches",
  "question": "How do you migrate a WordPress site without downtime?",
  "claims": [
    {
      "claim_id": "cl-0001",
      "text": "Cutting over DNS only after validating a staging copy avoids visitor-facing downtime.",
      "evidence_ids": ["ext-10aaf6c96053"],
      "source_ids": ["src-a1b2c3d4e5f6"],
      "confidence": "high",
      "notes": null
    }
  ],
  "output": { "path": "syntheses/syn-c3aee52b8fa4/synthesis.md", "media_type": "text/markdown", "sha256": "sha256:9c1d…" },
  "stale": false,
  "provenance": {
    "produced_by": { "tool": "pi-forge", "tool_version": "0.1.0", "model": "local-llm", "method": "model", "prompt_version": "deep-research/report@1" },
    "created_at": "2026-08-15T18:15:00Z",
    "derived_from": { "source_ids": ["src-a1b2c3d4e5f6"], "extraction_ids": ["ext-10aaf6c96053"] }
  }
}
```

### Claim integrity (validator-enforced, L2)

- Every `claims[].evidence_ids` and `claims[].source_ids` MUST reference objects
  that exist (`dangling_extraction` / `dangling_source`).
- A claim MUST list the source id attached to each piece of evidence it cites: if
  a claim cites evidence from `src-X`, the claim must list `src-X`
  (`claim_missing_source`).
- The rendered `output` (e.g. `synthesis.md`) MUST cite every claim/evidence/
  source id its claims depend on (`uncited_in_output`) and MUST NOT contain
  hand-authored, unsourced findings.

## The hop-C gate (output ↔ extraction)

Generated prose is where a fabricated quotation would do its damage, so UPC gates
**every quotation in a rendered output** against the extractions the output
cites. This is the second verified hop of `output → extraction → source` (hop B,
§03, having already tied the extraction to the source). It applies to
generation/synthesis `output.path` files and, identically, to *any* text handed
to `upc verify-quotes` — a chat answer, a report, a slide outline.

A quotation is marked in output with a **citation marker** (grammar below). For
each marker `(quoted_text, ext_id)`, with no normalization:

```
1. ext = extraction(ext_id) MUST exist                    [output_cites_unknown_extraction]
2. ext MUST carry a direct_quote                          [cited_extraction_not_quotable]
3. ext.status:
     retracted  -> ERROR                                  [cites_retracted]
     superseded -> WARNING                                 [cites_superseded]
4. quoted_text MUST equal ext.direct_quote, exactly       [output_quote_mismatch]
```

Because hop B has already verified `ext.direct_quote` against the source, a
quotation that passes hop C is transitively verified to the source bytes. A
marker citing an extraction that itself fails hop B cannot be considered verified,
so a full `verify-quotes` run reports both.

**Strict mode** additionally flags any double-quoted span of ≥ 20 codepoints that
carries no adjacent marker (`output_quote_uncited`) — the safety net against
prose that looks like a quotation but cites nothing. In default mode this is a
warning; under `--strict` it is an error.

### Citation-marker grammar

Two forms, both plain Markdown-safe text, both parseable in one regex pass:

- **Inline** — a straight-double-quoted span immediately followed by an optional
  space and the extraction id in square brackets. The quoted span contains no
  `"` and no newline:

  ```
  "cut over DNS only after the staging copy is fully validated" [ext-10aaf6c96053]
  ```
  Parser: `/"([^"\n]+)"\s?\[(ext-[0-9a-f]{12})\]/g`.

- **Block** — a fenced block whose info string is `quote <ext-id>`; the body is
  the exact quote and may contain `"` and newlines. Use this for quotations that
  span lines or contain double quotes:

  ````
  ```quote ext-10aaf6c96053
  the exact multi-line
  quoted text, verbatim
  ```
  ````
  Parser: `` /^(`{3,})quote (ext-[0-9a-f]{12})\n([\s\S]*?)\n\1$/gm ``.

- **Bare citation** — an id in brackets with no preceding quoted span
  (`[ext-10aaf6c96053]`) is a **paraphrase citation**: it attributes a claim to an
  extraction without asserting verbatim text, and is not gated. Paraphrase freely,
  cite with a bare marker; quote only with a copied span and a full marker.

The soft-wrap guideline (§02) exists so the inline form works for most quotations:
a soft-wrapped clean representation keeps sentences on one line, so their quotes
contain no `\n` and need no block form.

## The derivation chain

```
SOURCE  ──▶  REPRESENTATION  ──▶  EXTRACTION  ──▶  GENERATION  ──▶  SYNTHESIS
 (bytes)      (clean.md)          (ext-… quote)    (gen-… summary)  (syn-… answer)
                                   │ hop B          │
                                   └───── gated ─────┴── hop C ──▶  OUTPUT PROSE
```

Because each arrow is recorded in `provenance.derived_from`, and each quotation is
gated at hops B and C, a reviewer can start at a synthesis claim and walk back to
the exact quote, the representation it came from, and the original source bytes —
and every quotation along the way is provably real, or flagged.
