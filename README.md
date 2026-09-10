# Universal Provenance Corpus (UPC)

**A tool-independent standard for storing research materials with explicit,
portable provenance and byte-exact quotation gates.** Version **1.13.1**.

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

Two further objects record *judgements about* that graph rather than material
derived from it ([§12](spec/12-codes-and-codings.md)):

```
CODEBOOK ──defines──▶ code          EXTRACTION ◀──targets── CODING ──by──▶ coder
```

- **Codebook** — a named coding scheme: the vocabulary a coder may apply.
- **Coding** — one coder's judgement that one code applies to one target.

The span and the judgement are deliberately separate objects. An extraction is
content-addressed over its location and text, so two coders who select the same
sentence converge on **one** span — which is exactly why the verdict cannot live
on it. And because a span-level coding must target an `ext-` id, **every coded
passage has already passed the quotation gate before it can be labelled**: a code
can never become a second, ungated way to point at text.

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
| `spec/` | The normative specification (`00`–`12` + Appendix A). Self-contained. |
| `vocab/vocab.json` | Single source of truth for closed enums; schemas `$ref` it. |
| `schemas/` | JSON Schema (2020-12) for every object type. |
| `examples/` | A minimal corpus and a web-research corpus, regenerated by `examples/build-examples.mjs` with true ids and byte-exact quotes. |
| `tests/` | `selftest.mjs` (library units) and `conformance/` (per-rule fixtures). |
| `crosswalks/` | Field-by-field mappings: pi-forge and ResearchAssistant (adoption); RO-Crate, Web Annotation, PROV, Obsidian (interoperability); BagIt/WARC/Memento/nanopublication (deferral notes). |
| `profiles/` | The UPC RO-Crate profile (`profiles/ro-crate/`) that RO-Crate exports declare via `conformsTo`, and the Obsidian vault profile (`profiles/obsidian/`) that describes the vault an Obsidian export writes. |
| `docs/` | [`adoption-plan.md`](docs/adoption-plan.md) — the living program for putting UPC underneath ResearchAssistant and pi-forge, with the measurements that shaped it. |
| `skill/universal-provenance/` | Portable zero-dep skill: `upc.mjs` CLI, common lib, references. |
| `package.json` | Installable, zero-dependency package (`@ellian-eorwyn/upc`, `bin: upc`). |
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

Bring a quotation's source up in place — the verified span with its context and
line number, plus any advisory page / image-region / timestamp anchor it carries
(add `--format web-annotation` for the W3C Web Annotation form):

```bash
node skill/universal-provenance/scripts/upc.mjs locate <ext-id> --corpus examples/web-research-corpus
```

Export an RO-Crate 1.3 metadata graph, or a W3C PROV-O derivation graph
(deterministic, read-only projections — the corpus objects stay canonical):

```bash
node skill/universal-provenance/scripts/upc.mjs export examples/web-research-corpus --format ro-crate
node skill/universal-provenance/scripts/upc.mjs export examples/web-research-corpus --format prov -o prov.jsonld
```

Read the corpus as an Obsidian vault — one clean Markdown note per source, images
copied in with their descriptions, boilerplate stripped, and every note's origin in
a folded provenance block:

```bash
node skill/universal-provenance/scripts/upc.mjs export examples/web-research-corpus --format obsidian -o /tmp/corpus-vault
```

Unlike the other exports this one is **lossy on purpose** — nav chrome, running
heads and page numbers go, so the note is the content and nothing else — and it says
in each note what it removed. Quotations are still rendered from the representation
bytes at the locator and still carry their gate badge, so stripping the body cannot
change what a quotation claims.

Put documents *into* a corpus. UPC reads no PDFs and fetches nothing — what a
document is made of is the tool's business — but identity and layout are not, so
`add` does the hashing, minting, slugging and journalling for a producer written
in any language:

```bash
echo '{"title":"A paper","source_kind":"document",
       "files":[{"path":"/abs/paper.pdf","role":"document_pdf","media_type":"application/pdf"},
                {"path":"/abs/paper.txt","role":"text","media_type":"text/plain","parent":0}]}' \
  | node skill/universal-provenance/scripts/upc.mjs add source --corpus <corpus>
```

Let a model propose quotations and have the tool decide which are real. With
`--normalize`, a span the model retyped with straight quotes, a joined line break
or an expanded ligature is still located — and what gets **stored** is the
document's own characters, never the model's:

```bash
echo '{"quote":"the span the model believes is there","type":"passage"}' \
  | node skill/universal-provenance/scripts/upc.mjs anchor --corpus <corpus> --rep <rep-id> --normalize
```

Publish the corpus as a static site for people who have a question about the
literature rather than about the corpus — code pages, per-source pages carrying
the reading copy with every passage highlighted in place, a searchable passage
index, and rendered overviews:

```bash
node skill/universal-provenance/scripts/upc.mjs export <corpus> --format site -o /tmp/corpus-site --bundle
```

It is a pile of files, not an app: no fetch, no router, no CDN, so it works from
`file://`. `index.html` (above) stays what it always was — the surface for
checking whether a corpus holds up; this one is for handing to a colleague.

A folder is not what gets emailed, though, and detached from its siblings that
site's index page is a set of dead links. So the same library also builds as **one
self-contained file** — stylesheet, data, reading copies and all — which opens
from a USB stick with nothing else beside it:

```bash
node skill/universal-provenance/scripts/upc.mjs export <corpus> --format site-one -o library.html
```

`--no-text` drops the embedded reading copies, which are most of the weight: for a
178-paper corpus, 21 MB becomes 4.7 MB and every passage, code and overview stays.

Rebuild the examples and run the tests:

```bash
node examples/build-examples.mjs
node tests/selftest.mjs
node tests/conformance/build-fixtures.mjs && node tests/conformance/run-conformance.mjs
```

## Adopting UPC in a tool

Read the crosswalk for your tool ([pi-forge](crosswalks/pi-forge.md),
[ResearchAssistant](crosswalks/research-assistant.md)); it maps your existing
schema field-by-field to UPC and lists the changes to apply. Drop the
`skill/universal-provenance/` directory into your skills folder to get the CLI;
emit objects per the schemas; run `upc validate`.

Any conformant corpus can then be projected into the wider research-object
ecosystem — `upc export … --format ro-crate` emits an [RO-Crate
1.3](crosswalks/ro-crate.md) metadata graph conforming to the [UPC RO-Crate
profile](profiles/ro-crate/profile.md), with [Web Annotation](crosswalks/web-annotation.md)
selectors and [PROV](crosswalks/prov.md)-mappable derivation. What each level
mechanically guarantees — and, deliberately, what it does not — is stated in
[spec/11-guarantees.md](spec/11-guarantees.md).

## License

[PolyForm Noncommercial License 1.0.0](LICENSE.md) — free for **any noncommercial
purpose** (personal use, research, education, nonprofits, public institutions).
Adopt the standard, implement it, fork it, extend it, share it, all at no cost.
**Commercial use requires a separate license** from the copyright holder;
`SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0`.
