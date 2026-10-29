#!/usr/bin/env python3
"""Check the codes: a second reading of every passage coding, then a person decides what changes.

    python3 check_codes.py plan   --corpus <dir> --set <cds-id> [--codebook slug,…]
    python3 check_codes.py run    --corpus <dir> --set <cds-id> --checker <handle> [--codebook slug,…]
                                  [--papers N | --sample N] [--seed 1] [--limit N] [--model chat] [--url … | --pool]
    python3 check_codes.py report --corpus <dir> --set <cds-id> --checker <handle> [--out review.csv]
    python3 check_codes.py apply  --corpus <dir> --set <cds-id> --checker <handle> --approved-by <handle>
                                  (--sheet review.csv | --accept wrong,none,reason) [--dry-run]

`run` writes nothing to the corpus. Per paper, it sends a model the paper's coded passages (at most
`--batch` a call, so the server's cache keeps the codebooks), each inside its "In context" window as the
reader's site shows it (built once by `ctx_windows.mjs`; the passage marked « »), with the codes it
carries, their definitions, the other codes of the same codebook and the coder's stated reason, and asks
of every coding:

    fits       yes | partly | no: does the code fit the passage under its definition?
    better     when it does not: the code of the same codebook that does, or none
    reason_ok  is the stated reason a plain reason about this passage and this code? Not the coder's
               own deliberation ("…in tech list? No, … Wait, …", "Let's use …"), not a reason for
               another code, not empty.
    why        one sentence

A fixed check runs beside the model on every reason (`rationale_flags`): think tags, questions,
"wait", "let's use", talk of the code list. The answers go to
`<corpus>/.upc/upc-corpus/check_codes/<checker>/<set>.jsonl`, one per coding, so a stopped run resumes.
`--pool` checks papers on every server in the machine's pool at once (llm_pool.py, one worker each, the
same model on each), writing a paper's answers when it is done; without it, one server at `--url`.

`report` counts how often the codes fit, per codebook and code, and writes a review sheet: one row per
coding the checker doubts, with an `apply` column left empty for a person. `apply` turns the rows
marked yes (or, with `--accept`, every row of the named kinds) into `upc recode`:

    wrong   fits = no and a better code: changed to it, under the checker's handle
    none    fits = no and no code fits:  withdrawn (kept, retracted, not shown)
    reason  the code fits but its reason is not one: restated, the same code under the checker's
            handle with the checker's reason

Who decides: the checker only proposes. Nothing changes in the corpus until a person approves rows
(`--approved-by`, recorded in the event). The old codings are never deleted. Source-level codings
(a paper's study type, place…) are not checked yet: only codings of passages.
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import random
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402
import llm_pool  # noqa: E402

PROMPT_VERSION = "check-codes.v2"
FITS = ("yes", "partly", "no")
KINDS = ("wrong", "none", "reason")
SHEET = ["apply", "kind", "coding_id", "paper", "codebook", "code", "fits", "better", "reason_ok",
         "checker_why", "stored_reason", "flags", "passage", "extraction_id"]

# A stated reason that is really the coder thinking aloud (FORGE 2.2, 10-28: 4 of 30,326, e.g. "…closest fit for
# 'solar' in tech list? No, solar is not listed. Wait, …"). Quoted words are the source's, so they are left out.
_QUOTED = re.compile(r"\"[^\"\n]{0,400}\"|“[^”\n]{0,400}”")
FLAGS = {
    "think-tag": re.compile(r"</?think>|<\|im_(?:start|end)\|>", re.I),
    "question": re.compile(r"\?"),
    "deliberation": re.compile(r"(?:^|[.;:(?!]\s*)(?:wait|hmm+|actually|no,|but wait)\b|\blet'?s (?:use|go with|pick|say)\b|"
                               r"\bi(?:'ll| will| need to| think)\b", re.I),
    "code-list": re.compile(r"\b(?:tech|code|codebook) list\b|\bnot listed\b|\b(?:closest|best) fit\b|"
                            r"\b(?:barrier|enabler|actor|technology)\s*:\s*[a-z]+-[a-z-]+", re.I),
    "the-user": re.compile(r"\bthe user\b|\bthe prompt\b|\bthe instructions\b", re.I),
}


def rationale_flags(text: str) -> list[str]:
    """The fixed checks a stated reason fails, in FLAGS order; [] for a plain reason."""
    t = _QUOTED.sub('"…"', text or "")
    return [k for k, rx in FLAGS.items() if rx.search(t)]


def state_file(corpus: Path, checker: str, cds: str) -> Path:
    return C.state_dir(corpus, "check_codes", checker) / f"{cds}.jsonl"


def load(corpus: Path, cds: str, slugs: set[str] | None):
    """(books by id, passages by extraction id, titles by source id, the set's active passage codings)."""
    books = {}
    for f in sorted((corpus / "codebooks").glob("cbk-*.json")):
        b = C.load_json(f)
        if b:
            books[b["codebook_id"]] = b
    exts = {}
    for f in list(corpus.glob("sources/*/extractions.jsonl")) + list(corpus.glob("extractions/*/items.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                o = json.loads(line)
                exts[o["extraction_id"]] = o
    titles = {}
    for f in corpus.glob("sources/*/source.json"):
        s = C.load_json(f) or {}
        if s.get("source_id"):
            titles[s["source_id"]] = s.get("title") or s["source_id"]
    items = corpus / "codings" / cds / "items.jsonl"
    if not items.exists():
        C.die(f"no coding set {cds} in {corpus}")
    codings = []
    for line in items.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        c = json.loads(line)
        if (c.get("status") or "active") != "active" or (c.get("target") or {}).get("kind") != "extraction":
            continue
        b = books.get(c.get("codebook_ref"))
        if not b or c["target"]["id"] not in exts or (slugs and b.get("slug") not in slugs):
            continue
        codings.append(c)
    return books, exts, titles, codings


def load_windows(corpus: Path) -> dict:
    """{ext id: [window text, start, end]}, built once per corpus by ctx_windows.mjs (about a minute)."""
    f = C.state_dir(corpus, "check_codes") / "windows.json"
    if not f.exists():
        import subprocess
        print("  building the passages' In context windows (once)…", flush=True)
        r = subprocess.run(["node", str(Path(__file__).parent / "ctx_windows.mjs"), "--corpus", str(corpus), "--out", str(f)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  NOTE no windows ({(r.stderr or r.stdout).strip()[-200:]}): the checker reads each passage alone,"
                  " and judges codes that depend on the passage's context more strictly.", flush=True)
            return {}
    return C.load_json(f, {}) or {}


def quote_of(ext: dict) -> str:
    return ext.get("direct_quote") or ext.get("quote") or ""


def system_prompt(books: list[dict], context: str = "") -> str:
    lines = ["You check another coder's work on passages from research papers.",
             "For each passage you get the codes it was given. For each code: its codebook, its definition, "
             "the other codes of that codebook, and the reason the coder gave.",
             "",
             "For every code, answer:",
             "- fits: \"yes\" if the code fits the passage under its definition, \"partly\" if only loosely, "
             "\"no\" if it does not.",
             "- better: when fits is \"no\", the one code of the SAME codebook that fits this passage, or \"none\". "
             "Otherwise \"\".",
             "- reason_ok: true if the coder's reason is a plain reason about this passage and this code. false if "
             "it is the coder thinking aloud (questions, \"wait\", \"no,\", \"let's use\", talk of a code list), a "
             "reason for some other code, or empty.",
             "- why: one short sentence about the passage, written for a reader. Never mention these instructions.",
             "",
             "Each passage is shown between « and », inside the sentences around it. Judge what the passage says, "
             "read in that context (\"this project\" means the project the context names). The code must fit the "
             "passage, not merely the paper. A passage can fit several codes.",
             "Answer with JSON only: {\"checks\": [{\"id\": \"c1\", \"fits\": \"yes\", \"better\": \"\", "
             "\"reason_ok\": true, \"why\": \"…\"}, …]}, one entry per code id, in order."]
    if context:
        lines += ["", f"The project: {context}"]
    lines += ["", "## Codebooks"]
    for b in books:
        lines.append(f"\n### {b.get('slug')}: {b.get('title', '')}")
        if b.get("description"):
            lines.append(b["description"])
        for cd in b.get("codes") or []:
            lines.append(f"- {cd['code']}: {cd.get('label', '')}. {cd.get('definition', '')}".rstrip())
    return "\n".join(lines)


def user_prompt(title: str, batch: list[tuple[dict, list[tuple[str, dict, dict]]]], windows: dict | None = None) -> str:
    """batch: [(passage, [(short id, coding, codebook), …]), …]"""
    out = [f"Paper: {title}", ""]
    for n, (ext, codes) in enumerate(batch, 1):
        out.append(f"## Passage {n}")
        w = windows.get(ext["extraction_id"]) if windows else None
        out.append((w[0][:w[1]] + "«" + w[0][w[1]:w[2]] + "»" + w[0][w[2]:]).strip() if w else f"«{quote_of(ext).strip()}»")
        out.append("")
        for sid, c, b in codes:
            label = next((cd.get("label", "") for cd in b.get("codes") or [] if cd["code"] == c.get("code")), "")
            out.append(f"- {sid}: {b.get('slug')} / {c.get('code')} ({label}). Coder's reason: "
                       f"{(c.get('rationale') or '(none given)').strip()}")
        out.append("")
    return "\n".join(out)


def parse_checks(content: str, ids: dict[str, tuple[dict, dict]]) -> dict[str, dict]:
    """Model answer → {coding_id: verdict}. An answer that is malformed for one id is left out (re-asked on resume)."""
    j = C.parse_json_loose(content) or {}
    got = {}
    for a in j.get("checks") or []:
        if not isinstance(a, dict) or a.get("id") not in ids:
            continue
        c, b = ids[a["id"]]
        fits = str(a.get("fits", "")).strip().lower()
        if fits not in FITS:
            continue
        codes = {cd["code"] for cd in b.get("codes") or []}
        better = str(a.get("better") or "").strip()
        if fits != "no":
            better = ""
        elif better not in codes or better == c.get("code"):
            better = "none" if better in ("", "none") else ""
        if fits == "no" and not better:
            continue  # named a code the codebook hasn't: ask again
        why = " ".join(str(a.get("why") or "").split())[:300]
        got[c["coding_id"]] = {"fits": fits, "better": better, "reason_ok": a.get("reason_ok") is not False,
                               "why": why, "why_flags": rationale_flags(why)}
    return got


def kind_of(v: dict) -> str:
    """Which change a verdict proposes: wrong, none, reason, or "" (none needed)."""
    if v["fits"] == "no":
        return "none" if v["better"] == "none" else "wrong"
    if not v["reason_ok"] or v.get("flags"):
        return "reason"
    return ""


def done_ids(path: Path) -> dict[str, dict]:
    out = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                o = json.loads(line)
                out[o["coding_id"]] = o
    return out


def cmd_plan(a) -> int:
    corpus = Path(a.corpus)
    books, exts, titles, codings = load(corpus, a.set, set(filter(None, a.codebook.split(","))) or None)
    by_book = collections.Counter(books[c["codebook_ref"]]["slug"] for c in codings)
    papers = {exts[c["target"]["id"]].get("source_id") for c in codings}
    passages = {c["target"]["id"] for c in codings}
    flagged = [c for c in codings if rationale_flags(c.get("rationale", ""))]
    calls = sum(-(-len({c["target"]["id"] for c in codings if exts[c["target"]["id"]].get("source_id") == p}) // a.batch)
                for p in papers)
    C.counts_header("Checking the codes (plan)", [
        ("coding set", a.set), ("passage codings", len(codings)), ("passages", len(passages)),
        ("papers", len(papers)), ("model calls", calls),
        ("reasons the fixed check flags", len(flagged)),
        ("rough time at ~20 s a call", f"{calls * 20 / 3600:.1f} h"),
    ])
    for slug, n in by_book.most_common():
        print(f"  {slug:<28} {n}")
    for c in flagged[:10]:
        print(f"  flagged {c['coding_id']}: {rationale_flags(c['rationale'])} {c['rationale'][:120]}")
    return 0


def cmd_run(a) -> int:
    corpus = Path(a.corpus)
    books, exts, titles, codings = load(corpus, a.set, set(filter(None, a.codebook.split(","))) or None)
    out = state_file(corpus, a.checker, a.set)
    out.parent.mkdir(parents=True, exist_ok=True)
    done = done_ids(out)
    todo = [c for c in codings if c["coding_id"] not in done]
    if a.sample:
        rnd = random.Random(a.seed)
        todo = rnd.sample(todo, min(a.sample, len(todo)))
    by_paper = collections.defaultdict(lambda: collections.defaultdict(list))
    for c in todo:
        ext = exts[c["target"]["id"]]
        by_paper[ext.get("source_id")][ext["extraction_id"]].append(c)
    papers = sorted(by_paper)
    if a.papers:  # every coding of N random papers: an estimate that batches as well as a full run
        papers = sorted(random.Random(a.seed).sample(papers, min(a.papers, len(papers))))
    if a.limit:
        papers = papers[:a.limit]
    windows = load_windows(corpus) if papers else {}
    used = sorted({c["codebook_ref"] for c in codings}, key=lambda i: books[i].get("slug", ""))
    system = system_prompt([books[i] for i in used], a.context)
    endpoints = dict(llm_pool.ENDPOINTS) if getattr(a, "pool", False) else {}
    C.counts_header("Checking the codes", [
        ("coding set", a.set), ("checker", a.checker), ("already checked", len(done)),
        ("to check now", sum(len(v) for p in papers for v in by_paper[p].values())), ("papers", len(papers)),
        ("model", f"{a.model} on {', '.join(endpoints)}" if endpoints else f"{a.model} at {a.url}"),
    ])
    t0 = time.time()
    n = collections.Counter()

    def check_paper(p: str, url: str, pooled: bool = False) -> list[tuple[dict, dict]]:
        """The model's verdicts on one paper's codings, one call per `--batch` passages: [(ids, verdicts)]."""
        answers = []
        plist = list(by_paper[p].items())
        for i in range(0, len(plist), a.batch):
            ids, batch, k = {}, [], 0
            for xid, cs in plist[i:i + a.batch]:
                row = []
                for c in cs:
                    k += 1
                    ids[f"c{k}"] = (c, books[c["codebook_ref"]])
                    row.append((f"c{k}", c, books[c["codebook_ref"]]))
                batch.append((exts[xid], row))
            try:
                r = C.llm_chat(system, user_prompt(titles.get(p, p), batch, windows), url=url, model=a.model,
                               max_tokens=200 + 120 * k, temperature=0.1)
            except C.Unavailable as e:
                if pooled:
                    raise llm_pool.Unavailable(str(e)) from None
                raise
            if pooled and llm_pool.is_relayed(r.get("headers") or {}, url):
                raise llm_pool.Relayed(url)
            answers.append((ids, parse_checks(r["content"], ids)))
        return answers

    with out.open("a", encoding="utf-8") as fh:
        def record(p: str, answers: list[tuple[dict, dict]], server: str = "") -> None:
            """One paper's verdicts into the state file. Pooled, the pool runs this under its lock."""
            for ids, got in answers:
                n["calls"] += 1
                n["missing"] += len(ids) - len(got)
                for c, b in ids.values():
                    v = got.get(c["coding_id"])
                    if not v:
                        continue
                    v.update({"coding_id": c["coding_id"], "extraction_id": c["target"]["id"], "source_id": p,
                              "codebook": b.get("slug"), "code": c.get("code"), "coder": c.get("coder"),
                              "flags": rationale_flags(c.get("rationale", "")),
                              "checker": a.checker, "model": a.model, "prompt_version": PROMPT_VERSION,
                              "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
                    v["kind"] = kind_of(v)
                    fh.write(json.dumps(v, ensure_ascii=False) + "\n")
                    n["ok"] += 1
            fh.flush()
            n["papers"] += 1
            if n["papers"] % 10 == 0 or n["papers"] == len(papers):
                el = time.time() - t0
                print(f"  [{n['papers']}/{len(papers)}] {n['ok']} checked, {n['calls']} calls, "
                      f"~{el / n['papers'] * (len(papers) - n['papers']) / 60:.0f}m left"
                      f"{f' (last on {server})' if server else ''}", flush=True)

        if endpoints:
            problems, left = llm_pool.run_all(papers, lambda p, name, url: check_paper(p, url, pooled=True),
                                              lambda p, answers, name, _s: record(p, answers, name), endpoints)
            for prob in dict.fromkeys(problems):
                print(f"  POOL {prob}", flush=True)
            if left:
                print(f"  stopped with {len(left)} of {len(papers)} papers left: no server could take them. "
                      "Run again to resume.")
                return 1
        else:
            for p in papers:
                try:
                    answers = check_paper(p, a.url)
                except C.Unavailable as e:
                    print(f"  stopped: {e}. Run again to resume.")
                    return 1
                record(p, answers)
    C.counts_header("Checked", [("codings checked", n["ok"]), ("model calls", n["calls"]),
                                ("answers to ask again (malformed)", n["missing"]),
                                ("minutes", round((time.time() - t0) / 60, 1))])
    print("Nothing in the corpus changed. Next: check_codes.py report.")
    return 0


def cmd_report(a) -> int:
    corpus = Path(a.corpus)
    books, exts, titles, codings = load(corpus, a.set, None)
    active = {c["coding_id"]: c for c in codings}
    done = {k: v for k, v in done_ids(state_file(corpus, a.checker, a.set)).items() if k in active}
    if not done:
        C.die("nothing checked yet: run check_codes.py run first")
    per = collections.defaultdict(collections.Counter)
    for v in done.values():
        per[v["codebook"]][v["fits"]] += 1
        per[v["codebook"]]["reason not ok"] += 0 if v["reason_ok"] and not v.get("flags") else 1
    print(f"## Checked {len(done)} of {len(active)} active passage codings in {a.set} ({a.checker})\n")
    print(f"  {'codebook':<26} {'checked':>7} {'fits':>6} {'partly':>6} {'no':>5} {'reason?':>8}")
    for slug in sorted(per):
        c = per[slug]
        n = c["yes"] + c["partly"] + c["no"]
        print(f"  {slug:<26} {n:>7} {c['yes'] / n:>6.0%} {c['partly'] / n:>6.0%} {c['no']:>5} {c['reason not ok']:>8}")
    rows = []
    for cid, v in done.items():
        k = kind_of(v)
        if not k:
            continue
        c, ext = active[cid], exts[active[cid]["target"]["id"]]
        rows.append({"apply": "", "kind": k, "coding_id": cid, "paper": titles.get(v["source_id"], "")[:90],
                     "codebook": v["codebook"], "code": v["code"], "fits": v["fits"], "better": v["better"],
                     "reason_ok": "yes" if v["reason_ok"] else "no", "checker_why": v["why"],
                     "stored_reason": c.get("rationale", ""), "flags": " ".join(v.get("flags") or []),
                     "passage": " ".join(quote_of(ext).split())[:600], "extraction_id": ext["extraction_id"]})
    rows.sort(key=lambda r: (KINDS.index(r["kind"]), r["codebook"], r["code"]))
    kinds = collections.Counter(r["kind"] for r in rows)
    print(f"\n  to decide: {len(rows)} (wrong code {kinds['wrong']}, no code fits {kinds['none']}, "
          f"reason not a reason {kinds['reason']})")
    if a.out:
        with open(a.out, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=SHEET)
            w.writeheader()
            w.writerows(rows)
        print(f"  review sheet: {a.out} (put yes in `apply` for each change you approve, then check_codes.py apply)")
    return 0


def changes_from(rows: list[dict], verdicts: dict[str, dict], checker: str, approved_by: str) -> list[dict]:
    """Approved sheet rows (or verdicts) → `upc recode` lines. A row whose verdict is gone is skipped."""
    out = []
    for r in rows:
        v = verdicts.get(r["coding_id"])
        if not v:
            continue
        k = kind_of(v)
        why = f"{v['why']} (checked by {checker}; approved by {approved_by})"
        if k == "wrong":
            out.append({"coding_id": r["coding_id"], "to": v["better"], "coder": checker, "why": why})
        elif k == "none":
            out.append({"coding_id": r["coding_id"], "retract": True, "why": why})
        elif k == "reason" and v["why"] and not v.get("why_flags"):
            out.append({"coding_id": r["coding_id"], "to": v["code"], "coder": checker, "why": why,
                        "rationale": v["why"]})
    return out


def cmd_apply(a) -> int:
    corpus = Path(a.corpus)
    verdicts = done_ids(state_file(corpus, a.checker, a.set))
    if a.sheet:
        with open(a.sheet, newline="", encoding="utf-8") as f:
            rows = [r for r in csv.DictReader(f) if (r.get("apply") or "").strip().lower() in ("yes", "y", "x", "✓")]
    else:
        accept = set(filter(None, a.accept.split(",")))
        if not accept or accept - set(KINDS):
            C.die(f"--accept takes some of {','.join(KINDS)}")
        rows = [{"coding_id": k} for k, v in verdicts.items() if kind_of(v) in accept]
    changes = changes_from(rows, verdicts, a.checker, a.approved_by)
    if not changes:
        print("Nothing approved to apply.")
        return 0
    args = ["recode", "--corpus", str(corpus), "--set", a.set, "--coder-kind", "model", "--model", a.model,
            "--tool", "check_codes.py",
            "--why", f"Checked by {a.checker} ({PROMPT_VERSION}); changes approved by {a.approved_by}."]
    if a.dry_run:
        args.append("--dry-run")
    out = C.upc(*args, stdin="\n".join(json.dumps(c, ensure_ascii=False) for c in changes) + "\n", check=False)
    tally = out.get("tally", {}) if isinstance(out, dict) else {}
    C.counts_header("Applied" + (" (dry run)" if a.dry_run else ""), [
        ("approved rows", len(rows)), ("changes sent", len(changes)),
        *[(k, n) for k, n in sorted(tally.items())]])
    if not a.dry_run:
        C.upc("regen", "--corpus", str(corpus), check=False)
        rep = C.upc("validate", "--corpus", str(corpus), "--level", "L2", check=False)
        print(f"  corpus: {rep.get('status') if isinstance(rep, dict) else rep}, "
              f"{len(rep.get('errors', [])) if isinstance(rep, dict) else '?'} errors. Rebuild the site to show it.")
    return 0 if not any(k in tally for k in ("error", "invalid")) else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "run", "report", "apply"):
        p = sub.add_parser(name)
        p.add_argument("--corpus", required=True)
        p.add_argument("--set", required=True, help="the coding set (cds-…)")
        p.add_argument("--codebook", default="", help="only these codebook slugs, comma-separated")
        p.add_argument("--batch", type=int, default=10, help="passages a call")
        if name != "plan":
            p.add_argument("--checker", required=True, help="the checker's handle, e.g. <project>-27b-check-v1")
        if name == "run":
            p.add_argument("--model", default="chat")
            p.add_argument("--url", default=C.TASK_URL)
            p.add_argument("--pool", action="store_true",
                           help="check papers on every server in the machine's pool at once (one worker each)")
            p.add_argument("--context", default="", help="one line on the project, for the checker")
            p.add_argument("--sample", type=int, default=0, help="check a random sample of N codings")
            p.add_argument("--papers", type=int, default=0, help="check every coding of N random papers")
            p.add_argument("--seed", type=int, default=1)
            p.add_argument("--limit", type=int, default=0, help="at most N papers")
        if name == "report":
            p.add_argument("--out", default="", help="write the review sheet (CSV) here")
        if name == "apply":
            p.add_argument("--approved-by", required=True, help="the person approving the changes")
            p.add_argument("--sheet", default="", help="the review sheet with `apply` filled in")
            p.add_argument("--accept", default="", help="instead of a sheet: every change of these kinds")
            p.add_argument("--model", default="chat", help="the checker's model, for the record")
            p.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.cmd == "apply" and bool(a.sheet) == bool(a.accept):
        C.die("apply needs exactly one of --sheet or --accept")
    return {"plan": cmd_plan, "run": cmd_run, "report": cmd_report, "apply": cmd_apply}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
