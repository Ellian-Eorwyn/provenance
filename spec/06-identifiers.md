# UPC 06 — Identifiers & Hashing

Identity is the load-bearing decision of an interoperable format: it is what lets
two tools recognize that they are looking at the same source, and what lets a
validator confirm that an id was not typed by hand. UPC uses **content-addressed
canonical identifiers** computed by fully specified, deterministic recipes, with
**per-tool aliases** for each tool's local id.

Every recipe here is written out so that an implementation in any language
produces byte-identical ids. Nothing in this section depends on this repository's
code or on any tool's source.

## Hashing

All hashes are **SHA-256**, lowercase hex.

- A **full artifact hash** is written `sha256:<64 hex>` and identifies the exact
  bytes of a file (a representation, a document).
- A **short id hash** is the first **12 hex characters** of the SHA-256 digest of
  a type-specific **key string** (below). Twelve hex = 48 bits; collision risk is
  negligible at corpus scale and the ids stay human-typeable. A validator detects
  the rare collision (`id_duplicate`) rather than trying to prevent it.

Key strings are always encoded as **UTF-8** before hashing. Where a key includes
JSON, that JSON is serialized with the canonical scheme below so the bytes are
identical everywhere.

## Canonical JSON (JCS, RFC 8785)

Any JSON that enters an id key or an `input_digest` is serialized with **JSON
Canonicalization Scheme (RFC 8785)**:

1. **Objects**: members sorted by key. Keys are compared as sequences of UTF-16
   code units, ascending (the ECMAScript string-comparison order).
2. **No insignificant whitespace**: no spaces or newlines between tokens.
3. **Strings**: minimally escaped per RFC 8785 — escape only `"` (`\"`), `\`
   (`\\`), and the C0 controls (`\b`, `\t`, `\n`, `\f`, `\r`, and `\u00xx` for the
   rest); all other characters, including non-ASCII, are emitted literally as
   UTF-8.
4. **Numbers**: the shortest round-tripping form (ECMAScript `Number` →
   shortest decimal). UPC id keys avoid floats; integers serialize as their plain
   decimal digits with no leading zeros, no `+`, no exponent.
5. **Arrays**: element order preserved.

Because locators and digest manifests use only strings, integers, and nested
objects/arrays, JCS over UPC data reduces to "sort object keys, emit compact,
escape minimally." The reference `jcs()` ships with the RFC 8785 test vectors.

## Canonical identifiers

Every object has a canonical id of the form `<prefix>-<12hex>`. Unless noted, the
id is `prefix + first 12 hex of sha256(UTF-8 key)`:

| Object | Prefix | Key (before `sha256(...).slice(0,12)`) |
|---|---|---|
| Corpus | `cor-` | a corpus-creation nonce (opaque; format-checked only) |
| Source | `src-` | `"src\n" + canonical_url`, or `"src\nsha256:" + <64hex of primary original bytes>` when there is no URL |
| Representation | `rep-` | *(no key string)* first 12 hex of the file's byte sha256 |
| Image (representation subtype) | `img-` | *(no key string)* first 12 hex of the image file's byte sha256 |
| Extraction | `ext-` | `"ext\n" + source_id + "\n" + representation_ref + "\n" + JCS(locator) + "\n" + Q` |
| Generation | `gen-` | `"gen\n" + type + "\n" + JCS(sorted_input_ids) + "\n" + input_digest` |
| Synthesis | `syn-` | `"syn\n" + type + "\n" + question + "\n" + JCS(sorted_input_ids)` |
| Activity event | `evt-` | sequential per journal (`evt-000001`); a content hash is also permitted |

Definitions used above:

- **`Q`** (the extraction's text component) is the extraction's exact
  `direct_quote` if present, otherwise its `text`. It is the raw string, not
  re-normalized. `secondary_locators`, `context_*`, `query`, and confidence are
  **excluded** from identity, so adding context or re-running the same extraction
  yields the same id.
- **`JCS(locator)`** is the canonical serialization of the primary `locator`
  object (`{type, representation_ref, value}`), so `{"start":247,"end":306}`
  hashes identically regardless of member order or spacing in the source file.
- **`sorted_input_ids`** is the array of all `derived_from` ids (sources +
  representations + extractions + generations + syntheses as applicable), sorted
  as strings by UTF-16 code unit, then JCS-serialized.
- **`input_digest`** is the digest defined in §07 (single input = that input's
  byte sha256 with the `sha256:` prefix; multi-input = the JCS manifest hash).

Because ids are content-addressed by these exact recipes, **the same source
captured by two tools gets the same `src-` id**, and **two tools that extract the
identical span from the identical representation produce the same `ext-` id** —
which is what makes corpora dedup and merge automatically. A validator MUST
recompute every content-addressed id from the object and flag any mismatch
(`id_mismatch`), which is exactly what prevents hand-typed placeholder ids from
ever passing.

For the `src-` recompute specifically: a URL source's canonical URL is normally
derived from `retrieval.original_url` (the requested URL is the stable identity);
a document source's key is a representation's bytes. Because a tool MAY have
chosen the final URL or a particular primary representation, a validator accepts
an `src-` id that reproduces from **any** of the source's declared URL fields
(`original_url`, `final_url`, or `bibliographic.url`, each normalized) **or** from
**any** of its representations' byte hashes; it flags `id_mismatch` only when the
id matches none of them (which a fabricated placeholder never will). `rep-`,
`img-`, and `ext-` recomputes are exact.

### URL normalization (for `src-`)

When a source has a URL, its `src-` id is derived from the **canonical URL**
produced by this closed, ordered algorithm. It depends only on the URL string —
never on page content:

1. **Parse** per the WHATWG URL standard. A URL that does not parse is not a URL
   source; hash by content instead.
2. **Scheme & host lowercase.** Lowercase the scheme and host. Encode an
   internationalized host to ASCII (punycode), lowercased.
3. **Drop default port** (`:80` for `http`, `:443` for `https`).
4. **Percent-encoding normalization** (RFC 3986 §6.2.2): uppercase the hex digits
   of every `%XX`, and decode any `%XX` that encodes an unreserved character
   (`A–Z a–z 0–9 - . _ ~`).
5. **Drop the fragment** (`#…`).
6. **Trailing slash**: remove a single trailing `/` from a non-root path (leave
   `https://host/` as-is).
