# Settings

Two files, both optional. With neither, every script runs against one model server at
`http://127.0.0.1:8080` and asks for anything it can't infer (a coder name, say) on the
command line.

## The machine's config

`UPC_CORPUS_CONFIG`, else `~/.config/upc-corpus/config.json`. It says where things run on
this machine, so it is the same for every corpus. `../config.example.json` has every key.

| Key | What | Default |
|---|---|---|
| `chat_url` | The chat-completions URL for coding, rating and writing | `http://127.0.0.1:8080/v1/chat/completions` |
| `task_url` | A smaller, faster model for screening | `chat_url` |
| `embed_url` | The embeddings URL for `embed.py`, `search.py` and claim groups | `http://127.0.0.1:8080/v1/embeddings` |
| `default_model` | The model name sent with each request | `think` |
| `model_tag` | A short name for the model family, used in coder ids (`<ns>-<tag>-appraise-v1`) | `llm` |
| `pool` | Several chat servers side by side, `{name: url}`. `appraise.py`, `synthesize.py --v2` and `claim_groups.py` run one worker per server | `{"chat": chat_url}` |
| `relay` | When a proxy in front of one server relays to another and says so in a header: `{header, value, to}`, with `to` the pool name it relays to. A worker whose replies are relayed steps aside, so one server isn't asked to do two things at once | none |
| `context` | Each pool server's context window in tokens, `{name: tokens}`. `appraise.py run` sends a paper only to a server it fits (about 3.4 characters a token, plus room for the answer); a paper no server fits is left out and named | every paper goes to every server |
| `notify` | A command for one-line notices from `appraise.py overnight`, as an argument list with `{text}` where the message goes | none (no notices) |
| `agent_name` | How pages name the assistant that wrote summaries ("Summary by …") | `the assistant` |
| `contact` | An address put in the user agent of `digest.py`'s page reads | none |
| `overnight_window` | `[not before, stop at]` for `appraise.py overnight`, as `HH:MM` | `["22:00", "06:00"]` |

`transcribe` (interviews, `references/interviews.md`):

```json
"transcribe": {
  "url": "http://127.0.0.1:8014",
  "second": {"kind": "mlx-audio", "name": "whisper-large-v3-turbo", "model": "~/.cache/whisper-mlx/large-v3-turbo"},
  "mlx_bin": "~/path/to/mlx-runtime-venv/bin",
  "clean_model": "chat",
  "code_model": "chat"
}
```

| Key | What | Default |
|---|---|---|
| `url` | A transcription server with the OpenAI `/v1/audio/transcriptions` API; `diarize=true` and word timestamps are asked for | `http://127.0.0.1:8014` (or `TRANSCRIPT_URL`) |
| `second` | The second, independent engine: `{"kind": "mlx-audio", "model": <path>}` for any mlx-audio speech model, or `{"kind": "openai", "url": …, "model": …}`. `name` is how logs and pages name it | Whisper large-v3-turbo through mlx-audio |
| `mlx_bin` | Where `mlx_audio.stt.generate` lives | the llm-stack's runtime venv |
| `clean_model`, `code_model` | The model names sent for the clean-up and the interview coding | `chat` |

Environment variables win over the file: `UPC_CHAT_URL`, `UPC_TASK_URL`, `UPC_EMBED_URL`.
Two more say where the other tools are: `UPC_CLI` (the `upc` command, for example
`node /path/to/upc.mjs`) and `AUTHORITY_CLI` (the ASR CLI).

The model servers are expected to speak the OpenAI chat-completions API and to answer one
request at a time. Each script sends one request per server at a time and never fans out.

`appraise.py` reads four more variables, so a run can try another model without editing
anything: `APPRAISE_MODEL` (default `chat`), `APPRAISE_EFFORT`, and
`APPRAISE_CRITERIA_MODEL` / `APPRAISE_CRITERIA_EFFORT` for the checklist alone. Each
combination keeps its records in its own folder, so set the same variables on every later
`appraise.py`, `synthesize.py --v2` and `methods.py` command for that run.

## A corpus's settings

`<corpus>/.upc/upc-corpus/settings.json`. It says what belongs to this corpus and its team:

```json
{
  "namespace": "retrofits",
  "short_name": "Retrofit library",
  "audience": "a team studying home energy retrofits",
  "domain": "us-residential-buildings",
  "coders": {"code": "retrofits-27b-v1", "screen": "retrofits-9b-screen-v1"}
}
```

| Key | What | Without it |
|---|---|---|
| `namespace` | Starts the ids of codebooks, coding sets and coders (`cbk-<ns>-…`, `cds-<ns>-…`) | Inferred from the corpus's codebooks, then from its sources' single alias key. A script that can't infer one asks for `--namespace` |
| `short_name` | The corpus's name in notices and tables | Its title in `corpus.json`, else the folder name |
| `audience` | Who the overviews are written for, in the overview prompt ("Write for …") | `a research team` |
| `domain` | The setting the team works in, for the evidence ratings: a file name in `appraisal/domains/`, a path (relative to the corpus), or the object itself | Papers get no setting, and statements aren't marked as coming from elsewhere |
| `coders` | `code` and `screen`: the coder names `code_pass.py` and `screen.py` use | Pass `--coder` |
| `places_codebook` | The slug of the corpus's own source-level codebook of places (`place`, say). The evidence ratings then say where a statement's evidence comes from in its codes, the evidence map's place column is one of them (`map_place` in `site/findings.json`), and `appraise.py store` writes no `place` scheme of its own, which would take the same id and replace the corpus's codebook (`store` refuses to replace a codebook another tool made) | Places come from a rule over the countries the design vote agreed on: the United States, Europe, elsewhere, no one place |
| `lead_author` | How the evidence ratings tell studies apart: `family` (the first author's family name, folded) or `family-initial` (with the first initial, so three different Wangs stay three; an organisation stays its whole name) | `family` |

A script's own flag always wins over the settings.

### Two more files beside it, for the site

- `site/findings.json`: the Findings page's starting points and wording (see the SKILL's
  task "Publish an updated edition"). Without it the pages build with no starting points.
  `"revision_labels": false` there shows a revised overview or summary with no "Revised" label and no link
  to the earlier edition, for a site whose only account of how it was made is its Methods page.
- `site/methods.template.md`: the corpus's own Methods page template. Without it,
  `methods.py` uses `methods.template.md` in this folder.

### The corpus's own rubric

`<corpus>/.upc/upc-corpus/appraisal/` may hold a copy of `appraisal/` (`designs.json`, `profiles/`,
`rubric.md`, and `domains/` if it needs its own). `appraise.py`, `spotcheck.py`, `methods.py` and
`synthesize.py` then read it instead of the toolkit's, so a project that needs other designs or questions
edits its copy and leaves every other project's prompts and records as they were.

## A domain

A domain names the setting a team cares about, so a rating can say whether a paper's
evidence comes from that setting (GRADE's indirectness). `appraisal/domains/` has one
example. Its keys:

| Key | What |
|---|---|
| `domain`, `version`, `title` | Its name, the version of the shape, and a title |
| `team_setting` | The setting in words, as prompts show it |
| `target.sectors` | The sectors that count, as the design step names them |
| `target.places` | The places that count, as `place` codes: `us`, `europe`, `elsewhere` |
| `words` | What a passage's setting line says for `target`, `near` (one of the two) and `other` |
| `setting_rules`, `why` | The rule and its reason, for people |

A country is read for its place by name ("Germany", "United States", "California, USA"):
US states count as `us`, a compound name counts if any part does.
