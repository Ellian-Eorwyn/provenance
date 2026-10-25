---
name: upc-corpus
description: Build, code, rate and publish UPC research corpora with local models — PDFs, Markdown bundles or spreadsheets in; quote-checked passages, codings, evidence ratings, overviews and a browsable site out, an annotated list of the papers, or a dossier or a one-pager for an audience and a project. Use when turning a folder of papers into a corpus, coding or screening it, annotating each paper, answering a question from it, rating how strong its evidence is, writing overviews from it, or publishing it for a team.
version: 1.2.0
license: PolyForm-Noncommercial-1.0.0
---

# upc-corpus

Use this to turn a folder of PDFs (or a bundle of Markdown, or a set of **spreadsheets**)
into a UPC corpus where every claim is traceable, to rate how strong its evidence is, and to
build the site a colleague opens with no software. The `upc` CLI it drives is the sibling
skill, `../universal-provenance/`.

**The one idea worth holding on to:** the model *proposes* text, the tool *decides* whether
it exists. A quotation the model half-remembered fails to anchor and is reported, never
stored. That is why a small local model is safe here.

If something happens that no step covers, read the error, look at the file it names, and
work it out, or ask the person who owns the corpus.

## Conventions in this file

| Written as | Means |
|---|---|
| `<python>` | A Python 3.11+ with `requirements.txt` installed (a venv; never the system Python) |
| `<skill>` | This folder, as an absolute path (the folder holding this `SKILL.md`) |
| `upc <command>` | `node <skill>/../universal-provenance/scripts/upc.mjs <command>` |
| `<corpus>` | The corpus folder, as an absolute path |
| `<clone>` | A copy of the corpus that rating work happens in (Task 8) |
| `<staging>` | A folder for builds and drafts, outside the corpus |
| the owner | The person the corpus belongs to |

The scripts find the CLI themselves (`UPC_CLI` overrides). Every script takes `--plan`
(report, write nothing) where it would write, is resumable and idempotent (a re-run writes
nothing new), and prints its **counts first**. Read those; never re-count anything yourself.
Run the long ones in the background with `-u` (`<python> -u …`), or nothing is printed until
the end.

## Who decides

| Decision | Who | How |
|---|---|---|
| Codebook definitions | The owner (or the topic lead) | Draft them; the owner edits before any coding pass |
| A full coding pass, an overnight run | The owner | Only after the owner says so, for that corpus |
| `tables.py units --approve`, the agreement sheet, a new codebook version | The owner | `--by <owner>` only on their word |
| Replacing files already handed to people | The owner | Ask first: they may already have been sent |
| Putting a site online or replacing a hosted one | The owner | Only when the owner says to, each time |
| A home summary's wording | The owner | Write it with them; the page says a language model wrote it. Store it only on their OK (Task 11) |
| The Findings starting points and their names | The owner | Draft them from the team's own tasks (Task 12); the owner approves the names |
| The rubric, profiles, domain and Methods wording | The owner | Draft them; the owner approves before any full rating run |
| Each paper's design and profile | The owner (skims the table) | `appraise.py table`; a person should confirm each profile |
| Who codes the blind sheet | A person, or another model, before any model output exists | Never show the coder the model's ratings |
| A dossier profile's contents and its never-publish phrases | The owner | Draft from their notes, with `basis`; the owner reads it before any build |
| A dossier's words (entries, memo) | Their writer, named on every page | The owner reviews before it is shared |
| The annotation fields (`fields.json`) and a full annotation run | The owner | Draft the fields from the research questions; run past the pilot only on the owner's word (Task 16) |

Everything else (preflight, reports, `--plan` runs, building into staging, comparing) you
may run without asking.

## Task 0: Set up a machine and a corpus

1. Install (`README.md`, "Install"), then write the machine's config at
   `~/.config/upc-corpus/config.json` from `<skill>/config.example.json`: at least
   `chat_url`. `references/settings.md` explains every key.
2. For each corpus, write `<corpus>/.upc/upc-corpus/settings.json` when the defaults don't
   fit: its `namespace`, `coders`, `audience`, and for evidence ratings its `domain`
   (`references/settings.md`).
3. Run the preflight. It checks nine gates in a few seconds (interpreter, `upc` version,
   pdftotext, the three model servers, disk, the ingest config, the corpus) and prints the
   fix for each failure. A coding pass takes hours; never start one on a hope.
   ```
   <python> -u <skill>/scripts/preflight.py --corpus <corpus> --config <ingest config>.json
   ```
   - Expect `passed 9`. Leave out `--config` when there is no ingest config.
   - If it prints `Stop here`, fix what it names, then run it again.

The model servers are expected to answer **one request at a time**: the scripts send one
request per server at a time and never fan out across papers. Different servers (chat,
task, embeddings, or several chat servers in a `pool`) may run at once.

## Task 1: Where does a corpus stand?

1. Run:
   ```
   <python> -u <skill>/scripts/report.py --corpus <corpus>
   ```
   It prints sources, passages, codings per coder, overviews and agreement.
2. Validate it:
   ```
   upc validate <corpus>
   ```
   Read `status`, `level` and `errors`. Warnings are not failures.
   - If `errors` is not 0, report the first few `code`s. Nothing can be published until
     they are fixed.

## Task 2: Answer a research question from a corpus

1. One call:
   ```
   <python> -u <skill>/scripts/search.py --corpus <corpus> "<question>"
   ```
   It merges semantic and keyword hits and prints passages with source, year and
   position. If it says the index is missing, build it once (Task 3, step 9) or answer
   from keyword hits and say so.
2. At most **five** follow-ups, and only for passages whose exact wording you need, in one
   `batch` call (one `{"cmd":"quote","ext":"<ext-id>"}` line per passage on stdin):
   ```
   upc batch --corpus <corpus>
   ```
3. Quote only what `quote` prints, marker and all. Never retype a quotation from memory
   or from a search preview.
4. Write the answer to a file, then check it:
   ```
   upc verify-quotes <answer file> --corpus <corpus>
   ```
   Exit 0 means every quotation checks out. If not, replace the failing quotation with
   the `quote` output, or drop it.
5. **If you are about to repeat a call you have already made, stop and write the answer
   instead.**

## Task 3: Build a new corpus from PDFs

1. **Write the ingest config** as `<recipe folder>/ingest.json` (`references/jsonl-shapes.md`
   has the shape): `corpus` (a new folder), `manifest`, `pdf_dir`, `namespace`, and the
   column mapping. Use full paths.
