#!/usr/bin/env python3
"""Turn a plain codebook definition file into minted UPC codebooks.

    python3 make_codebooks.py --corpus <dir> --defs codebooks.json [--plan]

The definition file is the thing a researcher actually edits — a list of
codebooks, each a list of codes with a definition and an example or two:

    [
      {"slug": "theory", "title": "Theory or framework", "unit": "either",
       "multi_label": true,
       "question": "Which transitions theory does this passage invoke?",
       "codes": [
         {"code": "mlp", "label": "Multi-level perspective",
          "definition": "Explains transitions through niche, regime and landscape. Not any mention of levels.",
          "examples": ["niche-innovations build up internal momentum"]}
       ]}
    ]

Ids are minted by the CLI, never here: a codebook's id is a hash of
(namespace, slug) alone, so its codes can be edited freely afterwards without
re-minting anything or dangling a single existing coding.

Editing an existing codebook is safe and expected: this rewrites the codes,
bumps `revision`, and recomputes `revision_digest`. Codings already made keep
pointing at the same codebook and record which revision they were made under,
so the validator can tell you where a judgement predates a definition change.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402

GOOD_DEF = 40   # a definition shorter than this is usually too vague to code against


def revision_digest(codes: list[dict]) -> str:
    """JCS-canonical digest of the codes array — computed by Node, like every hash."""
    script = ('import("%s/upc_common.mjs").then(m=>{let s="";'
              'process.stdin.on("data",d=>s+=d).on("end",()=>'
              'console.log(m.codebookRevisionDigest(JSON.parse(s))))})') % (
        str(Path(C.UPC_CLI[-1]).parent))
    p = subprocess.run(["node", "-e", script], input=json.dumps(codes),
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise C.Unavailable(f"could not compute the codebook digest: {p.stderr[:200]}")
    return p.stdout.strip()


def build_codebook(corpus: Path, b: dict, namespace: str) -> tuple[dict, Path, str, list[str]]:
    """One definition -> (minted codebook, its file, new|revised|unchanged,
    warnings). Minting goes through the CLI; nothing is written here."""
    warnings = []
    codes = []
    seen = set()
    for c in b["codes"]:
        if c["code"] in seen:
            warnings.append(f"{b['slug']}: duplicate code {c['code']} — the second was dropped")
            continue
        seen.add(c["code"])
        entry = {"code": c["code"], "label": c.get("label", c["code"])}
        if c.get("definition"):
            entry["definition"] = c["definition"]
            if len(c["definition"]) < GOOD_DEF:
                warnings.append(f"{b['slug']}/{c['code']}: definition is very short; "
                                f"a coder (human or model) will guess")
        else:
            warnings.append(f"{b['slug']}/{c['code']}: no definition")
        if c.get("examples"):
            entry["examples"] = c["examples"]
        if c.get("parent"):
            entry["parent"] = c["parent"]
        codes.append(entry)

    obj = {
        "codebook_id": "",
        "namespace": namespace,
        "slug": b["slug"],
        "title": b.get("title", b["slug"]),
        "closed": bool(b.get("closed", True)),
        "multi_label": bool(b.get("multi_label", False)),
        "unit": b.get("unit", "passage"),
        "revision": 1,
        "codes": codes,
        "provenance": {
            "produced_by": {"tool": b.get("tool", "upc-corpus"), "method": b.get("method", "manual")},
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    }
    if b.get("question"):
        obj["question"] = b["question"]
    if b.get("ext"):
        # e.g. {"upc-site": {"group": "evidence"}} (UPC 1.15.0); not part of the id
        obj["ext"] = b["ext"]

    cbk_id = C.upc("mint", "cbk", stdin=json.dumps(obj))
    obj["codebook_id"] = cbk_id if isinstance(cbk_id, str) else cbk_id.get("codebook_id")
    dest = corpus / "codebooks" / f"{obj['codebook_id']}.json"

    # An edit keeps the id and the creation stamp, and bumps the revision.
    prior = C.load_json(dest)
    if prior:
        obj["provenance"] = prior.get("provenance", obj["provenance"])
        same = json.dumps(prior.get("codes"), sort_keys=True) == json.dumps(codes, sort_keys=True)
        obj["revision"] = prior.get("revision", 1) if same else prior.get("revision", 1) + 1
    obj["revision_digest"] = revision_digest(codes)
    status = ("unchanged" if prior and obj["revision"] == prior.get("revision") else
              "revised" if prior else "new")
    return obj, dest, status, warnings


def write_codebooks(corpus: Path, rows: list[tuple[dict, Path, str]]) -> dict:
    """Save minted codebooks, then regenerate and validate the corpus."""
    (corpus / "codebooks").mkdir(parents=True, exist_ok=True)
    for obj, dest, _ in rows:
        C.save_json(dest, obj)
    C.upc("regen", str(corpus))
    rep = C.upc("validate", str(corpus))
    return rep if isinstance(rep, dict) else {}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--defs", required=True)
    ap.add_argument("--namespace", default="", help="required for a new corpus; default: the corpus's own")
    ap.add_argument("--plan", action="store_true")
    args = ap.parse_args()

    corpus = Path(args.corpus).expanduser()
    defs = C.load_json(args.defs)
    if not defs:
        C.die(f"{args.defs} is missing or not JSON")
    try:
        C.check_compat()
    except C.Unavailable as e:
        C.die(str(e))
    namespace = C.namespace_of(corpus, args.namespace)

    rows, warnings = [], []
    for b in defs:
        obj, dest, status, notes = build_codebook(corpus, b, namespace)
        rows.append((obj, dest, status))
        warnings.extend(notes)

    C.counts_header("Codebooks", [
        ("codebooks defined", len(rows)),
        ("codes in total", sum(len(o["codes"]) for o, _, _ in rows)),
        ("new", sum(1 for *_, s in rows if s == "new")),
        ("revised", sum(1 for *_, s in rows if s == "revised")),
        ("unchanged", sum(1 for *_, s in rows if s == "unchanged")),
        ("corpus", str(corpus)),
    ])
    for obj, dest, status in rows:
        units = obj["unit"]
        print(f"  {status:9} {obj['slug']:22} {obj['codebook_id']}  "
              f"{len(obj['codes']):2} codes · unit {units}"
              f"{' · multi-label' if obj['multi_label'] else ''}")
    for w in warnings[:20]:
        print(f"  NOTE {w}")

    if args.plan:
        print("\nPlanning only; nothing was written.")
        return 0

    rep = write_codebooks(corpus, rows)
    print(f"\nWrote {len(rows)} codebooks. Corpus: {rep.get('status')} {rep.get('level')}, "
          f"{len(rep.get('errors', []))} errors.")
    for e in rep.get("errors", [])[:5]:
        print(f"  ERROR {e.get('code')}: {str(e.get('detail'))[:100]}")
    print("Codebooks written.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
