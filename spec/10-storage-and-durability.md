# UPC 10 — Storage & Durability

A corpus is a live store that tools and people write to, sometimes concurrently,
sometimes on a laptop that loses power mid-write. This section makes the
filesystem behavior a normative part of the standard so a corpus stays consistent
and portable, and so "regenerate the projections" is always a valid recovery
move.

## Atomic writes

Every write of a corpus file MUST be **atomic** from a reader's point of view — a
reader sees either the old file or the new file, never a half-written one:

1. Write the new bytes to a temporary file **in the same directory** as the
   target (so the final step is a same-filesystem rename): `.<name>.<nonce>.tmp`.
2. `fsync` the temp file.
3. `rename()` the temp file onto the target (atomic on POSIX; on Windows, use the
   platform's atomic replace).
4. SHOULD `fsync` the containing directory so the rename is durable.

The reference `atomicWriteFile` does this. A crash leaves at most a stray `.tmp`
file (ignored by readers and cleaned on the next write), never a corrupt target.

## Multi-file updates and recovery

A single logical change often touches several files (an object, then the
manifests, then the projections). The ordering is **objects first, derived
surfaces last**:

```
1. write/update the object files (source.json, extractions.jsonl, generated/*.json, syntheses/*)
2. append the activity event(s) to provenance/events.jsonl
3. regenerate the derived surface: corpus.json (counts, indexes, schema_hash),
   sources.csv, extractions.csv, index.html
```

Each individual file write is atomic. If a crash interrupts the sequence after
step 1 but before step 3, the objects are correct and only the projections are
stale — running `upc regen` rebuilds them. This is why the projections are
defined as regenerable (§01, §09): regeneration *is* the crash-recovery story.
There is no cross-file transaction and none is required; the object files are the
truth and the rest is derived.

## JSONL rules

JSONL files (`extractions.jsonl`, `items.jsonl`, `events.jsonl`) follow one set of
rules so a reader never chokes and a torn append never bricks a corpus:

- **Encoding** UTF-8, no BOM. **Line terminator** `\n` (LF). One complete JSON
  object per line. A trailing LF after the last object is required on write.
- **Reader tolerance.** A reader processes every well-formed line. If the **final**
  line is truncated (a torn append after a crash), the reader keeps the good lines
  and reports `jsonl_torn_tail` (a warning) — it does not fail. A malformed
  **interior** line is a real corruption and is an error (`jsonl_invalid`).
- **Editing.** `extractions.jsonl` and `items.jsonl` are **edited by atomic
  whole-file rewrite** (read all, change the object, write via the atomic
  procedure). At corpus scales (tens of thousands of lines) this is fast and keeps
  every read consistent. Records are addressed by `extraction_id`; on a duplicate
  id the last record in file order wins, and the duplicate is reported
  (`id_duplicate`).
- **Append-only exception.** `provenance/events.jsonl` is **append-only** — new
  events are appended, never rewritten. A correction or removal is a *new* event
  (below), which is what makes the journal a trustworthy audit log.

## Removal and tombstones

Sources are immutable, but a corpus still needs to remove material (a
mis-captured source, a retracted extraction, redaction for rights or privacy).
Removal is explicit, logged, and regeneration-safe:

- **Retract** — set an extraction/generation/synthesis `status` to `retracted`
  (or add a `retracted` marker). The object is **retained** but excluded from
  gates and exports, and journaled as a `retract` event. Citations of it are
  flagged (`cites_retracted`), not silently broken.
- **Remove** — delete an object and its files entirely: rewrite the owning JSONL /
  delete the object file, append a `remove` event recording the id(s) removed,
  then `regen`. The journal preserves the fact that something was removed even
  though the object is gone.
- **Redact** — replace representation bytes that must not be retained with a
  redaction placeholder (new bytes → new `rep-` id), append a `redact` event, and
  re-anchor or flag the affected extractions (§09). The original bytes are gone;
  the record that they existed and were redacted remains.

## Concurrency (advisory single-writer lock)

UPC is a file store, not a database, so it does not promise multi-writer
serializability. It defines a **best-effort advisory lock** so cooperating tools
avoid clobbering each other:

- A writer SHOULD create `.upc/lock` with `O_EXCL` before a write session, holding
  JSON `{ "pid", "tool", "hostname", "acquired_at" }`, and remove it when done.
- A writer that finds a lock older than 60 minutes MAY treat it as stale, break
  it, and proceed, emitting a warning.
- The lock is advisory: a non-cooperating writer can ignore it. Atomic writes
  (above) still guarantee no torn files even without the lock; the lock only
  prevents two writers from interleaving logical updates.

`.upc/` is **tool-private scratch space**: it is never a corpus member, never
referenced by a manifest, and MAY be deleted at any time. Tools use it for locks,
caches, and in-progress work.

## Filename portability

Every path a manifest declares MUST be portable across POSIX and Windows
filesystems and safe on case-insensitive and Unicode-normalizing volumes:

- **Relative & POSIX-separated.** Corpus-relative, `/`-separated, no leading `/`,
  no drive letter, no `\`.
- **Contained.** After resolving symlinks (realpath), the target is inside the
  corpus root — `..`, absolute paths, and symlink escapes are rejected
  (`path_escape` / `symlink_escape`).
- **Character set.** No control characters and none of the Windows-forbidden
  characters `< > : " | ? *`; no trailing dot or space on any path segment; no
  segment equal to a Windows reserved device name (`con`, `prn`, `aux`, `nul`,
  `com1`–`com9`, `lpt1`–`lpt9`).
- **Unicode.** Path strings are stored **NFC-normalized**, so a name written on
  one platform resolves on another (macOS returns NFD from the filesystem;
  compare normalized).
- **Case.** Two paths that differ only by case MUST NOT both exist (they collide
  on case-insensitive volumes); the slug algorithm's collision suffix (§06)
  prevents this for source folders.

A validator enforces these as `filename_illegal` (§08 rule 0.6). Keeping to them
means a corpus zipped on Linux unzips and validates unchanged on macOS or Windows.
