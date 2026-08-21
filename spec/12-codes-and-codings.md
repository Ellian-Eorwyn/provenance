# UPC 12 — Codes & Codings

A research corpus is not only a pile of evidence; it is evidence that someone has
**judged**. A qualitative researcher labels passages against a coding scheme; a
classifier assigns a category to a document; two raters disagree and the
disagreement is itself a finding. UPC 1.6.0 adds the two objects that make those
judgements first-class, portable, and — crucially — **anchored to text that has
already been proved real**.

Schemas: [`codebook.schema.json`](../schemas/codebook.schema.json),
[`coding.schema.json`](../schemas/coding.schema.json),
[`coding-set.schema.json`](../schemas/coding-set.schema.json).

## The span is not the judgement

This is the whole design, and everything else follows from it.

An **extraction** is a *span*: a located piece of a representation. Its id is
content-addressed over `(source, representation, locator, quoted text)` (§06), so
two coders who select the same sentence deterministically produce **the same
`ext-` id**. That convergence is a feature — one sentence, one object — but it
means an extraction cannot also carry the verdict about itself, because two
raters must be able to say different things about one span.

A **coding** is that *judgement*: one coder, one code, one target. Its id includes
the coder and the code, so agreement, disagreement, and multi-labelling are all
representable without collision.

```
CODEBOOK ──defines──▶ code
                        │
EXTRACTION ◀──targets── CODING ──by──▶ coder
 (the span,              (the judgement,
  gate-verified)          never gated)
```

The separation also closes a hole. **A coding MUST NOT carry a locator.** If it
could, a code would be a second way to point at text — one that never passed the
hop-B gate. By forcing a span-level coding to target an `ext-` id, UPC guarantees
that **every coded passage was proved real before it could be labelled**. The gate
is upstream of the judgement, always.

A coding is never verified in the sense §03 means. A code is an opinion; the
corpus records *whose* opinion, *under which scheme*, and *about which verified
span*. That is the honest claim, and §09 requires a surface to present it as such.

## Codebook — the scheme

A codebook is a named controlled vocabulary. It lives at
`codebooks/<codebook-id>.json`, declared by `sections.codebooks`.

```json
{
  "codebook_id": "cbk-4f2a8c1d9e07",
  "namespace": "researchassistant",
  "slug": "org-type",
  "title": "Org Type",
  "question": "What kind of organization published this source?",
  "closed": true,
  "multi_label": false,
  "unit": "source",
  "revision": 3,
  "revision_digest": "sha256:…",
  "codes": [
    { "code": "utility", "label": "Utility",
      "definition": "An investor-owned, municipal or cooperative electric utility.",
      "parent": "operator", "examples": ["…"] }
  ],
  "aliases": { "researchassistant": "custom_92142bf5" },
  "provenance": { "produced_by": { "tool": "researchassistant", "method": "manual" }, "created_at": "…" }
}
```

**Identity is over `(namespace, slug)` and nothing else** (§06). A controlled
vocabulary's entire job is to keep a stable identity while its contents evolve;
hashing `codes[]` into the id would dangle every `codebook_ref` on every edit. The
same reasoning governs `src-`, which is addressed over the canonical URL rather
than the page bytes. `namespace` is what lets ResearchAssistant and pi-forge each
own an `org-type` codebook without collision.

Evolution is carried instead by two **advisory** members: `revision` (a monotonic
integer) and `revision_digest` (`"sha256:" + sha256(JCS(codes))`). A coding records
the pair it was made under; a later mismatch raises `coding_codebook_drift` (§08),
exactly as `input_digest` raises `stale_input`. Neither member enters any identity
recipe, so **editing a codebook never re-mints a coding**.

- `closed: true` (the default) means a coding MUST carry a `code` drawn from
  `codes[]`. `closed: false` is an open or emergent scheme: a coding carries a
  free-text `value` instead, and `codes[]` may be a seed list.
- `multi_label` says whether one coder may apply more than one code from this
  codebook to one target. It is advisory; it informs a surface and the
  `coding_disagreement` advisory, and is never a hard error.
- `unit` (`passage` / `source` / `either`) hints at what the scheme is normally
  applied to. Advisory: it never constrains `target.kind`.
- `codes[].parent` names another `code` in the same codebook, forming a hierarchy.
  **Rollups are computed by the reader and MUST NOT be stored** — the projection
  rule of §09 applies to derived counts exactly as it applies to CSVs.
- `codes[].definition` is what makes a code interpretable. §09 requires a browsing
  surface to put it one interaction away; an undefined code is uninterpretable
  jargon.
- Retiring a code sets `deprecated: true` rather than deleting it, so existing
  codings stay resolvable.

## Coding — the judgement

Codings live in sets: `codings/<set-id>/{manifest.json, items.jsonl}`, declared by
`sections.codings`, one JSON object per line under the §10 JSONL rules.

```json
{
  "coding_id": "cod-a7b3c9d1e2f4",
  "codebook_ref": "cbk-4f2a8c1d9e07",
  "code": "utility",
  "target": { "kind": "extraction", "id": "ext-10aaf6c96053" },
  "coder": "ra-column-v1",
  "status": "active",
  "codebook_revision": 3,
  "codebook_revision_digest": "sha256:…",
  "confidence": "high",
  "confidence_score": 0.82,
  "rationale": "The publisher is a municipal utility identified in the byline.",
  "query": "What kind of organization published this source?",
  "provenance": {
    "produced_by": { "tool": "researchassistant", "model": "chat2", "method": "model", "prompt_version": "source_column.v1" },
    "created_at": "2026-08-20T09:54:00Z",
    "derived_from": { "extraction_ids": ["ext-10aaf6c96053"] }
  }
}
```

