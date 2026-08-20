---
name: universal-provenance
description: Read, write, validate, and browse a Universal Provenance Corpus (UPC) — the tool-independent research-corpus format for sources, representations, extractions, generations, and syntheses with portable provenance and byte-exact quotation gates. Use when producing or consuming a UPC corpus, verifying that a quotation is real, validating a corpus, regenerating its projections, exporting citations, or generating its static HTML browser.
---

# Universal Provenance Corpus (UPC) skill

This skill lets an agent produce, consume, verify, and browse a **UPC corpus**: a
portable folder of research materials where every object carries explicit
provenance, **every quotation is verified byte-for-byte against its source**, and
every human/consumer format is a regenerable projection of structured objects. It
is tool-independent — the same corpus is read and written by pi-forge,
ResearchAssistant, and any other tool.

The normative specification is in `spec/` at the root of the UPC standard; the
skill-local working contract is `references/upc-contract.md`. **Read that contract
before writing a corpus.** If you will emit quotations into any output, also read
`references/small-llm-protocol.md` (a 10-step gate you can follow verbatim).

## Object model (one line)

`SOURCE → REPRESENTATION → EXTRACTION → GENERATION → SYNTHESIS`, indexed by
`corpus.json`, each derived object stamped with `provenance.derived_from`, each
`direct_quote` anchored by a `char_range` locator so it verifies exactly.

## The one rule that matters most

**Never type a quotation from memory. Copy it, cite it, verify it.** A quotation
in the corpus or in any output is real only if it passes the gate:

```
output quote  ==exact==  extraction.direct_quote  ==exact==  representation bytes at the locator
```

No normalization happens at verification time. If a quote does not match
byte-for-byte, it is flagged — never silently accepted. To emit a quote, run
`upc quote <ext-id>` and paste its output unchanged; to check any prose you wrote,
run `upc verify-quotes`.

## When to use

- Producing research output another tool should read → **write a UPC corpus**
  (follow `references/upc-contract.md`).
- Consuming a corpus made by another tool → **read via the manifests** (resolve
  objects by id through `corpus.json`; never assume file paths).
- Emitting a quotation in an answer/report/table → **`upc quote` then
  `upc verify-quotes`** (`references/small-llm-protocol.md`).
- Re-pulling evidence after a better cleaning pass → **re-extraction protocol**
  (`references/re-extraction.md`); after a re-render → **`upc reanchor`**.
- Checking a corpus is well-formed and its quotes verify → **validate**.
- Rebuilding manifests/CSVs/browser, or exporting citations → **regen / export**.
- Giving a human a browseable, verified view → **build the HTML browser**.

## Tools (`scripts/upc.mjs`, zero-dep Node ≥18)

Resolve this skill's directory from the loaded `SKILL.md` path, then shell out.

```bash
node scripts/upc.mjs validate <corpus-dir> [--strict]
node scripts/upc.mjs verify-quotes <file> --corpus <corpus-dir> [--strict]
node scripts/upc.mjs verify <ext-id> --corpus <corpus-dir>
node scripts/upc.mjs quote <ext-id> --corpus <corpus-dir> [--narrow <start> <end>]
node scripts/upc.mjs regen <corpus-dir>
node scripts/upc.mjs export <corpus-dir> --format bibtex|ris|csl-json|jsonl|markdown [-o <file>]
node scripts/upc.mjs reanchor <ext-id>|--all --corpus <corpus-dir> [--to <rep-id>]
node scripts/upc.mjs build-index <corpus-dir>
node scripts/upc.mjs mint <src|ext|gen|syn> < object.json
```

- **validate** — runs the spec/08 rule registry: schema, referential integrity,
  content-addressed id recompute, and the hop-A/B/C quotation gates. Prints a
  bounded JSON report keyed by error code; `level` is the highest conformance
  level fully satisfied (L0/L1/L2), computed from rules passed. Exits non-zero on
  any error. **Run before declaring a corpus complete.**
- **verify-quotes** — runs the hop-C gate over any file (a chat answer, a report):
  every `"…" [ext-id]` marker must match that extraction's `direct_quote` exactly.
- **verify** — the full chain (hop A + B) for one extraction; prints a reanchor
  hint if the quote drifted.
- **quote** — prints `"<exact quote>" [ext-id]`, ready to paste; `--narrow <a> <b>`
  mints a sub-quote extraction and prints its marker.
- **regen** — rebuilds `corpus.json` (counts, indexes, `schema_hash`), the CSV
  mirrors, and `index.html` from the objects, atomically. Also the crash-recovery
  move.
- **export** — CSL-JSON (authoritative) → BibTeX/RIS, plus `jsonl` and `markdown`.
- **reanchor** — after a representation is re-rendered, byte-exact-searches the
  successor for each quote and re-locates it (unique hit) or flags `needs_review`.
- **build-index** — writes a self-contained, offline `index.html` browser (a
  projection): findability, the provenance graph both ways, and a **verification
  badge on every quotation** with context read from the representation at the
  locator. Read-only.

`validate.mjs` / `build-index.mjs` remain as thin back-compat wrappers. The
scripts locate the UPC `schemas/` and `vocab/` by walking up from the script dir;
when installed outside a UPC checkout, vendor `schemas/` + `vocab/` alongside them
or set `UPC_SCHEMA_DIR` / `UPC_VOCAB_DIR`.

## Writing a corpus — the rules that matter

1. **Objects are the source of truth.** Write structured `source.json`,
   extractions, generations, syntheses first; the CSV mirrors, `index.html`, and
   any Markdown deliverable are regenerated (`upc regen`) — never hand-authored
   with unsourced claims.
2. **Quotes are exact and anchored.** A `direct_quote` is copied verbatim from a
   textual representation and carries a `char_range` locator (Unicode codepoints);
   it must pass the hop-B gate. A paraphrase goes in `text` and is never presented
   as a quotation.
3. **Content-addressed ids + aliases.** `src-/rep-/ext-/gen-/syn-<12hex>` (spec
   §06), computed by the recipes there (the validator recomputes and enforces
   them). Keep your tool's own id in `aliases`. Use `upc mint` to compute one.
4. **Stamp every derived object** with `provenance.produced_by` (incl. `method`) +
   `created_at` + `derived_from`, and `provenance.input_digest` for
   generations/syntheses.
5. **Generated prose cites and verifies.** A `synthesis.md` cites every
   evidence/source id its claims depend on, marks each quotation with `"…"
   [ext-id]`, and passes `upc verify-quotes`.
6. **Never mutate a source.** Re-capture is a new representation; a moved URL is a
   new source related by `supersedes`. Correct a derived object via the modify
   workflow (edit → `upc validate` → `upc regen`), never by hand-editing a
   manifest.

## Adoption

To map an existing tool's schema onto UPC, see the crosswalks at
`crosswalks/pi-forge.md` and `crosswalks/research-assistant.md`. Each is a
field-by-field bridge plus the import/export direction and the migration notes
for that tool.

## Interoperability & guarantees

Any conformant corpus projects into the research-object ecosystem:
`upc export <corpus> --format ro-crate` writes a deterministic RO-Crate 1.3
metadata graph conforming to `profiles/ro-crate/` (crosswalks: `ro-crate.md`,
`web-annotation.md`, `prov.md`). The Web-Annotation selectors are
interoperability-only; the UPC `char_range` stays gate-authoritative. What each
conformance level mechanically guarantees — and, deliberately, what it does not —
is stated normatively in `spec/11-guarantees.md`.
