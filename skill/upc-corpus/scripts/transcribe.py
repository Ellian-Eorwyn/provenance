#!/usr/bin/env python3
"""Interview recordings into a UPC corpus: transcribed twice, cleaned, timed, saved.

    python3 transcribe.py prepare <interview folder> --corpus <dir>   intake + recordings -> a work folder
    python3 transcribe.py run     <work folder>                       the two engines (and Zoom's transcript)
    python3 transcribe.py clean   <work folder> [--no-model]          glossary, then the disputed words
    python3 transcribe.py save    <work folder>                       a transcript revision in the corpus
    python3 transcribe.py all     <interview folder> --corpus <dir>   the four above
    python3 transcribe.py bench   <work folder> --truth <file> [--from S --to S]   word error rate per engine
    python3 transcribe.py status  --corpus <dir>

An **interview folder** is what an interviewer hands over: the recording (a phone memo,
Zoom's audio file, or Zoom's one-file-per-participant tracks), Zoom's transcript if
there is one (.vtt), the filled notes form, and `intake.yaml`:

    interviewee: Jane Doe
    affiliation: Subscriber since 1992
    interviewer: Morgan
    date: 2026-11-03
    circle: 1
    hoped_perspective: a long-time subscriber's
    left_out: [{from: "00:41:10", to: "00:42:05", why: personal}]   # optional, times only

A folder named `2026-11-03 Jane Doe` needs no intake for the date and name.

The **work folder** (`<corpus>/.upc/upc-corpus/interviews/<slug>/`, never published)
holds the engines' raw output in the speaker-transcripts layout (`transcript.json`), so
`speaker_transcripts.py name` can enroll a confirmed voice from it.

**What is automatic, and what stays checkable.** The primary engine (Parakeet on the
transcription server: words with times, speakers diarized and matched to enrolled voices)
is compared word by word with a second, independent engine (Whisper by default, primed
with the glossary). `clean` replaces the glossary's known misrecognitions, then asks the
chat model to settle each disputed stretch, changing only the disputed words (a reply
that changes more is refused and the words stay as heard). Every change is logged and
the log is saved with the transcript, beside both engines' raw output, so a quotation can
always be traced to what the machines heard. A quotation is verified *to the transcript*
(spec/05), never to the recording.

Speakers are named, in this order, by: a Zoom participant track (certain), an enrolled
voice, Zoom's own transcript labels, then the intake (of the two main voices, the one who
asks the questions is the interviewer). Anyone left is "Speaker N".

`save` adds the interview as a source: the cleaned transcript (`transcript`), its timings
(`metadata`, application/vnd.upc.timings+json: each segment's time, speaker and
character range), the recording as it came, a web copy (mono AAC, levelled, left-out
stretches silenced), and the raw engine output and clean-up log. A later `save` of the
same interview is a new revision: the old source is marked superseded and its passages
and codings are carried over where their words are still found exactly once.
"""

from __future__ import annotations

import argparse
import datetime as dt
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import audio as A     # noqa: E402
import common as C    # noqa: E402
import glossary as G  # noqa: E402

TOOL = "upc-corpus/transcribe"
TOOL_VERSION = "1.0.0"
TCFG = C.CONFIG.get("transcribe") or {}
SERVER = (os.environ.get("TRANSCRIPT_URL") or TCFG.get("url") or "http://127.0.0.1:8014").rstrip("/")
MLX_BIN = Path(os.path.expanduser(TCFG.get("mlx_bin") or
                                  "~/Applications/LLMs/llm-stack-manager/deps/mlx-runtime-venv/bin"))
SECOND = TCFG.get("second") or {"kind": "mlx-audio", "name": "whisper-large-v3-turbo",
                                "model": "~/.cache/whisper-mlx/large-v3-turbo"}
CLEAN_MODEL = TCFG.get("clean_model") or "chat"
SEG_MAX = 15.0            # no segment longer than this, so a passage's time is close to its words
UNNAMED = "Speaker {n}"
FILLERS = {"uh", "um", "mm", "hmm", "mhm", "er", "ah", "oh", "uhhuh", "mmhmm", "huh"}
BACKCHANNEL = FILLERS | {"yeah", "yes", "right", "okay", "ok", "sure", "wow", "really", "uhhuh", "mmhm", "true",
                         "exactly", "nice", "great", "good", "no"}
LEFT_OUT = "[left out]"
TIMINGS = "application/vnd.upc.timings+json"
INTAKE_KEYS = ("interviewee", "affiliation", "interviewer", "date", "circle", "hoped_perspective")
NOTES_EXT = {".pdf", ".docx", ".doc", ".pages", ".txt", ".md", ".jpg", ".jpeg", ".png", ".heic"}
_SLUG = re.compile(r"[^a-z0-9]+")


class Refused(SystemExit):
    pass


# ------------------------------------------------------------------ small helpers
def hms(s: float, frac: bool = False) -> str:
    s = max(0.0, float(s))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{sec:05.2f}" if frac else f"{int(h):02d}:{int(m):02d}:{int(sec):02d}"


def secs(t) -> float:
    if isinstance(t, (int, float)):
        return float(t)
    parts = [float(x) for x in str(t).strip().replace(",", ".").split(":")]
    while len(parts) < 3:
        parts.insert(0, 0.0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def slugify(x: str) -> str:
    return _SLUG.sub("-", x.lower()).strip("-")[:60] or "interview"


def _tok(w: str) -> str:
    return re.sub(r"[^\w]", "", w.lower().replace("’", "'").replace("-", ""))


def overlaps(a0: float, a1: float, ranges: list[tuple[float, float]]) -> bool:
    return any(a0 < b1 and b0 < a1 for b0, b1 in ranges)


def work_root(corpus: Path) -> Path:
    return C.state_dir(corpus, "interviews")


def interview_settings(corpus: Path) -> dict:
    """The corpus's `interviews` settings, with paths made absolute."""
    s = dict(C.corpus_settings(corpus).get("interviews") or {})
    for k in ("glossary", "guide", "drop"):
        if s.get(k):
            p = Path(os.path.expanduser(s[k]))
            s[k] = str(p if p.is_absolute() else (corpus / p))
    return s


def load_work(work: Path) -> dict:
    j = C.load_json(work / "work.json")
    if not j:
        raise Refused(f"{work} is not a work folder (no work.json): run `transcribe.py prepare` first")
    return j


def save_work(work: Path, j: dict) -> None:
    C.save_json(work / "work.json", j)


# ------------------------------------------------------------------ prepare: intake and recordings
def read_intake(folder: Path) -> tuple[dict, list[str]]:
    """(intake, missing keys). intake.yaml/.yml/.json in the folder, else what the folder's
    name says (`2026-11-03 Jane Doe`)."""
    intake: dict = {}
    for name in ("intake.yaml", "intake.yml", "intake.json"):
        f = folder / name
        if f.exists():
            if f.suffix == ".json":
                intake = json.loads(f.read_text(encoding="utf-8")) or {}
            else:
                import yaml  # noqa: PLC0415
                intake = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
            break
    m = re.match(r"(\d{4}-\d{2}-\d{2})\s+(.+)$", folder.name)
    if m:
        intake.setdefault("date", m.group(1))
        intake.setdefault("interviewee", m.group(2).strip())
    if intake.get("date") is not None:
        intake["date"] = str(intake["date"])
    if intake.get("circle") is not None:
        intake["circle"] = str(intake["circle"]).strip()
    missing = [k for k in ("interviewee", "interviewer", "date", "circle") if not intake.get(k)]
    return intake, missing


_TRACK = re.compile(r"^audio([A-Za-z][A-Za-z ._'-]*?)\d{6,}$")


def participant_of(path: Path) -> str | None:
    """Zoom names a participant's own track `audio<Name><digits>.m4a` (local recordings,
    'Record a separate audio file for each participant'). The name, spaced, or None."""
    m = _TRACK.match(path.stem)
    if not m:
        return None
    name = m.group(1).replace("_", " ").strip()
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name)


