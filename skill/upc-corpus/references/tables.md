# Coding spreadsheets (`scripts/tables.py`)

A general route for coding **tables** (CSV, TSV, JSONL, Excel) against a codebook, one
unit at a time, with every piece of evidence tied to exact characters of a cell. Built
2026-09-21; first test case: a forum's moderation records (32,920 posts in 8 tables)
with a field codebook. Nothing in it is specific to that dataset: forum dumps, survey
answers, interview turns and policy clauses all fit.

## The ideas that matter

- **A run folder, not the data folder.** `init` copies every input into
  `<run>/inputs/` (with `SHA256SUMS`). Later commands read only the copies, refuse to go
  on if a copy changed, and report when an original changed since (`status`,
  "inputs changed at their source"). Nothing is written into an input's folder, the
  codebook's folder, or any `--readonly` folder (the path guard raises).
- **The model proposes, the script checks, a person approves.**
  - `init --describe` asks the model to label column roles, and the script checks the labels against measured facts.
  - `units --draft` writes a first `units.json`, which a person or the agent edits.
  - `units --check` renders every unit and reports.
  - `units --approve --by <name>` is required before any `--all` run.
- **Whitelist rendering.** A unit's text shows only the columns `units.json` names, so a
  blind part is blind by construction. For blind parts, `units --check` also runs a leak
  test: the own words of a hidden column (e.g. the moderator text of the actions that
  sanctioned a post) must not largely reappear in the rendered unit.
