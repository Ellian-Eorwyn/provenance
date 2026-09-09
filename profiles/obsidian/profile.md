# UPC Obsidian Vault Profile

- **Profile id:** `https://provenance.dev/upc/1.8.0/profiles/obsidian`
- **Machine form:** [`profile.json`](profile.json)
- **Status:** the target of the `upc export … --format obsidian` projection
  ([crosswalks/obsidian.md](../../crosswalks/obsidian.md)).

A profile describes **the vault**, not the corpus: which frontmatter properties a
note may carry and in what order, which callouts exist, which blocks a note is
assembled from and in what order, and where notes and attachments are filed.

## Why this is data and not code

UPC is a standard, and a standard must not compile one person's private vault
conventions into its tooling. Obsidian itself imposes almost nothing — a vault is a
folder of Markdown files — so "what a note looks like" is always a local decision.
Any vault that has made that decision can state it here and get the same exporter;
`--profile <file>` replaces the shipped default wholesale.

The shipped profile describes a vault in the shape the export was designed against:
numbered domain folders, a sources root that files by kind, a small controlled
frontmatter vocabulary, and an apparatus of folded callouts at the end of a note.

## What a profile declares

| Key | Meaning |
|---|---|
| `frontmatter.property_order` | the only properties a note may carry, in the order they must appear |
| `frontmatter.properties` | each property's shape (`scalar`, `list`, `wikilink`, `wikilink_list`) and whether it is human-owned |
| `frontmatter.extended_properties` | the extra keys `--frontmatter extended` may add |
| `blocks` | the block grammar, in order; a note is assembled by selecting from it and never reordering |
| `callouts` | the callout registry — a type not listed here is not written |
| `owner_blocks` | blocks a tool must never write and never read |
| `routes` | the inbox, sources root, meta root and its subdomains, and the attachment folders |
| `source_kinds` | the kind vocabulary and the numbered folder each names |
| `kind_mapping` | how a UPC source becomes one of those kinds |
| `body_roles.prefer` | representation-role preference for the note body, cleanest first |

## Rules a conforming export follows

1. **Only declared properties are emitted**, in the declared order, with empty
   strings, empty lists and nulls dropped rather than written.
2. **Only registered callouts are used.** Stock Obsidian callouts (`info`, `quote`,
   `tip`, …) may be declared with `"stock": true` to be used at their stock meaning;
   inventing a type is not permitted.
3. **Owner blocks are inviolable in both directions** — never written, never read
   back, and carried across verbatim when a note is rewritten.
4. **Exactly one level-one heading per note.** A representation that opens with its
   own title has that heading dropped and any later `#` demoted, never deleted.
5. **Human-owned properties are never inferred**, only carried.
6. Notes are written **atomically**, and a note edited since it was last exported is
   **left alone and reported**, never silently overwritten.

## Deriving a profile from a vault

A vault that already documents its own schema — a note listing approved properties,
source kinds and folder routes — is describing this same thing in prose. The
intended path for such a vault is to compile its schema note into a profile and pass
it with `--profile`, so the vault's document stays the single source of truth and
the exporter has no second opinion about it.

`--into <vault>` deliberately does **not** try to infer a vault's domain
vocabulary. It writes to the inbox at `status: raw` and lets whatever owns
classification in that vault do the filing. Guessing a domain would file a note
somewhere plausible and wrong, and a wrong folder is harder to notice than an
unfiled note.

## Non-goals

- **No importer.** The export is lossy by design (§09); a vault cannot reconstruct
  the corpus it came from, and pretending otherwise would invite someone to try.
- **No canonical status.** The vault is a projection. Nothing in it is a second
  source of truth, and a correction belongs in the corpus.
- **No styling.** The profile names callouts and blocks; how they render is the
  vault's CSS, which the export never writes.