def find_inputs(folder: Path) -> dict:
    """{recordings: [...], tracks: {name: path}, captions: [...], notes: [...]}"""
    files = sorted(p for p in folder.rglob("*") if p.is_file() and not p.name.startswith("."))
    recs = [p for p in files if A.is_recording(p)]
    tracks = {}
    for p in recs:
        who = participant_of(p)
        if who:
            tracks[who] = p
    main = [p for p in recs if p not in tracks.values()]
    # Zoom's audio-only file is the one to keep when it also left a video.
    main.sort(key=lambda p: (p.suffix.lower() not in (".m4a", ".mp3", ".wav"), -p.stat().st_size))
    captions = [p for p in files if p.suffix.lower() in (".vtt", ".srt")]
    notes = [p for p in files if p.suffix.lower() in NOTES_EXT and not p.name.startswith("intake")]
    return {"recordings": main, "tracks": tracks if len(tracks) >= 2 else {}, "captions": captions, "notes": notes}


def cmd_prepare(folder: Path, corpus: Path) -> Path:
    folder = folder.expanduser().resolve()
    if not folder.is_dir():
        raise Refused(f"{folder} is not a folder")
    found = find_inputs(folder)
    if not found["recordings"] and not found["tracks"]:
        raise Refused(f"{folder} has no recording ({', '.join(sorted(A.AUDIO_EXT))})")
    intake, missing = read_intake(folder)
    slug = slugify(f"{intake.get('date', '')} {intake.get('interviewee') or folder.name}")
    work = work_root(corpus) / slug
    work.mkdir(parents=True, exist_ok=True)
    prior = C.load_json(work / "work.json", {}) or {}
    main = found["recordings"][0] if found["recordings"] else None
    rec = {"slug": slug, "folder": str(folder), "intake": intake, "missing": missing,
           "recording": str(main) if main else None,
           "tracks": {k: str(v) for k, v in found["tracks"].items()},
           "captions": [str(p) for p in found["captions"]], "notes": [str(p) for p in found["notes"]],
           "prepared_at": dt.datetime.now().isoformat(timespec="seconds")}
    if main:
        rec["probe"] = A.probe(main)
    elif found["tracks"]:
        first = next(iter(found["tracks"].values()))
        rec["probe"] = A.probe(first)
    if prior.get("probe", {}).get("sha256") not in (None, rec["probe"]["sha256"]):
        rec["replaced_recording"] = prior["probe"]["sha256"]
    for k in ("saved", "revision"):
        if k in prior:
            rec[k] = prior[k]
    save_work(work, rec)
    print(f"prepared {slug}: " + (f"{len(found['tracks'])} participant tracks" if found["tracks"] else Path(main).name)
          + f", {rec['probe']['duration'] / 60:.1f} min"
          + (f", Zoom transcript {Path(found['captions'][0]).name}" if found["captions"] else "")
          + (f", notes {', '.join(Path(p).name for p in found['notes'])}" if found["notes"] else ""))
    if missing:
        print(f"  intake missing: {', '.join(missing)} (add intake.yaml to {folder})")
    print(f"  work folder: {work}")
    return work


# ------------------------------------------------------------------ captions (Zoom's .vtt, any .srt)
_CUE = re.compile(r"(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}")


def parse_captions(path: Path) -> list[dict]:
    """[{start, end, speaker|None, text}] from WebVTT or SRT. Zoom writes `Name: words`."""
    out = []
    lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    i = 0
    while i < len(lines):
        if _CUE.search(lines[i]):
            a, b = [x.strip().split(" ")[0] for x in lines[i].split("-->")]
            text = []
            i += 1
            while i < len(lines) and lines[i].strip():
                text.append(re.sub(r"<[^>]+>", "", lines[i]).strip())
                i += 1
            t = " ".join(x for x in text if x)
            m = re.match(r"^([^:]{1,60}):\s+(.*)$", t)
            who, words = (m.group(1).strip(), m.group(2)) if m and not re.search(r"\d:\d", m.group(1)) else (None, t)
            if words:
                out.append({"start": secs(a), "end": secs(b), "speaker": who, "text": words})
        i += 1
    return out


def words_of_cues(cues: list[dict]) -> list[dict]:
    """Cue text spread evenly over its time: word times good enough to compare engines."""
    out = []
    for c in cues:
        ws = c["text"].split()
        if not ws:
            continue
        step = (c["end"] - c["start"]) / len(ws)
        for k, w in enumerate(ws):
            out.append({"word": w, "start": round(c["start"] + k * step, 2), "end": round(c["start"] + (k + 1) * step, 2),
                        "p": 1.0, "speaker": c.get("speaker")})
    return out


# ------------------------------------------------------------------ run: the engines
def _post(flac: Path, diarize: bool) -> dict:
    args = ["curl", "-sS", "--max-time", "7200", "-F", f"file=@{flac}", "-F", "response_format=verbose_json",
            "-F", "timestamp_granularities[]=word", "-F", "timestamp_granularities[]=segment"]
    if diarize:
        args += ["-F", "diarize=true"]
    p = subprocess.run(args + [f"{SERVER}/v1/audio/transcriptions"], capture_output=True, text=True)
    if p.returncode:
        raise C.Unavailable(f"the transcription server at {SERVER} did not answer: {p.stderr.strip()[:200]}")
    try:
        j = json.loads(p.stdout)
    except json.JSONDecodeError:
        raise C.Unavailable(f"the transcription server returned: {p.stdout[:200]}") from None
    if "segments" not in j:
        raise C.Unavailable(f"transcription failed: {json.dumps(j)[:200]}")
    return j


