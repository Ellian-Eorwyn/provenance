# UPC RO-Crate Profile

- **Profile id:** `https://provenance.dev/upc/1.5.0/profiles/ro-crate`
- **Conforms to:** [RO-Crate 1.3](https://w3id.org/ro/crate/1.3)
- **Adds:** the UPC evidence model, selector semantics, quotation-verification
  boundary, derivation constraints, and conformance levels.
- **Status:** the target of the `upc export … --format ro-crate` projection
  ([crosswalks/ro-crate.md](../../crosswalks/ro-crate.md)). A crate produced by
  that command declares this profile in the root `Dataset.conformsTo`.

An RO-Crate conforming to this profile is a **lossless-enough, deterministic
projection** of a UPC corpus: a plain RO-Crate consumer can read the research
object (files, sources, derivation, agents), and a UPC-aware consumer can recover
the gate-bearing evidence via the `upc:` terms. The profile id embeds the UPC
minor version, exactly like the schema `$id`s (§00 versioning); a crate's
`conformsTo` pins the version it was written against.

## Conformance requirements

A crate conforms to this profile when:

1. It is a valid RO-Crate 1.3 (a `ro-crate-metadata.json` descriptor with
   `conformsTo` `https://w3id.org/ro/crate/1.3` and `about` the root `Dataset`).
2. The root `Dataset.conformsTo` includes `https://provenance.dev/upc/<ver>/profiles/ro-crate`.
3. The `@context` includes the RO-Crate 1.3 context **and** a `upc:` term binding
   `https://provenance.dev/upc/terms#`.
4. Every abstract UPC object (source, extraction, generation, synthesis, event)
   appears as an entity carrying **both** a fragment `@id` (`#<upc-id>`) **and**
   `identifier` = the UPC content-addressed id, **and** a typed `upc:<kind>Id`.
5. Every stored representation and rendered output appears as a `File` data
   entity whose `@id` is its crate-relative path and which carries `upc:sha256`
   and (for representations) `upc:role` and `upc:representationId`.
6. Every **active, `char_range`, `direct_quote`** extraction carries
   `upc:gateAuthoritative: true`, `upc:charRange`, and a companion `Annotation`
   flagged `upc:interopOnly: true`.

## `@id` is a locator, not the UPC identity

RO-Crate `@id` answers *"how is this entity referenced in this crate?"*. The UPC
content-addressed id (§06) answers *"which exact UPC object is this?"*. A consumer
**MUST** key UPC identity on `identifier` / `upc:*Id`, never on `@id`.

- `File` entities: `@id` = crate-relative **path** (RO-Crate requirement); UPC id
  in `identifier`.
- Abstract entities: `@id` = `#<upc-id>` fragment; UPC id also in `identifier`.

## Object → type mapping

| UPC object | `@type` | Required UPC properties |
|---|---|---|
| Corpus | `Dataset` (`@id: "./"`) | `identifier` (cor-), `upc:specVersion`, `conformsTo` |
| Representation | `File` | `identifier` (rep-/img-), `upc:sha256`, `upc:role`, `upc:representationId` |
| Rendered output | `File` | `upc:sha256`, `upc:outputOf` |
| Source | `["<CreativeWork subtype>","upc:Source"]` | `identifier`, `upc:sourceId`, `name` (optional: `upc:identifiers`, `upc:relations`) |
| Extraction | `"upc:Extraction"` | `identifier`, `upc:extractionId`, `upc:sourceId`, `upc:type`, `upc:status`, `upc:representation` |
| Extraction (gated) | + companion `Annotation` | `upc:gateAuthoritative`, `upc:charRange`, `upc:directQuote`, `upc:annotation` |
| Generation | `["CreativeWork","upc:Generation"]` | `identifier`, `upc:generationId`, `upc:type`, `upc:derivedFrom`, `upc:inputDigest` |
| Synthesis | `["CreativeWork","upc:Synthesis"]` | `identifier`, `upc:synthesisId`, `upc:type`, `upc:derivedFrom`; `upc:claims` when present |
| Person | `Person` | `name` |
| Tool | `SoftwareApplication` | `name`; `softwareVersion` when known |
| Activity event | `CreateAction` | `identifier`, `upc:eventId`, `upc:activityType`; `object`/`result` |

## The `upc:` vocabulary (namespace `https://provenance.dev/upc/terms#`)

Types: `upc:Source`, `upc:Extraction`, `upc:Generation`, `upc:Synthesis`.

Properties: `upc:sourceId`, `upc:extractionId`, `upc:generationId`,
`upc:synthesisId`, `upc:eventId`, `upc:representationId`, `upc:role`,
`upc:sourceKind`, `upc:type`, `upc:status`, `upc:query`, `upc:directQuote`,
`upc:charRange`, `upc:gateAuthoritative`, `upc:interopOnly`, `upc:unit`,
`upc:annotation`, `upc:representation`, `upc:derivedFrom`, `upc:inputDigest`,
`upc:stale`, `upc:output`, `upc:outputOf`, `upc:outputValue`, `upc:producedBy`,
`upc:producedByPerson`, `upc:model`, `upc:activity`, `upc:claims`, `upc:claimId`,
`upc:evidence`, `upc:source`, `upc:confidence`, `upc:question`, `upc:aliases`,
`upc:retrieval`, `upc:sha256`, `upc:specVersion`, `upc:corpusId`,
`upc:identifiers`, `upc:identifierScheme`, `upc:relations`, `upc:relationType`,
`upc:relationTarget`, `upc:conformsTo`, `upc:reference`.

`upc:conformsTo` names the external fragment standard a `FragmentSelector`
projects to (`rfc5147`, `media-frags`, `pdf-open-params`); `upc:reference` carries
the `{width, height}` frame a pixel `bbox` was captured against, because
`#xywh=pixel:` is resolution-dependent. Both are advisory, and both appear only on
selectors that are already flagged `upc:interopOnly`.

## The quotation gate is UPC-authoritative; Web-Annotation selectors are advisory

This is the profile's central normative statement (see
[spec/11-guarantees.md](../../spec/11-guarantees.md) and
[crosswalks/web-annotation.md](../../crosswalks/web-annotation.md)):

- The UPC `char_range` (carried as `upc:charRange`, flagged
  `upc:gateAuthoritative: true`) is the **only gate-bearing selector**. It counts
  Unicode codepoints over the strict-UTF-8 decoding of the exact stored bytes,
  with no normalization.
- The companion `Annotation`'s `TextPositionSelector` / `TextQuoteSelector` are an
  **interoperability representation only**, flagged `upc:interopOnly: true` and
  `upc:unit: "codepoint"`. A `TextPositionSelector` implemented over normalized
  text or UTF-16 units can diverge from `upc:charRange`; when they disagree, the
  UPC selector governs.
- Consuming a conforming crate does **not** verify the quotations. Only a UPC
  validator re-runs the hop-A/B/C gates (§08). A profile-conforming crate records
  *where* evidence is and *what* it says; it does not, by itself, prove it.

## Non-goals

This profile does **not** define an importer or a canonical RO-Crate container for
UPC. Export is a regenerable projection; the UPC objects remain the single source
of truth (§00, §09). Making RO-Crate the canonical metadata graph would be a
breaking change reserved for a future major version, gated on round-trip testing.
