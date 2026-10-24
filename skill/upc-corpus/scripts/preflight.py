#!/usr/bin/env python3
"""Check everything a run needs, before the run, in one call.

    python3 preflight.py [--corpus <dir>] [--config <ingest.json>]

A coding pass is a two-hour job. Finding out ninety minutes in that the model
host is unreachable, or that this interpreter has no `requests`, wastes the whole
evening. Every gate below is cheap, and each failure prints the one thing to do
about it.

Exit 0 means go. Exit 1 means stop and fix what it named — never start the long
job anyway and hope.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402

OK, BAD = "ok  ", "FAIL"


def check(name: str, fn) -> tuple[bool, str, str]:
    try:
        ok, detail, fix = fn()
        return ok, detail, fix
    except Exception as e:  # a gate must never crash the preflight
        return False, f"{type(e).__name__}: {e}", "investigate this gate itself"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", default="")
    ap.add_argument("--config", default="")
    args = ap.parse_args()

    rows = []

    def interpreter():
        mods = ["requests", "numpy"]
        if args.config:
            cfg = C.load_json(args.config) or {}
            if str(cfg.get("manifest", "")).lower().endswith((".xlsx", ".xlsm")):
                mods.append("openpyxl")
        missing = [m for m in mods if importlib.util.find_spec(m) is None]
        return (not missing,
                f"{sys.executable.split('/')[-1]} {sys.version.split()[0]}, "
                + ("all modules present" if not missing else f"missing {', '.join(missing)}"),
                f"run with an interpreter that has them, e.g. `python3` on PATH, "
                f"or pip install {' '.join(missing)}")

    def cli():
        try:
            v = C.check_compat()
        except C.Unavailable as e:
            return False, str(e), f"set UPC_CLI, or check out the standard; currently {' '.join(C.UPC_CLI)}"
        return True, f"upc {v} satisfies {C.REQUIRES}", ""

    def tools():
        want = ["pdftotext", "pdfinfo", "node"]
        # An interview corpus also cuts and converts recordings (references/interviews.md).
        if args.corpus and C.corpus_settings(Path(args.corpus).expanduser()).get("interviews"):
            want += ["ffmpeg", "ffprobe"]
        missing = [t for t in want if not shutil.which(t)]
        return (not missing, ", ".join(want) if not missing else f"missing {', '.join(missing)}",
                "brew install poppler node ffmpeg")

    def model(url: str, label: str):
        def go():
            try:
                import requests
            except ImportError:
                return False, "requests missing", "see the interpreter gate"
            base = url.rsplit("/v1/", 1)[0]
            try:
                r = requests.get(base + "/v1/models", timeout=6)
            except Exception as e:
                return False, f"{base} unreachable ({type(e).__name__})", \
                       "is the model server up, and is its URL right in the config?"
            if r.status_code != 200:
                return False, f"{base} returned HTTP {r.status_code}", "check the model server"
            ids = [m.get("id") for m in r.json().get("data", [])]
            return True, f"{base} serving {', '.join(str(i) for i in ids)}", ""
        return go

    def disk():
        target = Path(args.corpus).expanduser() if args.corpus else Path.home()
        while not target.exists() and target != target.parent:
            target = target.parent
        free = shutil.disk_usage(target).free / 1e9
        return free > 5, f"{free:.1f} GB free at {target}", \
               "a corpus needs roughly the size of its PDFs, plus the site again if you bundle"

    def corpus():
        if not args.corpus:
            return True, "not checked (no --corpus given)", ""
        d = Path(args.corpus).expanduser()
        if not (d / "corpus.json").exists():
            return False, f"{d} is not a corpus", "run ingest.py first"
        rep = C.upc("validate", str(d))
        if not isinstance(rep, dict):
            return False, "validate did not return a report", "run `upc validate` by hand and read the output"
        n = len(rep.get("errors", []))
        return n == 0, f"{rep.get('status')} at {rep.get('level')}, {n} errors", \
               "fix the errors before adding more to the corpus"

    def config():
        if not args.config:
            return True, "not checked (no --config given)", ""
        cfg = C.load_json(args.config)
        if not cfg:
            return False, f"{args.config} is missing or not JSON", "check the path"
        missing = [k for k in ("corpus", "manifest", "pdf_dir") if not cfg.get(k)]
        if missing:
            return False, f"config lacks {', '.join(missing)}", "see references/jsonl-shapes.md"
        gone = [k for k in ("manifest", "pdf_dir") if not Path(cfg[k]).expanduser().exists()]
        return not gone, ("manifest and PDFs found" if not gone else f"{', '.join(gone)} does not exist"), \
               "fix the paths in the config"

    rows.append(("interpreter", check("interpreter", interpreter)))
    rows.append(("upc CLI", check("cli", cli)))
    rows.append(("command line tools", check("tools", tools)))
    rows.append(("chat model", check("chat", model(C.CHAT_URL, "chat"))))
    rows.append(("small model", check("task", model(C.TASK_URL, "task"))))
    rows.append(("embedding model", check("embed", model(C.EMBED_URL, "embed"))))
    rows.append(("disk", check("disk", disk)))
    rows.append(("config", check("config", config)))
    rows.append(("corpus", check("corpus", corpus)))

    failed = [(n, d, f) for n, (ok, d, f) in rows if not ok]
    C.counts_header("Preflight", [
        ("gates checked", len(rows)),
        ("passed", len(rows) - len(failed)),
        ("failed", len(failed)),
    ])
    width = max(len(n) for n, _ in rows)
    for name, (ok, detail, _fix) in rows:
        print(f"  {OK if ok else BAD}  {name.ljust(width)}  {detail}")
    print()
    if failed:
        print("Stop here. Fix these, then run preflight again:")
        for name, detail, fix in failed:
            print(f"  {name}: {detail}")
            if fix:
                print(f"      -> {fix}")
        print("Preflight failed.")
        return 1
    print("All gates green. Safe to start a long run.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