def primary(work: Path, w: dict) -> dict:
    """transcript.json in the speaker-transcripts layout ({meta, names, result})."""
    out = work / "transcript.json"
    if out.exists() and C.load_json(out, {}).get("meta", {}).get("sha256") == w["probe"]["sha256"]:
        return C.load_json(out)
    flac = work / "asr.flac"
    names: dict[str, dict] = {}
    if w.get("tracks"):
        # One engine pass per participant; each track is one speaker, known for certain.
        segs, words = [], []
        for k, (who, path) in enumerate(sorted(w["tracks"].items())):
            tf = A.for_asr(Path(path), work / f"track-{k}.flac")
            r = _post(tf, diarize=False)
            sid = f"track_{k}"
            names[sid] = {"name": who, "source": "track", "enrolled": False}
            for s in r.get("segments", []):
                if not s.get("text", "").strip():
                    continue
                s = {**s, "speaker": sid, "speaker_name": who}
                s["words"] = [{**x, "speaker": sid} for x in s.get("words") or []]
                segs.append(s)
                words += s["words"]
        segs.sort(key=lambda s: s["start"])
        words.sort(key=lambda x: x["start"])
        result = {"text": " ".join(s["text"].strip() for s in segs), "segments": segs, "words": words,
                  "speakers": [{"id": sid, "name": v["name"]} for sid, v in names.items()],
                  "model": "per-track", "backend": SERVER}
        A.merge_tracks([Path(p) for p in w["tracks"].values()], flac)
    else:
        A.for_asr(Path(w["recording"]), flac)
        result = _post(flac, diarize=True)
        for s in result.get("speakers", []):
            if s.get("name"):
                names[s["id"]] = {"name": s["name"], "source": "voice", "enrolled": False,
                                  "score": s.get("voice_score")}
    data = {"meta": {"title": w["slug"], "source": w.get("recording") or next(iter(w["tracks"].values())),
                     "sha256": w["probe"]["sha256"], "recorded": w["intake"].get("date"),
                     "transcribed": dt.datetime.now().isoformat(timespec="minutes"), "duration": w["probe"]["duration"]},
            "names": names, "result": result}
    C.save_json(out, data)
    return data


def second(work: Path, w: dict, gl: dict) -> dict | None:
    """second.json: {engine, words: [{word, start, end, p}]} from an independent engine,
    else from Zoom's transcript, else None."""
    out = work / "second.json"
    have = C.load_json(out)
    if have and have.get("sha256") == w["probe"]["sha256"] and have.get("engine") == SECOND.get("name"):
        return have
    flac = work / "asr.flac"
    kind = SECOND.get("kind")
    res = None
    if kind == "mlx-audio" and (MLX_BIN / "mlx_audio.stt.generate").exists():
        model = os.path.expanduser(SECOND["model"])
        stem = work / "second-raw"
        args = [str(MLX_BIN / "mlx_audio.stt.generate"), "--model", model, "--audio", str(flac),
                "--output-path", str(stem), "--format", "json", "--language", "en",
                "--gen-kwargs", json.dumps({"word_timestamps": True})]
        hint = G.prompt(gl)
        if hint and SECOND.get("context", True):
            args += ["--context", hint]
        p = subprocess.run(args, capture_output=True, text=True)
        raw = C.load_json(stem.with_suffix(".json"))
        if p.returncode == 0 and raw:
            res = {"engine": SECOND.get("name") or Path(model).name, "words": engine_words(raw), "primed": bool(hint)}
        else:
            print(f"  second engine failed ({(p.stderr or '').strip()[-200:]}); trying Zoom's transcript")
    elif kind == "openai":
        r = subprocess.run(["curl", "-sS", "--max-time", "7200", "-F", f"file=@{flac}", "-F", "response_format=verbose_json",
                            "-F", "timestamp_granularities[]=word", "-F", f"prompt={G.prompt(gl)}",
                            "-F", f"model={SECOND.get('model', '')}", SECOND["url"]], capture_output=True, text=True)
        try:
            res = {"engine": SECOND.get("name") or SECOND.get("model"), "words": engine_words(json.loads(r.stdout))}
        except (json.JSONDecodeError, KeyError):
            res = None
    if res is None and w.get("captions"):
        res = {"engine": "zoom-transcript", "words": words_of_cues(parse_captions(Path(w["captions"][0])))}
    if res is None:
        return None
    res["sha256"] = w["probe"]["sha256"]
    C.save_json(out, res)
    return res


def engine_words(raw: dict) -> list[dict]:
    """Words with times from an engine's JSON: words[], or segments[].words[], or segment
    text spread over the segment."""
    out = []
    if raw.get("words"):
        src = raw["words"]
    else:
        src = [x for s in raw.get("segments", []) for x in (s.get("words") or [])]
    for x in src:
        word = (x.get("word") or x.get("text") or "").strip()
        if word:
            out.append({"word": word, "start": float(x["start"]), "end": float(x["end"]),
                        "p": float(x.get("probability", x.get("p", 1.0)))})
    if not out:
        out = words_of_cues([{"start": s["start"], "end": s["end"], "text": s.get("text", "")}
                             for s in raw.get("segments", [])])
    return out


def cmd_run(work: Path) -> int:
    w = load_work(work)
    s = interview_settings(Path(w["corpus"]) if w.get("corpus") else work.parents[3])
    gl = G.load(s.get("glossary"))
    try:
        p = primary(work, w)
        print(f"primary: {len(p['result']['segments'])} segments, {len(p['result'].get('words') or [])} words "
              f"({p['result'].get('model') or 'server'})")
    except C.Unavailable as e:
        if not w.get("captions"):
            raise
        # The server is down but Zoom transcribed it: use Zoom's, with cue-level times.
        print(f"UNAVAILABLE: {e}; using Zoom's transcript as the primary")
        cues = parse_captions(Path(w["captions"][0]))
        names, segs = {}, []
        for c in cues:
            sid = "zoom_" + slugify(c["speaker"] or "unknown")
            if c["speaker"]:
                names[sid] = {"name": c["speaker"], "source": "zoom", "enrolled": False}
            segs.append({"start": c["start"], "end": c["end"], "text": c["text"], "speaker": sid,
                         "words": words_of_cues([c])})
        C.save_json(work / "transcript.json", {
            "meta": {"title": w["slug"], "source": w["recording"], "sha256": w["probe"]["sha256"],
                     "duration": w["probe"]["duration"], "transcribed": dt.datetime.now().isoformat(timespec="minutes")},
            "names": names, "result": {"segments": segs, "words": [x for s in segs for x in s["words"]],
                                       "model": "zoom-transcript", "speakers": []}})
    sec = second(work, w, gl)
    print(f"second: {sec['engine']}, {len(sec['words'])} words" if sec else "second: none available")
    return 0


