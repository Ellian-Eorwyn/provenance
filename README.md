# Universal Provenance Corpus (UPC)

**A tool-independent standard for storing research materials with explicit,
portable provenance and byte-exact quotation gates.** Version **1.1.0**.

A UPC corpus is a folder in which both humans and software can always answer:
*What is this object? Where did it come from? What transformations produced it?
What evidence supports it? What other objects depend on it?* — and, above all,
*is this quotation real?*

It is designed to be **machine-managed, human-browsable, and LLM-renderable to
any format** at the same time — see the three co-equal audiences in
[spec/00-overview.md](spec/00-overview.md).

## The one hard promise

Every quotation attributed to a source is verified by **dumb byte-for-byte
comparison**, at each hop of a chain, or it is flagged:

```
output quote  ==exact==  extraction.direct_quote  ==exact==  representation bytes at the locator
```

No normalization softens the comparison; no heuristic "finds it anyway."
Normalization and cleanup happen when an extraction is *created* (you choose the
span); *verification* is dumb equality. A small language model can lean its whole
trustworthiness on this: if it only emits quotes that pass the gate, it cannot
fabricate one. See [spec/03](spec/03-extractions.md) (extraction ↔ source),
[spec/04](spec/04-generated-and-synthesis.md) (output ↔ extraction), and the
10-step [small-LLM protocol](skill/universal-provenance/references/small-llm-protocol.md).

## The model in one picture

```
SOURCE ──▶ REPRESENTATION ──▶ EXTRACTION ──▶ GENERATION ──▶ SYNTHESIS
```

- **Source** — the primary object (article, PDF, image, dataset), identified once.
- **Representation** — a typed rendering of a source (raw HTML, print-PDF, clean
  Markdown, an image, a transcript, metadata).
- **Extraction** — evidence pulled from a *specific representation* at an exact
  location; a quotation is anchored precisely enough to verify byte-for-byte.
- **Generation** — single-source derived material (summary, rating, translation).
- **Synthesis** — multi-source analysis (literature review, comparison, answer).

Every derived object records what it was derived from, so a synthesis is
inspectable backward to the original source bytes.

## Corpus at a glance

```text
<corpus>/
  corpus.json                 # root manifest (machine-owned, regenerable)
  sources.csv                 # spreadsheet mirror of sources (a projection)
  extractions.csv             # flattened evidence table (a projection)
  sources/
    <author-year-title>/      # human-readable slug; canonical id is inside source.json
      source.json             # representations, retrieval, bibliographic, provenance
      representations/        # raw.html, clean.md, images/, media/, transcripts/
      extractions.jsonl
      generated/              # <gen-id>.md, <gen-id>.json
  extractions/<set>/          # optional query-driven extraction sets
  syntheses/<id>/             # synthesis.json + generated synthesis.md
  provenance/events.jsonl     # activity journal (L2)
  index.html                  # generated static browser (a projection)
  .upc/                       # tool-private scratch; never a corpus member
```

Per-source is the canonical layout for writers; `corpus.json.sections` is
authoritative, so tools resolve objects by id through the manifest — never by
hard-coding paths. A per-media-type layout is a permitted readable variant
([Appendix A](spec/appendix-a-layout-decision.md)).

## Core principles

1. The unit is an identifiable research object with provenance, not a file.
2. Logical model is canonical; physical layout is manifest-declared.
3. Per-source directories with human-readable slug names.
4. Content-addressed identity + per-tool aliases, by fully specified recipes.
5. A locator is `(representation_ref, typed position)` — never a bare offset.
6. Derived objects carry an `input_digest` and backward links.
7. Structured objects are the single source of truth; every human/consumer format
   is a regenerable projection.
8. Referential **and content** integrity are enforced by a validator.
9. Storage is crash-safe and portable (atomic writes, portable filenames).
10. **Gates are dumb equality; failures are flagged, never absorbed.**

## Conformance levels

- **L0 Readable** — valid `corpus.json` + sources + ≥1 hashed representation each;
  paths contained; portable filenames.
- **L1 Provenanced** — + recomputed ids + typed locators + provenance stamps + CSL
  + **every active `direct_quote` passes the byte-exact gate**. L1 guarantees *no
  unverified quotations in the corpus*.
- **L2 Synthesized** — + generations/syntheses with backward links + `input_digest`
  + hashed outputs + the **output-quote gate** + an activity journal.

See [spec/08-conformance.md](spec/08-conformance.md) for the numbered rule
registry and error-code table; independent implementations can self-test against
`tests/conformance/`.

## Repository layout

| Path | What |
|---|---|
| `spec/` | The normative specification (`00`–`10` + Appendix A). Self-contained. |
| `vocab/vocab.json` | Single source of truth for closed enums; schemas `$ref` it. |
| `schemas/` | JSON Schema (2020-12) for every object type. |
| `examples/` | A minimal corpus and a web-research corpus, regenerated by `examples/build-examples.mjs` with true ids and byte-exact quotes. |
| `tests/` | `selftest.mjs` (library units) and `conformance/` (per-rule fixtures). |
| `crosswalks/` | Field-by-field mappings for pi-forge and ResearchAssistant. |
| `skill/universal-provenance/` | Portable zero-dep skill: `upc.mjs` CLI, common lib, references. |
| `CHANGELOG.md` | Version history. |

> **License:** [PolyForm Noncommercial 1.0.0](LICENSE.md) — free for **any
> noncommercial purpose** (personal, research, education, nonprofits, government).
> Commercial use requires a separate license from the copyright holder.

## Quickstart

Validate a corpus (schema + integrity + the quotation gates):

```bash
node skill/universal-provenance/scripts/upc.mjs validate examples/web-research-corpus
```

Verify the quotations in any output file against the corpus:

```bash
node skill/universal-provenance/scripts/upc.mjs verify-quotes examples/web-research-corpus/syntheses/*/synthesis.md --corpus examples/web-research-corpus
```

Regenerate manifests, CSV mirrors, and the browser; then open `index.html`:

```bash
node skill/universal-provenance/scripts/upc.mjs regen examples/web-research-corpus
```

Rebuild the examples and run the tests:

```bash
node examples/build-examples.mjs
node tests/selftest.mjs
node tests/conformance/build-fixtures.mjs && node tests/conformance/run-conformance.mjs
```

## Adopting UPC in a tool

Read the crosswalk for your tool ([pi-forge](crosswalks/pi-forge.md),
[ResearchAssistant](crosswalks/research-assistant.md)); it maps your existing
schema field-by-field to UPC and lists the 1.1.0 changes to apply. Drop the
`skill/universal-provenance/` directory into your skills folder to get the CLI;
emit objects per the schemas; run `upc validate`.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE.md) — free for **any noncommercial
purpose** (personal use, research, education, nonprofits, public institutions).
Adopt the standard, implement it, fork it, extend it, share it, all at no cost.
**Commercial use requires a separate license** from the copyright holder;
`SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0`.
