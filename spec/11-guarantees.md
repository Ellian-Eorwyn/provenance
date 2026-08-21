# UPC 11 — Guarantees & Non-Guarantees

UPC is credible because it makes **narrow** guarantees precisely, not broad ones
loosely. A validator that reports `passed` has established a specific, closed set
of mechanical facts about a corpus — and, just as importantly, has established
*none of the epistemic claims those facts are often mistaken for*. This section
states both halves normatively, so that a consumer, a UI, or another tool never
reads more into a UPC "verified" than the gate actually proves.

The keywords MUST, MUST NOT, SHOULD, and MAY are used as in RFC 2119.

## What UPC proves, records, and does not prove

- **Proves (mechanically).** For a corpus that passes at a given level, the
  properties in the *Guarantee* column below hold by exact computation over the
  stored bytes and objects — file fixity, codepoint-exact quotation at each hop,
  content-addressed identity, and referential integrity. These are the "yes"
  rows of §08's rule registry, classed **mechanical invariant** there.
- **Records (without proving).** UPC captures a great deal it does not *verify*:
  who produced an object and how (`provenance.produced_by`), what an extraction's
  `text` paraphrase says, what a source's bibliographic metadata claims, how a
  representation was transformed from its parent, and what a synthesis concludes.
  These are producer assertions. The validator checks that they are *present and
  well-formed* (the **producer-obligation** rows of §08), never that they are
  *true*.
- **Does not prove (ever, by design).** No UPC gate establishes that a source's
  claim is true, that a source is authoritative, that a quotation is fair in
  context, that an OCR/transcript faithfully represents its image/audio, that a
  paraphrase faithfully represents the evidence, that a model selected the
  relevant evidence, or that a synthesis's reasoning is sound. These are outside
  the equality gate and are **not** made truer by a passing corpus.

This boundary is the point: *UPC guarantees exactly what it can compute, and marks
the rest as the inference or assertion it is.*

## The guarantee matrix

Each row names a property, whether a passing corpus **mechanically guarantees**
it, and — where applicable — the §08 rule code and gate hop that enforce it.

| Property | Mechanically guaranteed? | Enforced by |
|---|---|---|
| A stored file's bytes hash to its recorded `sha256` | **Yes** (L0) | `rep_hash_mismatch` (hop A), `output_hash_mismatch` |
| An active `direct_quote` is codepoint-identical to its representation at the locator | **Yes** (L1) | `quote_gate_failed` (hop B) |
| A quotation in a generated/synthesis output matches its cited extraction | **Yes** (L2) | `output_quote_mismatch` (hop C) |
| Every content-addressed id equals its recomputed value | **Yes** (L1) | `id_mismatch` |
| Every reference (`source_id`, `representation_ref`, …) resolves to an object that exists | **Yes** (L1) | `dangling_*` |
| Every derived object carries a provenance stamp and (at L2) an `input_digest` | **Yes** (presence only) | `missing_provenance`, `missing_input_digest` |
| An `input_digest` still matches its input's current bytes (staleness) | **Detected, not required** | `stale_input` (advisory) |
| Short (48-bit) ids do not collide | **Detected, not prevented** | `id_duplicate` |
| The `text` paraphrase faithfully represents the evidence | No — not an equality claim | — |
| The source's claim is true | No | — |
| The source is authoritative or relevant | No | — |
| A quotation is fair in its original context | No | — |
| OCR text correctly represents the scanned image | No — inference (§05) | recorded via `produced_by.method` |
| A presentation locator (`line_range`, `page`, `bbox`, `timestamp_range`) points where it claims | No — advisory, never verified (§03) | shape only: `bbox_out_of_bounds`, `line_range_out_of_bounds` (advisory) |
| A highlighted image region corresponds to the quoted OCR text | No — inference (§05); recorded, not gated | labelling required by §09 |
| An exported Web Annotation selector resolves identically in another tool | No — interop projection only | flagged `upc:interopOnly`, `upc:unit` |
| A transcript correctly represents the speech/audio | No — inference (§05) | recorded via `produced_by.method` |
| An extracted PDF text layer correctly represents the PDF's own rendering | No — inference (§05); badged `verified-to-transcript`, not `verified` | derivation recorded via `parent_representation_ref` |
| A model-rewritten text preserves its parent's wording | **No — inference**; badged `verified-to-rewrite`, not `verified` (§09) | derivation recorded via `produced_by` + `parent_representation_ref` |
| A code applied to a passage is the *right* code | No — a coding is a recorded judgement, never a gate result (§12) | coder, codebook revision and provenance recorded; disagreement surfaced as `coding_disagreement` |
| Two coders who agree are therefore correct | No — agreement is a statistic, not a proof (§12) | both judgements retained; κ is a projection, never stored |
| A model selected the right evidence for a query | No | — |
| A coded passage is real text from its source | **Yes** — a span-level coding must target an extraction, which has already passed hop B (§12) | `dangling_coding_target` (error); a later break is surfaced as `coding_targets_failed_gate` |
| A synthesis's inference is logically sound | No | — |
| The web server actually authored the captured bytes | No — fixity ≠ authenticity | — |

