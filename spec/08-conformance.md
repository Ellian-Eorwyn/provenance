# UPC 08 — Conformance & Validation

Conformance is defined by the **numbered rule registry** below, not by any single
implementation. Each rule has a stable **error code**, a **severity** (error or
warning), the **level** at which it applies, and — for quotation rules — the
**gate hop** it enforces. The reference validator
(`skill/universal-provenance/scripts/upc.mjs validate`) implements exactly this
registry; where the code and this table disagree, the table governs.

The keywords MUST, MUST NOT, SHOULD, and MAY are used as in RFC 2119.

## Levels

Levels are **cumulative** and computed from **rules passed**, not from object
counts. A corpus satisfies level *L* iff every error-severity rule at *L* and all
lower levels passes. The reported `level` is the highest fully satisfied level;
`status` is `failed` if any error-severity rule fails at all, `passed` otherwise.

- **L0 — Readable.** The corpus opens, indexes, and browses; every file it claims
  exists, hashes correctly, and stays inside the corpus. A minimal capture agent
  emits L0.
- **L1 — Provenanced.** Evidence is traceable to exact locations, every
  content-addressed id checks out, every derived object is stamped, and **every
  active `direct_quote` passes the hop-B gate.** L1 is the level that guarantees
  *no unverified quotations in the corpus*; it is reachable by a one-source corpus
  with a single quoted extraction and no generations.
- **L2 — Synthesized.** Generations and syntheses exist and are fully
  back-linked, their rendered outputs are hashed, **every quotation in those
  outputs passes the hop-C gate**, and an activity journal records how the corpus
  was built.

## Rule registry

Severity: **E** = error (fails conformance at its level), **W** = warning
(advisory; an error only under `--strict` where noted). Hop: which quotation gate
(A/B/C) the rule enforces, where applicable. **Class** classifies what *kind* of
assurance a rule provides (see "Rule classes" below): **Mech** = mechanical
invariant (proved by exact computation), **Oblig** = producer obligation
(presence/shape is checked, not truth), **Advis** = advisory semantic (heuristic
or informational).

### L0 — Readable

| # | Rule | Code(s) | Sev | Hop | Class |
|---|---|---|---|---|---|
| 0.1 | `corpus.json` present, parses, validates, declares an understood `upc_spec_version` | `load_error`, `schema_invalid`, `spec_version_missing` | E | — | Mech |
| 0.2 | Every source is listed in the manifest and has a `source.json` that validates | `manifest_source_unlisted`, `missing_source_json`, `schema_invalid` | E | — | Oblig |
| 0.3 | Every declared path resolves **inside** the corpus root — no `..`, no absolute path, no symlink escape (realpath-checked) | `path_escape`, `symlink_escape` | E | — | Mech |
| 0.4 | Every source has ≥ 1 representation with a `role`, a resolvable `path`, a `media_type`, and a `sha256` | `missing_representation`, `missing_file` | E | — | Oblig |
| 0.5 | Every representation file's bytes hash to its recorded `sha256` | `rep_hash_mismatch` | E | **A** | Mech |
| 0.6 | Every declared path uses only portable filename characters (§10) | `filename_illegal` | E | — | Mech |
| 0.7 | Every JSONL file is well-formed; a torn final line is tolerated with a warning | `jsonl_invalid` (E), `jsonl_torn_tail` (W) | E/W | — | Mech |

### L1 — Provenanced

