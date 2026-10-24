"""Recordings: what ffmpeg and ffprobe do for an interview corpus.

    probe(path)                  duration (s), sha256, codec, channels
    for_asr(src, dest)           any recording -> 16 kHz mono FLAC, what the engines read
    web_copy(src, dest, cuts)    the copy a site plays: mono AAC, loudness levelled, every
                                 left-out stretch silenced, moov atom first so a player can
                                 seek before it has the whole file
    cut(src, dest, a, b)         one clip, for a page that can't seek (a printed one's QR)
    merge_tracks(paths, dest)    Zoom's one-file-per-participant tracks mixed into one

The original recording is kept as it came (role `original`); only the web copy is ever
published. Silencing rather than cutting keeps every later time valid: a left-out
stretch is quiet, not gone, so 12:34 in the transcript is 12:34 in the player.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

# What phones, Zoom and recorders hand over. Anything else ffmpeg reads is tried too.
AUDIO_EXT = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus", ".3gp", ".amr", ".aiff", ".aif",
             ".caf", ".wma", ".webm", ".mp4", ".mov", ".m4v", ".mkv"}
MEDIA_TYPES = {".m4a": "audio/mp4", ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4",
               ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac", ".flac": "audio/flac",
               ".ogg": "audio/ogg", ".opus": "audio/ogg", ".3gp": "audio/3gpp", ".amr": "audio/amr",
               ".aiff": "audio/aiff", ".aif": "audio/aiff", ".caf": "audio/x-caf", ".wma": "audio/x-ms-wma",
               ".webm": "audio/webm", ".mkv": "video/x-matroska"}
WEB_BITRATE = "48k"   # mono speech: about 21 MB an hour, clear on a phone speaker


class AudioError(RuntimeError):
    pass


def tool(name: str) -> str:
    found = shutil.which(name) or (f"/opt/homebrew/bin/{name}" if Path(f"/opt/homebrew/bin/{name}").exists() else None)
    if not found:
        raise AudioError(f"{name} is not installed (brew install ffmpeg)")
    return found


def _run(args: list[str]) -> subprocess.CompletedProcess:
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode:
        raise AudioError(f"{Path(args[0]).name} failed: {(p.stderr or p.stdout).strip()[-400:]}")
    return p


def media_type(path: Path) -> str:
    return MEDIA_TYPES.get(Path(path).suffix.lower(), "application/octet-stream")


def is_recording(path: Path) -> bool:
    return Path(path).suffix.lower() in AUDIO_EXT


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def probe(path: Path) -> dict:
    """{duration, sha256, codec, channels, sample_rate}. Refuses a file with no audio stream."""
    p = _run([tool("ffprobe"), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)])
    j = json.loads(p.stdout or "{}")
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not a:
        raise AudioError(f"{Path(path).name} has no audio stream")
    dur = float((j.get("format") or {}).get("duration") or a.get("duration") or 0)
    return {"duration": round(dur, 2), "sha256": sha256(path), "codec": a.get("codec_name"),
            "channels": a.get("channels"), "sample_rate": int(a.get("sample_rate") or 0)}


def for_asr(src: Path, dest: Path) -> Path:
    """16 kHz mono FLAC: what Parakeet, Whisper and the diarizer read."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    _run([tool("ffmpeg"), "-nostdin", "-v", "error", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
          "-c:a", "flac", str(dest)])
    return dest


def _silence(cuts: list[tuple[float, float]]) -> list[str]:
    return [f"volume=enable='between(t,{a:.2f},{b:.2f})':volume=0" for a, b in cuts]


def web_copy(src: Path, dest: Path, cuts: list[tuple[float, float]] | None = None,
             bitrate: str = WEB_BITRATE) -> Path:
    """Mono AAC for the site: levelled (EBU R128, so a quiet phone and a loud Zoom play
    alike), every left-out stretch silenced, faststart so seeking works over HTTP ranges."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    filters = ["loudnorm=I=-18:TP=-1.5:LRA=11"] + _silence(cuts or [])
    _run([tool("ffmpeg"), "-nostdin", "-v", "error", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "44100",
          "-af", ",".join(filters), "-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart", str(dest)])
    return dest


def cut(src: Path, dest: Path, a: float, b: float, bitrate: str = WEB_BITRATE) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    _run([tool("ffmpeg"), "-nostdin", "-v", "error", "-y", "-ss", f"{a:.2f}", "-i", str(src), "-t", f"{b - a:.2f}",
          "-vn", "-ac", "1", "-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart", str(dest)])
    return dest


def merge_tracks(paths: list[Path], dest: Path) -> Path:
    """Zoom's separate participant tracks share one clock; mixed, they are the meeting."""
    if len(paths) == 1:
        return for_asr(paths[0], dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    args = [tool("ffmpeg"), "-nostdin", "-v", "error", "-y"]
    for p in paths:
        args += ["-i", str(p)]
    args += ["-filter_complex", f"amix=inputs={len(paths)}:duration=longest:normalize=0", "-ac", "1", "-ar", "16000",
             "-c:a", "flac", str(dest)]
    _run(args)
    return dest