2. **Preflight** (Task 0) with `--config`, then plan the ingest:
   ```
   <python> -u <skill>/scripts/ingest.py --config <recipe folder>/ingest.json --plan
   ```
   It reports rows, missing files and rows with no PDF. Read it, then run the same command
   without `--plan` (about 8 s per 60 papers).
   - Two rows resolving to one source is **not a bug**: identical bytes get one id, so one
     PDF was saved twice under different names and one of the two records is wrong. Report
     both row ids.
   - "no DOI printed in the text" on many rows is normal.
   - A PDF with a pdf-harvest record beside it (`<file>.acq.json`, whose sha256 is the
     PDF's) gets it as its source's `retrieval`: where and how it was fetched. Its URL then
     addresses the source. A record that describes other bytes is noted and not attached; a
     row already in the corpus keeps its id.
3. **Codebooks, with the owner.** Draft `<recipe folder>/codebooks.json` from the research
   questions (`references/codebook-authoring.md`), check it, and give it to the owner to
   edit:
   ```
   <python> -u <skill>/scripts/make_codebooks.py --corpus <corpus> --defs <recipe folder>/codebooks.json --plan
   ```
   It warns about codes too thin to code against. After the owner's edits, run it without
   `--plan`.
4. **Pilot on ten papers:**
   ```
   <python> -u <skill>/scripts/code_pass.py --corpus <corpus> --coder <ns>-<model>-v1 --limit 10
   ```
   About 50 s per paper on a 27B model. Read some passages yourself. The anchoring rate
   should be above about 90%; if it isn't, see Known failures.
5. **Full pass**, only when the owner says so: the same command without `--limit`, in the
   background (179 papers took 2 h 20).
6. **Screen whole papers** (relevance, kind of study; about 2 s each on a 9B model):
   ```
   <python> -u <skill>/scripts/screen.py --corpus <corpus> --coder <ns>-<model>-screen-v1 --context "<what the team is studying>"
   ```
   Put both coder names in the corpus settings (`coders`) and `--coder` can be left out.
7. **Overviews**, one per code, for every scheme worth reading:
   ```
   <python> -u <skill>/scripts/synthesize.py --corpus <corpus> --codebook <slug> --min-passages 10
   ```
8. **Home summary** (optional, with the owner): `home-summary.md` + `.json` in the recipe
   folder, checked and placed through the quotation gate. Read every passage you cite
   first.
   ```
   node <skill>/scripts/place_summary.mjs --corpus <corpus> --prose <recipe folder>/home-summary.md --spec <recipe folder>/home-summary.json --plan
   ```
   Expect `problems 0`, then run it without `--plan` (add `--replace` when a summary is
   already placed).
9. **Search index** (on the embeddings server; about 10 min per 180 papers):
   ```
   <python> -u <skill>/scripts/embed.py --corpus <corpus> build
   ```
10. **Page numbers**, so each quotation opens its PDF at the right page (about 1 s per
    paper):
    ```
    <python> -u <skill>/scripts/paginate.py --corpus <corpus>
    ```
11. **Publish** into a handover folder:
    ```
    <python> -u <skill>/scripts/publish.py --corpus <corpus> --out <handover folder> --name <Name> --matrix <codebook>:<codebook> --pdfs --zip --folder-site
    ```
    About 15 s. It refuses a corpus that doesn't validate. It writes `<Name>.html` (one
    self-contained file: this is what gets emailed), `<Name>-light.html`, `<Name>_files/`
    (the PDFs), `<Name>.zip` (the thing to send) and `<Name>-site/` (the folder version:
    better to host, useless to email). Tell the owner the paths, and once how the site
    browses: ticks inside one scheme widen the set, ticks across two schemes narrow it.
    A PDF over 25 MiB (`--max-pdf-mib`) is left out of both bundles and not linked; its
    paper's page says so, and they are listed in `<Name>-left-out.json`.
12. **Online:** only when the owner asks. The `<Name>-site/` folder is a static site; put
    it behind a password if it carries the PDFs.

A run is finished when `upc validate` passes with 0 errors, `report.py` prints the counts,
and re-running `code_pass.py` with `--plan` says `to code now 0`.

## Task 4: Rebuild a published site and check it against the hosted copy

Use this to show that a corpus's site can be rebuilt, or before replacing a hosted site
after a change. It builds into staging and changes nothing that is published.

1. Check the corpus (Task 1).
2. Confirm nothing is left to do. Each must say `to code now 0` / `to screen now 0` /
   `problems 0`:
   ```
   <python> -u <skill>/scripts/code_pass.py --corpus <corpus> --plan
   <python> -u <skill>/scripts/screen.py --corpus <corpus> --plan
   node <skill>/scripts/place_summary.mjs --corpus <corpus> --prose <recipe folder>/home-summary.md --spec <recipe folder>/home-summary.json --plan
   ```
   Add `--coder <name>` to the first two unless the corpus settings name the coders. If
   `to code now` is not 0, the corpus gained sources: that is Task 3, steps 4–10, and the
   owner's call.
3. Build into staging, with the same `--name` and `--matrix` as the hosted build:
   ```
   <python> -u <skill>/scripts/publish.py --corpus <corpus> --out <staging>/<name> --name <Name> --matrix <codebook>:<codebook> --pdfs --zip --folder-site
   ```
   That uses the current renderer. To rebuild exactly what was hosted, check out the
   standard at the version that built it (a git tag or worktree) and put
   `UPC_CLI="node <that checkout>/skill/universal-provenance/scripts/upc.mjs"` in front of
   the command.
4. Compare the folder site with the hosted copy, file by file:
   ```
   <python> -u <skill>/scripts/compare_site.py <staging>/<name>/<Name>-site <hosted folder>
   ```
   - `IDENTICAL`: the site rebuilds exactly; publishing would change nothing.
   - `DIFFERENT`: it lists each changed, new and gone file. Say what changed and why (a
     re-coding, new overviews, a newer renderer). If only `assets/site.js` or
     `assets/site.css` differ, the renderer changed.
   - To compare what the pages *say* rather than their bytes (every passage, code, count
     and sentence), add `--content`; `--approved <file>.json` lists differences the owner
     approved. Each difference is CHANGED, ADDED or approved.
5. Report the result. Replacing the hosted copy is a separate step, only when the owner
   says to.

## Task 5: A corpus from Markdown bundles

A bundle (`references/jsonl-shapes.md`, "A literature-extraction bundle") carries a reading
copy of each document, its catalog data, and optionally evidence items with each
quotation's exact characters. `import_bundle.py` puts it into a UPC corpus; Tasks 2–4 then
work as usual.

1. Plan the import, read it, then run it without `--plan`:
   ```
   <python> -u <skill>/scripts/import_bundle.py --bundle <bundle folder> --corpus <corpus> --plan
   ```

- Each document gets a **reading copy** (passages anchor in it, and the site shows it) and
  the original file.
