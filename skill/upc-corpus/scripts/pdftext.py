"""PDF -> a soft-wrapped UTF-8 reading copy, deterministically.

This is the one place the corpus's text comes from, so it is worth being exact
about. Three things go wrong if you just pipe `pdftotext` into a file, and all
three were measured on a real 179-paper library rather than guessed:

  1. `pdftotext` hard-wraps every line. Joined naively, a quotation spanning a
     line break contains a newline the model will never reproduce.
  2. Typeset PDFs break words with a SOFT HYPHEN (U+00AD), not a hyphen-minus.
     Joining those with a space produces "en ables" and "capa bility" — words
     that exist in no document and can never be quoted.
  3. The running head ("F.W. Geels, J. Schot / Research Policy 36 (2007) 399-417")
     is emitted inline at the page break, splicing a journal citation into the
     middle of whatever sentence straddled the page.

Everything here is model-free and deterministic: the same PDF gives the same
bytes, so the representation hash is stable across runs.
"""

from __future__ import annotations

import re
import subprocess
import unicodedata
from collections import Counter

SOFT_HYPHEN = "­"
# Hyphen-minus plus the Unicode dashes a typesetter may use to break a word.
_HYPHENS = "-" + SOFT_HYPHEN + "‐‑"
_DIGITS = re.compile(r"\d+")
_WS = re.compile(r"[ \t  -  　]+")


