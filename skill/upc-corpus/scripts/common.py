"""Shared plumbing for the upc-corpus scripts.

Two rules hold everywhere in this skill:

  * **Node mints, Python never does.** Every content-addressed id, every layout
    decision and every gate runs through the `upc` CLI. Python prepares JSON and
    reads results. A Python id recipe that drifts by one character produces a
    corpus that validates nowhere.
  * **The model proposes, the tool disposes.** Nothing a model emits is written
    as a quotation until `upc anchor` has found it byte-exactly in the document.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# --- settings ---------------------------------------------------------------
#
# Two files, both optional:
#
#   * the machine's config (UPC_CORPUS_CONFIG, else ~/.config/upc-corpus/config.json):
#     where the model servers are, how to send a one-line notice, the agent's name;
#     see ../config.example.json. Environment variables still win (UPC_CHAT_URL, …).
#   * a corpus's settings (<corpus>/.upc/upc-corpus/settings.json): its namespace,
#     the setting its team works in (an appraisal domain), and who the overviews are
#     written for. See ../references/settings.md.


def _load_config() -> dict:
    path = Path(os.environ.get("UPC_CORPUS_CONFIG") or Path.home() / ".config" / "upc-corpus" / "config.json")
    try:
        return json.loads(path.expanduser().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        print(f"  (ignoring the config {path}: {exc})", file=sys.stderr)
        return {}


CONFIG = _load_config()
AGENT_NAME = CONFIG.get("agent_name") or "the assistant"


def blind_coding(corpus: Path) -> dict:
    """The blind second coding of the evidence ratings (spotcheck.py --blind-ingest), or {}.

    It is a person's or another model's; `kind` says which and `name` is how pages name the
    coder. Older corpora keep it as blind/claude.json without `model` or `name`: their coder id
    is the model's plus "-blind"."""
    folder = state_dir(corpus, "appraise") / "blind"
    for name in ("coding.json", "claude.json"):
        b = load_json(folder / name)
        if b:
            b.setdefault("kind", "model")
            if b["kind"] == "model":
                b.setdefault("model", str(b.get("coder", "")).removesuffix("-blind"))
            b.setdefault("name", b.get("coder", ""))
            return b
    return {}


