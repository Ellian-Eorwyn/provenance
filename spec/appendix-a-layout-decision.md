# UPC Appendix A — Layout Decision Record: per-source vs per-media-type

This appendix records the resolution of an open design question: should a corpus
be organized as **one folder per source** (with each source's media, text,
extractions, and generations grouped under it) or **one folder per media type**
(all raw captures together, all cleaned text together, …, each item linking back
to its source)? The decision is normative; the reasoning is recorded so future
implementers understand *why* and can re-open it deliberately rather than by
accident.

## Context

Both predecessor tools independently chose a per-source arrangement for their
primary store, and one of them (a citation manager) also ships a standalone-job
mode whose real repositories are laid out **per media type** (`originals/`,
`markdown/`). So both layouts exist in the wild and a UPC reader must be able to
read either. The question is which one *writers* should emit as canonical, and
which the standard should optimize for.

## Options

- **A — Per-source.** `sources/<slug>/` contains `source.json`, `representations/`
  (with typed subfolders `images/`, `media/`, `transcripts/`),
  `extractions.jsonl`, and `generated/`. One source's entire evidence bundle lives
  under one directory.
- **B — Per-media-type.** Top-level `originals/`, `markdown/`, `images/`,
  `extractions/`, `generations/` …, each file naming the `source_id` it belongs
  to; the source's identity and metadata are assembled by joining across folders.

## Evaluation

| Criterion | Per-source (A) | Per-media-type (B) |
|---|---|---|
| **Human browsing** | Strong: open one folder, see everything about a source. | Weak: a source's material is scattered; you cross-reference folders by id. |
| **LLM / agent navigation** | Strong: one `ls` of a source folder is that source's whole context window; a source folder copied out is self-interpreting. | Weak: the agent must load and join several indexes to assemble one source. |
| **Self-contained copy-out** | Strong: `cp -r sources/<slug>` is a complete, valid mini-corpus. | Weak: no subtree is a complete source. |
| **Bulk-media operations** | Weaker: media is spread across source folders. | Strong: "re-OCR every PDF" or "thumbnail every image" is one folder. |
| **Deletion locality** | Strong: remove a source = one `rm -r` + `regen`. | Weak: deleting a source touches every media folder. |
| **Cross-app compatibility** | Both readable via manifest indirection; `sections` + per-representation `path` resolve either. | Same — but B needs the `generations` section key to be resolvable, which A supplies. |
| **Scale (thousands of sources)** | Fine: folders are cheap; indexes are the manifests, not the directory. | Fine, and marginally better for media-heavy bulk jobs. |

The only column B wins outright is bulk-media operations — which are batch jobs a
tool runs occasionally, not the everyday browse/verify/cite path the standard's
three audiences live in. Every audience-facing criterion favors A, and A's
"one folder = one source's whole context" property is exactly what makes a source
folder a portable, self-describing unit for both a human and an LLM.

## Decision

**Writers MUST emit the canonical per-source layout (Option A).** Inside a source
folder, media is grouped by type (`representations/images/`, `.../media/`,
`.../transcripts/`) — so A already captures B's within-source tidiness without
losing source locality.

**Readers MUST honor whatever `corpus.json.sections` declares, including a
per-media-type layout (Option B).** B remains a fully *readable* variant: because
every representation carries its own corpus-relative `path` and `sections` maps
each object class (now including `generations`) to its location, a per-media-type
corpus resolves through the manifest exactly like a per-source one. A tool MUST
resolve by id through the manifest and MUST NOT assume a class sits at a fixed
path (§01).

## Consequences

- The `sections` table gains a `generations` key (§01) so a layout that groups
  generations centrally is resolvable; the reference loader honors `sections`
  everywhere and no longer hard-codes `<source>/generated/`.
- A real per-media-type repository (a citation manager's standalone-job mode) is
  **readable and migratable without moving bytes**: point `sections` at the
  existing folders, or run a one-time `regen` into the canonical layout.
- The within-source media grouping means the per-source choice does not sacrifice
  the media-organization benefit that made B attractive.
- Nothing in identity, gates, or provenance depends on the layout, so the decision
  is purely ergonomic and can be revisited in a future version without affecting
  the data model.
