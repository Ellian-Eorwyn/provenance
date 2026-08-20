# Crosswalk: UPC ⇄ RO-Crate

[RO-Crate](https://www.researchobject.org/ro-crate/) 1.3 is a JSON-LD research-object
packaging and metadata specification. It provides the general research-object
*container and description* layer; UPC provides the research-*evidence* layer —
exact quotation gates, selector semantics, and derivation constraints. UPC does
**not** replace its own object store with RO-Crate; instead it emits a **lossless
RO-Crate projection** so any UPC corpus can be consumed by the RO-Crate ecosystem.

- **Direction (1.2.0): export only.** `upc export <corpus> --format ro-crate`
  writes `ro-crate-metadata.json` (see §09 projections). Like `index.html` and the
  CSV mirrors, it is a **regenerable, non-canonical** view; the UPC objects remain
  the single source of truth. RO-Crate *import* (round-trip) is deferred — reading
  arbitrary JSON-LD needs a full processor (expansion/framing), out of scope for a
  zero-dependency implementation and a later decision (see §00 versioning).
- **Profile.** The projection declares conformance to the **UPC RO-Crate profile**
  (`profiles/ro-crate/`), whose canonical id is
  `https://provenance.dev/upc/1.2.0/profiles/ro-crate`.

Legend: **exact** (semantics coincide) · **partial** (maps, but with a stated
divergence) · **incompatible** (do not equate) · **UPC-only** (no RO-Crate
counterpart; carried as a `upc:` term).

## Object mapping

| UPC | RO-Crate / schema.org | Mapping | Notes |
|---|---|---|---|
| Corpus (`corpus.json`) | root `Dataset` (`@id: "./"`) | exact | `identifier: cor-…`; `conformsTo` names RO-Crate 1.3 + the UPC profile |
| Stored representation (bytes) | `File` data entity (`@id` = crate-relative **path**) | exact | UPC id in `identifier: rep-…`; role in `upc:role` |
| Source (conceptual) | `["CreativeWork","upc:Source"]` (or `ScholarlyArticle`/`Dataset` per `bibliographic.item_type`) | partial | a bibliographic *work*, distinct from its representation `File`s |
| Extraction | `["upc:Extraction"]` entity + companion `Annotation` for gated ones | partial | see [web-annotation.md](web-annotation.md) |
| Generation | `["CreativeWork","upc:Generation"]` | exact | `output` → `File`/inline; `derived_from` → `hasPart`/PROV |
| Synthesis | `["CreativeWork","upc:Synthesis"]` (or `Dataset`) | exact | claim register carried as `upc:` terms |
| Person (`produced_by.person`) | `Person` | exact | |
| Tool (`produced_by.tool`) | `SoftwareApplication` | exact | `name` + `version` |
| Activity event (`events.jsonl`) | `CreateAction` (schema.org) | partial | PROV `Activity` in [prov.md](prov.md); `instrument`/`object`/`result` |
| Input dependency (`derived_from`) | `prov:wasDerivedFrom` / action input | exact | |
| Corpus profile conformance | `conformsTo` | exact | |
| **The hop-B/C quotation gate** | — | **UPC-only** | RO-Crate describes *where* a selection is; it does not verify a quote. §11. |
| Content-addressed id recipe (§06) | — | **UPC-only** | preserved as `identifier`, never overloaded onto `@id` |

## Identifiers: `@id` is a locator, not the UPC identity

RO-Crate `@id` answers *"how is this entity referenced within this crate?"*; the
UPC content-addressed id answers *"which exact UPC object is this?"*. They are not
the same and MUST NOT be conflated:

- **File** entities use the crate-relative **path** as `@id` (an RO-Crate
  requirement) and carry the UPC id in `identifier`.
- **Abstract** entities (source/extraction/generation/synthesis) use a
  `#<upc-id>` fragment as `@id` (unique by construction) and *also* carry
  `identifier: "<upc-id>"` plus a typed `upc:<kind>Id`.

A consumer keys on `identifier` / `upc:*Id`, never on `@id`. Example:

```json
{ "@id": "sources/example/clean.md", "@type": "File",
  "identifier": "rep-3333bbbb4444", "upc:role": "clean_markdown",
  "sha256": "…", "encodingFormat": "text/markdown" }
```

## Determinism

The projection is deterministic: `@graph` sorted by `@id` (with the
`ro-crate-metadata.json` descriptor and the `./` root pinned first per RO-Crate
convention), fixed key order, sorted arrays, and **no wall-clock / random** in the
output. `datePublished` is derived from corpus/event data or omitted. Re-running
the export on an unchanged corpus is byte-identical.

## `@context` and zero-dependency emission

The crate uses `"@context": ["https://w3id.org/ro/crate/1.3/context",
{"upc":"https://provenance.dev/upc/terms#"}]`. Emitting **flattened** JSON-LD (a
plain `@graph` of entities) needs no JSON-LD processor and no network — a consumer
that wants RDF runs its own processor against the referenced context. This is why
export is zero-dep and import is not.

## What does not survive as an equality claim

The gate is **UPC-only**. An RO-Crate consumer sees *where* an extraction points
and *what* text it selects, but a plain RO-Crate reader does not re-run hop B/C.
The projection therefore stamps every gated selection with `upc:gateAuthoritative:
true` and its companion Web-Annotation selectors with `upc:interopOnly: true`, so
the UPC selector remains the authority (§11). Consuming the crate does not verify
the quotes; only a UPC validator does.