# ------------------------------------------------------------------ clean: speakers, glossary, disputed words
def split_words(words: list[dict], limit: float = SEG_MAX) -> list[list[dict]]:
    """A long run of words in pieces of at most `limit` seconds: at the last sentence or
    clause end after 8 s when there is one, else at the longest pause."""
    out, chunk = [], []
    for x in words:
        if chunk and x["end"] - chunk[0]["start"] > limit:
            cut = None
            for i in range(len(chunk) - 1, 0, -1):
                if chunk[i - 1]["end"] - chunk[0]["start"] >= 8 and re.search(r"[.?!,;]$", chunk[i - 1]["word"]):
                    cut = i
                    break
            if cut is None:
                gaps = [(chunk[i]["start"] - chunk[i - 1]["end"], i) for i in range(1, len(chunk))
                        if chunk[i - 1]["end"] - chunk[0]["start"] >= 8]
                cut = max(gaps)[1] if gaps else len(chunk)
            out.append(chunk[:cut])
            chunk = chunk[cut:]
        chunk.append(x)
    if chunk:
        out.append(chunk)
    return out


def base_segments(tj: dict) -> list[dict]:
    """The primary engine's segments, none longer than SEG_MAX, each with its words."""
    allw = tj["result"].get("words") or []
    out = []
    for s in tj["result"]["segments"]:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        ws = s.get("words") or [x for x in allw if s["start"] - 0.01 <= x["start"] < s["end"]]
        ws = [{"word": x["word"].strip(), "start": float(x["start"]), "end": float(x["end"])} for x in ws if x.get("word", "").strip()]
        pieces = split_words(ws) if (s["end"] - s["start"] > SEG_MAX and ws) else [ws]
        for chunk in pieces:
            out.append({"start": round(chunk[0]["start"] if chunk else s["start"], 2),
                        "end": round(chunk[-1]["end"] if chunk else s["end"], 2),
                        "sid": s.get("speaker") or "unknown",
                        "text": " ".join(x["word"] for x in chunk) if len(pieces) > 1 else text,
                        "words": chunk})
    return out


def name_speakers(segs: list[dict], tj: dict, w: dict, cues: list[dict]) -> dict[str, dict]:
    """speaker id -> {name, how}. Tracks and enrolled voices first, then Zoom's labels,
    then the intake for the two main voices."""
    names = {sid: {"name": v["name"], "how": v.get("source", "voice")} for sid, v in (tj.get("names") or {}).items()
             if v.get("name")}
    intake = w.get("intake") or {}
    talk: dict[str, float] = {}
    asks: dict[str, int] = {}
    nseg: dict[str, int] = {}
    for s in segs:
        talk[s["sid"]] = talk.get(s["sid"], 0) + (s["end"] - s["start"])
        nseg[s["sid"]] = nseg.get(s["sid"], 0) + 1
        asks[s["sid"]] = asks.get(s["sid"], 0) + (1 if s["text"].rstrip().endswith("?") else 0)
    # Zoom's labels: the participant whose cues overlap a speaker's segments most.
    if cues:
        for sid in talk:
            if sid in names:
                continue
            votes: dict[str, float] = {}
            for s in (x for x in segs if x["sid"] == sid):
                for c in cues:
                    if c.get("speaker") and c["start"] < s["end"] and s["start"] < c["end"]:
                        votes[c["speaker"]] = votes.get(c["speaker"], 0) + min(s["end"], c["end"]) - max(s["start"], c["start"])
            if votes:
                best, v = max(votes.items(), key=lambda kv: kv[1])
                if v >= 0.6 * sum(votes.values()) and best not in {n["name"] for n in names.values()}:
                    names[sid] = {"name": best, "how": "zoom"}
    # A voice match by first name only ("Morgan") takes the intake's full name.
    for role in ("interviewer", "interviewee"):
        full = str(intake.get(role) or "")
        for v in names.values():
            if full and v["name"] != full and full.lower().startswith(v["name"].lower() + " "):
                v["name"] = full
    total = sum(talk.values()) or 1
    main = [sid for sid, t in sorted(talk.items(), key=lambda kv: -kv[1]) if t / total >= 0.08]
    taken = {v["name"] for v in names.values()}
    open_main = [sid for sid in main if sid not in names]
    roles = [r for r in ("interviewer", "interviewee") if intake.get(r) and intake[r] not in taken]
    if open_main and roles:
        if len(roles) == 2 and len(open_main) >= 2:
            a, b = open_main[:2]
            ra = asks.get(a, 0) / max(1, nseg.get(a, 1))
            rb = asks.get(b, 0) / max(1, nseg.get(b, 1))
            iv, ee = (a, b) if ra >= rb else (b, a)
            names[iv] = {"name": intake["interviewer"], "how": "intake (asks the questions)"}
            names[ee] = {"name": intake["interviewee"], "how": "intake"}
        elif len(roles) == 1:
            names[open_main[0]] = {"name": intake[roles[0]], "how": "intake (the other main voice)"}
    n = 0
    for sid in sorted(talk, key=lambda k: min(s["start"] for s in segs if s["sid"] == k)):
        if sid not in names:
            n += 1
            names[sid] = {"name": UNNAMED.format(n=n), "how": "unnamed"}
    return names


def mark_asides(segs: list[dict]) -> None:
    """A short "mm-hm" from one voice inside another's turn stays where it was said but
    doesn't break the turn."""
    for i in range(1, len(segs) - 1):
        s, a, b = segs[i], segs[i - 1], segs[i + 1]
        toks = [_tok(x) for x in s["text"].split()]
        if (a["speaker"] == b["speaker"] != s["speaker"] and len(toks) <= 3 and s["end"] - s["start"] <= 2.0
                and toks and all(t in BACKCHANNEL for t in toks)):
            s["aside"] = True


def _content(words: list[dict]) -> list[dict]:
    return [x for x in words if _tok(x["word"]) and _tok(x["word"]) not in FILLERS]


def disputes(segs: list[dict], other: list[dict]) -> dict[int, list[dict]]:
    """segment index -> [{ours, theirs, t}] where the engines disagree on a content word."""
    ours = [(i, x) for i, s in enumerate(segs) for x in _content(s["words"])]
    theirs = _content(other)
    sm = difflib.SequenceMatcher(None, [_tok(x["word"]) for _, x in ours], [_tok(x["word"]) for x in theirs], autojunk=False)
    out: dict[int, list[dict]] = {}
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        pa, wb = ours[i1:i2], theirs[j1:j2]
        if len(pa) > 12 or len(wb) > 12:
            continue   # a long run of disagreement is an alignment slip, not a word to settle
        if pa:
            seg = pa[0][0]
        else:
            t = wb[0]["start"]
            seg = min(range(len(segs)), key=lambda k: 0 if segs[k]["start"] <= t <= segs[k]["end"]
                      else min(abs(segs[k]["start"] - t), abs(segs[k]["end"] - t)))
        out.setdefault(seg, []).append({"ours": " ".join(x["word"] for _, x in pa),
                                        "theirs": " ".join(x["word"] for x in wb),
                                        "t": round((pa[0][1] if pa else wb[0])["start"], 2)})
    return out