`target.kind` is `extraction` (span-level), `source` (document-level), or
`representation`. Exactly one of `code` and `value` is present, matching the
codebook's `closed` flag.

### What the identity recipe includes, and why

`cod-` hashes `(codebook_ref, target.kind, target.id, coder, {code}|{value})`
(§06). Every property below is a direct consequence of that choice:

| Situation | Result | Because |
|---|---|---|
| Two coders disagree | two codings, both retained | `coder` and the label are both in the key |
| Two coders agree | two codings | `coder` is in the key, so agreement stays *countable* |
| One coder, two codes on one span | two codings | the label is in the key |
| The same pass re-runs unchanged | the same `cod-` id; the record is refreshed | `created_at`, `confidence`, `rationale`, `query` and `status` are **out** of the key |
| A coder changes their answer | a new coding; the old one goes `superseded` | reuses §03's lifecycle rather than mutating a content id |
| The codebook is edited | ids unchanged; advisory `coding_codebook_drift` | the revision members are out of the key |
| A code's `label` is renamed | ids unchanged | the machine `code` token is in the key, not the display label |
| Codings are added or removed | the extraction's `ext-` id never moves | codings live in their own files; `mintExtId` never sees them |

Idempotence is the practical payoff: an LLM coding pass can be re-run over a whole
corpus and, where the answers have not changed, **write nothing**.

### `coder` is a stable handle, not a model string

`coder` identifies *the rater*, e.g. `ra-column-v1`, `ellie`, `adjudicator`. It
MUST be declared in the set manifest's `coders[]`, which is where the volatile
detail lives:

```json
{
  "set_id": "cds-91b2f4e7a0c3",
  "items_path": "codings/cds-91b2f4e7a0c3/items.jsonl",
  "codebook_refs": ["cbk-4f2a8c1d9e07"],
  "coders": [
    { "coder": "ra-column-v1", "kind": "model", "model": "chat2", "prompt_version": "source_column.v1" },
    { "coder": "ellie", "kind": "human", "person": "ellie" }
  ]
}
```

If the model version were embedded in `coder`, every model upgrade would re-mint
every coding id and destroy the agreement history. Keeping identity stable and
detail in the manifest means a rater's record survives its implementation. To
compare two models *as two raters*, declare two handles — a deliberate act, not an
accident of an upgrade.

### Disagreement is data, not damage

Two active codings from different coders that assign different labels to the same
target under the same single-label codebook raise the **advisory**
`coding_disagreement`. It is informational: inter-rater disagreement is a normal,
often desirable state of a coded corpus, and it is exactly the signal a reliability
statistic is computed from.

There is deliberately **no `resolved`, `gold`, or `final_code` member**. An
adjudication is simply another coding, by a coder whose handle says so. That keeps
resolution visible and attributable instead of collapsing two judgements into one
unattributed verdict. §09 forbids a browsing surface from silently picking a
winner.

Agreement statistics (percent agreement, Cohen's or Fleiss' κ) are **projections**
computed from the codings and MUST NOT be stored (§09).

### A code on a span that later breaks

If a coding's target extraction fails hop B — the representation was re-rendered,
the offsets drifted — the coding is **not** invalidated. It remains a faithful
record of a judgement that was made; the *span* is what broke. The validator raises
the advisory `coding_targets_failed_gate`, never an error, and §09 requires a
surface to show the break and to stop presenting the code as attached to verified
text. Repair belongs to the extraction (`upc reanchor`, §09), not to the judgement.

## Producing codings safely

The intended pipeline for a model-driven coding pass reuses the re-extraction
protocol of §03 and §09, in two stages:

1. **Anchor.** The model proposes candidate quotations as data; `upc anchor`
   byte-exact-searches the chosen representation. A unique hit mints an `active`
   `char_range` extraction that passes hop B *by construction*; zero or several
   hits are returned as `not_found` / `ambiguous` and never written as verified.
2. **Code.** `upc code` applies codes to the resulting `ext-` ids, checking each
   against its codebook and superseding any prior judgement by the same coder.

The division of labour is the same one that makes the whole standard work: **the
model chooses what to select and what to call it; the tool guarantees that the
text is real.** A model cannot code a sentence that does not exist, because it
cannot anchor one.

Exhaustive per-sentence classification is possible but rarely what is wanted: it
produces mostly negative judgements. The targeted form — *find and quote the
passages that instantiate each code* — yields a smaller, denser, byte-anchored
corpus, and makes the model commit to a span rather than to a label on a span it
was handed.

## Conformance

Every rule in §08's coding block is vacuous on a corpus with no codings, so **L1 is
unchanged for every corpus written before 1.6.0**, and the presence of codings
never changes a corpus's conformance level. A bad coding pass must not make a
corpus report `failed`: the level describes provenance integrity, not whether a
rater was any good. What *is* an error is a coding that is structurally
incoherent — one that names a codebook or target that does not exist, uses a code
its codebook does not define, or mixes up the open and closed forms.

## Physical layout

```text
<corpus>/
  codebooks/
    cbk-4f2a8c1d9e07.json
    cbk-665765ce72cd.json
  codings/
    cds-91b2f4e7a0c3/
      manifest.json
      items.jsonl
```

Both directories are declared in `corpus.json.sections` (§01) and are absent from a
corpus that has no coding scheme. There is deliberately only **one** physical
arrangement for codings.
