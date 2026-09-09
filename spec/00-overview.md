# UPC 00 — Overview

**Universal Provenance Corpus (UPC), version 1.7.0**

A UPC corpus is a portable, tool-independent collection of research materials in
which both humans and software can always answer: *What is this object? Where did
it come from? What transformations produced it? What evidence supports it? What
other objects depend on it?* — and, above all, *is this quotation real?*

UPC is a **versioned data specification with a conventional filesystem
representation**. The spec + schemas make a corpus interoperable between
software; the filesystem layout makes it portable and inspectable by humans. The
specification is **self-contained**: every algorithm a conforming implementation
needs (identifier hashing, canonical JSON, URL normalization, slug generation,
the quotation gates) is written out here, so a corpus can be produced and read
without this repository's reference code.

## Why this exists

Two existing tools — **pi-forge** (deep web research) and **ResearchAssistant**
(RA, a research-source manager) — each store research materials in their own
on-disk format, so a corpus produced by one is not directly usable by the other.
They have, however, *independently converged* on nearly the same design: file
based (no database as the source of truth), one directory per source, a JSON
store with a CSV mirror, sha256 content hashing, per-generation provenance
stamps, and capabilities delivered as "skills."

UPC is therefore a **reconciliation and generalization of two very-close
formats**, not a new invention. It reuses their vocabulary and conventions
wherever possible so that adoption is a mapping, not a rewrite. Where this
document mentions how a rule "generalizes" one tool's mechanism, that is
motivation only: the normative rule is stated in full here and depends on no
external code.

## The one hard promise

Everything else in UPC serves a single guarantee: **a quotation attributed to a
source is really there, verified by dumb byte-for-byte comparison, or it is
flagged.** No normalization softens the comparison; no heuristic "finds it
anyway." A small language model can lean its entire trustworthiness on this: if
it only ever emits quotes that pass the gate, it cannot fabricate a quotation.
The verification chain and its gates are §03 (extraction ↔ source), §04 (output ↔
extraction), and §08 (the rule registry that enforces both).

## Three co-equal audiences

A UPC corpus must serve all three of these at once; none may win at the expense
of another.

1. **Machine-managed / machine-readable.** Agents and tools create and maintain
   the corpus. Manifests, identifiers, schemas, and the provenance graph are the
   machine surface. Manifests and indexes are *machine-owned and regenerable* —
   never hand-maintained.
2. **Human-browsable.** A person can open the folder (or the generated HTML
   browser) and *find materials easily*: human-readable directory and file
   names, readable indexes, a browse/search surface, and the ability to correct
   what is wrong and export what they need (§09).
3. **LLM-renderable to any format.** Because every object is structured and every
   claim traces back to verifiable evidence, an LLM can be asked to emit
   *whatever format is desirable* — a literature review, a table, a BibTeX file,
   slides, a prose answer — as a view over the canonical data, with its
   quotations mechanically checkable.

## The provenance graph

The corpus is a directed, backward-traversable graph of five object kinds:

```
SOURCE ──▶ REPRESENTATION ──▶ EXTRACTION ──▶ GENERATION ──▶ SYNTHESIS
```

- **Source** — the primary conceptual object (a web article, a PDF, an image, a
  dataset). Identified once; everything else references it.
- **Representation** — a typed rendering of a source: the raw HTML capture, a
  print-to-PDF, cleaned Markdown, an extracted image, a transcript, metadata.
  Representations are *different views of the same source*, not separate sources.
- **Extraction** — structured evidence selected from a *specific representation*
  at an *exact location*: a quotation, passage, entity, or query-relevant
  statement. A quotation-bearing extraction is anchored precisely enough to be
  verified byte-for-byte.
- **Generation** — single-source derived material: a summary, rating,
  translation, classification, description.
- **Synthesis** — multi-source derived material that combines evidence across
  sources: a literature review, comparative analysis, research memo, or answer.

Two further objects record *judgements about* the graph rather than material
derived from it (§12):

- **Codebook** — a named coding scheme: the controlled vocabulary of codes a
  coder may apply.
- **Coding** — one coder's judgement that one code applies to one target. A
  span-level coding targets an **extraction**, never a raw position, so every
  coded passage has already passed the quotation gate before it can be labelled.

Every non-source object records what it was *derived from* and how, so any
synthesis is inspectable backward all the way to the original source bytes.

## Core design principles

These are normative; each later spec section elaborates one or more.

1. **The unit is an identifiable research object with explicit provenance, not a
   file.** Files are representations of sources.
2. **Logical model is canonical; physical layout is manifest-declared.** Tools
   MUST resolve objects through manifests and identifiers, and MUST NOT assume a
   given file type sits at a fixed path. Manifests and indexes are machine-owned
   and regenerable. (§01)
3. **Per-source directory is the canonical physical layout**, with
   **human-readable slug** names for browsability. The canonical content-hash id
   lives in the manifest, not in the folder name. A per-media-type layout is a
   permitted *readable* variant (Appendix A). (§01, §02, Appendix A)
4. **Content-addressed identity with local aliases.** The canonical id of an
   object is derived from its content by a fully specified, deterministic recipe
   (§06); each tool may keep its own id as a non-canonical alias. Same content →
   same canonical id across tools, in any language.
5. **A locator is `(representation_ref, typed position)` — never a bare offset.**
   A position only means something relative to one representation; naming the
   representation is what lets two tools' locators denote the same span. A
   quotation-bearing extraction MUST use an exact-range locator (§03).