CLEAN_SYSTEM = """You correct speech-recognition errors in an interview transcript{about}.

Each item is one stretch of speech as the main engine heard it (`text`), the places where a
second, independent engine heard something different (`disputed`: ours vs theirs), and
spellings the project knows are right (`glossary`).

Rules:
- Change ONLY words in a disputed place. Everything else stays exactly as it is.
- In a disputed place pick ours, theirs, or the glossary spelling, whichever makes sense as
  speech in context. Do not invent a third reading.
- Keep the speaker's own words: fillers (um, uh), false starts, repetitions and grammar stay.
- Do not add or remove punctuation except next to a word you changed.
- If neither reading is clearly better, keep ours.

Reply with JSON: {"items": [{"id": <id>, "text": <the stretch, corrected>}]} with every id."""

CLEAN_SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {
    "type": "object", "properties": {"id": {"type": "integer"}, "text": {"type": "string"}}, "required": ["id", "text"]}}},
    "required": ["items"]}


def guard(before: str, after: str, allowed: int) -> str | None:
    """Why a model's correction is refused, or None. It may change at most `allowed` words
    (twice the disputed words, at least 3), and in a stretch of 20 words or more must keep
    90% of them (in a short one a single fixed word is already more than a tenth)."""
    a, b = before.split(), after.split()
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    changed = sum(max(i2 - i1, j2 - j1) for op, i1, i2, j1, j2 in sm.get_opcodes() if op != "equal")
    if changed > allowed:
        return f"changed {changed} words, {allowed} allowed"
    if len(a) >= 20 and sum(m.size for m in sm.get_matching_blocks()) / len(a) < 0.9:
        return "kept under 90% of the words"
    return None


def settle(items: list[dict], gl: dict, about: str, log: list) -> dict[int, str]:
    """{id: corrected text} for the items the model settled within the rules."""
    terms = [t["term"] for t in gl["terms"]]
    out: dict[int, str] = {}
    for k in range(0, len(items), 12):
        batch = items[k:k + 12]
        user = json.dumps({"glossary": terms[:300], "items": [{"id": x["id"], "text": x["text"], "disputed": x["disputed"]}
                                                            for x in batch]}, ensure_ascii=False)
        try:
            r = C.llm_chat(CLEAN_SYSTEM.replace("{about}", about), user, model=CLEAN_MODEL, max_tokens=4000,
                           temperature=0.0, schema=CLEAN_SCHEMA, timeout=900)
        except C.Unavailable as e:
            log.append({"step": "model", "status": "unavailable", "detail": str(e)[:200]})
            return out
        got = (C.parse_json_loose(r["content"]) or {}).get("items") or []
        by = {x["id"]: x for x in batch}
        for g in got:
            x = by.get(g.get("id"))
            if not x or not isinstance(g.get("text"), str) or g["text"].strip() == x["text"]:
                continue
            allowed = max(3, 2 * sum(len(d["ours"].split()) or 1 for d in x["disputed"]))
            why = guard(x["text"], g["text"].strip(), allowed)
            if why:
                log.append({"step": "model", "status": "refused", "at": x["start"], "why": why,
                            "before": x["text"], "proposed": g["text"].strip()})
                continue
            out[x["id"]] = g["text"].strip()
            log.append({"step": "model", "status": "changed", "at": x["start"], "before": x["text"], "after": out[x["id"]],
                        "disputed": x["disputed"]})
    return out


def cmd_clean(work: Path, use_model: bool = True) -> int:
    w = load_work(work)
    corpus = Path(w["corpus"])
    s = interview_settings(corpus)
    gl = G.load(s.get("glossary"))
    tj = C.load_json(work / "transcript.json")
    if not tj:
        raise Refused(f"no transcript.json in {work}: run `transcribe.py run` first")
    other = (C.load_json(work / "second.json") or {}).get("words") or []
    cues = parse_captions(Path(w["captions"][0])) if w.get("captions") else []
    segs = base_segments(tj)
    names = name_speakers(segs, tj, w, cues)
    for x in segs:
        x["speaker"] = names[x["sid"]]["name"]
    log: list[dict] = []
    # 1. the glossary's known misrecognitions, everywhere
    rules = G.rules(gl)
    for x in segs:
        new, changes = G.apply(x["text"], gl, rules)
        if changes:
            log += [{"step": "glossary", "status": "changed", "at": x["start"], **c} for c in changes]
            x["text"] = new
    # 2. the disputed words, settled by the model within the rules
    dis = disputes(segs, other) if other else {}
    near = {}
    for i, x in enumerate(segs):
        for m in G.near_misses(x["text"], gl):
            near.setdefault(i, []).append({"ours": m["heard"], "theirs": m["term"], "t": x["start"]})
    items = []
    for i in sorted(set(dis) | set(near)):
        x = segs[i]
        items.append({"id": i, "text": x["text"], "start": x["start"], "disputed": dis.get(i, []) + near.get(i, [])})
    about = f" about {s['about']}" if s.get("about") else ""
    fixed = settle(items, gl, about, log) if (use_model and items) else {}
    for i, t in fixed.items():
        segs[i]["text"] = t
    mark_asides(segs)
    suggestions = G.near_misses("\n".join(x["text"] for x in segs), gl)
    result = {"made_at": dt.datetime.now().isoformat(timespec="seconds"), "speakers": names,
              "segments": [{k: v for k, v in x.items() if k != "sid"} for x in segs],
              "glossary": {"path": s.get("glossary"), "revision": gl["revision"], "digest": gl["digest"]},
              "engines": {"primary": tj["result"].get("model") or "server", "second": (C.load_json(work / "second.json") or {}).get("engine")},
              "stats": {"segments": len(segs), "disputed_segments": len(items),
                        "glossary_changes": sum(1 for x in log if x["step"] == "glossary"),
                        "model_changes": sum(1 for x in log if x["step"] == "model" and x["status"] == "changed"),
                        "model_refused": sum(1 for x in log if x["step"] == "model" and x["status"] == "refused"),
                        "model": "unavailable" if any(x.get("status") == "unavailable" for x in log)
                        else ("off" if not use_model else CLEAN_MODEL)},
              "suggestions": suggestions, "log": log}
    C.save_json(work / "clean.json", result)
    st = result["stats"]
    print(f"cleaned: {st['segments']} segments; {st['glossary_changes']} glossary fixes; "
          f"{st['disputed_segments']} disputed stretches, {st['model_changes']} settled by the model, "
          f"{st['model_refused']} refused (kept as heard); model {st['model']}")
    print("speakers: " + "; ".join(f"{v['name']} ({v['how']})" for v in names.values()))
    if suggestions:
        print(f"glossary suggestions ({len(suggestions)}): "
              + "; ".join(f"{m['heard']!r} -> {m['term']} ×{m['count']}" for m in suggestions[:8]))
    return 0