7. **Remove tracking query parameters** — exactly this closed set, matched
   case-insensitively by key: every key with prefix `utm_`, plus `gclid`,
   `fbclid`, `msclkid`, `twclid`, `igshid`, `mc_cid`, `mc_eid`, `wbraid`,
   `gbraid`. (Generic keys such as `ref` are **not** stripped — they are
   load-bearing on many sites.)
8. **Sort remaining query parameters** by (key, value) bytewise ascending,
   preserving duplicates; re-encode as `k=v&…`. If no parameters remain, drop the
   `?`.

The result is the `canonical_url` used for identity. Note this is computed from
the fetched URL only; a page's advertised `rel=canonical` / `og:url` is recorded
in `retrieval.canonical_url` as metadata (§02) but never feeds identity, so a page
cannot dictate its own corpus id.

## Aliases (`aliases`)

Every object MAY carry an `aliases` object mapping a **tool namespace** to that
tool's local id:

```json
"aliases": { "researchassistant": "000123", "pi-forge": "src-a1b2c3d4e5f6" }
```

- A tool MUST preserve aliases it does not own when rewriting an object.
- A tool MAY add or update its own namespace.
- Aliases are non-canonical: cross-references between objects use the canonical
  id, never an alias. A citation manager's sequential `000123` and a research
  tool's per-run ids live here, so neither tool gives up its internal identity
  while the corpus identity stays the content hash.

## Directory names vs identity

The on-disk source directory is named with a **human-readable slug** for
browsability, not the id:

```
sources/suits-2005-the-grasshopper/
```

- The slug SHOULD follow the bibliographic `Author - Date - Title` convention,
  slugified by the algorithm below, with `n-d` for undated works.
- The directory name is a convenience, **not** an identifier. `source.json`
  carries the canonical `source_id`, and `corpus.json.sections` / `sources.csv`
  map id ↔ path. A tool MUST locate a source by id through the manifest, never by
  parsing the folder name.

A tool MAY instead name directories by id (`sources/src-a1b2c3d4e5f6/`) if it does
not need human-browsable folders; conformance does not require slugs, only that
the manifest resolves ids to paths.

### Slug algorithm

To produce a slug from a string (deterministic, portable, collision-safe):

1. **Compose the basis** `"<author> <year> <title>"` (year `n-d` when undated;
   omit an absent author).
2. **NFKD-normalize**, then **remove combining marks** (Unicode category `Mn`),
   folding accented Latin to ASCII (`café → cafe`).
3. **Lowercase.**
4. Replace every run of characters outside `[a-z0-9]` with a single `-`.
5. Trim leading/trailing `-`.
6. **Cap at 60 characters**, trimming any trailing `-` left by the cut.
7. If the result is empty, use `untitled`.
8. **Collision / reserved-name suffix.** If the slug (compared
   case-insensitively) already names another source in the corpus, or equals a
   Windows reserved name (`con`, `prn`, `aux`, `nul`, `com1`–`com9`,
   `lpt1`–`lpt9`), append `--<first 6 hex of source_id's hash>`; if that still
   collides, use the first 12 hex.

The slug is never used for resolution, so a tool that cannot reproduce it exactly
still interoperates — but a tool that follows this algorithm produces stable,
portable directory names (see §10 for the full filename-portability rules).

## Stability rules

- A source's `src-` id is stable as long as its canonical URL (or content, for
  documents) is stable. A changed URL is a *new source*; relate them with
  `aliases` or a `supersedes` link (§07).
- Representation `rep-`/`img-` ids change if the bytes change — that is correct; a
  re-render is a new representation, and its extractions are re-anchored (§03) or
  flagged, never silently repointed.
- An extraction's `ext-` id is a function of its source, representation, locator,
  and quoted text. Correcting any of those mints a *new* extraction; the old one
  is superseded (§03), never mutated in place, so no citation is left dangling.
- Per-run sequential ids MAY be used **internally** by a producing tool, but the
  corpus-level canonical ids MUST be the content-addressed forms above, carried in
  `aliases` alongside the tool's local id.
