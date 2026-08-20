# Crosswalk: UPC ⇄ W3C PROV

UPC's provenance model is *inspired by* [W3C PROV](https://www.w3.org/TR/prov-o/)
(entities, activities, agents, derivation) but stays plain JSON/JSONL — no RDF,
PROV-N, or PROV-O required (§07). This crosswalk maps the two so a PROV-consuming
system can understand a UPC derivation graph.

- **Status.** Shipped in 1.4.0. `upc export <corpus> --format prov` emits the
  mapping below as deterministic, zero-dependency **flattened PROV-O JSON-LD**
  (streamed to stdout or `-o <file>`), reusing the RO-Crate exporter's
  entity/activity/agent machinery. The RO-Crate projection also exposes derivation
  edges (`prov:wasDerivedFrom`) via [ro-crate.md](ro-crate.md); the PROV export is
  the dedicated PROV view.
- **Direction:** export/projection only. UPC keeps the compact operational
  JSON/JSONL as canonical; PROV is an interoperability view. Like `index.html` and
  the CSV mirrors, the PROV output is regenerable and never a second source of
  truth.

Legend: **exact** · **partial** · **incompatible** · **UPC-only**.

## Mapping

| UPC | PROV | Mapping | Notes |
|---|---|---|---|
| source / representation / extraction / generation / synthesis | `prov:Entity` | exact | each derived object is an entity |
| activity event (`events.jsonl`) | `prov:Activity` | exact | `search`/`fetch`/`render`/`extract`/`generate`/`synthesize`/… |
| person (`produced_by.person`) | `prov:Agent` / `prov:Person` | exact | |
| tool / model (`produced_by.tool`/`.model`) | `prov:Agent` / `prov:SoftwareAgent` | exact | |
| `provenance.derived_from` | `prov:wasDerivedFrom` | exact | the backward links |
| a production event | `prov:wasGeneratedBy` | exact | entity ← activity |
| event `inputs` | `prov:used` | exact | activity → entity |
| `produced_by` (tool/person) | `prov:wasAttributedTo` / `prov:wasAssociatedWith` | partial | attribution (entity) vs association (activity) |
| `supersedes` / `superseded_by` | `prov:wasRevisionOf` | partial | use only where the successor really revises the predecessor |
| a quotation-bearing extraction | `prov:wasQuotedFrom` | partial | see caution below |
| retrieval provenance (`source.retrieval`) | `prov:wasDerivedFrom` (acquisition) | partial | **not** `prov:hadPrimarySource` by default — see caution |
| **the hop-B/C quote gate** | — | **UPC-only** | PROV records derivation; it does not verify a quote (§11) |
| `input_digest` / staleness | — | **UPC-only** | PROV has no built-in fixity-staleness relation |

## Cautions (do not over-map by wording)

- **`prov:hadPrimarySource` has a specific epistemic meaning** ("this is the
  original source of the information") — it is **not** a synonym for "UPC source."
  Do not map every UPC `source` to `prov:hadPrimarySource` merely because the
  English sounds similar. A UPC source is a captured resource; whether it is a
  *primary source* in PROV's sense is a claim UPC does not make.
- **`prov:wasQuotedFrom`** may be used for a `direct_quote` extraction, but it
  asserts only "this content was quoted from that entity" — it carries **none** of
  UPC's mechanical guarantee. The fact that the quote is codepoint-exact against a
  hash-fixed representation is UPC-only and is lost in a plain PROV consumer (§11).
- **`prov:wasRevisionOf`** applies to supersession/re-anchoring only when the new
  object is a corrected version of the old; a mere `duplicate_of` is not a revision.

## Entities vs activities (why the journal is separate)

UPC deliberately separates `object.provenance` (a compact statement of how an
object came to exist — entities + derivation) from `provenance/events.jsonl` (the
historical record of activities: timing, failures, corrections, resumability).
This maps cleanly onto PROV's entity/activity distinction: the object graph gives
`Entity` + `wasDerivedFrom`, and the journal gives `Activity` + `used` /
`wasGeneratedBy`. A detached object still carries enough provenance to identify its
inputs and producer without the journal.