# ------------------------------------------------------------------ save: a transcript revision in the corpus
def left_out(w: dict) -> list[tuple[float, float]]:
    out = []
    for r in (w.get("intake") or {}).get("left_out") or []:
        a = secs(r["from"])
        b = float("inf") if str(r.get("to", "end")) == "end" else secs(r["to"])
        out.append((a, b))
    return sorted(out)


def build_transcript(segs: list[dict], cuts: list[tuple[float, float]]) -> tuple[str, list[dict]]:
    """(transcript.md, timings segments). One paragraph per turn, headed by the speaker
    and the time; an aside ("mm-hm") sits inside the turn in parentheses; a left-out
    stretch is one marker line. Each row knows its characters (codepoints)."""
    text, rows, cur = "", [], None
    i = 0
    while i < len(segs):
        s = segs[i]
        if overlaps(s["start"], s["end"], cuts):
            j = i
            while j + 1 < len(segs) and overlaps(segs[j + 1]["start"], segs[j + 1]["end"], cuts):
                j += 1
            if text and not text.endswith("\n\n"):
                text += "\n\n"
            c0 = len(text)
            text += f"*{LEFT_OUT}*"
            rows.append({"start": s["start"], "end": segs[j]["end"], "speaker": None, "c0": c0, "c1": len(text), "left_out": True})
            text += "\n\n"
            cur = None
            i = j + 1
            continue
        if s.get("aside") and cur:
            text += " ("
            c0 = len(text)
            text += f"{s['speaker']}: {s['text']}"
            rows.append({"start": s["start"], "end": s["end"], "speaker": s["speaker"], "c0": c0, "c1": len(text), "aside": True})
            text += ")"
            i += 1
            continue
        if s["speaker"] != cur:
            if text and not text.endswith("\n\n"):
                text += "\n\n"
            text += f"**{s['speaker']}** [{hms(s['start'])}]\n"
            cur = s["speaker"]
        else:
            text += " "
        c0 = len(text)
        text += s["text"]
        rows.append({"start": s["start"], "end": s["end"], "speaker": s["speaker"], "c0": c0, "c1": len(text),
                     "words": [[x["word"], x["start"], x["end"]] for x in s.get("words") or []]})
        i += 1
    return text.rstrip() + "\n", rows


def interview_title(intake: dict) -> str:
    who = intake.get("interviewee") or "Interview"
    return f"{who}" + (f", {intake['date']}" if intake.get("date") else "")


def current_revision(corpus: Path, slug: str) -> dict | None:
    """The live (not superseded) source for this interview, or None."""
    for sj in (corpus / "sources").glob("*/source.json"):
        d = C.load_json(sj, {})
        iv = (d.get("ext") or {}).get("upc-interview") or {}
        if iv.get("slug") == slug and not iv.get("superseded_by"):
            return d
    return None


def reps_of(src: dict) -> dict:
    reps = src.get("representations") or []
    tr = next((r for r in reps if r["role"] == "transcript" and r.get("produced_by") != "model-raw"), None)
    tm = next((r for r in reps if r.get("media_type") == TIMINGS), None)
    web = next((r for r in reps if r["role"] == "audio" and r.get("produced_by") == "conversion"), None)
    rec = next((r for r in reps if r["role"] in ("audio", "original") and r.get("produced_by") == "import"), None)
    return {"transcript": tr, "timings": tm, "web": web, "recording": rec}


