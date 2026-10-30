#!/usr/bin/env python3
"""Turn a finished corpus into the thing you actually hand someone.

    python3 publish.py --corpus <dir> --out <dir> --name Library-literature \\
                       [--matrix theory:analytical-dimension] [--pdfs] [--zip] [--folder-site]

Produces, in `--out`:

    <name>.html            one self-contained file: passages, codes, overviews,
                           the matrix, and the full reading copy of every paper
    <name>-light.html      the same without the reading copies (a fifth of the size)
    <name>_files/          the original PDFs, if --pdfs — every passage links to
                           its own page in them
    <name>.zip             all of the above, if --zip
    <name>-site/           the multi-page version, if --folder-site

Why both shapes: the folder version has real URLs, one page per source and prints
a theme cleanly, but it only works opened from *inside* its folder — send someone
its index page alone and every link is dead. The single file has no such trap. It
is the one to email; the folder is the one to host.

Both browse identically: a sidebar of checkable codes on Passages and on each code
page, a list built as it is scrolled, and Overviews as a list beside the review
being read. That needs `upc` 1.10 or newer; on an older CLI the same corpus still
publishes, with the previous dropdown filters.

`paginate.py` should have run first, or the PDF links will point at a file rather
than a page. This says so rather than quietly producing weaker links.

A PDF over `--max-pdf-mib` (default 25: Cloudflare Pages takes no file larger) stays
out of both bundles, unlinked, and its paper's page says so. They are listed here and
in `<name>-left-out.json` beside the outputs.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402


def pages_present(corpus: Path) -> tuple[int, int]:
    total = with_page = 0
    files = list(corpus.glob("sources/*/extractions.jsonl")) + list(corpus.glob("extractions/*/items.jsonl"))
    for f in files:
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            o = json.loads(line)
            if not o.get("direct_quote"):
                continue
            total += 1
            if C.place_of(o):  # a page, or a full-text XML's section (paginate.py does both)
                with_page += 1
    return with_page, total


def human(n: int) -> str:
    return f"{n / 1e6:.1f} MB" if n >= 1e6 else f"{n / 1e3:.0f} KB"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", default="corpus")
    ap.add_argument("--matrix", default="")
    ap.add_argument("--pdfs", action="store_true", help="copy the PDFs beside the file and link every passage to its page")
    ap.add_argument("--zip", dest="do_zip", action="store_true", help="also write one .zip of everything")
    ap.add_argument("--folder-site", action="store_true", help="also write the multi-page version")
    ap.add_argument("--about", default="", help="a Methods page from this Markdown file (UPC 1.15.0)")
    ap.add_argument("--original-edition", default="",
                    help="URL of the edition a revised overview links back to, e.g. https://example.org/library/1.0/")
    ap.add_argument("--findings", default="",
                    help="starting points and wording for the Findings pages (JSON; UPC 1.15.0). "
                         "Default: <corpus>/.upc/upc-corpus/site/findings.json when it exists")
    ap.add_argument("--list", default="", help="an annotated list page on the folder site, from sources_table.py --json")
    ap.add_argument("--criteria", default="", help="a Criteria page on the folder site, from this Markdown file (pipe tables work)")
    ap.add_argument("--max-pdf-mib", type=float, default=25,
                    help="leave out of the bundles any PDF larger than this (MiB; 0 = no limit)")
    ap.add_argument("--plan", action="store_true")
    args = ap.parse_args()

    corpus = Path(args.corpus).expanduser()
    out = Path(args.out).expanduser()
    try:
        C.check_compat()
    except C.Unavailable as e:
        C.die(str(e))

    rep = C.upc("validate", str(corpus))
    if not isinstance(rep, dict):
        C.die("validate did not return a report; fix that before publishing")
    errors = len(rep.get("errors", []))
    with_page, total = pages_present(corpus)

    C.counts_header("Publishing", [
        ("corpus", f"{rep.get('status')} at {rep.get('level')}, {errors} errors"),
        ("sources", rep.get("counts", {}).get("sources", "?")),
        ("passages", rep.get("counts", {}).get("extractions", "?")),
        ("syntheses (overviews + summaries)", rep.get("counts", {}).get("syntheses", 0)),
        ("passages with a page number", f"{with_page} of {total}"),
        ("into", str(out)),
    ])
    if errors:
        print("Refusing to publish a corpus that does not validate. Fix the errors first.")
        return 1
    import citations as CIT  # noqa: E402
    if CIT.impact_codings(corpus):
        n_ok, problems = CIT.check(corpus)
        if problems:
            print(f"Refusing to publish: {len(problems)} citation figures aren't found again in ASR's payloads "
                  f"(citations.py check --corpus {corpus}).")
            for p in problems[:5]:
                print(f"  {p}")
            return 1
        print(f"  citation figures: all {n_ok} found again in ASR's payloads")
    if args.pdfs and with_page < total:
        print(f"  NOTE {total - with_page} passages have no page or section — run paginate.py first")
        print("       for links that open the PDF at the right page rather than page 1.")
    if args.plan:
        print("Planning only; nothing was written.")
        return 0

    out.mkdir(parents=True, exist_ok=True)
    made, t0 = [], time.time()
    mx = ["--matrix", args.matrix] if args.matrix else []
    if args.about:
        mx += ["--about", str(Path(args.about).expanduser().resolve())]
    if args.original_edition:
        mx += ["--original-edition", args.original_edition]
    findings = Path(args.findings).expanduser() if args.findings else corpus / ".upc" / "upc-corpus" / "site" / "findings.json"
    if findings.exists():
        mx += ["--findings", str(findings.resolve())]
    elif args.findings:
        C.die(f"no such file: {findings}")
    if args.list:
        mx += ["--list", str(Path(args.list).expanduser().resolve())]
    if args.criteria:
        mx += ["--criteria", str(Path(args.criteria).expanduser().resolve())]

    cap = ["--max-file-bytes", str(int(args.max_pdf_mib * 1048576))] if args.max_pdf_mib > 0 else []
    full = out / f"{args.name}.html"
    r = C.upc("export", str(corpus), "--format", "site-one", "-o", str(full), *mx,
              *(["--bundle", *cap] if args.pdfs else []))
    made.append((full, r if isinstance(r, dict) else {}))

    light = out / f"{args.name}-light.html"
    C.upc("export", str(corpus), "--format", "site-one", "--no-text", "-o", str(light), *mx)
    made.append((light, {}))

    if args.folder_site:
        site = out / f"{args.name}-site"
        rs = C.upc("export", str(corpus), "--format", "site", "-o", str(site), *mx, "--bundle", *cap)
        made.append((site, rs if isinstance(rs, dict) else {}))

    # PDFs too large for the host: left out of every bundle, recorded once.
    left = {x["file"]: x for _, meta in made for x in meta.get("left_out") or []}
    left_rec = out / f"{args.name}-left-out.json"
    if left:
        C.save_json(left_rec, {"max_bytes": int(args.max_pdf_mib * 1048576),
                               "why": "larger than the host takes in one file; not copied and not linked, "
                                      "and the paper's page says so",
                               "files": sorted(left.values(), key=lambda x: x["source"])})
    else:
        left_rec.unlink(missing_ok=True)

    files_dir = out / f"{args.name}_files"
    if args.do_zip:
        # Zip the file plus its PDFs, so one thing travels.
        stage = out / f".{args.name}-zip"
        shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir(parents=True)
        shutil.copy2(full, stage / full.name)
        shutil.copy2(light, stage / light.name)
        if files_dir.exists():
            shutil.copytree(files_dir, stage / files_dir.name)
        archive = shutil.make_archive(str(out / args.name), "zip", root_dir=str(stage))
        shutil.rmtree(stage, ignore_errors=True)
        made.append((Path(archive), {}))

    rows = []
    for p, meta in made:
        if p.is_dir():
            size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
            rows.append((p.name + "/", human(size), f"{sum(1 for _ in p.rglob('*.html'))} pages"))
        else:
            rows.append((p.name, human(p.stat().st_size),
                         f"{meta.get('pdfs_bundled', 0)} PDFs bundled" if meta.get("pdfs_bundled") else ""))
    if files_dir.exists():
        size = sum(f.stat().st_size for f in files_dir.rglob("*") if f.is_file())
        rows.append((files_dir.name + "/", human(size), "the original PDFs"))

    if left:
        print(f"Left out {len(left)} PDFs over {args.max_pdf_mib:g} MiB (listed in {left_rec.name}):")
        for x in sorted(left.values(), key=lambda x: x["source"]):
            print(f"  {x['file']}  {human(x['bytes'])}  ({x['source']})")
    print("Written:")
    w = max(len(r[0]) for r in rows)
    for name, size, note in rows:
        print(f"  {name.ljust(w)}  {size.rjust(9)}  {note}")
    print(f"\nHand over `{args.name}.html`"
          + (f" together with `{args.name}_files/`" if args.pdfs else "")
          + (f", or just `{args.name}.zip`" if args.do_zip else "") + ".")
    print("It opens with no internet, no server and nothing else installed.")
    print(f"Took {time.time() - t0:.0f}s. Publishing finished.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