- Each item whose quotation can be placed becomes a passage, its type a code in the
  `item-type` codebook. Items that can't be placed (under 12 characters, or occurring
  twice with no way to tell which) are listed in
  `<corpus>/.upc/upc-corpus/imports/<bundle>/not_imported.jsonl`.
- One **namespace** per corpus (default `literature`); pass the same one to
  `make_codebooks.py --namespace`.
- No PDFs: skip `paginate.py` and `--pdfs`.
- **Speed:** each document is one `upc anchor` call, which reloads the corpus (0.08 s at 12
  sources, 0.20 s at 500): 500 documents take about 2 minutes.

## Task 6: Code spreadsheets (`tables.py`)

For tables, not documents: the unit is a row (or a row with its linked rows, or one line of
a long cell), coded against a codebook one unit per model call. Every `units.json` key and
the measurements: `references/tables.md`. Every command prints counts and `Next:`, and keeps
`<run>/README.md` current.

```
<python> -u <skill>/scripts/tables.py init --run "<run folder>" --input <folder or file> --codebook <file> --question "<research question>" --describe
<python> -u <skill>/scripts/tables.py units --run "<run folder>" --draft
<python> -u <skill>/scripts/tables.py units --run "<run folder>" --check
<python> -u <skill>/scripts/tables.py code --run "<run folder>" --part <part> --dry-run --ids <id>
<python> -u <skill>/scripts/tables.py code --run "<run folder>" --part <part> --sample 60
<python> -u <skill>/scripts/tables.py agree --run "<run folder>" --part <part> --fields <field1,field2> --n 25
<python> -u <skill>/scripts/tables.py units --run "<run folder>" --approve --by <owner>
<python> -u <skill>/scripts/tables.py code --run "<run folder>" --part <part> --all --detach
<python> -u <skill>/scripts/tables.py screen --run "<run folder>" --screen <name> --detach
<python> -u <skill>/scripts/tables.py export --run "<run folder>" --xlsx
<python> -u <skill>/scripts/tables.py publish --run "<run folder>" --corpus <corpus> --pseudonymize
<python> -u <skill>/scripts/tables.py status --run "<run folder>"
```

In order: `init`, `units --draft` (then edit `units.json`), `units --check` (renders every
unit; read `UNITS.md`), a dry run, a pilot of 60, the agreement sheet, the owner's approval,
the full run, `screen` for big tables, then `export` and `publish`.

- The run folder keeps byte copies of the inputs and never writes into an input's folder
  or the codebook's.
- The model cites **sentence ids** (`M1.3`, `S2.1`); the script maps them to exact
  characters. Quotations come from `exports/evidence.csv`, never memory.
- **Relevance:** the model screens sections (~8,000 characters per call) and lists only
  relevant rows. Never drop rows by embedding score: on one forum corpus, embeddings put 2
  of the codebook's 8 anchor cases in the bottom half.
- **Blind parts see only whitelisted columns.** A column that reveals the outcome being
  coded (a sanction, a later status) would leak it; `units --check` runs a leak test, with
  candidates in `data_issues.csv`.

## Task 7: Spot-check the model's coding

1. Write a sheet of 20 passages per code with a blank `verdict` column:
   ```
   <python> -u <skill>/scripts/spotcheck.py --corpus <corpus> --per-code 20 --out <staging>/spotcheck.csv
   ```
2. A person fills in `verdict`: `agree`, `wrong-code`, `not-relevant` or `wrong-span`.
3. Turn it into codings under the checker's name, beside the model's:
   ```
   <python> -u <skill>/scripts/spotcheck.py --corpus <corpus> --ingest <staging>/spotcheck.csv --coder <checker>
   ```
4. `report.py` then prints per-code agreement; the site shows the disagreements. Nothing is
   overwritten.

## Task 8: Rate the evidence (papers, passages, statements)

This rates each paper (a grade), each passage (whose claim it is, and what backs it) and
each overview statement (does each cited passage support it; an IPCC-style confidence).
Ratings are **advisory and model-made**, and every page says so. The rubric is
`references/appraisal/rubric.md`, with `designs.json`, `profiles/` and `domains/` beside
it; the owner owns the wording. Name the team's setting in the corpus settings (`domain`)
so a statement can say when its evidence comes from elsewhere.

Work on a **clone** of the corpus, never the original: `cp -cR <corpus> <clone>` on APFS
(instant), else `cp -R`.

1. Write the windows the model and the blind coder read (the "In context" sentences,
   exactly as the site shows them):
   ```
   node <skill>/scripts/ctx_windows.mjs --corpus <clone> --out <clone>/.upc/upc-corpus/appraise/windows.json
   ```
2. Define the sets. A pilot names the overviews to check and the codes whose candidate
   passages a revision draws on; `all` is every paper:
   ```
   <python> -u <skill>/scripts/appraise.py plan --corpus <clone> --set pilot --syntheses <home id>,<overview id> --codes <slug>:<code>,<slug>:<code>
   <python> -u <skill>/scripts/appraise.py plan --corpus <clone> --set all
   ```
   Ids and codes are separated by commas, with no spaces. It prints papers, passages,
   statements and a time estimate.
3. **Before any model output exists**, write the blind sheet (15 papers, 40 passages,
   seeded), have it coded with only the rubric and profiles, and read it back:
   ```
   <python> -u <skill>/scripts/spotcheck.py --corpus <clone> --blind <staging>/blind
   <python> -u <skill>/scripts/spotcheck.py --corpus <clone> --blind-ingest <staging>/blind --coder <handle>
   ```
   For a person, that is all. When another model coded it, add
   `--coder-kind model --model <model id> --name "<how pages name it>"`: the record and the
   pages then say it is another model, not a person.