- **Evidence by sentence id.** Each cell is split into the author's own words and quote
  blocks (someone else's words). Own words become sentences with ids that say whose they
  are: `M1.3` (moderator), `S2.1` (sanctioned post 2), `E1.4` (earlier post), `L1.2`
  (later post), `R1.1` (rule statement), `U1.x` (a unit's text by default).
  - The output schema lets each evidence field cite only its allowed speakers, so a quote is exact by construction and never misattributed.
  - Quote blocks whose quoted row is in the case collapse to `‹quotes S1›`. Other quote blocks are shown as `‹quoted from X› … ‹end quote›` and cannot be cited.
- **Relevance routes; it does not delete.** Units the analysis must count (every action,
  when yearly shares matter) are coded in full. Screening is for big or uncovered tables,
  such as context posts or rules-thread discussion.

## Commands

```
python3 -u tables.py init     --run <dir> --input <folder|file> [--input …] --codebook <file> --question "<q>" [--readonly <dir>] [--describe]
python3 -u tables.py units    --run <dir> --draft | --check | --approve --by <name>
python3 -u tables.py code     --run <dir> --part <P> (--ids a,b | --sample N | --all) [--dry-run] [--plan] [--detach] [--recode-stale]
python3 -u tables.py repeat   --run <dir> --part <P> --repeat 10          # same answer twice? (self-consistency)
python3 -u tables.py screen   --run <dir> --screen <name> [--order embed] [--limit N] [--plan] [--detach]
python3 -u tables.py screen   --run <dir> --screen <name> --calibrate [--audit 300]
python3 -u tables.py screen   --run <dir> --screen <name> --sheet 100 | --ingest-sheet <csv> --coder <name>
python3 -u tables.py draft-parts --run <dir> --screen <name>
python3 -u tables.py export   --run <dir> [--xlsx]
python3 -u tables.py agree    --run <dir> --part <P> --fields F1,F2 [--also PART:FIELD] --n 25 [--review]
python3 -u tables.py agree    --run <dir> --ingest <sheet.csv> --coder <name>
python3 -u tables.py publish  --run <dir> --corpus <dir> [--parts P1,P2] [--limit N] [--pseudonymize] [--plan]
python3 -u tables.py markdown --run <dir> --part <P> --out <dir> [--min-relevance r]
python3 -u tables.py status   --run <dir>
```

Every command prints counts first, rewrites `<run>/README.md` and ends with `Next:`.
Long jobs take `--detach`; the log goes to `<run>/state/logs/`, and `status` shows it.
The model defaults to the config's chat server (`chat_url`); local servers are usually single-slot. Before
a coding or screening run, `code` and `screen` time a one-token answer and refuse (unless
`--force`) when the model is busy with another job.

## Codebooks

- **A field codebook:** `{version, fields: {NAME: {type, def, values}}, parts: {PART: {unit, fields}}}`.
  - Types: `single`, `multi`, `int`, `text`, `multi_with_quotes` (codes with evidence), `multi_with_polarity` (codes with a polarity and evidence).
  - `values` is either `{code: meaning}` or the name of a lookup table defined in `units.json`, such as `CORE_RULES`.
- **upc-corpus's list format:** also accepted. Each codebook becomes a field, and all fields form one part named `main`.
- The codebook file is never edited. `draft-parts` writes proposals to `<run>/drafts/`.

## units.json (one entry per codebook part)

| key | meaning |
|---|---|
| `table`, `id` | the base table (or a list of tables, union by id; a later table wins) and its id column |
| `where` | conditions: `{"column": c, "in"/"not_in": {"table": t, "column": k} or {"values": [...]}}`, `{"column": c, "not_empty": true}`, `{"column": c, "equals": v}` |
| `screened` | `{"screen": name, "part": P, "min_relevance": 2}`: only rows a screen routed to this part |
| `segment` | `{"by": "line"/"paragraph", "min_chars", "neighbors", "keep_heading": regex, "include_quotes"}`: units are lines of a cell (`<row>-001` …). Headings are context. Quoted lines are skipped unless `include_quotes` |
| `code` | letter for the unit's own sentences (M, S, R, …) |
| `header`, `header_lists` | metadata lines (columns of the row; values reached through a link path) |
| `text` | `{"column", "label", "speaker", "date"}`: the text being coded |
| `related` | linked rows: `{"label", "code", "id", "text", "speaker", "path": [{"from": "t.c", "to": "u.k", "list"?, "transform"?}], "include_codes": PART, "max", "empty_note"}` |
| `context` | neighbours in a group: `{"table", "id", "text", "speaker", "group", "order", "before", "after", "anchor_path", "exclude", "require_text", "adjacent": {"column", "max_gap"}}` |
| `blind`, `leak_check` | blind part; hidden texts reached by a path that must not reappear |
| `evidence` | `{FIELD: [speaker codes]}`: which sentences each field may cite |
| `int_ranges`, `text_max`, `polarity` | per-field limits (ints otherwise parsed from the definition) |
| `date_checks` | `{"name", "field", "lookup", "unit_date"}`: flag lookup codes whose date is after the unit's date (e.g. R_predates_policy) |
| `strata` | `[{"column", "transform": "year"/"first"}]` for `--sample` |
| `export` | `{"id_column", "id_prefix", "columns", "joined_name"}`: export naming, e.g. to match `find_examples.py` |
| `instructions` | part-specific text for the (cached) system prompt |

Top-level keys:
- `question`
- `quote_blocks`: `{"style": "xenforo"/"markdown"/"email", "sources_column"}`
- `lookups`: `{NAME: {"table", "code", "label", "definition", "date", "add_by_part"}}`
- `screens`, described below
- `data_checks`: named conditions whose matching units are listed in `data_issues.csv`

Linked rows and context are checked by `units --check`, which reports:
- units per part and how many have their own text;
- how many have context;
- how many show more than one related row;
- blind-leak candidates and forced-choice fields (single fields without `unclear` / `not_applicable` / `none`);
- an example rendering per part in `UNITS.md`.

`code --dry-run --ids <id>` prints the exact system prompt, user text and schema keys.

## Outputs

- **`coded/<part>.<coder>.jsonl`:** one record per unit. It holds:
  - the field values;
  - the evidence, as sentence ids mapped to table, row, column, start, end, speaker and text;
  - `_invalid`;
  - the hashes of the case, prompt, codebook and spec;
  - the model, tokens, seconds and finish reason.
- **Coder handles** include the codebook version and a prompt hash, so any change to what the model sees starts a new coder. Old codings are kept, and `upc code` cannot retract multi-label codes.
- **`exports/<part>_coded.csv`, `exports/<joined_name>.csv`, `exports/evidence.csv`** (plain UTF-8, no BOM):
  - multi values `;`-joined;
  - polarity as `code(polarity)`;
  - `<field>_evidence` as `code: «sentence» [id]`;
  - date checks; `J_review`; relevance.
  - With `--xlsx`, Excel copies with cells cut at 32,000 characters (the CSV keeps the full text).
- **`agree/`:**
  - Blind sheets and dossiers. B-type fields are shown on the post alone, before the full case.
  - `--ingest` writes `AGREEMENT.md`: agreement with a Wilson interval, Cohen's kappa and Krippendorff's alpha, weighted kappa for ints, and Jaccard for multi fields.
  - About 25 cases find unclear definitions; about 100 are needed for a reportable figure.
  - `--review` is the J-code adjudication sheet (model values shown; accept or change).

## Relevance screening (measured 2026-09-21 on the forum dataset)

- **What was compared,** on 3,115 actions: weak labels (400 topical, 305 housekeeping) plus the codebook's 8 anchor cases.

  | Method | Speed | Result |
  |---|---|---|
  | Embeddings (Qwen3-Embedding-4B) | 92 s for all | AUC 0.79 (0.86 with a housekeeping contrast query); the instruction prefix made no difference; anchors ranked 13, 129, 167, 286, 511, 681, 1,725 and 2,247 of 3,115, so a 50% cut loses 2 of 8 |
  | 4B model | 0.46 s per action | only 4 of 8 anchors at ≥ 2; recall 0.68 against the 27B |
  | 27B model | 1.35 s per action | 8 of 8 anchors = 3; 46 of 56 housekeeping = 0 |

  - The 27B reads at about 5,000 tokens/s and writes at 55–60 tokens/s, so its cost is the length of its answer.
- **Therefore:**
  - The 27B screens **sections**: rows grouped by a column (a thread) and ordered, packed whole into windows of about 8,000 characters with one row of overlap.
  - It lists only the relevant rows (`r` 1–3, parts, a 2–4 word label). Unlisted rows count as 0, and a cut-off window counts as failed, never as zeros.
  - Embeddings only order the queue (`--order embed`) and stratify the audit.
  - Measured on 6 real windows of 7–11 posts: 4.4 s per window, 26% of posts listed.
- **`--calibrate`** re-screens a sample one row at a time: two thirds zeros stratified by embedding similarity, one third listed rows. It reports the miss rate with a Wilson interval (weighted by stratum). `--sheet` gives a person a blind sheet for precision and recall.

`screens` in `units.json`:
```json
{"table": "posts", "id": "id", "text": "text", "speaker": "author", "date": "datetime",
 "group": "thread_id", "order": "datetime", "header": ["thread_title"], "where": [...],
 "window_chars": 8000, "row_chars": 1400, "overlap": 1, "parts": ["new"], "instructions": "…", "anchors": []}
```
`draft-parts --screen <name>` sends a sample of relevant rows no part covers (with their labels) to the 27B. It proposes up to 3 new parts, reusing existing fields where they fit, in `drafts/parts_draft_<name>.md`/`.json`, for the codebook's next version.

## Publishing into UPC

`publish` maps a run onto UPC, which has no table model:
- **Sources:** one source per unit, whose reading copy is the unit's rendered text (no ids, no model codes, UTF-8, LF). The unit id is on its first line, so identical posts never merge.
  - The post URL goes only in `bibliographic.url`. A URL as identity would lose its `#post-N` fragment and merge a whole thread.
  - Also: `aliases {namespace: unit id}`, `x-shows` relations to the sources of related units, and `ext`.
- **Codebooks:** one UPC codebook per non-text field. Codes are `[a-z0-9-]` tokens, ints become "0"…"5", and polarity becomes child codes `<code>-<polarity>` with `parent`.
- **Codings:**
  - Unit-level fields become source codings; J fields carry J_notes as the rationale.
  - Evidence sentences are anchored (`upc anchor`, one call per source, sets of 500), each with a `section` locator "`<table> <row> <column> <start>-<end>`" in the cell, and coded.
  - Text fields stay in the CSVs.
  - Human codings from `agree --ingest` use coder kind human.
- **`--pseudonymize`:** keyed-hash names (`User-xxxxxx`) replace speaker names in headers, quote attributions and mentions. The key stays in `<run>/state/`. Without it the site holds real usernames: keep it private.
- **Time:** every `upc` call reloads the corpus, so time a `--limit` first (see "Pilot numbers" below).

## literature-extraction

No change there. `markdown --part P --out <dir>` writes one `.md` per unit with a YAML header (title, author, date, posturl, source_type, unit_id, part, table, row) built from the same row as the body, reads each file back to check that, and runs `literature-extraction.py plan <dir> --json` as a black-box check.

## Pilot numbers (2026-09-21, a 27B model with thinking off, temperature 0, seed 7)

- **The run:** `init --describe` took 69 s for 8 tables (32,920 posts). `units --check` rendered all 6,377 units in about 5 s.

  | Part | Units | Seconds each | Output tokens | Invalid values |
  |---|---|---|---|---|
  | A (rule statements) | 44 | 4.4 | 267 | 0 |
  | B (blind posts) | 57 | 3.6 | 201 | 0 |
  | C (actions) | 68 | 8.1 | 520 | 0 |

  - Every C unit cited evidence.
  - v0.2-style prompts with typed quotes took about 11.6 s and 600–700 tokens per action.
  - Projected full run: B 2,890 × 3.6 s ≈ 2.9 h, C 3,115 × 8.1 s ≈ 7 h, A 372 × 4.4 s ≈ 0.5 h, so about 10.5 h.
- **Codebook anchors:** 13 of 18 expected C codes and 7 of 9 A codes were present.
  - One code was never used across the pilot, including on the codebook's own key case: a definition to sharpen, not a finding.
- **Same answer twice** (10 C units re-coded at temperature 0 with a fixed seed):
  - descriptive fields 10 of 10;
  - R_mapped_core, P_positioning, J_gap and J_confidence 9 of 10;
  - J_basis, J_inference_warrant and M_moves 8 of 10;
  - N_norms 7 of 10;
  - J_exemplar_for 6 of 10.
  - Judgement fields wobble even at temperature 0 (GPU arithmetic and prompt caching). Report this, and treat J codes as a queue for a person's review.
- **Publish:** 169 units went into a scratch UPC corpus in 18 s: 282 evidence sentences anchored (all of them) and 3,205 codings, and the corpus passed at L1 with 0 errors. The site was built in 5 s (442 pages).
- **Screening** (details in the run's `screen/RELEVANCE-<screen>.md`):

  | Screen | Rows | Windows | Time | Rated 3 / 2 / 1 | Relevant (≥ 2) |
  |---|---|---|---|---|---|
  | Rules threads | 1,254 | 76 | ~8 min | 205 / 232 / 42 | 437 (35%) |
  | Context posts, first 200 windows | 2,020 | 200 | 11.4 min (3.4 s per window) | 118 / 137 / 84 | 255 (12.6%) |

  - All 2,771 context windows would take about 2.6 h.

## Pitfalls

- **Code from the raw tables, not derived files.** In the pilot, a derived section file had an empty context column in all 2,939 rows; the run builds units from the raw tables instead.
- **Blind parts must not see a column that gives the answer away,** or anything after the target (in the pilot: whether a user was later banned, their role, the action taken, and a context list that included later posts). `units --check` runs a leak test; read its candidates in `data_issues.csv`.
- **A role column may be unreliable.** Prefer the links between tables.
- **Excel cells hold 32,767 characters;** posts reach 35,500. Use the CSVs for analysis.
- **Usernames are real.** Publish with `--pseudonymize` before anything leaves the machine.