### Why a model rewrite needed its own badge

Through 1.5.0 the badge was decided from the derivation's *media types* alone, so a
text-to-text step counted as fidelity-preserving and a model-rewritten Markdown
badged plain **verified**. Measured against a real 106-source corpus, that was not
safe: 68% of substantive lines in the model-"cleaned" copies were not verbatim in
the deterministic extraction they came from. One source read

> Virtual Power Plants are cloud-based system that integrates multiple power sources

in the extracted text, and

> Virtual Power Plants are cloud-based systems that integrate multiple power sources

in the model's copy — the grammar silently corrected. A quotation anchored in the
rewrite passes hop B honestly (the bytes are exactly what the rewrite says) and yet
attributes to the source a sentence the source never wrote. The gate was doing its
job; the *badge* was overclaiming. `verified-to-rewrite` restores the distinction
between "these are the bytes we checked" and "this is what the source said."

## Verification scope: not every "verified" is the same claim

A quotation that passes the gate is verified **to a specific representation**, and
the strength of that claim depends on what the representation *is*. §05 draws the
trust boundary for non-text media; §09 requires the browser to surface it rather
than collapse everything into one green badge. The distinct scopes:

- **Exact in captured source text** — hop B passed against a representation that
  is (or is a faithful textual copy of) the retrieved bytes.
- **Exact in cleaned representation** — hop B passed against a *derived* textual
  representation (e.g. `clean_markdown`) produced by a transformation from the
  raw capture. The quote is exactly what the cleaned text says; the cleaning step
  is provenance, not a gate, and §09 exposes the derivation chain rather than one
  undifferentiated badge.
- **Exact in OCR / transcript text** — hop B passed against `ocr_text` or a
  `transcript`. The `transcript == audio` / `ocr == image` step is **inference**,
  recorded via `parent_representation_ref` + `produced_by.method`, never gated.
  §09 requires a distinct *verified-to-transcript* badge.
- **Unverifiable** — a `text`-only extraction (a paraphrase) or a coarse locator.
  Never styled as a quotation.

The guarantee is the *narrowest* true statement, not the most reassuring one: a
quote verified against a transcript is "verified to the transcript," which is not
the claim "verified to the recording."

## Fixity, provenance, and authority are three different things

Three confusions this section forecloses:

- **Fixity ≠ authenticity.** A matching `sha256` proves the bytes have not
  changed relative to a recorded digest. It does not prove who authored them or
  that a server really served them. UPC records retrieval provenance
  (`source.retrieval`), which is an assertion about acquisition, not a signature.
- **Provenance ≠ truth.** Knowing where a statement came from, and by what tool
  or model, does not make the statement true. The provenance graph is for
  traceability and staleness, not for adjudicating claims.
- **Source authority is out of scope.** Whether a source *should* be trusted is a
  judgment UPC does not make; it belongs to whatever retrieval/authority layer
  produced the fetch. A UPC quote-gate pass never confers authority on a source,
  and a source's authority never substitutes for a gate pass.

## Relation to the rule registry and conformance

Every "Yes" in the matrix corresponds to an error-severity rule in §08, classed
there as a **mechanical invariant** or a **producer obligation** (presence/shape,
not truth). Every "No" corresponds to a property the registry deliberately does
**not** contain. If a future model-assisted checker assesses a semantic property
(paraphrase fidelity, evidence relevance), its result MUST be recorded as a
distinct, advisory `model_assessed` observation — never as the same kind of
verification as the quotation gate. See §00 (the one hard promise), §05 (the
multimodal trust boundary), §08 (the rule registry), and §09 (how the browser
must display each scope).
