# Crosswalk: UPC ⇄ BagIt (deferred)

[BagIt](https://datatracker.ietf.org/doc/html/rfc8493) (RFC 8493) is a hierarchical
file-packaging format with checksum manifests, designed for reliable storage and
transfer. It deliberately treats payload contents as **opaque bytes** — it knows
nothing about UPC evidence semantics.

**Status: deferred (not in UPC 1.2.0).** BagIt is useful as an *outer* packaging
for archival transfer / repository deposit, not as a replacement for UPC. A future
optional command (`upc pack <corpus> --bagit`) could wrap a corpus (or its RO-Crate
projection) in a bag; RO-Crate 1.3 explicitly permits profiles to recommend BagIt
packaging. It is not mandatory for ordinary working corpora.

## Conceptual nesting

```
BagIt                      ← archival packaging + fixity manifest (opaque payload)
  └── RO-Crate             ← research-object description (ro-crate-metadata.json)
       └── UPC profile     ← research-evidence constraints
            └── evidence   ← the corpus objects + gated quotations
```

## Sketch of the eventual mapping

| UPC | BagIt | Notes |
|---|---|---|
| corpus directory | bag `data/` payload | bytes moved verbatim |
| per-file `sha256` (§06) | `manifest-sha256.txt` entries | UPC already records these; BagIt re-lists them |
| corpus-level fixity (future digest) | `tagmanifest-sha256.txt` | complements, does not replace, per-file hashes |
| the quote gate / evidence graph | — | **UPC-only**; BagIt sees only opaque bytes |

BagIt provides fixity for *transfer*; it does not verify quotations or understand
derivation. Keep it optional and outermost.