| # | Rule | Code(s) | Sev | Hop | Class |
|---|---|---|---|---|---|
| 1.1 | Every object id is well-formed, unique, and equals its recomputed content-addressed value (§06) | `id_format`, `id_duplicate`, `id_mismatch` | E | — | Mech |
| 1.2 | Every referenced `source_id` / `representation_ref` / `extraction_id` / `generation_id` / `synthesis_id` exists | `dangling_source`, `dangling_representation`, `dangling_extraction`, `dangling_generation`, `dangling_synthesis` | E | — | Mech |
| 1.3 | Each extraction's `locator.representation_ref` equals its `representation_ref` | `locator_rep_mismatch` | E | — | Mech |
| 1.4 | Each locator's `value` matches its type's shape and is in range (`0 ≤ start ≤ end ≤ len` for `char_range`) | `locator_range_invalid` | E | B | Mech |
| 1.5 | Every active extraction with a `direct_quote` has a `char_range` locator into a **textual** representation | `quote_locator_missing`, `quote_rep_not_text` | E | B | Mech |
| 1.6 | The representation decodes as strict UTF-8, and the codepoint span at the locator equals `direct_quote` exactly | `invalid_utf8`, `quote_gate_failed` | E | **B** | Mech |
| 1.7 | Non-active extractions (needs_review / superseded / retracted) are surfaced | `flagged_extraction` | W | B | Advis |
| 1.8 | Every derived object (representation, extraction, generation, synthesis) carries a `provenance` stamp with `produced_by` and `created_at` | `missing_provenance` | E | — | Oblig |
| 1.9 | Where bibliographic metadata is present, it is valid CSL-aligned JSON | `bibliographic_invalid` | E | — | Mech |

### L2 — Synthesized

| # | Rule | Code(s) | Sev | Hop | Class |
|---|---|---|---|---|---|
| 2.1 | Every generation and synthesis has a `derived_from` naming existing inputs and an `input_digest` | `missing_derived_from`, `missing_input_digest` | E | — | Oblig |
| 2.2 | Every synthesis claim's `evidence_ids`/`source_ids` exist, and a claim lists the source of each evidence it cites | `dangling_extraction`, `dangling_source`, `claim_missing_source` | E | — | Mech/Oblig |
| 2.3 | Every rendered `output.path` exists and its bytes hash to `output.sha256` | `missing_output`, `output_hash_mismatch` | E | — | Mech/Oblig |
| 2.4 | A synthesis output cites every claim/evidence/source id its claims depend on | `uncited_in_output` | E | — | Oblig |
| 2.5 | Every citation marker in an output resolves to a quotable, non-retracted extraction and its quoted text equals that extraction's `direct_quote` exactly | `output_quote_mismatch`, `output_cites_unknown_extraction`, `cited_extraction_not_quotable`, `cites_retracted` (E); `cites_superseded` (W) | E/W | **C** | Mech |
| 2.6 | No un-cited long quoted span in an output (≥ 20 codepoints, double-quoted, no adjacent marker) | `output_quote_uncited` | W (E under `--strict`) | C | Advis |
| 2.7 | An activity journal exists, its events validate, and it covers the generations and syntheses | `missing_journal`, `event_invalid` (E); `event_dangling_ref` (W) | E/W | — | Mech/Oblig |

### Advisory (any level; warnings, `--strict` promotes marked ones)

| Rule | Code | Class | Notes |
|---|---|---|---|
| Derived object is stale (input digest mismatch) | `stale_input` | Advis | normal in an active corpus |
| A CSV mirror disagrees with the objects | `csv_stale` | Advis | objects are truth; regenerate |
| `counts` / index disagrees with the objects | `counts_mismatch` | Advis | objects are truth |
| Unknown object member encountered | `unknown_field` | Advis | E under `--strict`; forward-compat otherwise |
| An alias namespace maps to a different canonical id elsewhere | `alias_collision` | Advis | — |
| An `x-` extension enum value is used | `x_extension` | Advis | reported so reviewers see non-standard vocabulary |
| `confidence` enum and `confidence_score` are inconsistent | `confidence_inconsistent` | Advis | e.g. `low` + `0.99` |
| A source `identifiers[].scheme` is unrecognized | `identifier_scheme_unknown` | Advis | non-`x-` value outside `vocab/identifier_scheme`; UPC never resolves external identifiers (§02, §06) |
| A source `relations[].target` is id-shaped but does not resolve | `relation_dangling` | Advis | only intra-corpus `src-`/`rep-`/… targets are checked; external identifiers / URLs are never checked (§02) |