def corpus_settings(corpus: Path) -> dict:
    """<corpus>/.upc/upc-corpus/settings.json, or {}."""
    f = Path(corpus) / ".upc" / "upc-corpus" / "settings.json"
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def namespace_of(corpus: Path, given: str | None = None) -> str:
    """The corpus's namespace: --namespace, else its settings, else the one its codebooks
    were made under, else (before any codebook) the one alias namespace its sources share.
    Stops when none of those says."""
    if given:
        return given
    ns = corpus_settings(corpus).get("namespace")
    if ns:
        return ns
    seen = set()
    for f in sorted((Path(corpus) / "codebooks").glob("*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if d.get("namespace"):
            seen.add(d["namespace"])
    if len(seen) == 1:
        return seen.pop()
    if not seen:  # no codebooks yet: the alias namespace its ingest keyed every source by
        keys = set()
        for f in (Path(corpus) / "sources").glob("*/source.json"):
            try:
                keys |= set((json.loads(f.read_text(encoding="utf-8")).get("aliases") or {}).keys())
            except (OSError, ValueError):
                continue
        if len(keys) == 1:
            return keys.pop()
    die("this corpus doesn't say its namespace: pass --namespace, or add \"namespace\" to "
        f"{Path(corpus) / '.upc' / 'upc-corpus' / 'settings.json'}" + (f" (its codebooks use {sorted(seen)})" if seen else ""))


# --- the UPC CLI ----------------------------------------------------------

# The standard this skill ships in (skill/upc-corpus beside skill/universal-provenance),
# else a checkout at ~/Documents/GitHub/provenance or ~/provenance. UPC_CLI overrides all.
_UPC_REL = Path("skill/universal-provenance/scripts/upc.mjs")
_UPC_CHECKOUTS = ("Documents/GitHub/provenance", "provenance")
_SIBLING = Path(__file__).resolve().parents[2] / "universal-provenance" / "scripts" / "upc.mjs"


def locate_upc_cli(env=os.environ, home: Path | None = None, sibling: Path = _SIBLING) -> list[str]:
    if env.get("UPC_CLI"):
        return env["UPC_CLI"].split()
    home = home or Path.home()
    checkouts = [home / c / _UPC_REL for c in _UPC_CHECKOUTS]
    # Nothing found: name the usual checkout, a path one can act on.
    found = next((p for p in [sibling, *checkouts] if p.is_file()), checkouts[0])
    return ["node", str(found)]


def upc_scripts_dir(cli: list[str]) -> str:
    return str(Path(cli[-1]).parent)


UPC_CLI = locate_upc_cli()
REQUIRES = "^1.8"


class Unavailable(RuntimeError):
    """A dependency is broken, as opposed to a result being empty.

    Downstream, a missing section and an empty one look identical unless the
    script says which it was, so every failure path raises this and every
    reporting path prints `UNAVAILABLE: <reason>`.
    """


# `validate` exits 1 when the corpus HAS errors — that is a result, not a crash,
# and the report on stdout is exactly what the caller wants to read.
_EXIT_OK = {"validate": (0, 1), "code": (0, 1), "add": (0, 1), "verify-quotes": (0, 1)}


def upc(*args, stdin: str | None = None, check: bool = True) -> dict | list | str:
    """Run the CLI and parse its JSON. Raises Unavailable on a real failure."""
    proc = subprocess.run(UPC_CLI + [str(a) for a in args],
                          input=stdin, capture_output=True, text=True)
    ok = _EXIT_OK.get(str(args[0]) if args else "", (0,))
    if check and proc.returncode not in ok:
        raise Unavailable(f"upc {' '.join(str(a) for a in args[:3])} exited {proc.returncode}: "
                          f"{(proc.stderr or proc.stdout).strip()[:300]}")
    out = proc.stdout.strip()
    if not out:
        return {}
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out


def upc_jsonl(*args, records: list[dict]) -> dict:
    """Run a CLI subcommand that takes JSONL on stdin."""
    payload = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
    return upc(*args, stdin=payload, check=False)  # per-record status is in the result


def check_compat() -> str:
    """Fail loudly and early if the CLI is not the version this skill targets."""
    try:
        v = upc("version", "--json")
    except Unavailable as e:
        raise Unavailable(f"the upc CLI is not runnable ({e})") from None
    proc = subprocess.run(UPC_CLI + ["check-compat", "--requires", REQUIRES],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise Unavailable(f"upc {v.get('spec_version')} does not satisfy {REQUIRES}")
    return v.get("spec_version", "?")


def require_tools(*names: str) -> None:
    missing = [n for n in names if not shutil.which(n)]
    if missing:
        raise Unavailable(f"missing command(s): {', '.join(missing)}")


# --- local models ---------------------------------------------------------

# OpenAI-compatible servers: a chat model for coding and writing, a small task model
# for screening, and an embedding model for search. The config names them; the
# defaults are one local server.
CHAT_URL = os.environ.get("UPC_CHAT_URL") or CONFIG.get("chat_url") or "http://127.0.0.1:8080/v1/chat/completions"
TASK_URL = os.environ.get("UPC_TASK_URL") or CONFIG.get("task_url") or CHAT_URL
EMBED_URL = os.environ.get("UPC_EMBED_URL") or CONFIG.get("embed_url") or "http://127.0.0.1:8080/v1/embeddings"
EMBED_MODEL = "embed"
EMBED_DIMS = 2560
# The embedding server runs --ubatch-size 512; a chunk over ~600 tokens returns
# HTTP 500, so chunks are capped well under that. Measured, not guessed.
MAX_CHUNK_CHARS = 1400
MIN_CHUNK_CHARS = 60
EMBED_BATCH = 8


def _requests():
    try:
        import requests  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        raise Unavailable("python package 'requests' is not installed in this interpreter") from None
    return requests


# The model name sent with each call. Servers that offer a thinking and a
# non-thinking alias of one model ("think", "chat") are common; the config picks.
DEFAULT_MODEL = CONFIG.get("default_model") or "think"
# Thinking tokens count against max_tokens; limits sized for chat get this much more.
THINK_HEADROOM = 8000


def llm_chat(system: str, user: str, *, url: str = CHAT_URL, model: str = DEFAULT_MODEL,
             max_tokens: int = 4000, temperature: float = 0.2,
             schema: dict | None = None, timeout: int = 1800, seed: int | None = None) -> dict:
    """One chat completion. Returns {content, seconds, prompt_tokens, ...}.

    `cache_prompt` matters: the system prefix (the codebooks) is identical for
    every paper in a run, so the server keeps its KV cache and only the paper
    itself is processed each time.
    """
    requests = _requests()
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": max_tokens + (THINK_HEADROOM if model in ("think", "code") else 0),
        "temperature": temperature,
        "cache_prompt": True,
    }
    if seed is not None:
        body["seed"] = seed
    if schema:
        body["response_format"] = {"type": "json_schema",
                                   "json_schema": {"name": "result", "schema": schema}}
    t0 = time.time()
    try:
        r = requests.post(url, json=body, timeout=timeout)
    except Exception as e:  # network, DNS, timeout
        raise Unavailable(f"{url} unreachable: {type(e).__name__}") from None
    if r.status_code != 200:
        raise Unavailable(f"{url} returned HTTP {r.status_code}: {r.text[:200]}")
    j = r.json()
    usage = j.get("usage", {})
    return {
        "content": j["choices"][0]["message"]["content"],
        "seconds": round(time.time() - t0, 2),
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "finish_reason": (j["choices"][0] or {}).get("finish_reason"),
    }


def parse_json_loose(text: str) -> dict | None:
    """Parse a model's JSON, tolerating a code fence or leading prose."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            return None
    return None


def embed_batch(texts: list[str], timeout: int = 300) -> list[list[float]]:
    requests = _requests()
    r = requests.post(EMBED_URL, json={"model": EMBED_MODEL, "input": texts}, timeout=timeout)
    if r.status_code != 200:
        raise Unavailable(f"{EMBED_URL} returned HTTP {r.status_code}")
    data = sorted(r.json()["data"], key=lambda d: d.get("index", 0))
    return [d["embedding"] for d in data]


def embed_resilient(texts: list[str]) -> list[list[float] | None]:
    """Embed a batch, bisecting on failure so one bad chunk cannot lose a batch."""
    if not texts:
        return []
    try:
        return list(embed_batch(texts))
    except Exception:
        if len(texts) == 1:
            return [None]
        mid = len(texts) // 2
        return embed_resilient(texts[:mid]) + embed_resilient(texts[mid:])


# --- state, timing, reporting --------------------------------------------

def state_dir(corpus: str | Path, *parts: str) -> Path:
    """Tool-private scratch inside the corpus (spec/10: never a corpus member)."""
    d = Path(corpus) / ".upc" / "upc-corpus"
    for p in parts:
        d = d / p
    d.mkdir(parents=True, exist_ok=True)
    return d


def log_timing(corpus: str | Path, record: dict) -> None:
    path = state_dir(corpus) / "timing.jsonl"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def counts_header(title: str, pairs: list[tuple[str, object]], notes: list[str] | None = None) -> None:
    """Print the numbers first, so the model never counts anything itself."""
    print(f"## {title}")
    print()
    width = max((len(k) for k, _ in pairs), default=0)
    for k, v in pairs:
        print(f"  {k.ljust(width)}  {v}")
    for n in notes or []:
        print(f"  {n}")
    print()


def load_json(path: str | Path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return default


def save_json(path: str | Path, obj) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def alias_of(source: dict, prefer: str | None = None) -> str:
    """A source's short name: its alias in the preferred namespace (the corpus's own,
    which its ingest keyed it by), else its first alias in any namespace, else its id."""
    aliases = source.get("aliases") or {}
    return str((aliases.get(prefer) if prefer else None)
               or next((v for v in aliases.values() if v), None) or source["source_id"])


def reading_copy(representations: list[dict]) -> dict | None:
    """The textual representation passages are anchored in: the conversion
    (a PDF's extracted text, or a bundle's reading copy) when there is one,
    else a reading-copy role (a web page's clean markdown, never its raw HTML),
    else the first textual representation."""
    texts = [r for r in representations if str(r.get("media_type", "")).startswith("text/")]
    return (next((r for r in texts if r.get("produced_by") == "conversion"), None)
            or next((r for r in texts if r.get("role") in READING_ROLES), None)
            or (texts[0] if texts else None))


READING_ROLES = ("clean_markdown", "text", "markdown", "transcript", "ocr")
XML_TYPES = ("text/xml", "application/xml")
# A reading copy's structure map (spec/02): what each block is, its section and paragraph (xmltext.structure()).
STRUCTURE = "application/vnd.upc.structure+json"


# --- where a passage is: "p. 12", "§3.2 ¶4" --------------------------------
# The same rule as placeOf in upc_common.mjs; tests/section-cites.json holds the cases both must pass.

_NUMBERED_LABEL = re.compile(r"^(\d+|[A-Z])(\.(\d+|[A-Z]))*\.?$")


def short(s: str, n: int = 40) -> str:
    """At most n characters, whole words, with "…" when cut."""
    if len(s) <= n:
        return s
    out = ""
    for w in s.split():
        if len(out) + len(w) + (1 if out else 0) > n:
            break
        out = f"{out} {w}" if out else w
    return (out or s[:n]) + "…"


def section_cite(loc: dict) -> str:
    """A `section` locator as a reader cites it: "§3.2 ¶4" (a numbered section), "Abstract ¶1", "Appendix A ¶2",
    "Table 2" (a caption, table row or table note), "n. 3" (a footnote), "References"."""
    block, item = loc.get("block"), loc.get("item")
    if block in ("caption", "row", "table_note", "box") and item:
        return str(item)
    if block == "note":
        return f"n. {item}" if item else "Notes"
    if block in ("reference", "keywords", "title"):
        return str(loc.get("value") or "")
    label = str(loc.get("label") or "")
    head = "§" + label.rstrip(".") if label and _NUMBERED_LABEL.match(label) else \
        label or short(str(loc.get("title") or loc.get("value") or ""))
    para = loc.get("paragraph")
    return f"{head} ¶{para}" if para and head else head


def add_child_rep(corpus: Path, source_json: Path, parent: dict, data: bytes, filename: str, *, role: str,
                  media_type: str, produced_by: str, provenance: dict) -> tuple[dict, bool]:
    """Add a representation derived from `parent` to an existing source: its file beside the parent's, its record
    appended to source.json (both written atomically). `upc add source` never touches a source that exists, and
    spec/02 lets a source gain representations (never change one). The id is the bytes' (rep-<sha256[:12]>), so the
    same bytes twice are one representation. -> (record, added)."""
    import hashlib  # noqa: PLC0415
    hexd = hashlib.sha256(data).hexdigest()
    rid = "rep-" + hexd[:12]
    src = json.loads(source_json.read_text(encoding="utf-8"))
    have = next((r for r in src.get("representations", []) if r.get("representation_id") == rid), None)
    if have:
        return have, False
    rel = (Path(parent["path"]).parent / filename).as_posix()
    dest = corpus / rel
    if not dest.resolve().is_relative_to(corpus.resolve()):
        raise ValueError(f"refusing to write outside the corpus: {rel}")
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, dest)
    rec = {"representation_id": rid, "role": role, "media_type": media_type, "path": rel,
           "sha256": "sha256:" + hexd, "bytes": len(data), "produced_by": produced_by,
           "parent_representation_ref": parent["representation_id"], "provenance": provenance}
    src.setdefault("representations", []).append(rec)
    tmp = source_json.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(src, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, source_json)
    return rec, True


def place_of(e: dict) -> str:
    """Where a passage is in its paper: "p. 12" in a PDF (paginate.py's page), "§3.2 ¶4" in a full-text XML (its
    section locator). A section locator without `block` (a bundle's heading, a table cell) is not a citable place."""
    secs = e.get("secondary_locators") or []
    page = next((s.get("value") for s in secs if s.get("type") == "page"), None)
    if page:
        return f"p. {page}"
    sec = next((s for s in secs if s.get("type") == "section" and s.get("block")), None)
    return section_cite(sec) if sec else ""


def create_corpus(corpus: Path, spec: str, title: str, corpus_id: str | None = None) -> bool:
    """Write a new corpus's skeleton (no `upc` command creates one). Never
    touches an existing corpus.json. Returns True when it created one."""
    corpus.mkdir(parents=True, exist_ok=True)
    (corpus / "provenance").mkdir(exist_ok=True)
    if not (corpus / "provenance" / "events.jsonl").exists():
        (corpus / "provenance" / "events.jsonl").write_text("", encoding="utf-8")
    (corpus / "codebooks").mkdir(exist_ok=True)
    cj = corpus / "corpus.json"
    if cj.exists():
        return False
    import secrets  # noqa: PLC0415
    save_json(cj, {
        "upc_spec_version": spec,
        # An opaque creation nonce (spec/06); only its format is checked.
        "corpus_id": "cor-" + (corpus_id or secrets.token_hex(6))[:12],
        "title": title or corpus.name,
        "sections": {
            "sources": "sources/", "extractions": "extractions/",
            "codebooks": "codebooks/", "codings": "codings/",
            "provenance": "provenance/events.jsonl",
            "sources_csv": "sources.csv", "extractions_csv": "extractions.csv",
            "index_html": "index.html",
        },
    })
    return True


def occurrences(text: str, span: str, cap: int = 3) -> int:
    """How often ``span`` occurs in ``text``, overlaps included, up to ``cap``:
    the count `upc anchor` uses before refusing a quote as ambiguous."""
    count, position = 0, text.find(span)
    while position >= 0 and count < cap:
        count += 1
        position = text.find(span, position + 1)
    return count


def widen_to_unique(text: str, span: str, limit: int = 60) -> str | None:
    """The smallest widening of an ambiguous quote, whole words at a time and
    never past its own line, that occurs exactly once in ``text`` — still the
    document's exact characters — or None. Measured on converted web essays,
    whose HTML conversion flattened nested lists so each list line repeats the
    text of the lines after it: half of a coding pass's passages were refused
    as ambiguous. The later occurrence wins a tie (in a flattened list, the
    item's own line). The same rule as literature-extraction's export-bundle."""
    positions = []
    position = text.find(span)
    while position >= 0:
        positions.append(position)
        position = text.find(span, position + 1)
    best = None
    for position in reversed(positions):
        line_start = text.rfind("\n", 0, position) + 1
        line_end = text.find("\n", position + len(span))
        line_end = len(text) if line_end < 0 else line_end
        span_end = position + len(span)
        starts = [position] + [s for s in range(position - 1, max(line_start, position - limit) - 1, -1)
                               if s == line_start or text[s - 1].isspace()]
        ends = [span_end] + [e for e in range(span_end + 1, min(line_end, span_end + limit) + 1)
                             if e == line_end or text[e].isspace()]
        for start in starts[:12]:
            for stop in ends[:12]:
                width = (position - start) + (stop - span_end)
                if width == 0 or (best is not None and width >= best[2]):
                    continue
                if occurrences(text, text[start:stop]) == 1:
                    best = (start, stop, width)
    return text[best[0]:best[1]] if best else None


def corpus_reps(corpus: str | Path) -> dict[str, dict]:
    """alias -> {source_id, slug, text_rep, pdf_rep, title, chars}."""
    out = {}
    for sj in sorted(Path(corpus).glob("sources/*/source.json")):
        d = load_json(sj, {})
        if not d:
            continue
        alias = alias_of(d)
        if alias in out:  # the same short name in two namespaces
            alias = d["source_id"]
        text = reading_copy(d.get("representations", []))
        pdf = next((r for r in d.get("representations", [])
                    if str(r.get("media_type", "")).endswith("pdf")), None)
        out[alias] = {
            "source_id": d["source_id"],
            "slug": sj.parent.name,
            "title": d.get("title", ""),
            "text_rep": text["representation_id"] if text else None,
            "text_path": str(Path(corpus) / text["path"]) if text else None,
            "pdf_rep": pdf["representation_id"] if pdf else None,
            "chars": (text or {}).get("char_count"),
        }
    return out


# --- ASR (the Authoritative Source Registry): every fetch from a registered source --------
# Ported from deep-research's dr_sources.py (2026-10-05) so upc-corpus fetches through ASR
# too: ASR enforces each source's rate limits and robots posture, and journals the fetch.

_AUTH_REL = Path("skill/authoritative-sources/scripts/authority.mjs")


def locate_authority(env=os.environ, home: Path | None = None) -> Path:
    if env.get("AUTHORITY_CLI"):
        return Path(env["AUTHORITY_CLI"])
    home = home or Path.home()
    cands = [home / c / _AUTH_REL for c in ("Documents/GitHub/authority", "authority")]
    return next((p for p in cands if p.is_file()), cands[0])


AUTH = locate_authority()
REGISTRIES = AUTH.parents[3] / "registries"


def authority(*args: str, timeout: int = 180) -> dict:
    if not AUTH.is_file():
        raise Unavailable(f"the ASR CLI is not at {AUTH} (clone Ellian-Eorwyn/authority or set AUTHORITY_CLI)")
    p = subprocess.run(["node", str(AUTH), *args], capture_output=True, text=True, timeout=timeout)
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        raise Unavailable(f"authority {args[0]} printed no JSON: {(p.stderr or p.stdout)[:200]}") from None


def fetch_raw(registry: str, source: str, endpoint: str, params: dict, max_pages: int = 1) -> tuple[Path | None, dict]:
    """(payload file, ASR's fetch data) for one registered endpoint. The payload stays in
    ASR's store (registries/<registry>/fetched/); data carries fetch_id and sha256."""
    argv = ["fetch", str(REGISTRIES / registry), source, endpoint, "--max-pages", str(max_pages)]
    for k, v in params.items():
        argv += ["--param", f"{k}={v}"]
    for attempt in range(2):
        out = authority(*argv)
        data = out.get("data") or {}
        note = "; ".join(str(x) for x in (out.get("errors") or []) + (out.get("warnings") or []))[:160]
        # One retry for a dropped connection; never for a 4xx/5xx or a rate limit.
        if data.get("http_status") is None and "network" in note and attempt == 0:
            time.sleep(3)
            continue
        break
    if out.get("status") == "error" or data.get("fetch_status") != "success" or not out.get("artifacts"):
        return None, {**data, "note": note}
    return Path(out["artifacts"][0]), data


def die(msg: str, code: int = 1):
    print(f"UNAVAILABLE: {msg}")
    print("Nothing was written.")
    sys.exit(code)