4. Run the pilot (each paper's three runs on one server, one paper per server at a time),
   check its statements, and have the design chosen for every paper so the owner can skim
   the table:
   ```
   <python> -u <skill>/scripts/appraise.py run --corpus <clone> --set pilot
   <python> -u <skill>/scripts/appraise.py statements --corpus <clone> --set pilot
   <python> -u <skill>/scripts/appraise.py run --corpus <clone> --set all --only design
   ```
   - Exit 3 means it reached `--stop-at` with work left: run the same command again.
   - A `relayed` line: one server's proxy is relaying to another server in the pool, so
     that worker stepped aside. Nothing to do.
5. Vote, report agreement, and write the design table:
   ```
   <python> -u <skill>/scripts/appraise.py vote --corpus <clone>
   <python> -u <skill>/scripts/appraise.py report --corpus <clone>
   <python> -u <skill>/scripts/appraise.py table --corpus <clone> --out <staging>/designs.md
   ```
   `report` prints run-to-run agreement (all three runs agree, Fleiss' κ, Gwet's AC1) and
   agreement with the blind coding (κ and AC1 with bootstrap 95% intervals). `LOW` marks a
   dimension under 80% run to run or κ under 0.4 against the blind coder: `store` keeps its
   chips but leaves it out of the site's filters.
6. Show the owner the rubric, the report and the table, and ask whether to run the rest.
   Only on their go, the full run. It waits for the machine's `overnight_window`, starts
   nothing new after its end, resumes where it stopped, and sends one notice (the config's
   `notify`) at the end or on a failure:
   ```
   <python> -u <skill>/scripts/appraise.py overnight --corpus <clone> --dry-run
   <python> -u <skill>/scripts/appraise.py overnight --corpus <clone>
   ```
   Its thirteen steps: ratings, statements of the existing overviews, quotations checked
   again, vote, the agreement report, store, page numbers for the rating quotations,
   citation tiers (Task 9), revised overviews (Task 10), their statements, vote, the report
   again, store. `--not-before ""` starts at once.
   - To grade the checklist with a thinking model and everything else without, prefix
     `APPRAISE_CRITERIA_MODEL=think APPRAISE_CRITERIA_EFFORT=medium`. Records go to their
     own folder, so every later `appraise.py`, `synthesize.py --v2` and `methods.py`
     command needs the same prefix.
7. `store` alone (the overnight run calls it) writes into the clone, and is safe to repeat:
   ```
   <python> -u <skill>/scripts/appraise.py store --corpus <clone> --blind --write
   ```
   Expect `corpus passed at L2, 0 errors`. `answers voided` counts the yes or partly
   answers whose quotation `upc anchor` couldn't confirm; each became "can't tell" and its
   paper's grade was recomputed. The new codebooks, quotation set and coders are named
   under the corpus's namespace (`--namespace` overrides).

## Task 9: Citation standing (OpenAlex, beside the grade)

Citations measure attention, not rigour; they are shown beside the evidence grade and
**never combined** with it. Every fetch goes through the ASR CLI.

1. Fetch (≤50 DOIs a call; about 1 min for 179 papers):
   ```
   <python> -u <skill>/scripts/citations.py fetch --corpus <clone>
   ```
2. Code the tiers (top 1%, top 10%, above or below the median of field and year; "too
   recent" under 24 months; "not indexed"):
   ```
   <python> -u <skill>/scripts/citations.py code --corpus <clone> --write
   ```
3. Check that every figure is found again in ASR's stored payload (`publish.py` runs this
   itself and refuses to build when it fails):
   ```
   <python> -u <skill>/scripts/citations.py check --corpus <clone>
   ```

## Task 10: Overviews revised from rated evidence

The rules are `references/criteria-v2.md` (criteria-v2.1, with claim groups). A revision is
a new synthesis that supersedes the old one; the site shows it at the old one's address,
labelled "Revised from rated evidence", with a link back to the original edition. Task 8's
vote must exist. Use the same `APPRAISE_*` prefix as the rating run, if it had one.

1. **Revise.** Plan, then run:
   ```
   <python> -u <skill>/scripts/synthesize.py --corpus <clone> --v2 --codes all --plan
   <python> -u <skill>/scripts/synthesize.py --corpus <clone> --v2 --codes all
   ```
   - Before writing each theme, `claim_groups.py` finds the passages from different papers
     that make the same claim. It asks the model three times and pools what it finds, and
     cuts a large group to its 6 strongest papers. The writer is asked for one statement
     per group, citing every paper in it. Groups are saved in
     `<clone>/.upc/upc-corpus/claim-groups/`.
   - Each overview is drafted, then checked sentence by sentence (a sentence that cites
     nothing, a single-paper claim not attributed, a relayed claim not marked "citing", too
     long). It is fixed once, and the version with fewer problems is kept. `PROBLEM` lines
     are what is left; each is recorded in the synthesis.
   - `--codes <slug>:<code>,…` revises only those themes. A theme already revised is
     skipped; `--redo` writes it again. `--no-groups` writes without claim groups.
   - `SKIP … no single current overview titled …`: the theme has no overview, or two. Look
     at the corpus's syntheses before going on.
2. **Check each revised statement** against the passages it cites, three runs per
   statement:
   ```
   <python> -u <skill>/scripts/appraise.py statements --corpus <clone> --set revised
   ```
   A statement whose text or passages changed since its last check is checked again; one
   that hasn't isn't.
3. **Vote, report and store** (Task 8, steps 5 and 7), then `paginate.py` (Task 3, step 10)
   so the new quotations get page numbers. `store` writes one support matrix per overview,
   "Support for each statement: <overview title>", and a `place` coding per paper.

**How a statement's support is worded** (rules in `appraise.py`, reasons in
`references/appraisal/rubric.md`):

- **Each study is one lead author.** Papers that share a first author (family name folded,
  so Gölz and Golz match) count once. `same_lead` flags a statement whose supporting papers
  all share one lead author: one voice repeated, however many papers it cites.
- **Plain words on the pages:**

  | IPCC confidence | Shown as |
  |---|---|
  | very high, high | Well supported |
  | medium | Some support |
  | low | Limited |
  | very low, not supported by its passages, runs disagreed, not checked | Weak or unclear |

  The IPCC term appears on hover and on the Methods page. Very high and high are merged
  because the line between them isn't stable from one check to the next.
- **The kind of statement**, by rule over the passage labels: *unsupported*, *framework*
  (only theory, background or relayed passages), *finding* (an own finding or
  interpretation backed by data or a case), *recommendation*, or *argument*. Whose-claim
  labels are the least stable (70% run to run in one library), so kinds are a guide.
- **Where it was studied:** the `place` scheme (us, europe, elsewhere, not-stated), coded
  by a rule (coder kind `rule`) from the countries the design vote agreed on. A statement's
  places come only from its independent supporting papers.
- **Flags:** `relayed_only` (only relayed passages support it) and `same_lead`.

To read an overview's support as plain text, print the newest support matrix for it:
```
ls -t $(grep -l "Support for each statement: <overview title>" <clone>/syntheses/*/synthesis.json) | head -1
```
The `synthesis.md` beside it lists each statement, its support, its lead authors and papers,
and each passage's verdict.

## Task 11: A home summary rewritten from the rated evidence

After Task 10, when the owner wants the home summary to say what the rated evidence
supports. You write it; the owner approves it before it is stored.

1. **Read first:** the revised overviews and their support (the `ls -t` command above), the
   old summary (`<clone>/syntheses/<old home id>/synthesis.md`), and every passage you will
   cite (`upc quote`).