def cmd_save(work: Path) -> int:
    w = load_work(work)
    corpus = Path(w["corpus"])
    cl = C.load_json(work / "clean.json")
    if not cl:
        raise Refused(f"no clean.json in {work}: run `transcribe.py clean` first")
    cuts = left_out(w)
    text, rows = build_transcript(cl["segments"], cuts)
    old = current_revision(corpus, w["slug"])
    rev = ((old.get("ext") or {}).get("upc-interview", {}).get("revision", 0) + 1) if old else 1
    stage = Path(tempfile.mkdtemp(prefix="interview-"))
    slug = w["slug"]
    (stage / f"{slug}.md").write_text(text, encoding="utf-8")
    C.save_json(stage / f"{slug}.timings.json", {"upc_timings": 1, "duration": w["probe"]["duration"], "segments": rows})
    web = A.web_copy(Path(w["recording"]) if w.get("recording") else work / "asr.flac", stage / f"{slug}.web.m4a",
                     [(a, min(b, w["probe"]["duration"])) for a, b in cuts])
    shutil.copy(work / "transcript.json", stage / f"{slug}.engine-primary.json")
    C.save_json(stage / f"{slug}.clean-log.json", {k: cl[k] for k in ("made_at", "glossary", "engines", "stats", "speakers",
                                                                        "suggestions", "log")})
    originals = [Path(w["recording"])] if w.get("recording") else []
    originals += [Path(p) for p in (w.get("tracks") or {}).values()]
    files = [
        {"path": str(stage / f"{slug}.md"), "role": "transcript", "media_type": "text/markdown", "produced_by": "model",
         "parent": 2, "language": "en",
         "description": f"Transcript, revision {rev}: {cl['engines']['primary']} with speakers, checked word by word against "
                        f"{cl['engines']['second'] or 'no second engine'}; glossary spellings applied and disputed words "
                        "settled by a model (see the clean-up log)"},
        {"path": str(stage / f"{slug}.timings.json"), "role": "metadata", "media_type": TIMINGS, "produced_by": "conversion",
         "parent": 0, "description": "Each segment's time in the recording, speaker and character range in the transcript"},
    ]
    for k, p in enumerate(originals):
        files.append({"path": str(p), "role": "audio", "media_type": A.media_type(p), "produced_by": "import",
                      "duration_seconds": A.probe(p)["duration"],
                      "description": ("The recording as it was handed over" if k == 0 and w.get("recording")
                                      else f"Participant track: {participant_of(p) or p.stem}")})
    files.append({"path": str(web), "role": "audio", "media_type": "audio/mp4", "produced_by": "conversion", "parent": 2,
                  "duration_seconds": A.probe(web)["duration"],
                  "description": "Web copy: mono AAC, loudness levelled" + (", left-out stretches silenced" if cuts else "")})
    files.append({"path": str(stage / f"{slug}.engine-primary.json"), "role": "metadata", "media_type": "application/json",
                  "produced_by": "model", "parent": 2, "description": f"{cl['engines']['primary']}: segments, words and speakers as made"})
    if (work / "second.json").exists():
        shutil.copy(work / "second.json", stage / f"{slug}.engine-second.json")
        files.append({"path": str(stage / f"{slug}.engine-second.json"), "role": "metadata", "media_type": "application/json",
                      "produced_by": "model", "parent": 2, "description": f"{cl['engines']['second']}: words with times, as made"})
    files.append({"path": str(stage / f"{slug}.clean-log.json"), "role": "metadata", "media_type": "application/json",
                  "produced_by": "conversion", "parent": 0, "description": "Every change made in clean-up, and every one refused"})
    for p in w.get("notes") or []:
        p = Path(p)
        files.append({"path": str(p), "role": "original", "media_type": {
            ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".txt": "text/plain", ".md": "text/markdown", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".heic": "image/heic"}.get(p.suffix.lower(), "application/octet-stream"),
            "produced_by": "import", "description": "The interviewer's notes form"})
    intake = w.get("intake") or {}
    iv = {"slug": slug, "revision": rev, "recording_sha256": w["probe"]["sha256"],
          **{k: intake[k] for k in INTAKE_KEYS if intake.get(k) is not None},
          "speakers": {v["name"]: v["how"] for v in cl["speakers"].values()},
          "left_out": [[a, None if b == float("inf") else b] for a, b in cuts],
          "engines": cl["engines"], "glossary": cl["glossary"], "clean": cl["stats"],
          "supersedes": old["source_id"] if old else None, "made_at": dt.datetime.now().isoformat(timespec="seconds")}
    rec = {"slug": f"{slug}-r{rev}", "title": interview_title(intake), "source_kind": "audio", "files": files,
           "bibliographic": {"item_type": "interview", "title": interview_title(intake),
                             **({"issued": {"date_parts": [[int(x) for x in str(intake["date"]).split("-")]]}}
                                if re.fullmatch(r"\d{4}(-\d{2}){0,2}", str(intake.get("date") or "")) else {}),
                             **({"authors": [{"literal": intake["interviewee"]}]} if intake.get("interviewee") else {}),
                             **({"interviewer": [{"literal": intake["interviewer"]}]} if intake.get("interviewer") else {})},
           "tags": ["interview"], "ext": {"upc-interview": iv}}
    res = C.upc("add", "source", "--corpus", str(corpus), "--hardlink", "--tool", TOOL, stdin=json.dumps(rec))
    r0 = (res.get("results") or [{}])[0] if isinstance(res, dict) else {}
    if r0.get("status") not in ("added", "exists"):
        raise Refused(f"upc add source: {r0}")
    shutil.rmtree(stage, ignore_errors=True)
    new_sid = r0["source_id"]
    if old and new_sid == old["source_id"]:
        # The same transcript: only what the intake says may have changed (a circle added
        # later). That lives in ext, outside every id, so it is updated in place.
        sj = _source_file(corpus, new_sid)
        d = C.load_json(sj)
        cur = d.setdefault("ext", {}).setdefault("upc-interview", {})
        fresh = {k: intake[k] for k in INTAKE_KEYS if intake.get(k) is not None}
        if any(cur.get(k) != v for k, v in fresh.items()):
            cur.update(fresh)
            C.save_json(sj, d)
            print(f"transcript unchanged (revision {rev - 1}, {new_sid}); intake updated: {', '.join(sorted(fresh))}")
        else:
            print(f"transcript unchanged: still revision {rev - 1} ({new_sid})")
        return 0
    carried = carry_over(corpus, old, new_sid) if old else {"passages": 0, "codings": 0, "lost": []}
    w["saved"], w["revision"] = new_sid, rev
    save_work(work, w)
    print(f"saved {slug} revision {rev}: {new_sid} · {sum(1 for r in rows if not r.get('left_out'))} segments, "
          f"{len(cuts)} left out · {len(text):,} characters")
    if old:
        print(f"  carried over {carried['passages']} passages and {carried['codings']} codings from {old['source_id']}"
              + (f"; {len(carried['lost'])} passages not found exactly once in the new text" if carried["lost"] else ""))
        import timecode  # noqa: PLC0415
        timecode.run(corpus, quiet=True)
    return 0


def all_extractions(corpus: Path) -> list[dict]:
    """Every extraction, each with `_set` (its extraction set's id, or None for a source's own file)."""
    out = []
    for p in list(corpus.glob("sources/*/extractions.jsonl")) + list(corpus.glob("extractions/*/items.jsonl")):
        set_id = p.parent.name if p.name == "items.jsonl" else None
        for line in p.read_text(encoding="utf-8").splitlines():
            if line.strip():
                out.append({**json.loads(line), "_set": set_id})
    return out


def _source_file(corpus: Path, sid: str) -> Path | None:
    for sj in (corpus / "sources").glob("*/source.json"):
        if C.load_json(sj, {}).get("source_id") == sid:
            return sj
    return None


def carry_over(corpus: Path, old: dict, new_sid: str) -> dict:
    """Mark the old revision superseded; re-anchor its live passages in the new transcript
    (with their type and tool data) and give each the same codings by the same coders."""
    new = C.load_json(_source_file(corpus, new_sid))
    nr = reps_of(new)
    exts = [e for e in all_extractions(corpus)
            if e.get("source_id") == old["source_id"] and (e.get("status") or "active") == "active" and e.get("direct_quote")]
    mapping, lost = {}, []
    by_set: dict[str | None, list] = {}
    for e in exts:
        by_set.setdefault(e.get("_set"), []).append(e)
    for set_id, group in by_set.items():
        args = ["anchor", "--corpus", str(corpus), "--rep", nr["transcript"]["representation_id"], "--tool", TOOL]
        if set_id:
            args += ["--set", set_id]
        recs = [{"quote": e["direct_quote"], "type": e.get("type"), **({"text": e["text"]} if e.get("text") else {}),
                 **({"ext": e["ext"]} if e.get("ext") else {})} for e in group]
        res = C.upc_jsonl(*args, records=recs)
        for e, r in zip(group, res.get("results") or []):
            if r.get("status") in ("anchored", "exists", "refound"):
                mapping[e["extraction_id"]] = r["extraction_id"]
            else:
                lost.append(e["extraction_id"])
    ncod = 0
    for cs in (corpus / "codings").glob("*/manifest.json") if (corpus / "codings").exists() else []:
        man = C.load_json(cs, {})
        items = cs.parent / "items.jsonl"
        if not items.exists():
            continue
        recs = []
        for line in items.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            c = json.loads(line)
            t = c.get("target") or {}
            if (c.get("status") or "active") != "active":
                continue
            if t.get("kind") == "extraction" and t.get("id") in mapping:
                to = {"kind": "extraction", "id": mapping[t["id"]]}
            elif t.get("kind") == "source" and t.get("id") == old["source_id"]:
                to = {"kind": "source", "id": new_sid}
            else:
                continue
            # The set's manifest already declares each coder and its kind.
            recs.append({"codebook_ref": c["codebook_ref"], "target": to, "coder": c["coder"],
                         **({"code": c["code"]} if c.get("code") is not None else {"value": c.get("value")}),
                         **{k: c[k] for k in ("rationale", "confidence", "confidence_score") if c.get(k) is not None}})
        if recs:
            res = C.upc_jsonl("code", "--corpus", str(corpus), "--set", man.get("set_id") or cs.parent.name,
                              "--tool", TOOL, records=recs)
            ncod += sum(1 for r in res.get("results") or [] if r.get("status") in ("coded", "unchanged"))
    # The old revision steps aside; its bytes and passages stay, as provenance.
    sj = _source_file(corpus, old["source_id"])
    d = C.load_json(sj)
    d.setdefault("ext", {}).setdefault("upc-interview", {})["superseded_by"] = new_sid
    C.save_json(sj, d)
    return {"passages": len(mapping), "codings": ncod, "lost": lost}