6. **Derived objects carry an `input_digest`** (a hash of the exact bytes they
   consumed) and **backward links** to their inputs, enabling staleness
   detection and full traceability. (§04, §07)
7. **Structured objects are the single source of truth; every human/consumer
   format is a regenerable projection.** The HTML browser, the CSV mirrors,
   RIS/BibTeX exports, generated Markdown, and any ask-an-LLM output are *views*
   computed from the objects — never a second source of truth, and regenerable
   by tooling, never hand-maintained. (§09)
8. **Referential and content integrity are enforced by a validator**, not left
   to convention. A corpus that claims a source id that does not exist, or whose
   stored hash no longer matches its bytes, is invalid — not merely sloppy. (§08)
9. **Storage is crash-safe and portable.** Writes are atomic; every projection is
   regenerable from the objects, which is also the recovery story; filenames are
   constrained to be portable across POSIX and Windows filesystems. (§10)
10. **Gates are dumb equality; failures are flagged, never absorbed.** Quotation
    verification compares exact Unicode codepoints, with no normalization at
    verification time. Cleanup and normalization happen when an extraction is
    *created* (you choose the span, or write a cleaned representation and anchor
    into it). Anything that fails a gate is reported, never silently accepted or
    "corrected." (§03, §04, §08)

## Object and section map

| Object | Manifest / file | Section |
|---|---|---|
| Corpus | `corpus.json` (+ `sources.csv`, `extractions.csv` mirrors) | §01 |
| Source | `sources/<slug>/source.json` | §02 |
| Representation | inline in `source.json`; bytes under `representations/` | §02, §05 |
| Extraction | `sources/<slug>/extractions.jsonl`; `extractions/<set>/items.jsonl` | §03 |
| Generation | `sources/<slug>/generated/<id>.json` | §04 |
| Synthesis | `syntheses/<id>/synthesis.json` (+ `synthesis.md`) | §04 |
| Codebook | `codebooks/<cbk-id>.json` | §12 |
| Coding | `codings/<set-id>/items.jsonl` | §12 |
| Activity journal | `provenance/events.jsonl` | §07 |
| Identifiers & hashing | — | §06 |
| Conformance & validation | — | §08 |
| Human interface & projections | `index.html` and views | §09 |
| Storage & durability | atomic writes, JSONL/CSV rules, removal | §10 |
| Guarantees & non-guarantees | — | §11 |
| Layout decision record | per-source vs per-media-type | Appendix A |

## Conformance in one line

A corpus declares `upc_spec_version` and satisfies one of three cumulative
levels — **L0 Readable**, **L1 Provenanced** (which guarantees *no unverified
quotations in the corpus*), **L2 Synthesized** — verified against the numbered
rule registry in §08. The reference validator implements exactly that registry.

## Versioning policy

The specification version (`upc_spec_version`) is independent of any tool's
internal schema version, and follows semantic versioning:

- **Major** (`2.0.0`) — a breaking change: a removed or renamed field, a tighter
  constraint that can reject a previously valid corpus, or a changed identifier
  or gate recipe.
- **Minor** (`1.6.0`) — a backward-compatible addition: a new optional field, a
  new enum value, a new object kind or section. A reader for `1.x` MUST accept a
  `1.y` corpus for any `y ≥ x`.
- **Patch** (`1.1.1`) — editorial clarification only, no schema effect.

Two rules make additive minor versions actually compatible:

- **Must-ignore-unknown.** A reader MUST ignore object members it does not
  recognize rather than reject them. Accordingly, all object schemas set
  `additionalProperties: true`. The reference validator surfaces unknown members
  as an advisory `unknown_field` warning (an error only under `--strict`), so
  typos are still visible without breaking forward compatibility.
- **Writer discipline.** A writer MUST NOT invent top-level members. Tool-private
  data goes in the open `ext` object (namespaced by tool: `"ext": {"pi-forge":
  {...}}`) or in `aliases`. This keeps the shared surface clean while giving
  tools room to extend.

Each schema's `$id` embeds the minor version
(`https://provenance.dev/upc/1.6.0/schemas/...`). The corpus records
`integrity.schema_hash` (§01) so a reader can detect a schema skew even within a
minor version. This document supersedes UPC 1.0.0 wholesale; see `CHANGELOG.md`.

Two changes in 1.6.0 illustrate the boundary, and they are not equivalent.

Codebooks and codings are a **new object kind under new `sections` keys**, which an
older reader never looks for: purely additive, and forward-compatible in the full
sense above.

Relaxing a rule — 1.6.0 demoting a duplicate representation id with *matching
bytes* to an advisory (§08 rule 1.1) — is minor-safe in the sense that matters
most, **no previously valid corpus becomes invalid**, but it is honest to record
that it is *not* forward-compatible: a corpus that exploits the new laxity will
fail under the older, stricter validator. A relaxation therefore raises the
*minimum reader version* for corpora that use it, which is what
`upc check-compat --requires` is for. This is a permitted minor change; silently
assuming older readers will cope is not.

What a minor version must never do is change an identity recipe or add a value to a
closed enum: either would make a corpus that is *conforming under both versions*
fail under the previous minor's validator, which no amount of version-pinning can
repair.

## Status of this document

Version 1.7.0. Reference implementation: the zero-dependency Node ≥18 skill under
`skill/universal-provenance/`. The spec is normative; where the reference code
and this document disagree, the document governs and the code is the bug.