def pdftotext(pdf_path: str, first: int | None = None, last: int | None = None) -> str:
    """Raw text, page breaks preserved as form feeds.

    Plain mode (not -layout): on two-column academic PDFs -layout interleaves the
    columns, and so does PyMuPDF's sorted extraction. Plain mode reads each column
    in full, which is what a reader — and a quotation — needs.
    """
    cmd = ["pdftotext"]
    if first:
        cmd += ["-f", str(first)]
    if last:
        cmd += ["-l", str(last)]
    cmd += [pdf_path, "-"]
    out = subprocess.run(cmd, capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed for {pdf_path}: {out.stderr.decode('utf-8', 'replace')[:200]}")
    return out.stdout.decode("utf-8", "replace")


def _key(line: str) -> str:
    """A running head is 'the same line' across pages even as its numbers change."""
    return _DIGITS.sub("#", _WS.sub(" ", line).strip()).lower()


def find_running_lines(pages: list[str], edge: int = 3, min_share: float = 0.34) -> set[str]:
    """Keys of lines that recur at the top or bottom edge of many pages.

    Only the first and last few lines of each page are considered, so a sentence
    that happens to repeat in the body is never removed. The threshold is a share
    of pages, so it scales from a 5-page note to a 40-page review.
    """
    if len(pages) < 3:
        return set()
    seen: Counter[str] = Counter()
    for page in pages:
        lines = [l for l in page.split("\n") if l.strip()]
        edges = lines[:edge] + lines[-edge:]
        for k in {_key(l) for l in edges if len(l.strip()) > 3}:
            seen[k] += 1
    need = max(3, int(len(pages) * min_share))
    return {k for k, n in seen.items() if n >= need}


def strip_page_furniture(pages: list[str], running: set[str]) -> tuple[list[str], int]:
    """Drop running heads/feet and bare page numbers from each page's edges."""
    removed = 0
    out = []
    for page in pages:
        lines = page.split("\n")
        keep = []
        for i, line in enumerate(lines):
            near_edge = i < 4 or i >= len(lines) - 4
            s = line.strip()
            if near_edge and s:
                if _key(line) in running:
                    removed += 1
                    continue
                if re.fullmatch(r"[\[\(]?\d{1,4}[\]\)]?", s):  # a bare page number
                    removed += 1
                    continue
            keep.append(line)
        out.append("\n".join(keep))
    return out, removed


def strip_line_numbers(pages: list[str]) -> tuple[list[str], int]:
    """Remove the marginal line numbers of a peer-review manuscript.

    Accepted author manuscripts — 92 of the Elsevier PDFs in the corpus this was
    built for — carry a line number every line in the margin, and `pdftotext`
    emits each one as its own line, mid-sentence:

        ...socio-technical system of NEVs (the
        429
        niche) shows an impact on...

    Left in, the number is spliced into the text and no sentence spanning it can
    ever be quoted: two such papers anchored 0 of 47 proposed passages.

    Only removed when the document really is numbered — many standalone integers,
    mostly ascending — so a table of figures is never mistaken for one.
    """
    lines: list[tuple[int, int, str]] = []   # (page, index, text)
    for pi, page in enumerate(pages):
        for li, line in enumerate(page.split("\n")):
            lines.append((pi, li, line))
    nums = [(i, int(t.strip())) for i, (_, _, t) in enumerate(lines)
            if re.fullmatch(r"\d{1,4}", t.strip() or "x")]
    if len(nums) < 25:
        return pages, 0
    rising = sum(1 for a, b in zip(nums, nums[1:]) if b[1] > a[1])
    if rising < 0.7 * (len(nums) - 1):
        return pages, 0
    drop = {i for i, _ in nums}
    out, removed = [], 0
    idx = 0
    for pi, page in enumerate(pages):
        keep = []
        for line in page.split("\n"):
            if idx in drop:
                removed += 1
            else:
                keep.append(line)
            idx += 1
        out.append("\n".join(keep))
    return out, removed


def soft_wrap(text: str) -> str:
    """One line per paragraph, blank line between paragraphs.

    Spec/02 asks tool-produced text to be soft-wrapped, and it is load-bearing
    here: a hard-wrapped copy forces a newline into most multi-line quotations,
    which then cannot use the inline citation marker form.
    """
    paragraphs = re.split(r"\n[ \t]*\n", text)
    out = []
    for para in paragraphs:
        lines = [l.strip() for l in para.split("\n")]
        lines = [l for l in lines if l]
        if not lines:
            continue
        buf = ""
        for line in lines:
            if not buf:
                buf = line
            elif buf[-1] in _HYPHENS and re.match(r"^[a-zà-ɏ]", line):
                # A word broken across lines: rejoin it and drop the break hyphen.
                buf = buf[:-1] + line
            else:
                buf = buf + " " + line
        out.append(buf)
    # A word broken across a PAGE break lands in two different paragraphs, so
    # rejoin those too — otherwise the reading copy contains "devel- opment".
    merged: list[str] = []
    for para in out:
        if merged and merged[-1][-1:] in _HYPHENS and re.match(r"^[a-zà-ɏ]", para):
            merged[-1] = merged[-1][:-1] + para
        else:
            merged.append(para)
    return "\n\n".join(merged)


def convert(pdf_path: str) -> dict:
    """PDF -> {text, pages, running_removed, chars}. Deterministic."""
    raw = pdftotext(pdf_path)
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    pages = raw.split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    running = find_running_lines(pages)
    pages, removed = strip_page_furniture(pages, running)
    pages, numbered = strip_line_numbers(pages)
    removed += numbered
    # A page break is a paragraph break: never let the last sentence of one page
    # be glued to the first of the next.
    text = soft_wrap("\n\n".join(pages))
    text = unicodedata.normalize("NFC", text)
    text = SOFT_HYPHEN.join(text.split(SOFT_HYPHEN))  # keep any that survive inside a line
    if not text.endswith("\n"):
        text += "\n"
    return {
        "text": text,
        "pages": len(pages),
        "running_removed": removed,
        "line_numbers_removed": numbered,
        "running_patterns": sorted(running),
        "chars": len(text),
    }


PROBE = 40        # letters in a page's fingerprint
MIN_PAGE = 30     # a page with fewer letters than this is too empty to place
PROBE_SPAN = 2000  # fingerprints are taken from this many letters at the top of a page
REACH = 3000      # letters of slack beyond twice the expected distance to the next page


def _letters(text: str) -> tuple[str, list[int]]:
    """The text's letters alone, and where each one sits in the text.

    Pages are found by their letters because everything else is where a reading
    copy and a PDF page legitimately differ: soft-wrapped lines, words rejoined
    across a hyphen, marginal line numbers, ligature spacing.
    """
    where = [i for i, ch in enumerate(text) if ch.isalpha()]
    return "".join(text[i] for i in where), where


def _char_start(text: str, where: list[int], s: int) -> int:
    """The character offset where a page whose first letter is letter `s` begins:
    after the previous letter's word and the space that follows it, so "2. Methods"
    starts at "2", not at "M"."""
    if s >= len(where):
        return len(text)
    if s == 0:
        return 0
    j, pos = where[s - 1] + 1, where[s]
    while j < pos and not text[j].isspace():
        j += 1
    while j < pos and text[j].isspace():
        j += 1
    return j


def pdf_pages(pdf_path: str) -> list[str]:
    """Each page's text with its furniture removed, exactly as convert() removes it."""
    raw = pdftotext(pdf_path).replace("\r\n", "\n").replace("\r", "\n")
    pages = raw.split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    stripped, _ = strip_page_furniture(pages, find_running_lines(pages))
    stripped, _ = strip_line_numbers(stripped)
    return stripped


def locate_pages(pages: list[str], text: str) -> dict:
    """Where each page begins in `text`, and how that was worked out.

    A page is LOCATED when a fingerprint of its own letters (40, from the top of
    the page) occurs exactly once within reach of the previous located page (no
    earlier than it, and no further than twice the letters in between plus
    slack) and the page's next 40 letters follow it there too. Several
    fingerprints are tried in turn, so a figure caption or a
    garbled line at the top doesn't lose the page (on a 179-paper library, 4,449 of 4,450
    pages were located by their first). A page that can't be located that way is
    INTERPOLATED between its located neighbours in proportion to its length, and
    a page with almost no letters (a scanned image, a blank page) is EMPTY and is
    placed the same way. Nothing ever jumps ahead: the old method searched the
    whole rest of the text, so one false match far ahead (s0032) dragged every
    later page with it.

    Returns {"offsets": character offset where page i+1 starts, "how": per page,
    "letters": letters on each page, "starts": the same offsets in letters,
    "text_letters": letters in the whole text}.
    """
    T, where = _letters(text)
    P = [_letters(unicodedata.normalize("NFC", p))[0] for p in pages]
    n = len(P)
    start: list[int | None] = [None] * n
    how = ["empty" if len(p) < MIN_PAGE else "" for p in P]
    prev = since = 0
    for i, p in enumerate(P):
        if how[i] == "empty":
            since += len(p)
            continue
        hi = prev + 2 * since + REACH
        for k in range(0, max(1, min(len(p) - PROBE + 1, PROBE_SPAN)), PROBE):
            probe = p[k:k + PROBE]
            if len(probe) < MIN_PAGE:
                break
            a = T.find(probe, prev + k)
            if a < 0 or a - k > hi:
                continue
            b = T.find(probe, a + 1)
            if 0 <= b and b - k <= hi:
                continue   # twice within reach: this fingerprint can't say which
            after = p[k + PROBE:k + 2 * PROBE]
            if T[a + PROBE:a + PROBE + len(after)] != after:
                continue   # the page's next letters aren't there: a caption put elsewhere, or chance
            # Walk back over the page's letters before the fingerprint for as long
            # as the text has them too: a caption the reading copy put elsewhere
            # doesn't pull the page's start back into the page before.
            j, h = a, k
            while h > 0 and j > prev and T[j - 1] == p[h - 1]:
                j, h = j - 1, h - 1
            start[i], how[i] = j, "located"
            break
        if how[i] == "located":
            prev, since = start[i], len(p)
        else:
            since += len(p)

    # Place the rest between located neighbours (or the text's ends), by length.
    anchors = [(-1, 0)] + [(i, start[i]) for i in range(n) if how[i] == "located"] + [(n, len(T))]
    for (ia, sa), (ib, sb) in zip(anchors, anchors[1:]):
        lo = max(ia, 0)
        total = sum(len(P[j]) for j in range(lo, ib)) or 1
        run = sum(len(P[j]) for j in range(lo, ia + 1)) if ia >= 0 else 0
        for j in range(ia + 1, ib):
            start[j] = min(sb, sa + round((sb - sa) * run / total))
            run += len(P[j])
            if how[j] != "empty":
                how[j] = "interpolated"
    offsets = [_char_start(text, where, s) for s in start]
    return {"offsets": offsets, "how": how, "letters": [len(p) for p in P], "starts": start,
            "text_letters": len(T)}


def page_health(m: dict) -> dict:
    """Is a page map believable? Offsets must never go backwards; most pages with
    text must be located; and a located page's share of the text must be close
    to its own length (within half to double, for pages of 200 letters or more)."""
    how, letters, starts = m["how"], m["letters"], m["starts"]
    ends = starts[1:] + [m["text_letters"]]
    with_text = sum(1 for h in how if h != "empty")
    located = how.count("located")
    odd = [i + 1 for i in range(len(how))
           if how[i] == "located" and (i + 1 == len(how) or how[i + 1] == "located")
           and letters[i] >= 200 and not 0.5 <= (ends[i] - starts[i]) / letters[i] <= 2.0]
    backwards = [i + 1 for i in range(1, len(starts)) if starts[i] < starts[i - 1]]
    ok = not backwards and located >= 0.8 * with_text and len(odd) <= max(1, len(how) // 10)
    return {"pages": len(how), "with_text": with_text, "located": located,
            "interpolated": how.count("interpolated"), "empty": how.count("empty"),
            "odd_lengths": odd, "backwards": backwards, "ok": ok}


def page_map(pdf_path: str, text: str) -> dict:
    """locate_pages() for a PDF and its reading copy, with page_health() as
    "health" and each page's letters as "page_letters" (for page_of_quote)."""
    pages = pdf_pages(pdf_path)
    m = locate_pages(pages, text)
    m["health"] = page_health(m)
    m["page_letters"] = [_letters(unicodedata.normalize("NFC", p))[0] for p in pages]
    return m


def page_of_quote(page_letters: list[str], quote: str, n: int = 30) -> int | None:
    """The one PDF page (1-based) whose own text holds the quotation's first `n`
    letters, or None when they are on no page or on several.

    An independent check of a passage's page: it reads the PDF's pages, never
    the reading copy or its page map. A quotation that starts at the foot of a
    page and runs onto the next counts as starting on the first.
    """
    q = _letters(unicodedata.normalize("NFC", quote))[0][:n]
    if len(q) < 12:
        return None
    hits = [i + 1 for i, p in enumerate(page_letters) if q in p]
    if not hits:
        hits = [i + 1 for i in range(len(page_letters) - 1)
                if q in page_letters[i][-2 * n:] + page_letters[i + 1][:2 * n]]
    return hits[0] if len(hits) == 1 else None


def page_offsets(pdf_path: str, text: str) -> tuple[list[int], int]:
    """Where each PDF page begins in the converted text: (offsets, pages located).

    `offsets[i]` is the character index in `text` where page i+1 starts.

    This deliberately does NOT change how the text is produced. The text is the
    corpus's bytes: re-converting differently would change its hash and orphan
    every quotation anchored in it. So each page is found by its own letters
    (see locate_pages).

    Why bother: it lets a reader click a quotation and land on the right page of
    the original PDF, which is how you check that a quote says what it seems to.
    """
    m = page_map(pdf_path, text)
    return m["offsets"], m["how"].count("located")


if __name__ == "__main__":
    import json
    import sys

    r = convert(sys.argv[1])
    if len(sys.argv) > 2:
        open(sys.argv[2], "w", encoding="utf-8").write(r["text"])
    print(json.dumps({k: v for k, v in r.items() if k != "text"}, ensure_ascii=False))
