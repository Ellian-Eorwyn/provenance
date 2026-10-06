#!/usr/bin/env python3
"""Code spreadsheets (CSV, TSV, JSONL, Excel) against a codebook, one unit at a
time, with every quotation tied to exact characters of a cell.

    python3 -u tables.py init    --run <dir> --input <folder|file> ... --codebook <file> --question "<q>" [--describe]
    python3 -u tables.py units   --run <dir> --draft | --check | --approve --by <name>
    python3 -u tables.py code    --run <dir> --part <P> (--ids a,b | --sample N | --all) [--dry-run] [--plan] [--detach]
    python3 -u tables.py screen  --run <dir> --screen <name> [--calibrate] [--sheet N] [--plan] [--detach]
    python3 -u tables.py draft-parts --run <dir> --screen <name>
    python3 -u tables.py export  --run <dir>
    python3 -u tables.py agree   --run <dir> --part <P> --fields F1,F2 --n 25 | --ingest <sheet.csv> --coder <name> | --review
    python3 -u tables.py publish --run <dir> --corpus <dir> [--limit N] [--pseudonymize] [--plan]
    python3 -u tables.py markdown --run <dir> --part <P> --out <dir>
    python3 -u tables.py status  --run <dir>

A run folder (default under ~/Documents/Table Coding/) holds byte copies of the
inputs, the profile, the unit spec (units.json), codings, screening, drafts and
exports. Nothing is ever written into an input's folder or the codebook's
folder. Every command prints its counts first and ends with the next command.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402
import tables_data as D  # noqa: E402
import tables_model as M  # noqa: E402

DEFAULT_ROOT = Path("~/Documents/Table Coding").expanduser()
SECONDS_GUESS = 12.0


# --- shared ---------------------------------------------------------------------

def open_run(path: str) -> D.Run:
    run = D.Run(path)
    if not run.config_path.exists():
        C.die(f"{run.root} is not a table-coding run (no config.json); start with `init`")
    return run


def next_step(run: D.Run, text: str) -> None:
    print(f"Next: {text}")
    write_readme(run, text)


def write_readme(run: D.Run, next_text: str = "") -> None:
    cfg = run.config
    lines = [f"# {cfg.get('name', run.root.name)}", "",
             "A table-coding run of the upc-corpus skill (`scripts/tables.py`). This file is rewritten by the "
             "script after every command; do not edit it.", ""]
    if cfg.get("question"):
        lines += [f"**Research question.** {cfg['question']}", ""]
    lines += ["## Inputs (byte copies in `inputs/`, checked by sha256)", ""]
    for i in cfg.get("inputs", []):
        lines.append(f"- `{i['name']}`: {i['source_path']}")
    if cfg.get("codebook"):
        lines.append(f"- codebook: {cfg['codebook']['source_path']}")
    lines += ["", "## Where things are", "",
              "- `PROFILE.md`: what every column holds, keys and links between tables.",
              "- `units.json` / `UNITS.md`: what one unit of each codebook part is, and exactly what the model sees.",
              "- `coded/<part>.<coder>.jsonl`: one record per unit (codes, evidence spans, hashes).",
              "- `exports/`: coded CSV and Excel files; `evidence.csv` lists every cited sentence.",
              "- `screen/`: relevance screening; `RELEVANCE-<screen>.md` summarises each screen.",
              "- `drafts/`: codebook parts drafted by the model for review.",
              "- `agree/`: agreement sheets and `AGREEMENT.md`.", ""]
    counts = status_counts(run)
    if counts:
        lines += ["## Status", ""] + [f"- {k}: {v}" for k, v in counts] + [""]
    if next_text:
        lines += ["## Next", "", next_text, ""]
    lines += ["## Commands", "", "```",
              f"python3 -u {Path(__file__).resolve()} status --run \"{run.root}\"",
              f"python3 -u {Path(__file__).resolve()} code --run \"{run.root}\" --part <part> --dry-run --ids <id>",
              "```", ""]
    try:
        run.write_text(run.path("README.md"), "\n".join(lines))
    except D.GuardError:
        pass


def status_counts(run: D.Run) -> list[tuple[str, object]]:
    out = []
    try:
        spec = run.spec()
    except D.SpecError:
        return [("units.json", "not drafted yet")]
    out.append(("units.json", "approved" if spec.get("approved", {}).get("spec_sha") == run.spec_sha() else "draft (not approved)"))
    try:
        tables = run.tables()
    except D.GuardError as e:
        return out + [("inputs", f"PROBLEM: {e}")]
    for part in spec.get("parts", {}):
        recs = run.coded(part)
        try:
            total = len(D.Renderer(tables, spec, part).units(screened_for(run, spec, part)))
        except (D.SpecError, KeyError):
            total = "?"
        invalid = sum(1 for r in recs.values() if r.get("_invalid"))
        out.append((f"{part}", f"{len(recs)} of {total} units coded ({invalid} with invalid values)"))
    for f in sorted(run.path("screen").glob("*.windows.jsonl")):
        rows = [json.loads(x) for x in f.read_text(encoding="utf-8").splitlines() if x.strip()]
        ok_windows = {r["window"] for r in rows if r["status"] == "ok"}
        still_failed = {r["window"] for r in rows if r["status"] != "ok"} - ok_windows  # retried windows are done
        listed = sum(len(r["rows"]) for r in rows if r["status"] == "ok")
        out.append((f"screen {f.name.split('.')[0]}",
                    f"{len(ok_windows)} windows done, {len(still_failed)} failed, {listed} rows listed"))
    return out


def load_everything(run: D.Run):
    tables = run.tables()
    codebook = run.codebook()
    spec = run.spec()
    return tables, codebook, spec


NOT_IN_PROMPT = {"export", "strata", "date_checks", "leak_check", "max_tokens", "screened", "_note", "markdown"}


def prompt_sha(spec: dict, tables, codebook, part: str) -> str:
    """Changes when anything the model sees could change (the system prompt, the
    rendering rules, the codebook), not when export or sampling settings do."""
    system = M.system_prompt(spec, tables, codebook, part)
    shown = {k: v for k, v in spec["parts"][part].items() if k not in NOT_IN_PROMPT}
    body = D.canonical_json({"system": system, "part": shown, "quote": spec.get("quote_blocks"),
                             "codebook": codebook.sha256})
    return D.sha256_text(body)[:12]


def coder_handle(run: D.Run, codebook: D.Codebook, model: str, psha: str) -> str:
    version = codebook.version or codebook.sha256[:6]
    return D.slug_token(f"{run.slug}-{model}-v{version}-{psha[:6]}")


def dependencies(spec: dict, part: str) -> list[str]:
    return [rel["include_codes"] for rel in spec["parts"][part].get("related", []) if rel.get("include_codes")]


def screened_for(run: D.Run, spec: dict, part: str) -> dict | None:
    route = spec["parts"][part].get("screened")
    if not route:
        return None
    return load_screen_rows(run, route["screen"])


def load_screen_rows(run: D.Run, screen: str) -> dict[str, dict]:
    path = run.path("screen", f"{screen}.windows.jsonl")
    out: dict[str, dict] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        w = json.loads(line)
        if w["status"] != "ok":
            continue
        for rid in w["ids"]:
            out.setdefault(rid, {"r": 0, "parts": [], "label": "", "why": "", "window": w["window"]})
        for r in w["rows"]:
            cur = out[r["id"]]
            if r["r"] > cur["r"]:
                out[r["id"]] = {**r, "window": w["window"]}
    return out


# --- init -------------------------------------------------------------------------

def cmd_init(a) -> int:
    run = D.Run(a.run)
    sources = D.discover_inputs(a.input)
    codebook = Path(a.codebook).expanduser().resolve() if a.codebook else None
    readonly = [str(Path(p).expanduser().resolve()) for p in (a.readonly or [])]
    roots = [Path(p) for p in readonly] + [s.parent.resolve() for s in sources] + ([codebook.parent] if codebook else [])
    for root in roots:
        if D._inside(run.root, root):
            C.die(f"the run folder {run.root} is inside a read-only folder ({root}); choose another place, "
                  f"e.g. {DEFAULT_ROOT / run.root.name}")
    if run.config_path.exists() and not a.refresh:
        C.die(f"{run.root} already has a run; use --refresh to take new versions of changed inputs")
    C.counts_header("Init plan", [
        ("run folder", run.root),
        ("input tables", len(sources)),
        ("codebook", codebook or "(none yet)"),
        ("read-only folders", len(set(roots))),
    ], notes=[f"input: {s}" for s in sources])
    if a.plan:
        print("Planning only; nothing was written.")
        return 0
    run.root.mkdir(parents=True, exist_ok=True)
    cfg = run.config if run.config_path.exists() else {}
    cfg.update({"name": a.name or cfg.get("name") or run.root.name,
                "question": a.question or cfg.get("question", ""),
                "readonly": sorted(set(readonly + cfg.get("readonly", []))),
                "inputs": [{"source_path": str(s)} for s in sources],
                "created": cfg.get("created") or time.strftime("%Y-%m-%dT%H:%M:%S"),
                "tool": "upc-corpus tables.py"})
    if codebook:
        cfg["codebook"] = {"source_path": str(codebook)}
    run.save_config(cfg)
    for d in D.RUN_DIRS:
        run.guard(run.path(d)).mkdir(parents=True, exist_ok=True)
    old = {i["name"]: i["sha256"] for i in (cfg.get("inputs_previous") or [])}
    snap = D.snapshot_inputs(run, sources, codebook)
    cfg["inputs"] = snap["inputs"]
    if snap["codebook"]:
        cfg["codebook"] = snap["codebook"]
    run.save_config(cfg)
    run._tables = None
    tables = run.tables()
    t0 = time.time()
    profile = D.profile_tables(tables)
    if a.describe:
        for name in tables:
            try:
                desc = M.describe_table(name, profile["tables"][name], model=a.model, url=a.url)
            except C.Unavailable as e:
                print(f"  UNAVAILABLE: describing {name}: {e}")
                break
            roles = {c: v["role"] for c, v in desc["columns"].items()}
            profile["tables"][name]["describe"] = desc
            profile["tables"][name]["role_warnings"] = D.check_roles(profile["tables"][name], roles, profile["links"], name)
            print(f"  described {name} in {desc['seconds']} s")
    run.write_json(run.path("profile.json"), profile)
    run.write_text(run.path("PROFILE.md"), profile_markdown(profile))
    changed = [i["name"] for i in snap["inputs"] if old.get(i["name"]) and old[i["name"]] != i["sha256"]]
    C.counts_header("Init result", [
        ("tables", ", ".join(f"{n} ({len(t.rows)})" for n, t in tables.items())),
        ("links found", sum(1 for link in profile["links"] if not link["partial"])),
        ("partial links", sum(1 for link in profile["links"] if link["partial"])),
        ("inputs changed since the last init", ", ".join(changed) or "none"),
        ("seconds", round(time.time() - t0, 1)),
    ])
    next_step(run, "read PROFILE.md, then draft the unit spec: "
                   f"`tables.py units --run \"{run.root}\" --draft`")
    return 0


def profile_markdown(profile: dict) -> str:
    out = ["# Profile", "", "What every column holds, measured by the script (and labelled by the model where "
           "`--describe` was used). Check the roles: they decide what is quotable and what is metadata.", ""]
    for name, tp in profile["tables"].items():
        desc = tp.get("describe") or {}
        out += [f"## {name} ({tp['rows']} rows)", ""]
        if desc.get("row_is"):
            out += [f"One row is: {desc['row_is']}", ""]
        out += [f"Keys: {', '.join(tp['keys']) or 'none'}", "",
                "| column | role | filled | distinct | length (median / max) | notes |", "|---|---|---|---|---|---|"]
        for c, f in tp["columns"].items():
            role = (desc.get("columns") or {}).get(c, {}).get("role", "")
            notes = []
            for k in ("date", "url", "list", "int", "bool"):
                if f[k] >= 0.8:
                    notes.append(k)
            if f["quote_blocks"]:
                notes.append("quote blocks " + ", ".join(f"{k} {v}" for k, v in f["quote_blocks"].items()))
            if f["newlines"] > 0.1:
                notes.append(f"multi-line {f['newlines']:.0%}")
            out.append(f"| {c} | {role} | {f['fill']:.0%} | {f['distinct']}{' (unique)' if f['unique'] else ''} | "
                       f"{f['len_p50']} / {f['len_max']} | {'; '.join(notes)} |")
        for w in tp.get("role_warnings", []):
            out.append(f"\n- CHECK: {w}")
        out.append("")
    out += ["## Links", "", "| from | to | list | prefix | share found |", "|---|---|---|---|---|"]
    for link in profile["links"]:
        pre = f"{link['transform']['strip'] or '∅'} → {link['transform']['add'] or '∅'}" if link["transform"] else ""
        out.append(f"| {link['from']} | {link['to']} | {'yes' if link['list'] else ''} | {pre} | "
                   f"{link['containment']:.0%}{' (partial)' if link['partial'] else ''} |")
    return "\n".join(out) + "\n"


# --- units --------------------------------------------------------------------------

def cmd_units(a) -> int:
    run = open_run(a.run)
    if a.draft:
        return units_draft(run, a)
    if a.approve:
        spec = run.spec()
        problems = D.validate_spec(spec, run.tables(), run.codebook())
        if problems:
            C.die("fix these before approving:\n  " + "\n  ".join(problems))
        spec["approved"] = {"by": a.by or "unknown", "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "spec_sha": run.spec_sha()}
        run.write_json(run.path("units.json"), spec)
        print(f"units.json approved by {spec['approved']['by']} ({spec['approved']['spec_sha']}).")
        next_step(run, f"`tables.py code --run \"{run.root}\" --part <part> --all --detach`")
        return 0
    return units_check(run, a)


def units_draft(run: D.Run, a) -> int:
    if run.path("units.json").exists() and not a.force:
        C.die("units.json exists; edit it by hand or pass --force to draft again")
    tables = run.tables()
    codebook = run.codebook()
    profile = json.loads(run.path("profile.json").read_text(encoding="utf-8"))
    parts = {}
    for part, cp in codebook.parts.items():
        parts[part] = draft_part_guess(part, cp, profile, tables)
    lookups = {}
    for f in codebook.fields.values():
        if f["lookup"] and f["lookup"] not in lookups:
            exact = [t for t in tables if D.slug_token(t).replace("-", "_") == f["lookup"].lower()]
            guess = (exact or [t for t in tables if D.slug_token(t).replace("-", "_") in f["lookup"].lower()]
                     or [t for t in tables if f["lookup"].lower().split("_")[-1] in t.lower()] or [None])[0]
            lookups[f["lookup"]] = {"table": guess or "?", "code": (profile["tables"].get(guess, {}).get("keys") or ["?"])[0],
                                    "label": "name", "definition": "", "date": ""}
    quote_style = next((style for tp in profile["tables"].values() for f in tp["columns"].values()
                        for style in f["quote_blocks"]), None)
    spec = {"format": D.UNITS_FORMAT, "question": run.config.get("question", ""),
            "quote_blocks": {"style": quote_style} if quote_style else {}, "lookups": lookups, "parts": parts,
            "screens": {}, "data_checks": [],
            "_note": "Drafted by tables.py units --draft from the profile and the codebook. Check every part: "
                     "table, id, text, related rows, context, blind, evidence speakers; then units --check."}
    run.write_json(run.path("units.json"), spec)
    problems = D.validate_spec(spec, tables, codebook)
    print(f"Drafted units.json for {len(parts)} parts.")
    for p in problems:
        print(f"  FIX {p}")
    next_step(run, f"edit units.json (see references/tables.md), then `tables.py units --run \"{run.root}\" --check`")
    return 0


def draft_part_guess(part: str, cp: dict, profile: dict, tables) -> dict:
    """A deterministic first guess: the table named in the part's unit text, its
    key, and its longest text column. Links and context are left to the editor."""
    unit_text = (cp.get("unit") or "").lower()
    best = None
    for t in tables:
        stem = t.lower()
        score = (3 if stem + ".csv" in unit_text or stem in unit_text else 0) + \
                sum(1 for w in stem.replace("_", " ").split() if w.rstrip("s") in unit_text) + \
                (0.5 if profile["tables"][t]["keys"] else 0)
        if best is None or score > best[0]:
            best = (score, t)
    t = best[1]
    tp = profile["tables"][t]
    key = (tp["keys"] or [next(iter(tp["columns"]))])[0]
    text_col = max(tp["columns"], key=lambda c: tp["columns"][c]["len_p50"] if tp["columns"][c]["len_p90"] >= 40 else -1)
    date_col = next((c for c, f in tp["columns"].items() if f["date"] >= 0.9), None)
    return {"table": t, "id": key, "code": "U", "header": ([{"column": date_col, "label": "Date", "format": "date"}] if date_col else []),
            "text": {"column": text_col, "label": "TEXT"}, "related": [], "context": [], "evidence": {},
            "instructions": ""}


def units_check(run: D.Run, a) -> int:
    tables, codebook, spec = load_everything(run)
    problems = D.validate_spec(spec, tables, codebook)
    if problems:
        print("## Problems in units.json\n")
        for p in problems:
            print(f"  FIX {p}")
        print()
        return 1
    coded_deps = {}
    lines = ["# Units", "", "What one unit of each codebook part is, and what the model is shown. Written by "
             "`tables.py units --check`.", ""]
    issues = []
    summary = []
    for part in spec["parts"]:
        pspec = spec["parts"][part]
        renderer = D.Renderer(tables, spec, part, coded=coded_deps)
        screened = screened_for(run, spec, part)
        units = renderer.units(screened)
        n = len(units)
        with_text = with_context = multi = 0
        sizes = []
        leak_units = []
        empty_related = 0
        ex_multi = None
        ctx_before = [c for c in pspec.get("context", []) if c.get("before")]
        for uid, unit, seg in units:
            r = renderer.render(unit, segment=seg, unit_id=uid)
            sizes.append(len(r.text))
            if r.speakers.get(pspec.get("code", "U")):
                with_text += 1
            if ctx_before and any(b["code"].startswith(ctx_before[0].get("code_before", "E")) for b in r.blocks):
                with_context += 1
            rel_counts = Counter(b["code"].rstrip("0123456789") for b in r.blocks)
            for rel in pspec.get("related", []):
                if rel_counts.get(rel["code"], 0) == 0:
                    empty_related += 1
                if rel_counts.get(rel["code"], 0) > 1:
                    multi += 1
                    ex_multi = ex_multi or uid
            if pspec.get("blind") and pspec.get("leak_check"):
                hidden = []
                for lc in pspec["leak_check"]:
                    hidden += [row.get(lc["column"], "") for _t, row in D.resolve_path(tables, [unit], lc["path"])]
                hits = D.leak_check(r.text, hidden, (spec.get("quote_blocks") or {}).get("style"))
                if hits:
                    leak_units.append((uid, hits[0]))
            if not r.speakers.get(pspec.get("code", "U")):
                issues.append({"part": part, "unit": uid, "issue": "no text of its own to code"})
        for uid, hit in leak_units:
            issues.append({"part": part, "unit": uid, "issue": f"blind leak candidate: {hit[:60]}"})
        forced = [f for f in codebook.parts[part]["fields"] if codebook.fields[f]["type"] == "single"
                  and not set(D.field_values(spec, tables, codebook, f, part) or {}) & {"unclear", "not_applicable", "none"}]
        sizes.sort()
        summary.append((part, n, with_text, with_context, multi, empty_related, len(leak_units), sizes))
        lines += [f"## {part}", "", f"- unit: {codebook.parts[part].get('unit', '')}",
                  f"- units: {n}; with text of their own: {with_text}"
                  + (f"; with earlier context: {with_context} ({with_context / max(1, n):.0%})" if ctx_before else "")
                  + (f"; with more than one related row: {multi}" if pspec.get("related") else "")
                  + (f"; with no related row: {empty_related}" if pspec.get("related") else ""),
                  f"- prompt text per unit (characters): median {D.percentile(sizes, 0.5)}, p90 {D.percentile(sizes, 0.9)}, "
                  f"max {sizes[-1] if sizes else 0}",
                  f"- blind: {'yes' if pspec.get('blind') else 'no'}"
                  + (f"; leak candidates: {len(leak_units)}" if pspec.get("blind") else ""),
                  f"- evidence: " + (", ".join(f"{k} ← {'/'.join(v)}" for k, v in (pspec.get('evidence') or {}).items()) or "none"),
                  f"- forced choice (no unclear/not_applicable/none): {', '.join(forced) or 'none'}", ""]
        if units:
            example = ex_multi or units[0][0]
            ex = next(u for u in units if u[0] == example)
            r = renderer.render(ex[1], segment=ex[2], unit_id=ex[0])
            lines += [f"Example ({example}):", "", "```", r.text[:4000] + (" …" if len(r.text) > 4000 else ""), "```", ""]
    for check in spec.get("data_checks", []):
        part = check["part"]
        renderer = D.Renderer(tables, spec, part)
        cache: dict = {}
        for uid, (t, row), _seg in renderer.units():
            if all(D._cond_ok(tables, t, row, cond, cache) for cond in check.get("where", [])):
                issues.append({"part": part, "unit": uid, "issue": check["name"]})
    import csv as _csv  # noqa: PLC0415
    import io  # noqa: PLC0415
    buf = io.StringIO()
    w = _csv.DictWriter(buf, fieldnames=["part", "unit", "issue"])
    w.writeheader()
    w.writerows(issues)
    run.write_text(run.path("data_issues.csv"), buf.getvalue())
    run.write_text(run.path("UNITS.md"), "\n".join(lines))
    rows = []
    for part, n, wt, wc, mu, er, lk, sizes in summary:
        rows.append((part, f"{n} units, {wt} with own text, {wc} with context, {mu} multi-related, "
                           f"{er} without related rows, {lk} leak candidates"))
    rows.append(("data issues", f"{len(issues)} (data_issues.csv)"))
    rows.append(("approved", "yes" if spec.get("approved", {}).get("spec_sha") == run.spec_sha() else "no"))
    C.counts_header("Units check", rows)
    next_step(run, "read UNITS.md; try one unit with "
                   f"`tables.py code --run \"{run.root}\" --part <part> --dry-run --ids <id>`; approve with "
                   f"`tables.py units --run \"{run.root}\" --approve --by <name>`")
    return 0


# --- code ---------------------------------------------------------------------------

def cmd_code(a) -> int:
    run = open_run(a.run)
    if a.detach:
        return detach(run, "code", a)
    tables, codebook, spec = load_everything(run)
    problems = D.validate_spec(spec, tables, codebook)
    if problems:
        C.die("units.json has problems (run `units --check`):\n  " + "\n  ".join(problems))
    if a.part not in spec["parts"]:
        C.die(f"unknown part {a.part}; parts: {', '.join(spec['parts'])}")
    if not (a.ids or a.sample or a.all):
        C.die("choose the units: --ids a,b  or  --sample N  or  --all")
    drift = run.source_drift()
    if a.all and spec.get("approved", {}).get("spec_sha") != run.spec_sha():
        C.die("a full run needs an approved units.json (`units --approve --by <name>`); pilots may use --sample or --ids")
    return code_part(run, tables, codebook, spec, a.part, a, drift, top=True)


def select_units(renderer: D.Renderer, part: dict, a, screened: dict | None) -> list:
    units = renderer.units(screened)
    if a.ids:
        wanted = [x.strip() for x in a.ids.split(",") if x.strip()]
        by_id = {u[0]: u for u in units}
        missing = [w for w in wanted if w not in by_id]
        if missing:
            print(f"  NOTE not units of this part: {', '.join(missing[:10])}")
        return [by_id[w] for w in wanted if w in by_id]
    if a.sample:
        return M.stratified_sample(units, a.sample, M.strata_key(part), seed=a.seed)
    if a.all:
        if screened:
            units.sort(key=lambda u: -(screened.get(u[1][1].get(part["id"], "").strip(), {}).get("r", 0)))
        return units
    return []


def code_part(run: D.Run, tables, codebook, spec, part: str, a, drift, *, top: bool, only: list | None = None) -> int:
    pspec = spec["parts"][part]
    psha = prompt_sha(spec, tables, codebook, part)
    coder = a.coder if (a.coder and top) else coder_handle(run, codebook, a.model, psha)
    out_path = run.path("coded", f"{part}.{coder}.jsonl")
    coded_deps = {dep: run.coded_values(dep) for dep in dependencies(spec, part)}
    renderer = D.Renderer(tables, spec, part, coded=coded_deps)
    screened = screened_for(run, spec, part)
    todo_units = only if only is not None else select_units(renderer, pspec, a, screened)
    # dependencies first: the rows a unit shows with their codes must be coded
    for rel in pspec.get("related", []):
        dep = rel.get("include_codes")
        if not dep:
            continue
        dep_renderer = D.Renderer(tables, spec, dep)
        dep_units = {u[0]: u for u in dep_renderer.units(screened_for(run, spec, dep))}
        need_ids = []
        for _uid, unit, _seg in todo_units:
            for _t, r in D.resolve_path(tables, [unit], rel["path"]):
                rid = r.get(rel["id"], "").strip()
                if rid in dep_units and rid not in coded_deps.get(dep, {}) and rid not in need_ids:
                    need_ids.append(rid)
        if need_ids:
            print(f"Coding {len(need_ids)} {dep} unit(s) first (shown to {part} with their codes).")
            if not a.plan and not a.dry_run:
                rc = code_part(run, tables, codebook, spec, dep, a, drift, top=False, only=[dep_units[i] for i in need_ids])
                if rc:
                    return rc
            coded_deps[dep] = run.coded_values(dep)
    renderer = D.Renderer(tables, spec, part, coded=coded_deps)
    done = run.coded(part, coder)
    todo, stale = [], []
    for u in todo_units:
        rec = done.get(u[0])
        if rec is None:
            todo.append(u)
        elif not a.dry_run:
            r = renderer.render(u[1], segment=u[2], unit_id=u[0])
            if rec.get("case_sha") != r.sha256:
                stale.append(u)
    if a.recode_stale:
        todo += stale
    timing = [json.loads(x).get("seconds", 0) for x in out_path.read_text(encoding="utf-8").splitlines()[-50:]] \
        if out_path.exists() else []
    per_unit = (sum(timing) / len(timing)) if timing else SECONDS_GUESS
    if top or a.plan:
        C.counts_header(f"Code plan: {part}", [
            ("units selected", len(todo_units)),
            ("already coded by this coder", len(todo_units) - len(todo) - (0 if a.recode_stale else len(stale))),
            ("changed since coded (stale)", f"{len(stale)}{' (re-coding)' if a.recode_stale else ' (use --recode-stale)'}"),
            ("to code now", len(todo)),
            ("coder", coder),
            ("model", f"{a.model} at {a.url}"),
            ("estimated minutes", round(len(todo) * per_unit / 60, 1)),
            ("inputs changed at their source", ", ".join(drift) or "none"),
        ])
    if a.dry_run:
        system = M.system_prompt(spec, tables, codebook, part)
        for uid, unit, seg in todo_units[:3]:
            r = renderer.render(unit, segment=seg, unit_id=uid)
            schema = M.output_schema(spec, tables, codebook, part, r)
            print("=" * 30, "SYSTEM (cached for every unit of this part)\n" + system)
            print("=" * 30, f"USER ({uid}, {len(r.text)} characters)\n" + r.text)
            print("=" * 30, f"SCHEMA keys: {', '.join(schema['properties'])}; evidence ids offered: "
                  + ", ".join(f"{k}:{len(v)}" for k, v in r.speakers.items()))
        return 0
    if a.plan or not todo:
        if not todo:
            print("Nothing to code.")
        return 0
    wait = M.busy_seconds(a.url, a.model)
    if wait is None:
        C.die(f"the model at {a.url} is not answering")
    if wait > 30 and not a.force:
        C.die(f"the model took {wait} s to answer one token; another job is probably using it (use --force to go on)")
    system = M.system_prompt(spec, tables, codebook, part)
    lock = run.path("state", "code.lock")
    run.guard(lock)
    if lock.exists():
        try:
            pid = int(lock.read_text().strip())
            os.kill(pid, 0)
            if pid != os.getpid():
                C.die(f"another code run (pid {pid}) holds {lock}")
        except (ValueError, ProcessLookupError, PermissionError):
            pass
    lock.write_text(str(os.getpid()))
    t0 = time.time()
    tally = Counter()
    try:
        for n, (uid, unit, seg) in enumerate(todo, 1):
            r = renderer.render(unit, segment=seg, unit_id=uid)
            try:
                res = M.code_one(spec, tables, codebook, part, r, system=system, model=a.model, url=a.url,
                                 max_tokens=pspec.get("max_tokens", M.DEFAULT_MAX_TOKENS))
            except C.Unavailable as e:
                print(f"UNAVAILABLE: {e}. Stopped after {n - 1} units; re-run to continue.")
                return 2
            if res.get("parsed") is None:
                tally["unreadable answers"] += 1
                print(f"  [{n}/{len(todo)}] {uid}: no readable answer ({res.get('finish_reason')}); left for a re-run")
                continue
            fields, evidence, bad = M.check_answer(res["parsed"], spec, tables, codebook, part, r)
            record = {"unit": uid, "part": part, "coder": coder, "fields": fields, "evidence": evidence,
                      "spans": M.spans_for(evidence, r), "_invalid": bad, "row": r.header.get("row"),
                      "table": r.header.get("table"), "case_sha": r.sha256, "prompt_sha": psha,
                      "codebook_sha": codebook.sha256, "codebook_version": codebook.version, "spec_sha": run.spec_sha(),
                      "model": a.model, "seconds": res["seconds"], "prompt_tokens": res.get("prompt_tokens"),
                      "completion_tokens": res.get("completion_tokens"), "finish_reason": res.get("finish_reason"),
                      "attempts": res.get("attempts"), "coded_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
            if screened is not None:
                record["relevance"] = screened.get(r.header.get("row"), {}).get("r")
            run.append_jsonl(out_path, record)
            tally["coded"] += 1
            tally["with invalid values"] += 1 if bad else 0
            show = ", ".join(f"{k}={v}" for k, v in list(fields.items())[:3] if not isinstance(v, list))
            print(f"  [{n}/{len(todo)}] {uid} {res['seconds']}s {show[:110]}", flush=True)
    finally:
        try:
            lock.unlink()
        except OSError:
            pass
    secs = time.time() - t0
    C.counts_header(f"Code result: {part}", [*sorted(tally.items()), ("minutes", round(secs / 60, 1)),
                                             ("seconds per unit", round(secs / max(1, tally["coded"]), 1)),
                                             ("file", out_path)])
    if top:
        next_step(run, f"`tables.py export --run \"{run.root}\"` to write the coded CSVs")
    return 0


def cmd_repeat(a) -> int:
    """Self-consistency: re-code N coded units and compare field by field."""
    run = open_run(a.run)
    tables, codebook, spec = load_everything(run)
    part = a.part
    done = run.coded(part)
    if not done:
        C.die(f"nothing coded yet for {part}")
    rng = __import__("random").Random(a.seed)
    ids = sorted(done)
    rng.shuffle(ids)
    ids = ids[: a.repeat]
    coder = next(iter(done.values()))["coder"]
    coded_deps = {dep: run.coded_values(dep) for dep in dependencies(spec, part)}
    renderer = D.Renderer(tables, spec, part, coded=coded_deps)
    units = {u[0]: u for u in renderer.units(screened_for(run, spec, part))}
    system = M.system_prompt(spec, tables, codebook, part)
    out = run.path("coded", f"{part}.{coder}.repeat.jsonl")
    same = Counter()
    total = Counter()
    for uid in ids:
        u = units.get(uid)
        if not u:
            continue
        r = renderer.render(u[1], segment=u[2], unit_id=uid)
        res = M.code_one(spec, tables, codebook, part, r, system=system, model=a.model, url=a.url,
                         max_tokens=spec["parts"][part].get("max_tokens", M.DEFAULT_MAX_TOKENS))
        if res.get("parsed") is None:
            continue
        fields, evidence, bad = M.check_answer(res["parsed"], spec, tables, codebook, part, r)
        run.append_jsonl(out, {"unit": uid, "fields": fields, "evidence": evidence, "_invalid": bad,
                               "case_sha": r.sha256, "seconds": res["seconds"]})
        for k, v in fields.items():
            if codebook.fields[k]["type"] == "text":
                continue
            total[k] += 1
            same[k] += 1 if (sorted(v) if isinstance(v, list) else v) == \
                (sorted(done[uid]["fields"].get(k) or []) if isinstance(v, list) else done[uid]["fields"].get(k)) else 0
        print(f"  {uid} re-coded", flush=True)
    C.counts_header(f"Same answer twice ({part}, {len(ids)} units, temperature 0, fixed seed)",
                    [(k, f"{same[k]}/{total[k]}") for k in total])
    return 0


# --- detach ---------------------------------------------------------------------------

def detach(run: D.Run, name: str, a) -> int:
    argv = [x for x in sys.argv[1:] if x != "--detach"]
    log = run.path("state", "logs", f"{name}-{time.strftime('%Y%m%d-%H%M%S')}.log")
    run.guard(log).parent.mkdir(parents=True, exist_ok=True)
    fh = open(log, "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, "-u", str(Path(__file__).resolve()), *argv], stdout=fh,
                            stderr=subprocess.STDOUT, start_new_session=True)
    run.write_text(run.path("state", f"{name}.pid"), str(proc.pid))
    print(f"Started in the background (pid {proc.pid}). Log: {log}")
    print(f"Check on it with: tail -n 20 \"{log}\"  or  tables.py status --run \"{run.root}\"")
    return 0


# --- status ----------------------------------------------------------------------------

def cmd_status(a) -> int:
    run = open_run(a.run)
    rows = status_counts(run)
    drift = run.source_drift()
    rows.append(("inputs changed at their source", ", ".join(drift) or "none"))
    for pidfile in sorted(run.path("state").glob("*.pid")):
        pid = int(pidfile.read_text().strip() or 0)
        try:
            os.kill(pid, 0)
            rows.append((f"background {pidfile.stem}", f"running (pid {pid})"))
        except (ProcessLookupError, PermissionError):
            rows.append((f"background {pidfile.stem}", "finished"))
    C.counts_header(f"Status: {run.name}", rows)
    write_readme(run)
    return 0


# --- the rest lives in tables_out.py ---------------------------------------------------------

def lazy(name: str):
    def call(a):
        import tables_out as O  # noqa: PLC0415
        return getattr(O, name)(a)
    return call


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--run", required=True, help="the run folder")
        p.add_argument("--model", default=C.DEFAULT_MODEL)
        p.add_argument("--url", default=C.CHAT_URL)
        p.add_argument("--plan", action="store_true", help="report what would happen; write nothing")
        return p

    p = common(sub.add_parser("init", help="snapshot inputs and profile the tables"))
    p.add_argument("--input", action="append", required=True, help="a table file or a folder of them (repeatable)")
    p.add_argument("--codebook")
    p.add_argument("--question", default="")
    p.add_argument("--name")
    p.add_argument("--readonly", action="append", help="another folder the run must never write into")
    p.add_argument("--describe", action="store_true", help="ask the model to label column roles (one call per table)")
    p.add_argument("--refresh", action="store_true", help="take new versions of changed inputs")
    p.set_defaults(func=cmd_init)

    p = common(sub.add_parser("units", help="draft, check or approve units.json"))
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--draft", action="store_true")
    g.add_argument("--check", action="store_true")
    g.add_argument("--approve", action="store_true")
    p.add_argument("--by", help="who approves")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_units)

    p = common(sub.add_parser("code", help="code units of one part"))
    p.add_argument("--part", required=True)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--ids", help="comma-separated unit ids")
    g.add_argument("--sample", type=int, help="a stratified sample of N units")
    g.add_argument("--all", action="store_true")
    p.add_argument("--seed", type=int, default=11)
    p.add_argument("--coder", help="override the coder handle")
    p.add_argument("--dry-run", action="store_true", help="print the prompt of up to 3 units; no model call")
    p.add_argument("--recode-stale", action="store_true")
    p.add_argument("--detach", action="store_true", help="run in the background with a log")
    p.add_argument("--force", action="store_true", help="go on although the model looks busy")
    p.set_defaults(func=cmd_code)

    p = common(sub.add_parser("repeat", help="re-code N coded units and compare (self-consistency)"))
    p.add_argument("--part", required=True)
    p.add_argument("--repeat", type=int, default=10)
    p.add_argument("--seed", type=int, default=5)
    p.set_defaults(func=cmd_repeat)

    p = common(sub.add_parser("screen", help="relevance first pass by sections"))
    p.add_argument("--screen", required=True, help="a screen defined in units.json")
    p.add_argument("--limit", type=int, default=0, help="screen at most N windows")
    p.add_argument("--order", choices=["file", "embed"], default="file")
    p.add_argument("--calibrate", action="store_true")
    p.add_argument("--audit", type=int, default=300)
    p.add_argument("--sheet", type=int, default=0, help="write a blind sheet of N rows for a person")
    p.add_argument("--ingest-sheet", help="a filled sheet to compare with the screen")
    p.add_argument("--coder", default="")
    p.add_argument("--detach", action="store_true")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=lazy("cmd_screen"))

    p = common(sub.add_parser("draft-parts", help="draft codebook parts for relevant rows no part covers"))
    p.add_argument("--screen", required=True)
    p.add_argument("--min-relevance", type=int, default=2)
    p.add_argument("--sample", type=int, default=40)
    p.set_defaults(func=lazy("cmd_draft_parts"))

    p = common(sub.add_parser("export", help="coded CSV/Excel files and evidence.csv"))
    p.add_argument("--xlsx", action="store_true")
    p.set_defaults(func=lazy("cmd_export"))

    p = common(sub.add_parser("agree", help="agreement sheets, ingest, J-code review"))
    p.add_argument("--part")
    p.add_argument("--fields", default="")
    p.add_argument("--also", default="", help="PART:FIELD pairs coded on a linked unit, e.g. B_utterances:T4_face_level_harm")
    p.add_argument("--n", type=int, default=25)
    p.add_argument("--seed", type=int, default=3)
    p.add_argument("--ingest")
    p.add_argument("--coder", default="")
    p.add_argument("--review", action="store_true")
    p.set_defaults(func=lazy("cmd_agree"))

    p = common(sub.add_parser("publish", help="write coded units into a UPC corpus"))
    p.add_argument("--corpus", required=True)
    p.add_argument("--parts", default="")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--namespace", default="")
    p.add_argument("--pseudonymize", action="store_true")
    p.set_defaults(func=lazy("cmd_publish"))

    p = common(sub.add_parser("markdown", help="one Markdown file per unit (for literature-extraction)"))
    p.add_argument("--part", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--min-relevance", type=int, default=0)
    p.set_defaults(func=lazy("cmd_markdown"))

    p = common(sub.add_parser("status", help="counts, background jobs, next step"))
    p.set_defaults(func=cmd_status)

    a = ap.parse_args()
    try:
        return a.func(a)
    except (D.SpecError, D.GuardError) as e:
        C.die(str(e))


if __name__ == "__main__":
    sys.exit(main())