## Rule classes

The **Class** column records what *kind* of assurance each rule provides. This
matters because "the validator passed" means different things for different rules,
and a consumer should not read a mechanical proof into a producer's assertion.

- **Mech — mechanical invariant.** A fact computed exactly from the stored bytes
  and objects: hashes match, ids recompute, references resolve, the codepoint
  span equals the quote, paths stay contained, JSON/JSONL/schema shape is valid.
  A `Mech` pass is a *proof* of the stated property. These are the "Yes" rows of
  the guarantee matrix (§11).
- **Oblig — producer obligation.** A structural requirement the producer must
  satisfy for the corpus to be well-formed provenance: a `provenance` stamp is
  present, a `derived_from`/`input_digest` is present, an output exists and cites
  its dependencies, a claim lists its evidence's source. The validator checks the
  obligation was met **in form** — it does **not** check that the asserted
  content is meaningful or true. A present provenance stamp is not a true one; a
  cited dependency is not a faithfully-used one.
- **Advis — advisory semantic.** A heuristic or informational signal that does
  not, by itself, make a corpus invalid at its level: staleness, CSV/counts
  drift, an uncited long quoted span, confidence/score inconsistency, `x-`
  vocabulary use, alias collisions. Some are promoted to errors under `--strict`.

Rows marked **Mech/Oblig** bundle codes of both kinds: e.g. rule 2.3's
`output_hash_mismatch` is mechanical while `missing_output` is an obligation.

No rule in this registry is a *semantic* guarantee. The validator does **not**
mechanically establish that a `text` paraphrase is faithful, that evidence is
relevant, that a claim is adequately supported, or that a synthesis's inference is
sound (§11). If a future model-assisted checker assesses such a property, its
verdict MUST be recorded as a distinct, advisory `model_assessed` observation —
never as a mechanical invariant and never as the quotation gate.

## Validator output

The validator prints a bounded JSON report and exits non-zero on any
error-severity finding:

```json
{
  "status": "failed",
  "corpus": "/path/to/corpus",
  "upc_spec_version": "1.4.0",
  "level": "L1",
  "counts": { "sources": 12, "representations": 34, "extractions": 88, "generations": 12, "syntheses": 1 },
  "errors": [
    { "code": "quote_gate_failed", "level": "L1", "hop": "B", "object": "ext-1a2b3c4d5e6f",
      "detail": "codepoints[195:241] != direct_quote", "hint": "quote occurs byte-exact at [195:242] — offset drift; run `upc reanchor ext-1a2b3c4d5e6f`" }
  ],
  "warnings": [
    { "code": "stale_input", "object": "gen-…", "detail": "input_digest mismatch" }
  ]
}
```

Every finding carries its registry `code`; a consumer can program against the
codes. `level` is the highest level fully satisfied (or the level at which the
first error occurred). `exit 0` iff `errors` is empty; `exit 1` on any error;
`exit 2` on a usage/setup error.

## Conformance fixtures

Because conformance is defined by this registry and not by the reference code, an
independent implementation can self-test against the fixtures in
`tests/conformance/`. Each fixture is a minimal corpus plus an `expected.json`
listing the exact codes that MUST fire (empty for a passing fixture). The suite
includes a passing corpus per level and a failing corpus per error code — quote
drift, hash drift, locator drift, an uncited output quote, a paraphrase cited as a
quote, an id mismatch, a torn JSONL tail, a symlink escape, a duplicate id — so
every rule has a positive and negative control. A tool that reproduces the
`expected.json` for every fixture implements the registry correctly, without
running this repository's validator.

A tool that writes a corpus SHOULD run `upc validate` before declaring the corpus
complete.
