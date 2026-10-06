"""Output side of the tables route: screening runs, drafted parts, exports,
agreement sheets, UPC publishing and Markdown for literature-extraction.
Called from tables.py; each cmd_* takes the parsed arguments.
"""

from __future__ import annotations

import csv
import io
import json
import random
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import common as C
import tables_data as D
import tables_model as M
from tables import (DEFAULT_ROOT, coder_handle, dependencies, load_everything, load_screen_rows, next_step,  # noqa: F401
                    open_run, prompt_sha)

XLSX_CELL_MAX = 32000
LIT_EXTRACTION = Path(__file__).resolve().parents[2] / "literature-extraction" / "scripts" / "literature-extraction.py"


# --- small helpers -----------------------------------------------------------------

def csv_text(rows: list[dict], columns: list[str]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


def flat(value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return ";".join(str(v) for v in value)
    return str(value)


def export_meta(spec: dict, part: str) -> dict:
    p = spec["parts"][part]
    e = p.get("export") or {}
    return {"id_column": e.get("id_column") or p["id"], "id_prefix": e.get("id_prefix", ""),
            "columns": e.get("columns") or [h["column"] for h in p.get("header", [])]}


def lookup_dates(spec: dict, tables, name: str) -> dict[str, str]:
    return {c: v["date"] for c, v in D.lookup_values(spec, tables, name).items() if v["date"]}


def date_flags(spec: dict, tables, part: str, record: dict, row: dict) -> dict[str, str]:
    out = {}
    for chk in spec["parts"][part].get("date_checks", []):
        dates = lookup_dates(spec, tables, chk["lookup"])
        unit_date = (row.get(chk["unit_date"]) or "")[:10]
        codes = record["fields"].get(chk["field"]) or []
        codes = codes if isinstance(codes, list) else [codes]
        out[chk["name"]] = ";".join(c for c in codes if c in dates and unit_date and unit_date < dates[c][:10])
    return out


def evidence_text(record: dict, field: str) -> str:
    items = record.get("evidence", {}).get(field) or []
    spans = record.get("spans", {})
    parts = []
    for it in items:
        if isinstance(it, dict):
            label = it["code"] + (f"({it['polarity']})" if it.get("polarity") else "")
            parts.append(f"{label}: " + " / ".join(f"«{spans[i]['text']}» [{i}]" for i in it["ids"] if i in spans))
        elif it in spans:
            parts.append(f"«{spans[it]['text']}» [{it}]")
    return " | ".join(parts)


def unit_rows_by_id(tables, spec, part: str, screened=None) -> dict[str, tuple]:
    renderer = D.Renderer(tables, spec, part)
    return {uid: (unit, seg) for uid, unit, seg in renderer.units(screened)}


def reviews(run: D.Run, part: str) -> dict[tuple[str, str], dict]:
    out = {}
    for f in sorted(run.path("coded").glob(f"{part}.review-*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                out[(r["unit"], r["field"])] = r
    return out


# --- export ---------------------------------------------------------------------------------

def cmd_export(a) -> int:
    run = open_run(a.run)
    tables, codebook, spec = load_everything(run)
    written = []
    evidence_rows = []
    per_part_rows: dict[str, dict[str, dict]] = {}
    for part in spec["parts"]:
        recs = run.coded(part)
        if not recs:
            continue
        meta = export_meta(spec, part)
        units = unit_rows_by_id(tables, spec, part)
        fields = codebook.parts[part]["fields"]
        ev_fields = list((spec["parts"][part].get("evidence") or {}).keys())
        checks = [c["name"] for c in spec["parts"][part].get("date_checks", [])]
        rv = reviews(run, part)
        j_fields = [f for f in fields if f.startswith("J_")]
        rows = {}
        for uid, rec in recs.items():
            unit = units.get(uid)
            row = unit[0][1] if unit else {}
            out = {meta["id_column"]: meta["id_prefix"] + uid}
            for c in meta["columns"]:
                out[c] = row.get(c, "")
            for f in fields:
                out[f] = flat(rec["fields"].get(f))
            for f in ev_fields:
                out[f + "_evidence"] = evidence_text(rec, f)
            out.update(date_flags(spec, tables, part, rec, row))
            if j_fields:
                states = [rv.get((uid, f)) for f in j_fields]
                done = [s for s in states if s]
                out["J_review"] = ("unreviewed" if not done else
                                   f"reviewed by {done[0]['coder']} ({sum(1 for s in done if s['decision'] == 'change')} changed)")
            out["relevance"] = "" if rec.get("relevance") is None else rec["relevance"]
            out["_invalid"] = ";".join(rec.get("_invalid") or [])
            out["_coder"] = rec["coder"]
            out["_model"] = rec.get("model", "")
            out["_codebook"] = rec.get("codebook_version", "")
            out["_coded_at"] = rec.get("coded_at", "")
            rows[uid] = out
            for f in ev_fields:
                for it in rec.get("evidence", {}).get(f) or []:
                    items = [(it["code"], it.get("polarity"), i) for i in it["ids"]] if isinstance(it, dict) else [("", None, it)]
                    for code, pol, i in items:
                        sp = rec["spans"].get(i)
                        if sp:
                            evidence_rows.append({"part": part, "unit": uid, "field": f, "code": code, "polarity": pol or "",
                                                  "sentence": i, **{k: sp[k] for k in ("table", "row", "column", "start", "end",
                                                                                        "speaker", "text")}})
        columns = [meta["id_column"], *meta["columns"], *fields, *[f + "_evidence" for f in ev_fields], *checks,
                   *(["J_review"] if j_fields else []), "relevance", "_invalid", "_coder", "_model", "_codebook", "_coded_at"]
        path = run.path("exports", f"{part}_coded.csv")
        run.write_text(path, csv_text(list(rows.values()), columns))
        written.append((path, len(rows), columns))
        per_part_rows[part] = rows
    # joined exports: a part with the codes of the first unit it shows from another part
    for part in spec["parts"]:
        pspec = spec["parts"][part]
        for rel in pspec.get("related", []):
            dep = rel.get("include_codes")
            if not dep or part not in per_part_rows or dep not in per_part_rows:
                continue
            dep_fields = codebook.parts[dep]["fields"]
            dep_meta = export_meta(spec, dep)
            units = unit_rows_by_id(tables, spec, part)
            joined = []
            for uid, row in per_part_rows[part].items():
                unit = units.get(uid)
                linked = [r.get(rel["id"], "").strip() for _t, r in D.resolve_path(tables, [unit[0]], rel["path"])] if unit else []
                first = per_part_rows[dep].get(linked[0]) if linked else None
                out = dict(row)
                out[dep_meta["id_column"] + "s"] = ";".join(dep_meta["id_prefix"] + x for x in linked)
                if unit:
                    out[pspec["text"]["column"]] = unit[0][1].get(pspec["text"]["column"], "")
                for f in dep_fields:
                    out[f] = (first or {}).get(f, "")
                joined.append(out)
            name = (pspec.get("export") or {}).get("joined_name") or f"joined_{part}"
            cols = list(per_part_rows[part][next(iter(per_part_rows[part]))].keys())
            cols = cols[:1 + len(export_meta(spec, part)["columns"])] + [dep_meta["id_column"] + "s", pspec["text"]["column"]] \
                + dep_fields + cols[1 + len(export_meta(spec, part)["columns"]):]
            path = run.path("exports", f"{name}.csv")
            run.write_text(path, csv_text(joined, cols))
            written.append((path, len(joined), cols))
    ev_cols = ["part", "unit", "field", "code", "polarity", "sentence", "table", "row", "column", "start", "end", "speaker", "text"]
    run.write_text(run.path("exports", "evidence.csv"), csv_text(evidence_rows, ev_cols))
    written.append((run.path("exports", "evidence.csv"), len(evidence_rows), ev_cols))
    if a.xlsx:
        import openpyxl  # noqa: PLC0415
        for path, _n, cols in list(written):
            wb = openpyxl.Workbook(write_only=True)
            ws = wb.create_sheet(path.stem[:31])
            ws.append(cols)
            capped = 0
            for r in csv.DictReader(io.StringIO(path.read_text(encoding="utf-8"))):
                vals = []
                for c in cols:
                    v = r.get(c, "")
                    if len(v) > XLSX_CELL_MAX:
                        v = v[:XLSX_CELL_MAX] + " […cut; full text in the CSV]"
                        capped += 1
                    vals.append(v)
                ws.append(vals)
            xp = run.guard(path.with_suffix(".xlsx"))
            wb.save(xp)
            if capped:
                print(f"  {xp.name}: {capped} cells cut at {XLSX_CELL_MAX} characters (Excel's limit)")
    C.counts_header("Export", [(p.name, f"{n} rows") for p, n, _ in written])
    next_step(run, f"open exports/ in a spreadsheet; for agreement, `tables.py agree --run \"{run.root}\" --part <part> "
                   f"--fields <F1,F2> --n 25`")
    return 0


# --- agreement ---------------------------------------------------------------------------------

def allowed_block(spec, tables, codebook, part: str, fields: list[str]) -> list[str]:
    lines = []
    for f in fields:
        fd = codebook.fields[f]
        values = D.field_values(spec, tables, codebook, f, part)
        lines.append(f"- **{f}** ({fd['type']}): {fd['def']}")
        if fd["type"] == "int":
            lo, hi = M.int_range(spec["parts"][part], codebook, f)
            lines.append(f"  - an integer from {lo} to {hi}")
        for c, m in (values or {}).items():
            lines.append(f"  - `{c}`: {m}")
    return lines


def cmd_agree(a) -> int:
    run = open_run(a.run)
    tables, codebook, spec = load_everything(run)
    if a.ingest:
        return agree_ingest(run, tables, codebook, spec, a)
    if not a.part or not a.fields:
        C.die("a sheet needs --part and --fields (and optionally --also PART:FIELD)")
    part = a.part
    fields = [f.strip() for f in a.fields.split(",") if f.strip()]
    for f in fields:
        if f not in codebook.parts[part]["fields"]:
            C.die(f"{f} is not a field of {part}")
    also = [tuple(x.split(":", 1)) for x in a.also.split(",") if ":" in x]
    recs = run.coded(part)
    if not recs:
        C.die(f"nothing coded yet for {part}")
    rng = random.Random(a.seed)
    ids = sorted(recs)
    rng.shuffle(ids)
    ids = ids[: a.n]
    units = unit_rows_by_id(tables, spec, part)
    renderer = D.Renderer(tables, spec, part)
    stamp = time.strftime("%Y%m%d-%H%M")
    mode = "review" if a.review else "blind"
    rows, dossier = [], [f"# {'Review' if a.review else 'Agreement'} sheet: {part} ({stamp})", ""]
    if a.review:
        dossier += ["The model's codes are shown. For each field write `accept`, or `change` and the value you would give, "
                    "in the sheet. Nothing is published as a finding before this review.", ""]
    else:
        dossier += ["Code each case from the text alone. The model's codes are NOT shown. Fill the sheet's empty columns "
                    "with the allowed values below (separate several values with `;`).", ""]
    dossier += ["## Allowed values", ""] + allowed_block(spec, tables, codebook, part, fields)
    for dep, f in also:
        dossier += allowed_block(spec, tables, codebook, dep, [f])
    refs = M.lookup_block(spec, tables, codebook, part)
    if refs or spec.get("lookups"):
        names = list((spec.get("lookups") or {}))
        extra = "\n\n".join(M.lookup_block(spec, tables, codebook, p2) for p2 in spec["parts"]
                              if any(codebook.fields[f]["lookup"] in names for f in codebook.parts[p2]["fields"]))
        dossier += ["", "## Reference lists", "", "```", (refs or extra).strip(), "```"]
    blind_cases = []
    for n, uid in enumerate(ids, 1):
        unit, seg = units[uid]
        row = {"case": n, "part": part, "unit": uid}
        for f in fields:
            if a.review:
                row[f"{f} (model)"] = flat(recs[uid]["fields"].get(f))
                row[f"{f} decision"] = ""
                row[f"{f} your value"] = ""
            else:
                row[f] = ""
        for dep, f in also:
            rel = next((r for r in spec["parts"][part].get("related", []) if r.get("include_codes") == dep), None)
            linked = [r.get(rel["id"], "").strip() for _t, r in D.resolve_path(tables, [unit], rel["path"])] if rel else []
            row[f"{dep} unit"] = linked[0] if linked else ""
            row[f"{dep}:{f}"] = ""
            if linked:
                blind_cases.append((n, dep, linked[0]))
        row["note"] = ""
        rows.append(row)
    if blind_cases and not a.review:
        dossier += ["", "## Part 1. The posts alone (code these before reading Part 2)", ""]
        for n, dep, uid in blind_cases:
            dep_units = unit_rows_by_id(tables, spec, dep)
            if uid not in dep_units:
                continue
            r = D.Renderer(tables, spec, dep).render(dep_units[uid][0], unit_id=uid, show_ids=False)
            dossier += [f"### Case {n}: {dep} {uid}", "", "```", r.clean.strip(), "```", ""]
    dossier += ["", f"## {'Part 2. ' if blind_cases and not a.review else ''}The cases", ""]
    for n, uid in enumerate(ids, 1):
        unit, seg = units[uid]
        r = renderer.render(unit, segment=seg, unit_id=uid, show_ids=a.review, show_codes=False)
        dossier += [f"### Case {n}: {uid}", "", "```", r.clean.strip() if not a.review else r.text.strip(), "```", ""]
        if a.review:
            rec = recs[uid]
            dossier += [f"- {f}: {flat(rec['fields'].get(f))}" for f in fields]
            ev = [f"  - {k}: {evidence_text(rec, k)}" for k in rec.get("evidence", {}) if evidence_text(rec, k)]
            dossier += (["- evidence:"] + ev if ev else []) + [""]
    cols = list(rows[0].keys())
    sheet = run.path("agree", f"{mode}-{part}-{stamp}.csv")
    run.write_text(sheet, csv_text(rows, cols))
    doc = run.path("agree", f"{mode}-{part}-{stamp}.md")
    run.write_text(doc, "\n".join(dossier) + "\n")
    C.counts_header(f"{'Review' if a.review else 'Agreement'} sheet", [("cases", len(rows)), ("sheet", sheet), ("dossier", doc)])
    next_step(run, f"fill {sheet.name}, then `tables.py agree --run \"{run.root}\" --ingest \"{sheet}\" --coder <you>`")
    return 0


def agree_ingest(run: D.Run, tables, codebook, spec, a) -> int:
    if not a.coder:
        C.die("--ingest needs --coder (whose sheet it is)")
    sheet = Path(a.ingest).expanduser()
    rows = list(csv.DictReader(io.StringIO(sheet.read_text(encoding="utf-8-sig"))))
    if not rows:
        C.die("the sheet is empty")
    part = rows[0]["part"]
    review = any(k.endswith(" decision") for k in rows[0])
    recs = run.coded(part)
    if review:
        out = run.path("coded", f"{part}.review-{D.slug_token(a.coder)}.jsonl")
        n = 0
        for r in rows:
            for k in r:
                if not k.endswith(" decision"):
                    continue
                f = k[: -len(" decision")]
                decision = (r[k] or "").strip().lower()
                if decision not in ("accept", "change"):
                    continue
                run.append_jsonl(out, {"unit": r["unit"], "field": f, "decision": decision, "coder": a.coder,
                                       "model_value": r.get(f"{f} (model)", ""), "value": (r.get(f"{f} your value") or "").strip(),
                                       "note": r.get("note", ""), "at": time.strftime("%Y-%m-%dT%H:%M:%S")})
                n += 1
        C.counts_header("Review recorded", [("decisions", n), ("file", out)])
        next_step(run, f"`tables.py export --run \"{run.root}\"` marks reviewed J fields")
        return 0
    fields = [k for k in rows[0] if k not in ("case", "part", "unit", "note") and not k.endswith(" unit")]
    human_path = run.path("coded", f"{part}.human-{D.slug_token(a.coder)}.jsonl")
    report = [f"# Agreement: {part}, {a.coder} vs the model", "", f"Sheet: `{sheet.name}` ({len(rows)} cases). "
              "Chance-corrected agreement needs about 100 cases before it is worth reporting; 25 are enough to "
              "find unclear definitions.", "", "| field | n | agreement | Cohen's kappa | alpha | other |",
              "|---|---|---|---|---|---|"]
    disagreements = []
    human_records: dict[str, dict] = defaultdict(dict)
    for key in fields:
        dep, f = key.split(":", 1) if ":" in key else (part, key)
        fd = codebook.fields[f]
        values = D.field_values(spec, tables, codebook, f, dep) or {}
        dep_recs = run.coded(dep) if dep != part else recs
        pairs, jac, bad = [], [], 0
        for r in rows:
            uid = r.get(f"{dep} unit") if dep != part else r["unit"]
            raw = (r.get(key) or "").strip()
            if not uid or not raw or uid not in dep_recs:
                continue
            model = dep_recs[uid]["fields"].get(f)
            if fd["type"] in ("multi", "multi_with_quotes", "multi_with_polarity"):
                hv = sorted(x.strip() for x in raw.split(";") if x.strip())
                mv = sorted(re.sub(r"\(.*\)$", "", x) for x in (model or []))
                hv = [re.sub(r"\(.*\)$", "", x) for x in hv]
                if any(x not in values for x in hv):
                    bad += 1
                    continue
                jac.append(M.jaccard(set(hv), set(mv)))
                pairs.append((";".join(hv), ";".join(mv)))
                human_records[uid if dep == part else f"{dep}:{uid}"][f] = hv
            elif fd["type"] == "int":
                try:
                    hv = int(raw)
                except ValueError:
                    bad += 1
                    continue
                pairs.append((hv, model))
                human_records[uid if dep == part else f"{dep}:{uid}"][f] = hv
            else:
                if raw not in values:
                    bad += 1
                    continue
                pairs.append((raw, model))
                human_records[uid if dep == part else f"{dep}:{uid}"][f] = raw
            if pairs and pairs[-1][0] != pairs[-1][1]:
                disagreements.append((key, uid, pairs[-1][0], pairs[-1][1]))
        n = len(pairs)
        agree = sum(1 for x, y in pairs if x == y)
        other = ""
        if fd["type"] in ("multi", "multi_with_quotes", "multi_with_polarity"):
            other = f"mean Jaccard {sum(jac) / len(jac):.2f}" if jac else ""
            kappa = alpha = None
        elif fd["type"] == "int":
            lo, hi = M.int_range(spec["parts"][dep], codebook, f)
            ok = [(x, y) for x, y in pairs if isinstance(y, int)]
            other = f"weighted kappa {M.weighted_kappa(ok, lo, hi)}"
            kappa = M.cohens_kappa(pairs)
            alpha = M.krippendorff_alpha_nominal(pairs)
        else:
            kappa = M.cohens_kappa(pairs)
            alpha = M.krippendorff_alpha_nominal(pairs)
        ci = M.wilson(agree, n)
        report.append(f"| {key} | {n} | {agree}/{n}" + (f" ({ci[0]:.0%}–{ci[1]:.0%})" if ci else "") +
                      f" | {'' if kappa is None else kappa} | {'' if alpha is None else alpha} | {other}"
                      + (f"; {bad} unreadable" if bad else "") + " |")
    for uid, vals in human_records.items():
        if ":" in uid:
            dep, u = uid.split(":", 1)
            run.append_jsonl(run.path("coded", f"{dep}.human-{D.slug_token(a.coder)}.jsonl"),
                             {"unit": u, "part": dep, "coder": a.coder, "coder_kind": "human", "fields": vals,
                              "sheet": sheet.name, "coded_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
        else:
            run.append_jsonl(human_path, {"unit": uid, "part": part, "coder": a.coder, "coder_kind": "human",
                                          "fields": vals, "sheet": sheet.name, "coded_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    report += ["", "## Disagreements", "", "| field | unit | you | model |", "|---|---|---|---|"]
    report += [f"| {k} | {u} | {h} | {m} |" for k, u, h, m in disagreements]
    run.write_text(run.path("agree", "AGREEMENT.md"), "\n".join(report) + "\n")
    C.counts_header("Agreement", [("cases", len(rows)), ("fields", len(fields)), ("disagreements", len(disagreements)),
                                  ("report", run.path("agree", "AGREEMENT.md"))])
    next_step(run, "read agree/AGREEMENT.md; tighten unclear definitions in the codebook and draft a new version")
    return 0


# --- screening -------------------------------------------------------------------------------

def screen_embeddings(run: D.Run, name: str, rows: list[tuple[str, str]], question: str) -> dict[str, float]:
    """Cosine of each row (own words) with the question; cached by text hash."""
    import numpy as np  # noqa: PLC0415
    cache_path = run.path("state", "embed", f"{name}.json")
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    todo = [(rid, t) for rid, t in rows if D.sha256_text(t)[:16] not in cache]
    for i in range(0, len(todo), C.EMBED_BATCH * 4):
        batch = todo[i:i + C.EMBED_BATCH * 4]
        vecs = C.embed_resilient([t[: C.MAX_CHUNK_CHARS] for _, t in batch])
        for (rid, t), v in zip(batch, vecs):
            if v is not None:
                cache[D.sha256_text(t)[:16]] = [round(x, 5) for x in v]
        if i % 2000 == 0 and todo:
            print(f"  embedded {min(i + len(batch), len(todo))}/{len(todo)}", flush=True)
    run.write_text(cache_path, json.dumps(cache))
    q = C.embed_resilient([question])[0]
    if q is None:
        return {}
    qv = np.array(q, dtype="float32")
    qv /= np.linalg.norm(qv) or 1
    out = {}
    for rid, t in rows:
        v = cache.get(D.sha256_text(t)[:16])
        if v is not None:
            vv = np.array(v, dtype="float32")
            out[rid] = float(vv @ qv / (np.linalg.norm(vv) or 1))
    return out


def cmd_screen(a) -> int:
    run = open_run(a.run)
    if a.detach:
        from tables import detach  # noqa: PLC0415
        return detach(run, f"screen-{a.screen}", a)
    tables, codebook, spec = load_everything(run)
    scr = (spec.get("screens") or {}).get(a.screen)
    if not scr:
        C.die(f"no screen named {a.screen} in units.json (screens: {', '.join(spec.get('screens') or {}) or 'none'})")
    style = (spec.get("quote_blocks") or {}).get("style")
    if a.ingest_sheet:
        return screen_ingest_sheet(run, a, scr)
    windows = M.screen_windows(tables, scr, style)
    system = M.screen_system(spec, codebook, scr)
    parts = list(scr.get("parts") or ["new"])
    if "new" not in parts:
        parts.append("new")
    psha = D.sha256_text(system + D.canonical_json(scr))[:12]
    out_path = run.path("screen", f"{a.screen}.windows.jsonl")
    done = {}
    if out_path.exists():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                w = json.loads(line)
                if w.get("prompt_sha") == psha and w["status"] == "ok":
                    done[w["window"]] = w
    todo = [w for w in windows if w["window"] not in done]
    n_rows = sum(len(w["ids"]) for w in windows)
    if a.sheet:
        return screen_sheet(run, a, scr, style)
    if a.calibrate:
        return screen_calibrate(run, a, tables, spec, codebook, scr, style, system, parts, windows, done)
    per = 4.4
    C.counts_header(f"Screen plan: {a.screen}", [
        ("rows to screen", n_rows), ("windows", len(windows)), ("already screened", len(done)),
        ("to screen now", min(len(todo), a.limit) if a.limit else len(todo)),
        ("estimated minutes", round((min(len(todo), a.limit) if a.limit else len(todo)) * per / 60, 1)),
        ("model", f"{a.model} at {a.url}"), ("prompt", psha)])
    if a.plan or not todo:
        print("Nothing to screen." if not todo else "Planning only; nothing was written.")
        return 0
    if a.order == "embed":
        rows = [(rid, M.screen_row_text(r, scr, style, scr.get("row_chars", M.SCREEN_ROW_CHARS)))
                for _t, r in D.unit_rows(tables, {"table": scr["table"], "id": scr["id"], "where": scr.get("where", [])})
                for rid in [r.get(scr["id"], "").strip()]]
        scores = screen_embeddings(run, a.screen, rows, spec.get("question", ""))
        todo.sort(key=lambda w: -max((scores.get(i, 0) for i in w["ids"]), default=0))
    if a.limit:
        todo = todo[: a.limit]
    wait = M.busy_seconds(a.url, a.model)
    if wait is None:
        C.die(f"the model at {a.url} is not answering")
    if wait > 30 and not a.force:
        C.die(f"the model took {wait} s for one token; another job is probably using it (use --force)")
    t0 = time.time()
    tally = Counter()
    for n, w in enumerate(todo, 1):
        try:
            res = M.screen_one(system, w, parts, model=a.model, url=a.url)
        except C.Unavailable as e:
            print(f"UNAVAILABLE: {e}. Stopped after {n - 1} windows; re-run to continue.")
            break
        run.append_jsonl(out_path, {"window": w["window"], "group": w["group"], "ids": w["ids"], **res,
                                    "prompt_sha": psha, "model": a.model, "at": time.strftime("%Y-%m-%dT%H:%M:%S")})
        tally[res["status"]] += 1
        tally["rows listed"] += len(res["rows"])
        if n % 10 == 0 or n == len(todo):
            el = time.time() - t0
            print(f"  [{n}/{len(todo)}] windows; {tally['rows listed']} rows listed; "
                  f"~{int(el / n * (len(todo) - n) / 60)} min left", flush=True)
    relevance_report(run, a.screen, tables, spec, scr)
    C.counts_header(f"Screen result: {a.screen}", [*sorted(tally.items()), ("minutes", round((time.time() - t0) / 60, 1)),
                                                   ("summary", run.path("screen", f"RELEVANCE-{a.screen}.md"))])
    next_step(run, f"read screen/RELEVANCE-{a.screen}.md; then `tables.py screen --run \"{run.root}\" --screen {a.screen} --calibrate` "
                   f"and `tables.py draft-parts --run \"{run.root}\" --screen {a.screen}`")
    return 0


def relevance_report(run: D.Run, name: str, tables, spec, scr) -> None:
    rows = load_screen_rows(run, name)
    by_id = {r.get(scr["id"], "").strip(): r for _t, r in D.unit_rows(tables, {"table": scr["table"], "id": scr["id"]})}
    levels = Counter(v["r"] for v in rows.values())
    labels = Counter(v["label"].lower() for v in rows.values() if v["r"] >= 2 and v.get("label"))
    groups = Counter()
    years = Counter()
    years_all = Counter()
    for rid, v in rows.items():
        r = by_id.get(rid, {})
        y = (r.get(scr.get("date") or "", "") or "")[:4]
        years_all[y] += 1
        if v["r"] >= 2:
            groups[(r.get((scr.get("header") or [scr.get("group")])[0], "") or "")[:70]] += 1
            years[y] += 1
    lines = [f"# Relevance: {name}", "", f"{len(rows)} rows screened in windows; relevance is the model's 0–3 rating "
             "(0 = not listed). Embeddings were not used to drop anything.", "",
             "| relevance | rows |", "|---|---|"] + [f"| {k} | {levels.get(k, 0)} |" for k in (3, 2, 1, 0)]
    lines += ["", "## What the relevant rows do (labels, relevance ≥ 2)", ""] + [f"- {k}: {v}" for k, v in labels.most_common(30)]
    lines += ["", "## Where (top groups, relevance ≥ 2)", ""] + [f"- {k}: {v}" for k, v in groups.most_common(20)]
    lines += ["", "## By year (relevance ≥ 2 / screened)", ""] + \
        [f"- {y}: {years[y]} / {years_all[y]} ({years[y] / max(1, years_all[y]):.0%})" for y in sorted(years_all) if y]
    cal = run.path("screen", f"{name}.calibration.md")
    if cal.exists():
        lines += ["", cal.read_text(encoding="utf-8")]
    run.write_text(run.path("screen", f"RELEVANCE-{name}.md"), "\n".join(lines) + "\n")


def screen_calibrate(run, a, tables, spec, codebook, scr, style, system, parts, windows, done) -> int:
    """Per-row re-screening of a stratified sample, and a window-size check."""
    rows = load_screen_rows(run, a.screen)
    if not rows:
        C.die("screen some windows first; calibration compares against them")
    by_id = {r.get(scr["id"], "").strip(): r for _t, r in D.unit_rows(tables, {"table": scr["table"], "id": scr["id"],
                                                                              "where": scr.get("where", [])})}
    zeros = [rid for rid, v in rows.items() if v["r"] == 0 and rid in by_id]
    listed = [rid for rid, v in rows.items() if v["r"] >= 1 and rid in by_id]
    rng = random.Random(a.audit)
    n_zero = min(len(zeros), (a.audit * 2) // 3)
    n_list = min(len(listed), a.audit - n_zero)
    scores = {}
    try:
        texts = [(rid, M.screen_row_text(by_id[rid], scr, style, scr.get("row_chars", M.SCREEN_ROW_CHARS))) for rid in zeros]
        scores = screen_embeddings(run, a.screen, texts, spec.get("question", ""))
    except Exception as e:  # embeddings are optional here
        print(f"  (no embedding strata: {e})")
    strata = defaultdict(list)
    if scores:
        ordered = sorted(zeros, key=lambda r: scores.get(r, 0))
        for i, rid in enumerate(ordered):
            strata[min(4, i * 5 // max(1, len(ordered)))].append(rid)
    else:
        strata[0] = list(zeros)
    pick_zero = []
    for s, ids in sorted(strata.items()):
        rng.shuffle(ids)
        pick_zero += [(rid, s, len(ids)) for rid in ids[: max(1, n_zero // len(strata))]]
    pick_list = rng.sample(listed, n_list) if n_list else []
    out = run.path("screen", f"{a.screen}.calibration.jsonl")
    done_ids = set()
    if out.exists():
        done_ids = {json.loads(x)["id"] for x in out.read_text(encoding="utf-8").splitlines() if x.strip()}
    group_col, order_col = scr.get("group"), scr.get("order")
    members = defaultdict(list)
    for rid, r in by_id.items():
        members[(r.get(group_col, "") if group_col else "all").strip()].append(r)
    for g in members.values():
        g.sort(key=lambda r: (r.get(order_col, ""), r.get(scr["id"], "")))
    t0 = time.time()
    sample = [(rid, "zero", s, size) for rid, s, size in pick_zero] + [(rid, "listed", -1, 0) for rid in pick_list]
    for n, (rid, kind, stratum, size) in enumerate(sample, 1):
        if rid in done_ids:
            continue
        r = by_id[rid]
        g = members[(r.get(group_col, "") if group_col else "all").strip()]
        pos = next((i for i, x in enumerate(g) if x.get(scr["id"], "").strip() == rid), 0)
        ctx = g[max(0, pos - 2):pos]
        body = "\n\n".join("(context, already screened)\n" + M.screen_row_text(c, scr, style, 700) for c in ctx)
        text = (body + "\n\n" if body else "") + M.screen_row_text(r, scr, style, scr.get("row_chars", M.SCREEN_ROW_CHARS))
        res = M.screen_one(system, {"window": f"cal-{rid}", "ids": [rid], "text": text}, parts, model=a.model, url=a.url)
        r1 = res["rows"][0]["r"] if res["rows"] else 0
        run.append_jsonl(out, {"id": rid, "kind": kind, "stratum": stratum, "stratum_size": size, "window_r": rows[rid]["r"],
                               "row_r": r1, "status": res["status"], "seconds": res["seconds"]})
        if n % 25 == 0:
            print(f"  calibrated {n}/{len(sample)}", flush=True)
    cal = [json.loads(x) for x in out.read_text(encoding="utf-8").splitlines() if x.strip()]
    zs = [c for c in cal if c["kind"] == "zero" and c["status"] == "ok"]
    ls = [c for c in cal if c["kind"] == "listed" and c["status"] == "ok"]
    # weighted miss rate across embedding strata
    by_s = defaultdict(list)
    for c in zs:
        by_s[c["stratum"]].append(c)
    total = sum(max(c["stratum_size"] for c in cs) for cs in by_s.values()) or 1
    miss_w = sum((sum(1 for c in cs if c["row_r"] >= 2) / len(cs)) * max(c["stratum_size"] for c in cs) / total
                 for cs in by_s.values() if cs)
    raw_miss = sum(1 for c in zs if c["row_r"] >= 2)
    ci = M.wilson(raw_miss, len(zs))
    keep = sum(1 for c in ls if c["row_r"] >= 1)
    anchors = scr.get("anchors") or []
    lines = ["## Calibration", "",
             f"- Rows re-screened one at a time: {len(cal)} ({len(zs)} that the windows left out, {len(ls)} they listed).",
             f"- Missed by the windows (rated ≥ 2 on their own): {raw_miss}/{len(zs)}"
             + (f", 95% interval {ci[0]:.1%}–{ci[1]:.1%}" if ci else "") + f"; weighted by embedding stratum {miss_w:.1%}.",
             f"- Listed by the windows and still rated ≥ 1 alone: {keep}/{len(ls)}.",
             "- Strata (embedding similarity quintiles of the zeros, 0 = least similar): " +
             ", ".join(f"{s}: {sum(1 for c in cs if c['row_r'] >= 2)}/{len(cs)}" for s, cs in sorted(by_s.items()))]
    if anchors:
        lines.append("- Anchors: " + ", ".join(f"{x} r={rows.get(x, {}).get('r', 'not screened')}" for x in anchors))
    run.write_text(run.path("screen", f"{a.screen}.calibration.md"), "\n".join(lines) + "\n")
    relevance_report(run, a.screen, tables, spec, scr)
    C.counts_header(f"Calibration: {a.screen}", [("re-screened", len(cal)), ("missed (≥2 alone)", f"{raw_miss}/{len(zs)}"),
                                                 ("weighted miss rate", f"{miss_w:.1%}"),
                                                 ("minutes", round((time.time() - t0) / 60, 1))])
    return 0


def screen_sheet(run, a, scr, style) -> int:
    tables = run.tables()
    rows = load_screen_rows(run, a.screen)
    by_id = {r.get(scr["id"], "").strip(): r for _t, r in D.unit_rows(tables, {"table": scr["table"], "id": scr["id"]})}
    pos = [k for k, v in rows.items() if v["r"] >= 2 and k in by_id]
    neg = [k for k, v in rows.items() if v["r"] == 0 and k in by_id]
    rng = random.Random(a.seed if hasattr(a, "seed") else 3)
    pick = rng.sample(pos, min(len(pos), a.sheet // 2)) + rng.sample(neg, min(len(neg), a.sheet - a.sheet // 2))
    rng.shuffle(pick)
    out = [{"row": i + 1, "id": rid, "text": M.screen_row_text(by_id[rid], scr, style, 1400), "relevance (0-3)": "",
            "note": ""} for i, rid in enumerate(pick)]
    path = run.path("agree", f"screen-sheet-{a.screen}-{time.strftime('%Y%m%d-%H%M')}.csv")
    run.write_text(path, csv_text(out, ["row", "id", "text", "relevance (0-3)", "note"]))
    print(f"Blind sheet with {len(out)} rows (half listed, half not; shuffled): {path}")
    next_step(run, f"fill the relevance column, then `tables.py screen --run \"{run.root}\" --screen {a.screen} "
                   f"--ingest-sheet \"{path}\" --coder <you>`")
    return 0


def screen_ingest_sheet(run, a, scr) -> int:
    rows = load_screen_rows(run, a.screen)
    sheet = list(csv.DictReader(io.StringIO(Path(a.ingest_sheet).expanduser().read_text(encoding="utf-8-sig"))))
    tp = fp = fn = tn = 0
    for r in sheet:
        v = (r.get("relevance (0-3)") or "").strip()
        if not v.isdigit():
            continue
        human = int(v) >= 2
        model = rows.get(r["id"], {}).get("r", 0) >= 2
        tp += human and model
        fp += (not human) and model
        fn += human and not model
        tn += (not human) and not model
    prec = M.wilson(tp, tp + fp)
    rec = M.wilson(tp, tp + fn)
    lines = ["## Checked by a person", "", f"- rows with a rating: {tp + fp + fn + tn} ({a.coder or 'unnamed'})",
             f"- precision (model ≥2 that the person also rates ≥2): {tp}/{tp + fp}" + (f" ({prec[0]:.0%}–{prec[1]:.0%})" if prec else ""),
             f"- recall on this balanced sheet: {tp}/{tp + fn}" + (f" ({rec[0]:.0%}–{rec[1]:.0%})" if rec else "")]
    path = run.path("screen", f"{a.screen}.calibration.md")
    old = path.read_text(encoding="utf-8") if path.exists() else ""
    run.write_text(path, old + "\n" + "\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


# --- drafted parts ---------------------------------------------------------------------------

def cmd_draft_parts(a) -> int:
    run = open_run(a.run)
    tables, codebook, spec = load_everything(run)
    scr = (spec.get("screens") or {}).get(a.screen)
    if not scr:
        C.die(f"no screen named {a.screen}")
    rows = load_screen_rows(run, a.screen)
    style = (spec.get("quote_blocks") or {}).get("style")
    by_id = {r.get(scr["id"], "").strip(): r for _t, r in D.unit_rows(tables, {"table": scr["table"], "id": scr["id"]})}
    relevant = [(k, v) for k, v in rows.items() if v["r"] >= a.min_relevance and "new" in v.get("parts", []) and k in by_id]
    if not relevant:
        C.die("no relevant rows marked 'new' yet; screen first")
    counts = Counter(v["label"].lower().strip() for _k, v in relevant if v.get("label"))
    by_label = defaultdict(list)
    for k, v in relevant:
        by_label[v["label"].lower().strip()].append(k)
    rng = random.Random(7)
    sample = []
    if sum(1 for n in counts.values() if n > 1) >= len(counts) * 0.2:
        for lab, _n in counts.most_common():  # labels repeat: two rows per frequent label
            ids = by_label[lab]
            rng.shuffle(ids)
            sample += ids[:2]
            if len(sample) >= a.sample:
                break
    else:  # labels are mostly one-offs: spread the sample across groups (threads) instead
        by_group = defaultdict(list)
        for k, v in relevant:
            by_group[v.get("window", "").rsplit("-", 1)[0]].append(k)
        groups = list(by_group.values())
        for g in groups:
            rng.shuffle(g)
        rng.shuffle(groups)
        while len(sample) < a.sample and any(groups):
            for g in groups:
                if g and len(sample) < a.sample:
                    sample.append(g.pop())
    labelled = [{"id": k, "label": rows[k]["label"], "r": rows[k]["r"],
                 "text": M.screen_row_text(by_id[k], scr, style, 700)} for k in sample]
    C.counts_header("Draft parts", [("relevant rows marked new", len(relevant)), ("distinct labels", len(counts)),
                                    ("rows shown to the model", len(labelled))])
    if a.plan:
        return 0
    obj = M.draft_parts(spec, codebook, labelled, counts, model=a.model, url=a.url)
    obj["_from"] = {"screen": a.screen, "rows": len(relevant), "labels": counts.most_common(40),
                    "sample": [x["id"] for x in labelled], "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    run.write_json(run.path("drafts", f"parts_draft_{a.screen}.json"), obj)
    md = [f"# Drafted codebook parts ({a.screen})", "", "A PROPOSAL from the model, for you to edit. Nothing here "
          "changes your codebook. Merge what you keep into the next codebook version.", "",
          f"From {len(relevant)} rows screened as relevant (≥{a.min_relevance}) that no existing part covers.", ""]
    for p in obj.get("parts", []):
        md += [f"## {p['name']}", "", f"- Unit: {p['unit']}", f"- Why: {p['why']}", f"- Instructions: {p['instructions']}",
               f"- Reuses: {', '.join(p['reuse_fields']) or 'nothing'}", ""]
        for f in p.get("new_fields", []):
            md += [f"**{f['name']}** ({f['type']}). {f['def']}", ""] + [f"- `{v['code']}`: {v['meaning']}" for v in f.get("values", [])] + [""]
    md += ["## The labels the screen gave", ""] + [f"- {k}: {v}" for k, v in counts.most_common(40)]
    run.write_text(run.path("drafts", f"parts_draft_{a.screen}.md"), "\n".join(md) + "\n")
    print(f"Wrote drafts/parts_draft_{a.screen}.md ({len(obj.get('parts', []))} proposed parts, {obj.get('seconds')} s)")
    next_step(run, f"read drafts/parts_draft_{a.screen}.md and merge what you keep into the codebook")
    return 0


# --- Markdown for literature-extraction ------------------------------------------------------------

def yaml_value(v) -> str:
    return json.dumps("" if v is None else str(v), ensure_ascii=False)


def cmd_markdown(a) -> int:
    run = open_run(a.run)
    tables, codebook, spec = load_everything(run)
    out = Path(a.out).expanduser().resolve()
    run.guard(out)
    part = a.part
    pspec = spec["parts"][part]
    renderer = D.Renderer(tables, spec, part)
    from tables import screened_for  # noqa: PLC0415
    screened = screened_for(run, spec, part)
    units = renderer.units(screened)
    if a.min_relevance and screened:
        units = [u for u in units if screened.get(u[1][1].get(pspec["id"], "").strip(), {}).get("r", 0) >= a.min_relevance]
    if a.limit:
        units = units[: a.limit]
    meta_cols = pspec.get("markdown") or {}
    written = mismatches = 0
    out.mkdir(parents=True, exist_ok=True)
    for uid, unit, seg in units:
        t, row = unit
        r = renderer.render(unit, segment=seg, unit_id=uid, show_ids=False, show_codes=False)
        speaker_col = (pspec.get("text") or {}).get("speaker")
        fm = {"title": f"{uid} · {row.get(meta_cols.get('title', 'thread_title'), '') or r.header.get('thread_title', '')}".strip(" ·"),
              "author": row.get(speaker_col, "") if speaker_col else "",
              "date": (row.get(meta_cols.get("date", (pspec.get("text") or {}).get("date") or ""), "") or "")[:10],
              "posturl": row.get(meta_cols.get("url", "url"), ""),
              "source_type": meta_cols.get("source_type", "forum post"),
              "unit_id": uid, "part": part, "table": t, "row": row.get(pspec["id"], "")}
        body = "---\n" + "".join(f"{k}: {yaml_value(v)}\n" for k, v in fm.items()) + "---\n\n" + r.clean
        path = out / f"{D.slug_token(uid)}.md"
        run.write_text(path, body)
        written += 1
        # read it back: the header must describe the same row the body came from
        back = path.read_text(encoding="utf-8").split("---\n")[1]
        parsed = {line.split(": ", 1)[0]: json.loads(line.split(": ", 1)[1]) for line in back.strip().splitlines()}
        if parsed.get("row") != row.get(pspec["id"], "") or parsed.get("author") != fm["author"]:
            mismatches += 1
    check = ""
    if LIT_EXTRACTION.exists():
        proc = subprocess.run([sys.executable, str(LIT_EXTRACTION), "plan", str(out), "--json"], capture_output=True, text=True)
        try:
            plan = json.loads(proc.stdout)
            found = plan.get("documents") or plan.get("sources") or plan.get("count")
            check = f"literature-extraction plan found {len(found) if isinstance(found, list) else found} documents"
        except json.JSONDecodeError:
            check = f"literature-extraction plan did not return JSON ({proc.returncode})"
    C.counts_header("Markdown export", [("files", written), ("header/body mismatches", mismatches), ("folder", out),
                                        ("check", check or "literature-extraction not found")])
    return 0 if not mismatches else 1


# --- publish into UPC -----------------------------------------------------------------------------

PUBLISH_BATCH = 2000
UNITS_PER_SET = 500


def name_mapper(run: D.Run, tables, spec: dict, enabled: bool):
    """Keyed-hash pseudonyms for every speaker named in the tables' speaker columns."""
    if not enabled:
        return None, {}
    import hashlib  # noqa: PLC0415
    import hmac  # noqa: PLC0415
    import secrets  # noqa: PLC0415
    key_path = run.path("state", "pseudonym.key")
    if not key_path.exists():
        run.write_text(key_path, secrets.token_hex(16))
    key = key_path.read_text().strip().encode()
    names = set()
    for part in spec["parts"].values():
        cols = [(part.get("text") or {}).get("speaker")] + [r.get("speaker") for r in part.get("related", [])] + \
               [c.get("speaker") for c in part.get("context", [])]
        tabs = part["table"] if isinstance(part["table"], list) else [part["table"]]
        for rel in part.get("related", []):
            tabs.append(rel["path"][-1]["to"].split(".")[0])
        for ctx in part.get("context", []):
            tabs.append(ctx["table"])
        for t in set(tabs):
            for c in cols:
                if c and c in tables[t].columns:
                    names.update(v.strip() for v in (r.get(c, "") for r in tables[t].rows) if len(v.strip()) >= 3)
    mapping = {n: "User-" + hmac.new(key, n.encode(), hashlib.sha256).hexdigest()[:6] for n in names}
    ordered = sorted(mapping, key=len, reverse=True)
    rx = re.compile(r"(?<![\w@])@?(" + "|".join(re.escape(n) for n in ordered) + r")(?!\w)") if ordered else None

    def apply(text: str) -> str:
        if not rx or not text:
            return text
        return rx.sub(lambda m: ("@" if m.group(0).startswith("@") else "") + mapping[m.group(1)], text)
    return apply, mapping


def cmd_publish(a) -> int:
    import import_bundle as IB  # noqa: PLC0415
    import make_codebooks as MC  # noqa: PLC0415
    run = open_run(a.run)
    tables, codebook, spec = load_everything(run)
    corpus = run.guard(Path(a.corpus).expanduser().resolve())
    parts = [p for p in (a.parts.split(",") if a.parts else spec["parts"]) if run.coded(p)]
    order = []
    for p in parts:  # dependencies first, so relations can point at their sources
        for dep in dependencies(spec, p):
            if dep in parts and dep not in order:
                order.append(dep)
        if p not in order:
            order.append(p)
    try:
        upc_version = C.check_compat()
    except C.Unavailable as e:
        C.die(str(e))
    namespace = D.slug_token(a.namespace or run.slug)[:40]
    ledger_path = run.path("state", "publish", D.slug_token(str(corpus))[-60:], "ledger.json")
    ledger = json.loads(ledger_path.read_text(encoding="utf-8")) if ledger_path.exists() else {"units": {}}
    mapper, mapping = name_mapper(run, tables, spec, a.pseudonymize)
    plan_rows = []
    work = []
    for part in order:
        recs = run.coded(part)
        ids = sorted(recs)
        if a.limit:
            ids = ids[: a.limit]
        work.append((part, ids, recs))
        plan_rows.append((part, f"{len(ids)} units ({sum(1 for u in ids if ledger['units'].get(f'{part}:{u}', {}).get('done'))} already published)"))
    existing = len(list(corpus.glob("sources/*/source.json")))
    calls = sum(len(ids) for _p, ids, _r in work)
    C.counts_header("Publish plan", [*plan_rows, ("corpus", f"{corpus} ({existing} sources)"), ("namespace", namespace),
                                     ("pseudonyms", f"{len(mapping)} names" if a.pseudonymize else "no (real usernames; keep the site private)"),
                                     ("estimated minutes", IB.estimate_minutes(existing, calls, calls)), ("upc", upc_version)])
    if a.plan:
        print("Planning only; nothing was written.")
        return 0
    t0 = time.time()
    C.create_corpus(corpus, upc_version, run.config.get("name", run.name))
    totals = Counter()
    notes = []
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with IB.ImportLock(corpus):
        src_of: dict[str, str] = {k: v["source_id"] for k, v in ledger["units"].items() if v.get("source_id")}
        # codebooks first (their ids are needed by codings)
        books = {}
        rows_cb = []
        for part, _ids, _recs in work:
            ev = spec["parts"][part].get("evidence") or {}
            for f in codebook.parts[part]["fields"]:
                fd = codebook.fields[f]
                if fd["type"] == "text" or f in books:
                    continue
                values = {}
                for p2, _i, _r in work:
                    if f in codebook.parts[p2]["fields"]:
                        values.update(D.field_values(spec, tables, codebook, f, p2) or {})
                codes = []
                if fd["type"] == "int":
                    lo, hi = M.int_range(spec["parts"][part], codebook, f)
                    codes = [{"code": str(i), "label": str(i)} for i in range(lo, hi + 1)]
                else:
                    for c, m in values.items():
                        codes.append({"code": D.slug_token(c), "label": c, **({"definition": m} if m else {})})
                        if fd["type"] == "multi_with_polarity":
                            for pol in M.polarity_values(spec["parts"][part], f):
                                codes.append({"code": D.slug_token(f"{c}-{pol}"), "label": f"{c} ({pol})", "parent": D.slug_token(c)})
                entry = {"slug": D.slug_token(f), "title": f, "question": fd["def"][:500], "closed": True,
                         "multi_label": fd["type"] != "single" and fd["type"] != "int",
                         "unit": "passage" if f in ev and fd["type"] in ("multi_with_quotes", "multi_with_polarity") else "source",
                         "tool": "upc-corpus", "method": "import", "codes": codes}
                obj, dest, status, _w = MC.build_codebook(corpus, entry, namespace)
                rows_cb.append((obj, dest, status))
                books[f] = obj
        MC.write_codebooks(corpus, rows_cb)
        # Three passes over all parts: every source first, then every anchor (each `upc`
        # call reloads the whole corpus, so anchoring before any coding exists keeps the
        # calls cheap), then every coding. Each pass is idempotent: upc answers "exists".
        rendered_by: dict[str, dict] = {}
        ids_by: dict[str, list[str]] = {}
        meta_by: dict[str, tuple[str, str]] = {}
        for part, ids, recs in work:
            pspec = spec["parts"][part]
            coded_deps = {dep: run.coded_values(dep) for dep in dependencies(spec, part)}
            renderer = D.Renderer(tables, spec, part, coded=coded_deps, name_map=mapper)
            units = {uid: (unit, seg) for uid, unit, seg in D.Renderer(tables, spec, part).units()}
            coder = next(iter(recs.values()))["coder"]
            psha = next(iter(recs.values())).get("prompt_sha", "")
            meta_by[part] = (coder, psha)
            text_dir = run.path("state", "publish", "texts", part)
            records, record_ids, rendered = [], [], {}
            for uid in ids:
                key = f"{part}:{uid}"
                if ledger["units"].get(key, {}).get("done") or uid not in units:
                    continue
                unit, seg = units[uid]
                r = renderer.render(unit, segment=seg, unit_id=uid, show_ids=False, show_codes=False)
                rendered[uid] = r
                path = text_dir / f"{D.slug_token(uid)}.txt"
                run.write_text(path, r.clean)
                row = unit[1]
                speaker_col = (pspec.get("text") or {}).get("speaker")
                who = (row.get(speaker_col, "") or "").strip() if speaker_col else ""
                who = mapper(who) if mapper and who else who
                date = (row.get((pspec.get("text") or {}).get("date") or "", "") or "")[:10]
                bib = {"title": f"{uid} · {r.header.get('thread_title', '')}".strip(" ·"), "item_type": "post"}
                if who:
                    bib["authors"] = [{"family": who}]  # the site reads family/given; a username has neither, so it goes in family
                if re.match(r"\d{4}-\d{2}-\d{2}", date):
                    bib["issued"] = {"date_parts": [[int(date[:4]), int(date[5:7]), int(date[8:10])]]}
                url = (row.get("url") or "").strip()
                if url.startswith(("http://", "https://")):
                    bib["url"] = url
                rels = []
                for rel in pspec.get("related", []):
                    dep = rel.get("include_codes")
                    for _t, rr in D.resolve_path(tables, [unit], rel["path"]):
                        sid = src_of.get(f"{dep}:{rr.get(rel['id'], '').strip()}")
                        if sid:
                            rels.append({"type": "x-shows", "target": sid})
                records.append({"slug": D.slug_token(f"{part}-{uid}")[:60], "title": bib["title"], "source_kind": "document",
                                "bibliographic": bib, "aliases": {namespace: uid}, "relations": rels,
                                "ext": {"upc-corpus-tables": {"run": run.name, "part": part, "table": r.header.get("table"),
                                                              "row": r.header.get("row"), "case_sha": r.sha256, "coder": coder}},
                                "files": [{"path": str(path), "role": "text", "media_type": "text/plain",
                                           "produced_by": "conversion"}]})
                record_ids.append(uid)
            if records:
                print(f"  adding {len(records)} {part} sources", flush=True)
                res = C.upc_jsonl("add", "source", "--corpus", str(corpus), "--batch", "--tool", "upc-corpus", records=records)
                folders = {}
                for sj in corpus.glob("sources/*/source.json"):
                    folders[(C.load_json(sj, {}) or {}).get("source_id")] = sj.parent.name
                for uid, result in zip(record_ids, (res or {}).get("results", [])):
                    status = result.get("status")
                    totals[f"{part} sources {status}"] += 1
                    if status not in ("added", "exists"):
                        notes.append(f"{part} {uid}: {result.get('detail', 'add failed')}")
                        continue
                    slug = result.get("slug") or folders.get(result.get("source_id"))
                    src = C.load_json(corpus / "sources" / str(slug) / "source.json", {}) or {}
                    rep = C.reading_copy(src.get("representations", []))
                    ledger["units"][f"{part}:{uid}"] = {"source_id": result["source_id"], "slug": slug,
                                                         "rep": rep["representation_id"] if rep else None,
                                                         "case_sha": rendered[uid].sha256, "done": False}
                    src_of[f"{part}:{uid}"] = result["source_id"]
                run.write_json(ledger_path, ledger)
            rendered_by[part] = rendered
            ids_by[part] = record_ids
        # pass 2: anchor every cited sentence, one call per source
        ext_of: dict[tuple[str, str, str], str] = {}
        anchor_calls = sum(1 for part, _i, recs in work for uid in ids_by[part]
                           if any(recs[uid].get("evidence", {}).values()))
        done_calls = 0
        for part, _ids, recs in work:
            coder, psha = meta_by[part]
            rendered = rendered_by[part]
            located = []
            for n, uid in enumerate(ids_by[part], 1):
                entry = ledger["units"].get(f"{part}:{uid}")
                if not entry or not entry.get("rep"):
                    continue
                r = rendered[uid]
                rec = recs[uid]
                cited = []
                for f, items in rec.get("evidence", {}).items():
                    for it in items:
                        for i in (it["ids"] if isinstance(it, dict) else [it]):
                            if i not in cited:
                                cited.append(i)
                cands = []
                for i in cited:
                    if i not in r.clean_spans:
                        totals["evidence not in the reading copy"] += 1
                        continue
                    a0, z0 = r.clean_spans[i]
                    quote = r.clean[a0:z0]
                    if C.occurrences(r.clean, quote) > 1:
                        quote = C.widen_to_unique(r.clean, quote) or ""
                    if len(quote) < 3:
                        totals["evidence repeated in its case (not published)"] += 1
                        continue
                    cands.append((i, quote))
                if not cands:
                    continue
                set_name = f"exs-{D.slug_token(coder)[:40]}-{D.slug_token(part)[:12]}-{(n - 1) // UNITS_PER_SET + 1:03d}"
                res = C.upc_jsonl("anchor", "--corpus", str(corpus), "--rep", entry["rep"], "--set", set_name,
                                  "--type", "quote", "--tool", "upc-corpus", "--model", rec.get("model", "unknown"),
                                  "--prompt-version", psha,
                                  records=[{"quote": q, "note": f"{part} sentence {i}"} for i, q in cands])
                done_calls += 1
                by_index = {x.get("i"): x for x in (res or {}).get("results", [])} if isinstance(res, dict) else {}
                for k, (i, q) in enumerate(cands):
                    x = by_index.get(k, {})
                    st = x.get("status", "no result")
                    totals[f"passages {st}"] += 1
                    if st in ("anchored", "refound", "exists"):
                        ext_of[(part, uid, i)] = x["extraction_id"]
                        sp = rec["spans"].get(i) or {}
                        located.append((x["extraction_id"], entry["rep"],
                                        f"{sp.get('table')} {sp.get('row')} {sp.get('column')} {sp.get('start')}-{sp.get('end')}"))
                if done_calls % 100 == 0:
                    el = time.time() - t0
                    print(f"  anchored {done_calls}/{anchor_calls} sources ({round(el / 60, 1)} min)", flush=True)
            # locators: table, row, column and cell offsets of each passage
            if located:
                by_ext = {e: (rep, val) for e, rep, val in located}
                for set_file in sorted(corpus.glob(f"extractions/exs-{D.slug_token(coder)[:40]}-{D.slug_token(part)[:12]}-*/items.jsonl")):
                    items = IB.read_jsonl(set_file)
                    changed = False
                    for obj in items:
                        hit = by_ext.get(obj.get("extraction_id"))
                        if not hit:
                            continue
                        present = {(s.get("type"), s.get("value")) for s in obj.get("secondary_locators") or []}
                        loc = {"type": "section", "representation_ref": obj.get("representation_ref"), "value": hit[1]}
                        if ("section", hit[1]) not in present:
                            obj["secondary_locators"] = (obj.get("secondary_locators") or []) + [loc]
                            changed = True
                    if changed:
                        tmp = set_file.with_suffix(".jsonl.tmp")
                        tmp.write_text("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in items), encoding="utf-8")
                        tmp.replace(set_file)
        # pass 3: codings (model, then human)
        for part, _ids, recs in work:
            coder, psha = meta_by[part]
            pspec = spec["parts"][part]
            ev_fields = pspec.get("evidence") or {}
            codings = []
            for uid in ids_by[part]:
                entry = ledger["units"].get(f"{part}:{uid}")
                if not entry:
                    continue
                rec = recs[uid]
                sid = entry["source_id"]
                for f in codebook.parts[part]["fields"]:
                    fd = codebook.fields[f]
                    if f not in books:
                        continue
                    book = books[f]["codebook_id"]
                    if fd["type"] in ("multi_with_quotes", "multi_with_polarity"):
                        for it in rec.get("evidence", {}).get(f, []):
                            code = D.slug_token(it["code"] + (f"-{it['polarity']}" if it.get("polarity") else ""))
                            for i in it["ids"]:
                                if (part, uid, i) in ext_of:
                                    codings.append({"codebook_ref": book, "code": code, "coder": coder,
                                                    "target": {"kind": "extraction", "id": ext_of[(part, uid, i)]}})
                            codings.append({"codebook_ref": book, "code": code, "coder": coder,
                                            "target": {"kind": "source", "id": sid}})
                        continue
                    v = rec["fields"].get(f)
                    vals = v if isinstance(v, list) else ([] if v is None else [v])
                    for val in vals:
                        c = {"codebook_ref": book, "code": D.slug_token(str(val)) if fd["type"] != "int" else str(val),
                             "coder": coder, "target": {"kind": "source", "id": sid}}
                        if f.startswith("J_") and rec["fields"].get("J_notes"):
                            c["rationale"] = rec["fields"]["J_notes"][:300]
                        codings.append(c)
                    for i in (rec.get("evidence", {}).get(f) or []) if f in ev_fields else []:
                        if (part, uid, i) in ext_of and vals:
                            codings.append({"codebook_ref": book, "code": D.slug_token(str(vals[0])), "coder": coder,
                                            "target": {"kind": "extraction", "id": ext_of[(part, uid, i)]}})
            set_c = f"cds-{D.slug_token(coder)[:40]}-{D.slug_token(part)[:12]}"
            if codings:
                print(f"  writing {len(codings)} {part} codings", flush=True)
            for start in range(0, len(codings), PUBLISH_BATCH):
                out = C.upc_jsonl("code", "--corpus", str(corpus), "--set", set_c, "--coder-kind", "model",
                                  "--tool", "upc-corpus", "--model", next(iter(recs.values())).get("model", "unknown"),
                                  "--prompt-version", psha, records=codings[start:start + PUBLISH_BATCH])
                for k, v in ((out or {}).get("tally") or {}).items() if isinstance(out, dict) else []:
                    totals[f"{part} codings {k}"] += v
            for uid in ids_by[part]:
                if f"{part}:{uid}" in ledger["units"]:
                    ledger["units"][f"{part}:{uid}"]["done"] = True
            run.write_json(ledger_path, ledger)
            # human codings from agreement sheets
            for hf in sorted(run.path("coded").glob(f"{part}.human-*.jsonl")):
                hcod = []
                who = hf.stem.split(".human-", 1)[1]
                for line in hf.read_text(encoding="utf-8").splitlines():
                    if not line.strip():
                        continue
                    h = json.loads(line)
                    sid = src_of.get(f"{part}:{h['unit']}")
                    if not sid:
                        continue
                    for f, v in h["fields"].items():
                        if f not in books:
                            continue
                        for val in (v if isinstance(v, list) else [v]):
                            hcod.append({"codebook_ref": books[f]["codebook_id"], "coder": who,
                                         "code": D.slug_token(str(val)) if codebook.fields[f]["type"] != "int" else str(val),
                                         "target": {"kind": "source", "id": sid}})
                if hcod:
                    out = C.upc_jsonl("code", "--corpus", str(corpus), "--set", f"cds-{who}", "--coder-kind", "human",
                                      "--tool", "upc-corpus", records=hcod)
                    totals[f"{part} human codings"] += ((out or {}).get("tally") or {}).get("coded", 0) if isinstance(out, dict) else 0
        C.upc("regen", str(corpus))
        rep = C.upc("validate", str(corpus))
        C.upc("event", "--corpus", str(corpus), check=False, stdin=json.dumps({
            "activity_type": "import", "tool": "upc-corpus", "status": "success",
            "notes": f"tables.py publish from run '{run.name}' ({run.root}): parts {', '.join(order)}"}))
    state = (f"{rep.get('status')} {rep.get('level')}, {len(rep.get('errors', []))} errors"
             if isinstance(rep, dict) else "UNAVAILABLE: validate did not return a report")
    C.counts_header("Publish result", [*sorted(totals.items()), ("corpus state", state),
                                       ("minutes", round((time.time() - t0) / 60, 1))])
    for n in notes[:10]:
        print(f"  NOTE {n}")
    if isinstance(rep, dict):
        for e in rep.get("errors", [])[:6]:
            print(f"  ERROR {e.get('code')}: {str(e.get('detail'))[:120]}")
    next_step(run, f"`python3 -u {Path(__file__).parent / 'publish.py'} --corpus \"{corpus}\" --out <dir> --name <name>` "
                   "builds the browsable site (keep it private: real usernames unless --pseudonymize)")
    return 0
