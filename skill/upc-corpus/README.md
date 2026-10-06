# upc-corpus

A toolkit for building, coding, rating and publishing
[UPC](../../README.md) research corpora with local language models. It turns a folder of
PDFs, a bundle of Markdown, or a set of spreadsheets into a corpus where every quotation is
checked byte for byte by the `upc` CLI, then into a site a colleague can open with no
software.

**The one idea:** the model *proposes* text and the tool *decides* whether it exists. A
quotation the model half-remembered fails to anchor and is reported, never stored. That is
what makes a small local model safe to use here.

`SKILL.md` is the runbook an agent (or a person) follows, one task per section. This file
is the overview.

## What it does

| Stage | Scripts |
|---|---|
| Check a machine before a long run | `preflight.py` |
| Bring documents in | `ingest.py` (PDFs and a manifest), `import_bundle.py` (Markdown bundles), `add_acquired.py` (fetched material with its retrieval record) |
| Code passages and screen papers | `make_codebooks.py`, `code_pass.py`, `screen.py`, `spotcheck.py` |
| Code spreadsheets | `tables.py` (with `tables_data.py`, `tables_model.py`, `tables_out.py`) |
| Search and report | `embed.py`, `search.py`, `report.py` |
| Write overviews | `synthesize.py`, `claim_groups.py`, `place_summary.mjs` |
| Rate the evidence | `appraise.py`, `ctx_windows.mjs`, `citations.py`, `methods.py` |
| Publish and check | `paginate.py`, `publish.py`, `compare_site.py`, `digest.py` |
| Shared | `common.py`, `llm_pool.py`, `pdftext.py`, `corpus_view.py` |

Every script prints its counts first, takes `--plan` (report, write nothing) where it would
write, and is resumable: a re-run writes nothing new.

### Rating the evidence

`appraise.py` rates each paper (a grade, from a design-specific checklist), each passage
(whose claim it is, and what backs it) and each overview statement (does each cited passage
support it), three runs per item with a majority vote. Every yes or partly needs a
quotation the tool finds in the paper; one it can't find becomes "can't tell". The model
never sees the venue, citation counts or other codings. Citation standing (`citations.py`)
is shown beside the grade and never combined with it. The rubric, its sources and the five
appraisal profiles are in `references/appraisal/`; the rules for overviews written from
rated evidence are in `references/criteria-v2.md`.

Ratings are advisory and model-made, and the pages say so, with run-to-run agreement and
agreement against a blind second coder (`spotcheck.py --blind`).

## Install

The toolkit sits beside the standard it drives (`skill/upc-corpus/` next to
`skill/universal-provenance/`) and finds the `upc` CLI there by itself. From the
repository's root:

```
python3 -m venv ~/.venvs/upc-corpus
~/.venvs/upc-corpus/bin/pip install -r skill/upc-corpus/requirements.txt
```

You also need `node` 18 or newer, and poppler's `pdftotext` and `pdfinfo`. Then tell it
where your model servers are: copy `config.example.json` to
`~/.config/upc-corpus/config.json` and edit it. `references/settings.md` explains every key,
and the per-corpus settings.

Check everything in one go:

```
~/.venvs/upc-corpus/bin/python skill/upc-corpus/scripts/preflight.py --corpus <corpus>
```

## Tests

```
cd skill/upc-corpus && python3 -m unittest discover -s tests
```

They need no model server: every model call is a stub. A few build through the real `upc`
CLI. Two compare against built sites and are skipped unless `UPC_COMPARE_BUILT` and
`UPC_COMPARE_HOSTED` name them.

## License

Part of the UPC repository, under the same [PolyForm Noncommercial License
1.0.0](../../LICENSE.md).