2. **Write two files** in `<staging>/home-summary/`:
   - `synthesis.md`: the prose, in the old summary's sections, `[ext-…]` after each point,
     `[theme:<slug>/<code>]` and `[view:matrix]` links, and quotations copied from
     `upc quote` output only.
   - `synthesis.json`: `type` `answer`; `title` and `question` as the old summary has them;
     `claims` (`claim_id`, `text`, `evidence_ids`); `ext` `{"upc-site": {"placement":
     "home", "revision": {"label": "Revised from rated evidence", "date": "<YYYY-MM-DD>",
     "note": "<one line>"}}, "upc-corpus": {"criteria": "criteria-v2.1", "written_by":
     "<model>"}}`; and `provenance` `{"produced_by": {"tool": "<your tool>", "model":
     "<model>", "method": "model"}}`.

   The rules for claims, which the statement check enforces:
   - **A claim says only what its passages say.** Setting or framing ("in a nationwide
     simulation") goes in the prose; a claim that adds it checks lower.
   - **One claim per statement.** A sentence whose halves rest on different passages gets
     "partly" from each and scores low. Split it.
   - Where several papers agree, cite them all and say where they studied. Where a point
     rests on one study, name the study.
3. **Check it in a throwaway copy** before showing anyone:
   ```
   cp -R <clone> <staging>/hometry
   upc add synthesis --corpus <staging>/hometry --output <staging>/home-summary/synthesis.md --tool <your tool> --supersedes <old home id> < <staging>/home-summary/synthesis.json
   ```
   Then run Task 10, steps 2 and 3, on the copy, and read the summary's support. Reword any
   very low claim and anything "runs disagreed", then repeat. `upc add synthesis` refuses a
   misquotation; fix it from `upc quote`, never by hand.
4. **Show the owner** the draft and its support next to the old summary's. Store it only on
   their OK: back up `<clone>/syntheses/<old home id>/synthesis.json`, then run the same
   `add synthesis` against `<clone>`. It prints the new `syn-…` id; after an edit, the same
   command updates that synthesis in place.
5. Check, vote and store in the clone (Task 10, steps 2 and 3).

## Task 12: Publish an updated edition (Findings, evidence map, Methods)

This builds what a team reads: the Findings page (every checked statement, searchable, with
filters), the evidence map (one row per theme), a Key findings box on each overview, and a
Methods page. The renderer is generic; the corpus supplies its own words.

1. **The findings settings**, with the owner: `<clone>/.upc/upc-corpus/site/findings.json`.
   - `starting_points`: each is `{id, label, task, note, match}`. `match` takes `groups`
     (codebook slugs), `themes` (`slug/code`), `kinds`, `places` and `support` (`well`,
     `some`, `limited`, `weak`). Lists are ORed within one key and ANDed across keys.
   - `words.one_study`: the heading over single-study statements in Key findings.
   - `words.map_note`: one line above the evidence map.
   - `map_place`: the place given its own column on the map (for example `us`).
   Without the file the pages still build, with no starting points.
2. **Methods page** (it stops if any number is missing):
   ```
   <python> -u <skill>/scripts/methods.py --corpus <clone> --original <original edition URL> --out <staging>/methods.md
   ```
   Its words are `references/methods.template.md`; a corpus can keep its own at
   `<clone>/.upc/upc-corpus/site/methods.template.md`. Fill in or delete every `[bracketed]`
   instruction before publishing.
3. **Build into staging:**
   ```
   <python> -u <skill>/scripts/publish.py --corpus <clone> --out <staging>/build --name <Name> --matrix <codebook>:<codebook> --pdfs --folder-site --about <staging>/methods.md --original-edition <original edition URL>
   ```
   Expect `passed at L2, 0 errors`. With support matrices, the navigation reads Home,
   Findings, Evidence map, Overviews, Codes, Sources, Passages, Matrix, Methods.
4. **Compare with the edition it replaces.** Only overview and home texts, and the
   navigation, may be CHANGED; everything else must be ADDED:
   ```
   <python> -u <skill>/scripts/compare_site.py --content <previous build>/<Name>-site <staging>/build/<Name>-site --json <staging>/compare.json
   ```
   If anything else is CHANGED, find out why before going on.
5. **Look at it**: desktop and phone width, light and dark, a passage's "In context", the
   Findings filters and the map, and the single files opened from disk.
6. **Online, only on the owner's go**, each time.

## Task 13: A dossier for an audience and a project

A dossier tells one group what a set of documents says that matters to their project: one
folder per document (why it is in the file, a summary, notes per lens, key points with their
passages, numbers, dates, who's who, terms, exhibits), a cover memo across them, and the
same as a Word file and a spreadsheet. The shapes and checks are in `references/dossier.md`.

1. **Profiles**, once per group and project (reuse them after that). Copy
   `references/profiles/examples/*.example.yaml`, fill them in from the owner's notes, and
   record where each line came from under `basis`. Readers get work roles only. Put personal
   matters in `never_publish` as whole phrases. Check both (expect no output):
   ```
   <python> -c "import sys; sys.path.insert(0, '<skill>/scripts'); import dossier as D; D.load_profile('<audience.yaml>', 'audience'); D.load_profile('<project.yaml>', 'project')"
   ```
   The owner reads both before they are used.
2. **The documents in a corpus**, through Task 3 (PDFs) or `add_acquired.py` (fetched
   material with its retrieval record). If a person sent the list, add their note too, as a
   source: its lines become each document's "why it is in the file".
3. **The config:**
   ```
   <python> <skill>/scripts/dossier.py init --corpus <corpus> --audience <audience.yaml> --project <project.yaml> --title "<title>" --subtitle "<one line>" --prepared-by "<name>" --request-source <note's source_id> --request-quote "<its opening sentence>" --request-by "<who suggested them>" --request-date <YYYY-MM-DD>
   ```
   Expect a `Dossier: config` table. `--order <id,id,…>` fixes the documents' order;
   otherwise the most relevant come first. `--sections <sections.json>` (a JSON list of
   `{slug, title, description}`) groups the documents; each entry then names its `section`.
4. **One entry per document.** Either a writer drafts `entry.json` (shape in
   `references/dossier.md`) after reading the whole document, then:
   ```
   <python> <skill>/scripts/dossier.py add --corpus <corpus> --from <entry.json> --writer "<name>" [--model <model>] --plan
   ```
   The plan lists every `NOT FOUND` quotation. Fix each from the document, then run it again
   without `--plan`. Or the configured model drafts them all:
   ```
   <python> -u <skill>/scripts/dossier.py write --corpus <corpus> --plan
   ```
   Then run the same command without `--plan`. A model reads only the first `--max-chars`
   characters (default 48,000), and the page says so.
5. **Page numbers** for quotations from PDFs: `<python> <skill>/scripts/paginate.py --corpus <corpus>`.
6. **The memo:** `brief.json` (the shape is in `references/dossier.md`), then
   `dossier.py brief --corpus <corpus> --from <brief.json> --writer "<name>"`. A theme
   whose quotation is not found is left out, and the command says so.
7. **Check:** `<python> <skill>/scripts/dossier.py check --corpus <corpus>`. Expect
   `corpus errors 0` and `quotations NOT found 0`.
8. **Build into staging:**
   ```
   <python> <skill>/scripts/dossier.py build --corpus <corpus> --out <staging>/<name> --copies
   ```
   `--copies` offers each PDF up to 25 MiB for download: use it only where the documents
   may be shared with these readers. The build needs `pandoc` for the Word file and
   `pdftoppm` for pictures. `--no-docx` and `--no-images` skip them.
9. **Look at it:** the cover, two document pages, the timeline, at desktop and phone width,
   in light and dark. Open the Word file and the spreadsheet.
10. **Online, only on the owner's go**, each time. Behind a password if it carries copies of
    papers.

## Task 14: A one-pager for an audience

A one-pager is one printable page for one reader (a CEO, a plant manager, state staff), from
the same two profiles as a dossier: a headline in their terms, up to three numbers, how it
works, where it stands and the ask. Every number on it is a **figure** whose passage is in the
corpus, judged for that reader, checked by a person and found again at every build. The build
also writes the **figures note**: every number, its passage, who checked it and what is open.
The shapes and checks are in `references/one-pager.md`.

**Who decides:** the model may propose relevance and a class (`code`) and draft the words
(`write`). The owner sets relevance and class (`review --apply`). Only the named reviewer
records a check, and only the person who may release a result records a clearance
(`signoff`), each from their own reply saved as a source. A page leaves the team only on the
owner's go.

1. **Profiles** (Task 13, step 1), with the one-pager fields: for the audience, what they
   decide, their objections, the numbers they think in and those to keep off their page, the
   `one_pager` block (layout, ask, distribution); for the project, the brand, real images,
   reviewers and `allow_numbers`.
2. **The page's config:**
   ```
   <python> <skill>/scripts/onepager.py init --corpus <corpus> --slug <slug> --audience <audience.yaml> --project <project.yaml> --title "<title>" --show-writer-as "<writer>=<label>"
   ```
   Expect a `One-pager: config` table. One slug per page; the codebooks are made here.
3. **Figures.** Write `figures.json` (shape in `references/one-pager.md`): each figure's
   value, the passage that states it, copied from the saved text, and the forms the page may
   print. A value read off a chart is anchored in a readings table saved as its own source.
   ```
   <python> <skill>/scripts/onepager.py figures add --corpus <corpus> --from <figures.json> --by "<who>" --plan
   ```
   Fix every `NOT FOUND`, then run it without `--plan`. `figures import --from-dossier` adds a
   dossier's figures from the same corpus.
4. **Relevance and class.** The model's first pass:
   `<python> -u <skill>/scripts/onepager.py code --corpus <corpus> --slug <slug>`. Then the
   owner's sheet:
   ```
   <python> <skill>/scripts/onepager.py review --corpus <corpus> --slug <slug> --out <sheet.xlsx>
   <python> <skill>/scripts/onepager.py review --corpus <corpus> --slug <slug> --apply <sheet.xlsx> --coder <owner's handle>
   ```
   The owner edits only the class and relevance columns.
5. **Checks and clearances**, as replies arrive. Save each reply's text as a `.md` file and add
   it as a source (it prints the `source_id` to cite), then record what it says:
   ```
   <python> <skill>/scripts/onepager.py reply --corpus <corpus> --from <reply.md> --by <reviewer's handle> --title "<who, about what>" --date <YYYY-MM-DD>
   <python> <skill>/scripts/onepager.py signoff --corpus <corpus> --figure <id> --figure <id> --by <reviewer's handle> --check confirmed --ref <reply's source_id>
   <python> <skill>/scripts/onepager.py signoff --corpus <corpus> --figure <id> --by <handle> --clearance cleared --note "<what it covers>"
   ```
6. **The words.** Either a writer drafts `page.json` and runs
   `onepager.py add --corpus <corpus> --slug <slug> --from <page.json> --writer "<name>" --plan`,
   then without `--plan`; or the model drafts it:
   `<python> -u <skill>/scripts/onepager.py write --corpus <corpus> --slug <slug>`. Expect a
   `Page` table; each `OPEN` line is a figure not yet fit for a final page.
7. **Check:** `<python> <skill>/scripts/onepager.py check --corpus <corpus> --slug <slug> --draft`.
8. **Build into staging:**
   ```
   <python> <skill>/scripts/onepager.py build --corpus <corpus> --slug <slug> --out <staging>/<slug> --draft --playwright-dir <a folder with node_modules/playwright>
   ```
   Drop `--draft` only when every figure is confirmed (and, for a partner or public page,
   cleared). Needs `node` and an installed Playwright for the PDF (`--no-pdf` skips it) and
   `pandoc` for the Word note (`--no-docx`).
9. **Look at it:** the PDF, the page at phone width, and the figures note. The note's
   questions go to the engineers.
10. **Out of the team, only on the owner's go**, each time.

## Task 15: Interviews from recordings

Interviews someone records (on Zoom, a phone, a recorder) become a site where a reader picks a
question and reads and hears every answer to it: who answered, a brief, the key words verbatim
with ▶, ▶ for the whole answer, and who wasn't asked. Formats, settings and what is automatic
are in `references/interviews.md`.

**Who decides:** the owner writes the guide and the glossary, and says what is left out of a
recording (times only, in the intake's `left_out`). Transcription, clean-up and coding are
automatic. The briefs and highlights are the model's choices, and the site labels them so.
Quotations are verbatim to the cleaned transcript. A person's recode (`upc code --coder-kind
human`) stands beside the model's.

1. **Settings, guide, glossary** (once):
   - Write `<corpus>/.upc/upc-corpus/settings.json` with an `interviews` block, plus
     `guide.yaml` and `glossary.yaml` (shapes in the reference).
   - Then make the codebooks:
     ```
     <python> <skill>/scripts/make_codebooks.py --corpus <corpus> --guide <corpus>/guide.yaml --namespace <ns>
     ```
     Expect two codebooks, `questions` and `summary`.
2. **One interview by hand** (the first, to see each step):
   ```
   <python> <skill>/scripts/transcribe.py all "<interview folder>" --corpus <corpus>
   <python> <skill>/scripts/interview_pass.py --corpus <corpus>
   node <upc> export <corpus> --format site -o <corpus>/site
   ```
   - Expect, in order:
     - `prepared <slug>: …`;
     - `primary: …` and `second: …`;
     - `cleaned: …` (glossary fixes and the stretches settled or refused);
     - `speakers: …` (how each was named);
     - `saved <slug> revision 1: src-…`;
     - one line per interview: answers to which questions, highlights, names, referrals.
   - A `Speaker N` means a voice wasn't placed: name it in the intake and run `transcribe.py
     clean` and `save` again.
3. **The drop folder** (every later interview): a cron job, every 15 minutes:
   ```
   <python> <skill>/scripts/interview_drop.py --corpus <corpus>
   ```
   - It prints one message per interview that became ready, and nothing otherwise.
   - `status` lists each folder. `retry [FOLDER]` tries a failed one again.
4. **A new code** (a theme): `make_codebooks.py --defs`, then `code_pass.py`, or a person's
   `upc code`. Rebuild the site.
5. **Choosing an engine**: `transcribe.py bench` on a corrected stretch (reference, "Checking
   an engine"). Change `transcribe.second` in the machine config only on that evidence.

## Task 16: Annotate each paper, then list them all (Word, spreadsheet)

An annotation is a few fields per paper, written by the model from the paper's opening and
the passages already coded in it: codes from one of the corpus's codebooks with a one-line
note, or a sentence or two, each listing the passages it rests on. The list is one row per
paper (citation, DOI, its page on the site, its codes, its annotation) as a spreadsheet and
a Word file. Run the coding pass first (Task 3, steps 4 and 5): a paper with no coded
passages is annotated from its opening alone, and the plan counts them.

1. **The fields, with the owner.** Write `<recipe folder>/fields.json`:
   ```
   [{"key": "setting", "label": "Setting", "kind": "code", "scheme": "<codebook slug>", "max_words": 25},
    {"key": "findings", "label": "What it found", "kind": "text", "max_words": 60, "guide": "<what the field means>"}]
   ```
   `key` is a lower-case slug. A `code` field's `scheme` is a codebook slug in the corpus;
   a single-label codebook gives one code, a multi-label one several. `guide` says what the
   field means. The owner approves the fields before any full run.
2. **Plan:**
   ```
   <python> -u <skill>/scripts/annotate.py --corpus <corpus> --fields <recipe folder>/fields.json --coder <ns>-annotate-<model>-v1 --context "<what the team is studying>" --plan
   ```
   Expect an `Annotation plan` table, then the prompt and the first paper's input.
   - If it stops with `scheme '…' is not a codebook here`, fix the field's `scheme`.
3. **Pilot on ten papers:** the same command with `--limit 10` in place of `--plan`. About
   15 s a paper on a 27B model (every server in the pool works at once). Expect an
   `Annotation result` table with `refused by upc 0`. Publish into staging (Task 3,
   step 11) and read three papers' "Annotation" cards against the papers, with the owner.
   - `dropped or cut` counts what the checks removed: `quote_not_found` (not in the paper),
     `quote_unrenderable` (found only across a line break, which a card can't show),
     `unknown_code`, `unknown_citation`, `quotation_marks`, `trimmed` (over `max_words`).
     A few are normal. Many `unknown_code` mean a field's `guide` points at codes its
     codebook lacks.
4. **Full run, on the owner's go:** the same command without `--limit`, in the background.
   A re-run does only the papers left. `--redo` writes them again (`--ids <alias,…>` for
   some); a paper with the same inputs keeps one annotation.
5. **Page numbers**, so the Word file gives them: `<python> <skill>/scripts/paginate.py --corpus <corpus>`.
6. **The front matter:** `<recipe folder>/front.md`, in Markdown (methods, search strings,
   a flow diagram as a picture beside the file, appendices). It may start with its own
   `---` title block; otherwise `--title` (default: the corpus title) is used.
7. **The list:**
   ```
   <python> -u <skill>/scripts/sources_table.py --corpus <corpus> --site-base <the site's URL> --front <recipe folder>/front.md --coders <scheme>=<coder>,… --xlsx <staging>/<Name>.xlsx --docx <staging>/<Name>.docx
   ```
   `--site-base` is where the folder site will be hosted: each row links
   `<site-base>/sources/<slug>.html`, and the Word file links each cited passage there.
   `--coders` says whose codes each paper-level scheme shows; a scheme left out gets a column
   per coder, and the evidence schemes (grade, citation tier) come last. `--annotator
   <coder>` picks whose annotations when there are several. Expect a `Sources table` table
   with `local paths none`.
   - If it prints `Refusing to keep the list`, nothing was kept. Fix what it names (Known
     failures) and run it again.
8. **Look at both:** the Word file (an entry is about a third of a page) and the
   spreadsheet (filters on the header row). They go to people only on the owner's word.

## Known failures

| What you see | What it means | What to do |
|---|---|---|
| `UNAVAILABLE` from any script | The `upc` CLI, a model server or a tool is missing, not empty | Run the preflight; report which gate failed. A source with no passages is a finding; a source that never reached the model is an outage |
| `this corpus doesn't say its namespace` | No settings, and its codebooks or sources don't name one | Add `namespace` to `<corpus>/.upc/upc-corpus/settings.json`, or pass `--namespace` |
| `pass --coder` from `code_pass.py` or `screen.py` | No coder name given or set | Pass `--coder`, or set `coders` in the corpus settings |
| Preflight `config: manifest, pdf_dir does not exist` | The ingest config names folders that moved | Fix the paths in the config (full paths) |
| Anchoring rate under ~90% | A text problem, not a model problem: a running head spliced into a sentence at a page break, a soft-hyphen word break, the model adding a full stop | The first two are handled in `pdftext.py`; re-ingest with `--force-text`. Never loosen what counts as a match |
| Quotes from converted web pages fail | The text occurs twice (flattened nested lists) | `code_pass.py` widens such a quote within its line until unique; what stays ambiguous is refused |
| `Refusing to publish a corpus that does not validate` | `upc validate` has errors | Task 1; fix the errors first |
| `dossier.py`: `NOT FOUND key_points[2] (not_found)` | That quotation is not in the document's saved text | Find the passage in the document and copy it exactly; never loosen the match |
| `dossier.py`: `already exists from these inputs with a different output` | A rewritten entry uses the same passages as the stored one | Add `--replace` |
| `dossier.py build`: `a never-publish phrase would appear` | A profile's phrase is in an entry, the memo or a source quotation | Reword the writer's text, or drop that item; never delete the phrase from the profile to get past it |
| `dossier.py build`: `a local path would be published` | A writer's text or a caption names a file on this machine | Reword it |
| `onepager.py figures add`: `its value … is not in its quote` | The passage doesn't state the figure | Copy the span that states the value; for a chart, anchor the readings table |
| `onepager.py`: `the same passage as figure …` | Two figures on one span | Give each figure the span that states it |
| `onepager.py add`: `… is not a figure on this page` | The words print a number that isn't a cited figure's value or form | Cite the figure, use one of its display forms, or add a `plain_numbers` entry with a reason; never spell the number out to get past it |
| `onepager.py build`: `not confirmed by a reviewer` | No reviewer has checked that figure | Build `--draft` for now; ask the reviewer; record their reply with `signoff` |
| `onepager.py build`: `it prints on 2 pages, not one` | The words are too long for one sheet | Shorten the blocks it names; never shrink the type |
| `onepager.py build`: `figures changed since revision …` | A figure was replaced after the page was written | Add the page again |
| `NOTE … passages have no page number` | `paginate.py` hasn't run | Run it (Task 3, step 10), then publish again |
| `annotate.py`: `REFUSED …: … already exists from these inputs with a different output` | Another coder's annotation of that paper read the same passages (an annotation's id is its type and inputs) | `--redo` replaces it; or leave that paper to the first coder |
| `sources_table.py`: `Refusing to keep the list: a local path in …` | The front matter (or an annotation) names a file on this machine | Reword it; nothing was kept |
| `sources_table.py`: `… quotation differs from its passage` | An annotation's quotation no longer matches its stored passage | `annotate.py --redo --ids <alias>`, then the list again |
| `sources_table.py`: `not in the Word file word for word` | pandoc changed a quotation's characters | Report it with the quotation; don't share that Word file |
| A paper's page says its PDF `is over the … a file can be here` | `publish.py` left it out of the bundles: over `--max-pdf-mib` (25, the host's per-file limit) | Expected. They are listed in `<Name>-left-out.json`; readers use the DOI |
| A wrong PDF was replaced but nothing changed | `ingest.py` remembers each row in `<corpus>/.upc/upc-corpus/ingest.json` | Delete that row's entry and `<corpus>/.upc/upc-corpus/text/<id>.txt` and `.info.json`, then re-run ingest, `screen.py` and `code_pass.py` (each does only the new paper) |
| Import errors | The Python lacks `requirements.txt` | Use the venv |
| Compare says `DIFFERENT` in `assets/` only | The renderer changed since the hosted build | Task 4, step 3 |
| `appraise.py` exits 3 | It reached `--stop-at` with work left | Run the same command again |
| `no windows` from `appraise.py statements` | Task 8, step 1 wasn't run on this clone | Run it, then the command again |
| A mixed-methods paper rated under one profile only | Its strands weren't voted yet | `appraise.py run --set <set>` again; it fills the missing strand |
| `Refusing to publish: … citation figures aren't found again` | An ASR payload changed or a coding was edited | `citations.py check` names them; `citations.py fetch --again`, then `code --write` |
| `REFUSED support for syn-…` from `store` | The overview it names isn't in the corpus | Store into the corpus the statements were checked in |
| After a rating run, `vote` or `methods.py` show far fewer papers than were rated | The `APPRAISE_*` prefix of the run was left off, so the script read another folder | Run it again with the prefix. Nothing was overwritten: each folder keeps its own records |
| A statement checks low although each half of it is supported | A compound statement: each passage supports only part of it | In a summary you write, split it (Task 11). In generated overviews it is a known limit: report it, don't edit the overview by hand |
| `runs disagreed` on a statement | The three runs gave three different verdicts on a passage | Read the passage and the statement; it shows as weak or unclear |
| A theme that plainly has shared claims gets no claim groups | One grouping call misses groups by chance; three are pooled, but it can still happen | `synthesize.py --v2 --codes <slug>:<code> --redo` |
| `compare_site.py --content` reports CHANGED outside overviews, the home summary and the navigation | A passage, page number, code or paper changed between the editions | Don't publish. Find the cause; an approved correction goes into the `--approved` file with the owner's OK |

## Pitfalls

- **Never retype a quotation.** Copy it from the tool's output. This is the entire safety
  property.
- **Long documents are read in parts** of `--max-chars` (default 110,000); the per-code caps
  apply per part, and `--plan` says how many parts.
- **`screen.py` needs the research question** in `--context`.
- **Prompt versions are recorded** with every coding; a newer prompt never re-codes a
  source that already has its pass.
- **Screening verdicts are judgements, not evidence.** Show them as such, always with the
  coder name.
- **Never anchor into a model-rewritten copy.** Quotes go against the converted text
  `ingest.py` produces.
- **Codebook edits are safe.** A codebook's id is a hash of its namespace and slug only, so
  editing definitions never re-mints or dangles a coding.
- **Nothing leaves the machine.** Building a site is local; putting it online needs the
  owner's say-so.
- **Never send the folder site's `index.html` on its own:** its pages reference each other.
  Send the single file or the zip.
- **PDFs can't go inside the single file** (they base64 to well over twice their size). They
  ride beside it; the file still opens without them.
- **Code from the raw tables, not derived section files**: derived files can drop columns
  the coder needs.
- **Agreement counts lead authors, not papers.** Four papers by one author are one study.
- **Framework statements aren't evidence about the world.** Papers agreeing on what a
  theory says is agreement about the theory. The Findings page keeps them apart (kind
  *framework*); keep them apart in anything you write, too.
- **Single-study statements are leads, not failures.** Say which study, and where it was
  done.
- **Impact and evidence are never combined.** Citation tiers sit beside the grade, on the
  paper's page only.
- **The rating model never sees the venue, citation counts or other codings.** Don't add
  them to a prompt.

## Measured

A 179-paper library (4,500 pages, nine codebooks), on two servers each running a 27B model
and a 9B task model: ingest 24 s; screening 2–6 s per paper; coding ~50 s per paper
(2 h 20 in all); **anchoring 94%**; 3,239 verified passages, 7,855 codings, 50 overviews and
a home summary; valid at **L2 with zero errors**; site 294 pages, built in 12 s.

Evidence ratings, same library (the checklist on a thinking model, everything else
without):
- **Ratings:** 179 papers × 3 runs in 4.5 hours. Of the 4,344 quotations behind a yes or
  partly, 3,995 were found in the paper (92%).
- **Run-to-run agreement** (all three runs agree, then AC1): grade 89% (0.92); design 88%
  (0.91); what backs a claim 81% (0.84); whose claim 70% (0.76, LOW); statement verdict 89%
  (0.91).
- **Against a blind second coder** (another model; AC1): grade 0.93, design 0.77, the
  checklist 0.73.
- **Claim groups and 50 revised overviews:** 17 min. Checking their 741 statements: 20 min.
  Vote, store and page numbers: 1.5 min.