# ------------------------------------------------------------------ bench: word error rate per engine
def wer(ref: list[str], hyp: list[str]) -> tuple[float, int, int, int]:
    sm = difflib.SequenceMatcher(None, ref, hyp, autojunk=False)
    s = d = i = 0
    for op, a1, a2, b1, b2 in sm.get_opcodes():
        if op == "replace":
            s += min(a2 - a1, b2 - b1)
            d += max(0, (a2 - a1) - (b2 - b1))
            i += max(0, (b2 - b1) - (a2 - a1))
        elif op == "delete":
            d += a2 - a1
        elif op == "insert":
            i += b2 - b1
    return ((s + d + i) / max(1, len(ref)), s, d, i)


def cmd_bench(work: Path, truth: Path, t0: float, t1: float) -> int:
    """Each engine (and the cleaned transcript) against a person's corrected text of the
    same stretch: overall word error rate, and the share of glossary terms got right."""
    w = load_work(work)
    gl = G.load(interview_settings(Path(w["corpus"])).get("glossary"))
    ref_text = truth.read_text(encoding="utf-8")
    ref = [_tok(x) for x in ref_text.split() if _tok(x) and _tok(x) not in FILLERS]
    tj = C.load_json(work / "transcript.json")
    runs = {"primary (" + str(tj["result"].get("model") or "server") + ")":
            [x["word"] for x in tj["result"].get("words") or [] if t0 <= x["start"] < t1]}
    sec = C.load_json(work / "second.json")
    if sec:
        runs[f"second ({sec['engine']})"] = [x["word"] for x in sec["words"] if t0 <= x["start"] < t1]
    cl = C.load_json(work / "clean.json")
    if cl:
        runs["cleaned"] = [x for s in cl["segments"] if t0 <= s["start"] < t1 for x in s["text"].split()]
    terms = [t["term"] for t in gl["terms"] if t["term"].lower() in ref_text.lower()]
    print(f"## Word error rate, {hms(t0)}–{hms(t1)} ({len(ref)} reference words, fillers ignored)\n")
    for name, words in runs.items():
        hyp = [_tok(x) for x in words if _tok(x) and _tok(x) not in FILLERS]
        e, s, d, i = wer(ref, hyp)
        joined = " ".join(words).lower()
        right = sum(1 for t in terms if t.lower() in joined)
        print(f"  {name:40s} WER {e:6.1%}  (sub {s}, del {d}, ins {i})"
              + (f"  glossary terms {right}/{len(terms)}" if terms else ""))
    return 0


# ------------------------------------------------------------------ status, all
def cmd_status(corpus: Path) -> int:
    rows = []
    for wj in sorted(work_root(corpus).glob("*/work.json")):
        w = C.load_json(wj, {})
        cl = C.load_json(wj.parent / "clean.json", {}) or {}
        rows.append((w.get("slug"), w.get("intake", {}).get("interviewee", "?"),
                     f"{w.get('probe', {}).get('duration', 0) / 60:.0f} min",
                     "saved r%s" % w["revision"] if w.get("saved") else ("cleaned" if cl else
                     ("transcribed" if (wj.parent / "transcript.json").exists() else "prepared")),
                     ", ".join(w.get("missing") or [])))
    C.counts_header("Interviews", [("interviews", len(rows)), ("saved", sum(1 for r in rows if r[3].startswith("saved")))])
    for r in rows:
        print(f"  {r[0]:40s} {r[1]:28s} {r[2]:>7s}  {r[3]}" + (f"  (intake missing: {r[4]})" if r[4] else ""))
    return 0


def ensure_corpus(corpus: Path, title: str | None = None) -> None:
    if not (corpus / "corpus.json").exists():
        spec = C.check_compat()
        C.create_corpus(corpus, spec, title or C.corpus_settings(corpus).get("short_name") or corpus.name)
    gi = corpus / ".gitignore"
    want = ("# Recordings stay out of git; the corpus records their sha256.\n"
            + "".join(f"*{e}\n" for e in sorted(A.AUDIO_EXT))
            + "# The engines' output and the clean-up log hold left-out stretches word for word, the work\n"
              "# folders hold everything, and index.html (upc regen) quotes every text file: they stay here.\n"
              "sources/*/representations/*.engine-*.json\nsources/*/representations/*.clean-log.json\n"
              "index.html\n/site/\n.upc/upc-corpus/interviews/\n.upc/upc-corpus/drop/\n")
    have = gi.read_text(encoding="utf-8") if gi.exists() else ""
    missing = [ln for ln in want.splitlines() if ln and not ln.startswith("#") and ln not in have.splitlines()]
    if not have:
        gi.write_text(want, encoding="utf-8")
    elif missing:
        gi.write_text(have.rstrip("\n") + "\n" + "\n".join(missing) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["prepare", "run", "clean", "save", "all", "bench", "status"])
    ap.add_argument("folder", nargs="?")
    ap.add_argument("--corpus")
    ap.add_argument("--no-model", action="store_true", help="clean: glossary only, no model")
    ap.add_argument("--truth", help="bench: a person's corrected text of the stretch")
    ap.add_argument("--from", dest="t0", default="0")
    ap.add_argument("--to", dest="t1", default="99:00:00")
    a = ap.parse_args()
    try:
        if a.cmd == "status":
            return cmd_status(Path(a.corpus).expanduser())
        if not a.folder:
            ap.error("a folder is needed")
        folder = Path(a.folder).expanduser()
        if a.cmd in ("prepare", "all"):
            if not a.corpus:
                ap.error("--corpus is needed")
            corpus = Path(a.corpus).expanduser().resolve()
            ensure_corpus(corpus)
            work = cmd_prepare(folder, corpus)
            w = load_work(work)
            w["corpus"] = str(corpus)
            save_work(work, w)
            if a.cmd == "prepare":
                return 0
            cmd_run(work)
            cmd_clean(work, not a.no_model)
            return cmd_save(work)
        if a.cmd == "run":
            return cmd_run(folder)
        if a.cmd == "clean":
            return cmd_clean(folder, not a.no_model)
        if a.cmd == "save":
            return cmd_save(folder)
        if a.cmd == "bench":
            return cmd_bench(folder, Path(a.truth), secs(a.t0), secs(a.t1))
    except (C.Unavailable, A.AudioError) as e:
        C.die(str(e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
