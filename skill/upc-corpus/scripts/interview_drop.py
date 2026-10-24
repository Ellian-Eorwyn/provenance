#!/usr/bin/env python3
"""A drop folder of interviews, turned into a coded, playable site on its own.

    python3 interview_drop.py --corpus <dir>            one pass (a cron job, every 15 minutes);
                                                        prints one message per interview that became
                                                        ready or finally failed, nothing otherwise
    python3 interview_drop.py --corpus <dir> status     each interview folder and what happened to it
    python3 interview_drop.py --corpus <dir> retry [FOLDER]   try a failed one again on the next pass

The corpus's settings say where things are (`<corpus>/.upc/upc-corpus/settings.json`):

    "interviews": {
      "drop": "~/Library/Mobile Documents/com~apple~CloudDocs/Interviews Drop",
      "guide": "guide.yaml", "glossary": "glossary.yaml",
      "about": "Riverbend Symphony, an orchestra in Riverbend",
      "site": {"out": "site", "publish": [["python3", "/path/demo.py", "publish", "{out}", "--name", "orch-interviews"]]}
    }

An interview is a folder in the drop folder (`2026-11-03 Jane Doe/`: the recording or
Zoom's files, intake.yaml, the notes form). It is taken once nothing in it has changed for
two minutes (AirDrop and iCloud copies arrive in pieces), then: transcribe.py (both
engines, clean-up, saved as a source), interview_pass.py (answers, briefs, highlights,
names), the site rebuilt and published. A folder is known by the sha256 of its recordings
and its intake, so adding a missing intake later (the circle, say) brings the folder back
round and the site up to date; dropping the same recording twice does nothing.

A failure is retried on the next passes, three in all, then reported once. Passes never
overlap (a lock), and a pass starts no new interview after 25 minutes.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import audio as A          # noqa: E402
import common as C         # noqa: E402
import transcribe as T     # noqa: E402

HERE = Path(__file__).parent
SETTLE_S = 120
TRIES = 3
STEP_S = 3600
PASS_S = 1500


def settings(corpus: Path) -> dict:
    s = T.interview_settings(corpus)
    if not s.get("drop"):
        C.die(f"no interviews.drop in {corpus / '.upc/upc-corpus/settings.json'}")
    return s


def fingerprint(folder: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(folder.rglob("*")):
        if p.is_file() and not p.name.startswith(".") and (A.is_recording(p) or p.name.startswith("intake")
                                                           or p.suffix.lower() in (".vtt", ".srt")):
            h.update(p.name.encode())
            h.update(A.sha256(p).encode())
    return h.hexdigest()


def settled(folder: Path, now: float) -> bool:
    files = [p for p in folder.rglob("*") if p.is_file() and not p.name.startswith(".")]
    return bool(files) and any(A.is_recording(p) for p in files) and \
        all(now - p.stat().st_mtime >= SETTLE_S for p in files) and \
        not any(p.suffix in (".icloud", ".download", ".crdownload", ".part") for p in folder.rglob("*"))


def state_file(corpus: Path) -> Path:
    return C.state_dir(corpus, "drop") / "seen.json"


def load(corpus: Path) -> dict:
    return C.load_json(state_file(corpus), {}) or {}


def step(argv: list[str]) -> tuple[int, str]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=STEP_S)
        return p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired:
        return 124, f"{Path(argv[1]).name} took over an hour"


def py(script: str, *args: str) -> list[str]:
    return [sys.executable, str(HERE / script), *args]


def publish(corpus: Path, s: dict) -> str | None:
    """Rebuild the site and run the publish commands; the first URL any of them prints."""
    site = s.get("site") or {}
    out = Path(os.path.expanduser(site.get("out") or "site"))
    out = out if out.is_absolute() else corpus / out
    C.upc("export", str(corpus), "--format", "site", "-o", str(out))
    url = None
    for cmd in site.get("publish") or []:
        code, text = step([str(x).replace("{out}", str(out)) for x in cmd])
        for line in text.splitlines():
            if line.startswith("URL:") and not url:
                url = line.split(":", 1)[1].strip()
        if code:
            return f"(publishing failed: {text.strip().splitlines()[-1][:160] if text.strip() else code})"
    return url


def message(work: Path, coded: str, url: str | None) -> str:
    w = C.load_json(work / "work.json", {})
    cl = C.load_json(work / "clean.json", {}) or {}
    iv = w.get("intake") or {}
    st = cl.get("stats") or {}
    lines = [f"**Interview ready: {iv.get('interviewee') or w.get('slug')}**"
             + f" ({iv.get('date') or 'no date'}, {w.get('probe', {}).get('duration', 0) / 60:.0f} min)"]
    sp = cl.get("speakers") or {}
    if sp:
        lines.append("- Speakers: " + "; ".join(f"{v['name']} ({v['how']})" for v in sp.values()))
        if any(v["how"] == "unnamed" for v in sp.values()):
            lines.append("  Some voices weren't placed: check the transcript, and name them in intake.yaml (`speakers:`)")
    lines.append(f"- Clean-up: {st.get('glossary_changes', 0)} glossary spellings, {st.get('model_changes', 0)} disputed "
                 f"stretches settled, {st.get('model_refused', 0)} left as heard (model {st.get('model', '?')})")
    for line in coded.splitlines():
        if line.strip().startswith(w.get("slug", "\0")):
            lines.append("- Coded: " + line.split(":", 1)[1].strip())
    if w.get("missing"):
        lines.append(f"- Intake missing: {', '.join(w['missing'])}. Add them to intake.yaml in the folder; the site catches up on the next pass.")
    sug = cl.get("suggestions") or []
    if sug:
        lines.append("- Glossary suggestions: " + "; ".join(f"“{m['heard']}” → {m['term']}" for m in sug[:6]))
    if url:
        lines.append(f"- Site: {url}")
    return "\n".join(lines)


def one_pass(corpus: Path) -> list[str]:
    s = settings(corpus)
    lock = C.state_dir(corpus, "drop") / "drop.lock"
    with lock.open("w") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return []
        return _pass(corpus, s)


def _pass(corpus: Path, s: dict) -> list[str]:
    drop = Path(s["drop"])
    if not drop.is_dir():
        return []
    seen, out, began, now = load(corpus), [], time.monotonic(), time.time()
    loose = [p.name for p in drop.iterdir() if p.is_file() and A.is_recording(p)]
    if loose and not seen.get("_told_loose") == sorted(loose):
        out.append("Recordings dropped loose in the interviews folder wait until each is in a folder of its own, "
                   "named like `2026-11-03 Jane Doe`: " + ", ".join(loose[:5]))
        seen["_told_loose"] = sorted(loose)
    changed = False
    for folder in sorted(p for p in drop.iterdir() if p.is_dir() and not p.name.startswith(".")):
        if time.monotonic() - began > PASS_S or not settled(folder, now):
            continue
        fp = fingerprint(folder)
        rec = seen.get(folder.name, {})
        if rec.get("fingerprint") == fp and (rec.get("done") or rec.get("tries", 0) >= TRIES):
            continue
        if rec.get("fingerprint") != fp:
            rec = {"fingerprint": fp}
        code, text = step(py("transcribe.py", "all", str(folder), "--corpus", str(corpus)))
        coded = ""
        if code == 0:
            code, coded = step(py("interview_pass.py", "--corpus", str(corpus)))
        if code:
            rec.update(tries=rec.get("tries", 0) + 1, error=(text + coded).strip()[-400:],
                       at=datetime.now().isoformat(timespec="seconds"))
            seen[folder.name] = rec
            if rec["tries"] >= TRIES:
                out.append(f"Couldn't process the interview {folder.name} after {TRIES} tries: "
                           f"{(text + coded).strip().splitlines()[-1][:200] if (text + coded).strip() else 'no output'}")
            C.save_json(state_file(corpus), seen)
            continue
        slug = next((ln.split()[1].rstrip(":") for ln in text.splitlines() if ln.startswith("prepared ")), None)
        rec.update(done=True, slug=slug, at=datetime.now().isoformat(timespec="seconds"))
        seen[folder.name] = rec
        C.save_json(state_file(corpus), seen)
        changed = True
        out.append(("", T.work_root(corpus) / slug, coded))
    if changed:
        url = publish(corpus, s)
        out = [message(x[1], x[2], url) if isinstance(x, tuple) else x for x in out]
    C.save_json(state_file(corpus), seen)
    return out


def status(corpus: Path) -> list[str]:
    s = settings(corpus)
    seen = load(corpus)
    drop = Path(s["drop"])
    lines = []
    for folder in sorted(p for p in drop.iterdir() if p.is_dir() and not p.name.startswith(".")) if drop.is_dir() else []:
        r = seen.get(folder.name, {})
        state = ("done" + (" (changed since: will run again)" if r.get("fingerprint") != fingerprint(folder) else "")
                 if r.get("done") else f"failed {r['tries']}× ({r.get('error', '')[-120:]})" if r.get("tries")
                 else "waiting" if settled(folder, time.time()) else "still arriving")
        lines.append(f"{folder.name}: {state}")
    return lines or [f"{drop} has no interview folders."]


def retry(corpus: Path, name: str | None) -> list[str]:
    seen, again = load(corpus), []
    for k, rec in seen.items():
        if isinstance(rec, dict) and not rec.get("done") and rec.get("tries") and name in (None, k):
            rec["tries"] = 0
            again.append(k)
    C.save_json(state_file(corpus), seen)
    return [f"{k}: tried again on the next pass" for k in again] or ["Nothing has failed."]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("cmd", nargs="?", choices=["status", "retry"])
    ap.add_argument("name", nargs="?")
    a = ap.parse_args()
    corpus = Path(a.corpus).expanduser().resolve()
    lines = status(corpus) if a.cmd == "status" else retry(corpus, a.name) if a.cmd == "retry" else one_pass(corpus)
    if lines:
        print("\n\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
