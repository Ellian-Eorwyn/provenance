"""Model layer of the tables route: prompts, output schemas, and the loops that
code units and screen sections. Every call goes to one local server at a time
(the servers are single-slot), with the part's instructions in a cached system
prompt and the rendered unit as the user message.
"""

from __future__ import annotations

import json
import math
import random
import re
import time
from collections import Counter, defaultdict

import common as C
import tables_data as D

SEED = 7
DEFAULT_TEXT_MAX = 600
DEFAULT_MAX_TOKENS = 3000
EVIDENCE_MAX = 3
SCREEN_WINDOW_CHARS = 8000
SCREEN_ROW_CHARS = 1400
SCREEN_OVERLAP = 1
SCREEN_MAX_TOKENS = 1500
POLARITY_WORDS = {"enforced", "violated", "contested"}

GENERAL_RULES = """GENERAL RULES
- Be descriptive and even-handed; do not decide who is right. Keep what the text says apart from what a reader might infer.
- Use only the allowed values. When the text does not settle a field, choose "unclear" or "not_applicable" where they are offered, or leave a list empty. A forced code is worse than an honest "unclear".
- Cite evidence by sentence id, never by retyping text. An id such as [S1.2] marks the sentence that follows it: the letter says whose words they are (see HOW A CASE IS SHOWN), the numbers say which block and which sentence. Cite only sentences that actually carry the code.
- Text between ‹quoted from X› and ‹end quote› is someone else's words quoted inside a post. It has no ids and is never the author's own words. ‹quotes S1› marks the place where the author quoted block S1."""


# --- prompts --------------------------------------------------------------------

def block_legend(part: dict) -> list[str]:
    lines = []
    for ctx in part.get("context", []):
        if ctx.get("before"):
            lines.append(f"- {ctx.get('code_before', 'E')}1, {ctx.get('code_before', 'E')}2 … = "
                         f"{ctx.get('label_before', 'EARLIER POST').lower()}s, oldest first")
    for rel in part.get("related", []):
        lines.append(f"- {rel['code']}1, {rel['code']}2 … = {rel['label'].lower()}"
                     + (f" (with the codes already given to it in {rel['include_codes']})" if rel.get("include_codes") else ""))
    if part.get("text"):
        lines.append(f"- {part.get('code', 'U')}1 = {part['text'].get('label', 'TEXT').lower()}: the text being coded")
    for ctx in part.get("context", []):
        if ctx.get("after"):
            lines.append(f"- {ctx.get('code_after', 'L')}1, {ctx.get('code_after', 'L')}2 … = "
                         f"{ctx.get('label_after', 'LATER POST').lower()}s, oldest first")
    return lines


def field_lines(spec: dict, tables, codebook: D.Codebook, part_name: str) -> list[str]:
    part = spec["parts"][part_name]
    evidence = part.get("evidence") or {}
    out = []
    for name in codebook.parts[part_name]["fields"]:
        f = codebook.fields[name]
        line = f"- {name} ({f['type']}): {f['def']}".rstrip()
        values = D.field_values(spec, tables, codebook, name, part_name)
        if values and not f["lookup"]:
            line += " Allowed: " + "; ".join(f"{c} = {m}" if m else c for c, m in values.items())
        elif values and f["lookup"]:
            line += f" Allowed: the {f['lookup']} ids listed below" + \
                    (" (or none)" if "none" in values else "") + "."
        if f["type"] == "int":
            lo, hi = int_range(part, codebook, name)
            line += f" An integer from {lo} to {hi}."
        if f["type"] == "text":
            line += f" At most {text_max(part, name)} characters."
        if f["type"] == "multi_with_polarity":
            line += f" Polarity is one of: {', '.join(polarity_values(part, name))}."
        speakers = evidence.get(name)
        if speakers:
            where = " or ".join(speakers)
            if f["type"] in ("multi_with_quotes", "multi_with_polarity"):
                line += f" For each code cite 1–{EVIDENCE_MAX} sentence ids from {where}."
            else:
                line += f" Also give {name}_evidence: up to {EVIDENCE_MAX} sentence ids from {where} that support it."
        out.append(line)
    return out


def lookup_block(spec: dict, tables, codebook: D.Codebook, part_name: str) -> str:
    names = sorted({codebook.fields[f]["lookup"] for f in codebook.parts[part_name]["fields"]
                    if codebook.fields[f]["lookup"]})
    blocks = []
    for name in names:
        lk = spec["lookups"][name]
        rows = []
        for code, v in D.lookup_values(spec, tables, name, part_name).items():
            bit = f"- {code}: {v['label']}"
            if v["definition"]:
                bit += f". {v['definition']}"
            if v["date"]:
                bit += f" (in force from {v['date']})"
            rows.append(bit)
        blocks.append(f"{name} ({lk.get('title', name)}):\n" + "\n".join(rows))
    return "\n\n".join(blocks)


def system_prompt(spec: dict, tables, codebook: D.Codebook, part_name: str) -> str:
    part = spec["parts"][part_name]
    parts = [
        f"You are coding data for a research project, one {codebook.parts[part_name].get('unit') or 'unit'} at a time.",
        f"RESEARCH QUESTION: {spec.get('question', '').strip()}" if spec.get("question") else "",
        GENERAL_RULES,
        "HOW A CASE IS SHOWN\n" + "\n".join(block_legend(part)),
        part.get("instructions", "").strip(),
        "FIELDS (answer in this order)\n" + "\n".join(field_lines(spec, tables, codebook, part_name)),
        lookup_block(spec, tables, codebook, part_name),
        "Return one JSON object with exactly the keys of the fields above (plus the *_evidence keys named there).",
    ]
    return "\n\n".join(p for p in parts if p)


def int_range(part: dict, codebook: D.Codebook, name: str) -> tuple[int, int]:
    r = (part.get("int_ranges") or {}).get(name)
    if r:
        return int(r[0]), int(r[1])
    guessed = D.neutral_int_range(codebook.fields[name])
    return guessed or (0, 5)


def text_max(part: dict, name: str) -> int:
    return int((part.get("text_max") or {}).get(name, DEFAULT_TEXT_MAX))


def polarity_values(part: dict, name: str) -> list[str]:
    return list((part.get("polarity") or {}).get(name, D.DEFAULT_POLARITY))


def output_schema(spec: dict, tables, codebook: D.Codebook, part_name: str, rendered: D.Rendered) -> dict:
    part = spec["parts"][part_name]
    evidence = part.get("evidence") or {}
    props, required = {}, []

    def ids_for(speakers: list[str]) -> list[str]:
        return [eid for s in speakers for eid in rendered.speakers.get(s, [])]

    def ev_array(ids: list[str], min_items: int = 0) -> dict:
        if not ids:
            return {"type": "array", "maxItems": 0}
        return {"type": "array", "items": {"type": "string", "enum": ids}, "minItems": min_items, "maxItems": EVIDENCE_MAX}

    for name in codebook.parts[part_name]["fields"]:
        f = codebook.fields[name]
        values = D.field_values(spec, tables, codebook, name, part_name)
        t = f["type"]
        if t == "single":
            props[name] = {"type": "string", "enum": list(values)}
        elif t == "multi":
            props[name] = {"type": "array", "items": {"type": "string", "enum": list(values)}}
        elif t == "int":
            lo, hi = int_range(part, codebook, name)
            props[name] = {"type": "integer", "minimum": lo, "maximum": hi}
        elif t == "text":
            props[name] = {"type": "string", "maxLength": text_max(part, name)}
        elif t in ("multi_with_quotes", "multi_with_polarity"):
            ids = ids_for(evidence.get(name, []))
            if not ids:
                props[name] = {"type": "array", "maxItems": 0}
            else:
                item = {"type": "object", "properties": {"code": {"type": "string", "enum": list(values)}},
                        "required": ["code"], "additionalProperties": False}
                if t == "multi_with_polarity":
                    item["properties"]["polarity"] = {"type": "string", "enum": polarity_values(part, name)}
                    item["required"].append("polarity")
                item["properties"]["evidence"] = ev_array(ids, 1)
                item["required"].append("evidence")
                props[name] = {"type": "array", "items": item}
        required.append(name)
        if evidence.get(name) and t not in ("multi_with_quotes", "multi_with_polarity"):
            props[f"{name}_evidence"] = ev_array(ids_for(evidence[name]))
            required.append(f"{name}_evidence")
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


# --- checking an answer ----------------------------------------------------------------

def check_answer(obj: dict, spec: dict, tables, codebook: D.Codebook, part_name: str,
                 rendered: D.Rendered) -> tuple[dict, dict, list[str]]:
    """(field values, evidence per field, problems). Unknown values and ids are
    dropped and reported; a missing single field becomes unclear/None."""
    part = spec["parts"][part_name]
    allowed_speakers = part.get("evidence") or {}
    fields, evidence, bad = {}, {}, []

    def ok_ids(name: str, ids) -> list[str]:
        keep = []
        for i in ids if isinstance(ids, list) else []:
            e = rendered.evidence.get(i)
            if not e:
                bad.append(f"{name}: unknown sentence id {i}")
            elif e.code not in allowed_speakers.get(name, []):
                bad.append(f"{name}: {i} is not from {'/'.join(allowed_speakers.get(name, []))}")
            elif i not in keep:
                keep.append(i)
        return keep

    for name in codebook.parts[part_name]["fields"]:
        f = codebook.fields[name]
        values = D.field_values(spec, tables, codebook, name, part_name)
        v = obj.get(name)
        t = f["type"]
        if t == "single":
            if v not in (values or {}):
                if v is not None:
                    bad.append(f"{name}={v}")
                v = next((x for x in ("unclear", "not_applicable", "none") if x in (values or {})), None)
            fields[name] = v
        elif t == "multi":
            v = v if isinstance(v, list) else ([] if v is None else [v])
            bad += [f"{name}={x}" for x in v if x not in (values or {})]
            fields[name] = list(dict.fromkeys(x for x in v if x in (values or {})))
        elif t == "int":
            lo, hi = int_range(part, codebook, name)
            if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
                if v is not None:
                    bad.append(f"{name}={v}")
                v = None
            fields[name] = v
        elif t == "text":
            fields[name] = (v if isinstance(v, str) else "").strip()[: text_max(part, name)]
        else:
            items = []
            for it in v if isinstance(v, list) else []:
                if not isinstance(it, dict) or it.get("code") not in (values or {}):
                    bad.append(f"{name}={it}")
                    continue
                entry = {"code": it["code"], "ids": ok_ids(name, it.get("evidence"))}
                if t == "multi_with_polarity":
                    pol = it.get("polarity")
                    if pol not in polarity_values(part, name):
                        bad.append(f"{name}: polarity {pol}")
                        pol = None
                    entry["polarity"] = pol
                items.append(entry)
            fields[name] = [e["code"] + (f"({e['polarity']})" if e.get("polarity") else "") for e in items]
            evidence[name] = items
        if allowed_speakers.get(name) and t not in ("multi_with_quotes", "multi_with_polarity"):
            evidence[name] = ok_ids(name, obj.get(f"{name}_evidence"))
    return fields, evidence, bad


def spans_for(evidence: dict, rendered: D.Rendered) -> dict[str, dict]:
    ids = set()
    for items in evidence.values():
        for it in items:
            ids.update(it["ids"] if isinstance(it, dict) else [it])
    out = {}
    for i in sorted(ids):
        e = rendered.evidence[i]
        out[i] = {"table": e.table, "row": e.row, "column": e.column, "start": e.start, "end": e.end,
                  "speaker": e.speaker, "text": e.text}
    return out


# --- server checks ------------------------------------------------------------------------

def busy_seconds(url: str = C.CHAT_URL, model: str = "chat") -> float | None:
    """Time a one-token answer: a slow reply means another job has the model."""
    try:
        return C.llm_chat("Reply with OK.", "OK?", url=url, model=model, max_tokens=1, temperature=0,
                          timeout=120)["seconds"]
    except C.Unavailable:
        return None


# --- coding --------------------------------------------------------------------------

def code_one(spec, tables, codebook, part_name, rendered, *, system: str, model: str, url: str,
             max_tokens: int) -> dict:
    """One model call (plus one retry when the answer was cut off or unreadable)."""
    schema = output_schema(spec, tables, codebook, part_name, rendered)
    attempts, last = 0, None
    tokens = max_tokens
    while attempts < 2:
        attempts += 1
        res = C.llm_chat(system, rendered.text, url=url, model=model, max_tokens=tokens, temperature=0,
                         schema=schema, seed=SEED)
        last = res
        obj = C.parse_json_loose(res["content"])
        if obj is not None and res.get("finish_reason") != "length":
            res["parsed"] = obj
            res["attempts"] = attempts
            return res
        tokens = min(tokens * 2, 12000)
    last["parsed"] = None
    last["attempts"] = attempts
    return last


def stratified_sample(units: list, n: int, key, seed: int = 11) -> list:
    rng = random.Random(seed)
    groups = defaultdict(list)
    for u in units:
        groups[key(u)].append(u)
    for g in groups.values():
        rng.shuffle(g)
    pick = []
    keys = sorted(groups)
    while len(pick) < n and any(groups.values()):
        for k in keys:
            if groups[k] and len(pick) < n:
                pick.append(groups[k].pop())
    return pick


def strata_key(part: dict):
    specs = part.get("strata") or []

    def key(unit):
        _uid, (_t, row), _seg = unit
        out = []
        for s in specs:
            v = (row.get(s["column"]) or "").strip()
            if s.get("transform") == "year":
                v = v[:4]
            elif s.get("transform") == "first":
                v = D.list_values(v)[0] if D.list_values(v) else ""
            out.append(v)
        return tuple(out)
    return key


# --- screening -------------------------------------------------------------------------

def screen_row_text(row: dict, scr: dict, style: str | None, row_chars: int, name_map=None) -> str:
    text = row.get(scr["text"], "") or ""
    segs = D.split_quote_blocks(text, style)
    pieces = []
    for s in segs:
        if s.kind == "quote":
            pieces.append(f"‹quotes {s.author or 'someone'}›")
        else:
            pieces.append(text[s.start:s.end].strip())
    own = "\n".join(p for p in pieces if p).strip() or "(no text)"
    if len(own) > row_chars:
        head = int(row_chars * 0.78)
        own = own[:head].rstrip() + " […] " + own[-(row_chars - head - 5):].lstrip()
    who = (row.get(scr.get("speaker") or "", "") or "").strip()
    when = (row.get(scr.get("date") or "", "") or "").strip()[:10]
    meta = " · ".join(x for x in (who, when) if x)
    return f"[{row.get(scr['id'], '').strip()}]{(' ' + meta) if meta else ''}\n{own}"


def screen_windows(tables, scr: dict, style: str | None) -> list[dict]:
    """Rows of a screen, grouped and ordered, packed whole into windows with a
    one-row overlap (the overlap row is context and is not scored again)."""
    name = scr["table"]
    rows = D.unit_rows(tables, {"table": name, "id": scr["id"], "where": scr.get("where", [])})
    group_col, order_col = scr.get("group"), scr.get("order")
    groups: dict[str, list[dict]] = defaultdict(list)
    for _t, r in rows:
        groups[(r.get(group_col, "") if group_col else "all").strip()].append(r)
    window_chars = scr.get("window_chars", SCREEN_WINDOW_CHARS)
    row_chars = scr.get("row_chars", SCREEN_ROW_CHARS)
    overlap = scr.get("overlap", SCREEN_OVERLAP)
    out = []
    for g in sorted(groups):
        members = groups[g]
        if order_col:
            members.sort(key=lambda r: (r.get(order_col, ""), r.get(scr["id"], "")))
        rendered = [(r, screen_row_text(r, scr, style, row_chars)) for r in members]
        k, i = 0, 0
        while i < len(rendered):
            size, ids, body = 0, [], []
            context = rendered[max(0, i - overlap):i] if overlap and i else []
            for r, t in context:
                body.append("(context, already screened)\n" + t)
                size += len(t)
            while i < len(rendered) and (not ids or size + len(rendered[i][1]) <= window_chars):
                r, t = rendered[i]
                ids.append(r.get(scr["id"], "").strip())
                body.append(t)
                size += len(t)
                i += 1
            k += 1
            first = members[0]
            head = " · ".join((first.get(h, "") or "").strip() for h in scr.get("header", []) if (first.get(h) or "").strip())
            out.append({"window": f"{g}-{k:04d}", "group": g, "ids": ids,
                        "text": (head + "\n\n" if head else "") + "\n\n".join(body)})
    return out


def screen_system(spec: dict, codebook: D.Codebook, scr: dict) -> str:
    parts_lines = []
    for p in scr.get("parts", []):
        if p == "new":
            continue
        cp = codebook.parts.get(p, {})
        parts_lines.append(f"- {p}: {cp.get('unit', '')}. Fields: {', '.join(cp.get('fields', []))}")
    return "\n\n".join(x for x in [
        f"You screen rows of a table for a research project. RESEARCH QUESTION: {spec.get('question', '').strip()}",
        scr.get("instructions", "").strip(),
        "CODEBOOK PARTS a row can be coded under:\n" + ("\n".join(parts_lines) or "- (none yet)")
        + "\n- new: relevant to the question, but none of the parts above fits it",
        "Read the window of consecutive rows. List ONLY the rows that are relevant; every row you do not list "
        "counts as not relevant. relevance: 1 marginal, 2 relevant, 3 central to the question. parts: which of "
        "the parts apply (or \"new\"). label: 2 to 4 words naming what the row does that matters. why: at most "
        "8 words. Rows marked \"(context, already screened)\" are there for context only; never list them.",
    ] if x)


def screen_schema(ids: list[str], parts: list[str]) -> dict:
    return {"type": "object", "properties": {"rows": {"type": "array", "items": {
        "type": "object", "properties": {
            "id": {"type": "string", "enum": ids},
            "r": {"type": "integer", "minimum": 1, "maximum": 3},
            "parts": {"type": "array", "items": {"type": "string", "enum": parts}},
            "label": {"type": "string", "maxLength": 40},
            "why": {"type": "string", "maxLength": 80}},
        "required": ["id", "r", "parts", "label", "why"], "additionalProperties": False}}},
        "required": ["rows"], "additionalProperties": False}


def screen_one(system: str, window: dict, parts: list[str], *, model: str, url: str) -> dict:
    res = C.llm_chat(system, window["text"], url=url, model=model, max_tokens=SCREEN_MAX_TOKENS, temperature=0,
                     schema=screen_schema(window["ids"], parts), seed=SEED)
    obj = C.parse_json_loose(res["content"])
    status = "ok" if obj is not None and res.get("finish_reason") != "length" else "failed"
    rows = []
    if status == "ok":
        seen = set()
        for r in obj.get("rows", []):
            if r.get("id") in window["ids"] and r["id"] not in seen:
                seen.add(r["id"])
                rows.append({"id": r["id"], "r": int(r.get("r", 1)), "parts": [p for p in r.get("parts", []) if p in parts],
                             "label": (r.get("label") or "")[:40], "why": (r.get("why") or "")[:80]})
    return {"status": status, "rows": rows, "seconds": res["seconds"], "prompt_tokens": res.get("prompt_tokens"),
            "completion_tokens": res.get("completion_tokens"), "finish_reason": res.get("finish_reason")}


# --- statistics ------------------------------------------------------------------------------

def wilson(k: float, n: float, z: float = 1.96) -> tuple[float, float] | None:
    if n <= 0:
        return None
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def cohens_kappa(pairs: list[tuple]) -> float | None:
    if not pairs:
        return None
    n = len(pairs)
    agree = sum(1 for a, b in pairs if a == b) / n
    labels = {x for p in pairs for x in p}
    pe = sum((sum(1 for a, _ in pairs if a == x) / n) * (sum(1 for _, b in pairs if b == x) / n) for x in labels)
    return None if pe >= 1 else round((agree - pe) / (1 - pe), 3)


def weighted_kappa(pairs: list[tuple[int, int]], lo: int, hi: int) -> float | None:
    """Linearly weighted kappa for ordinal integers."""
    if not pairs or hi <= lo:
        return None
    n = len(pairs)
    cats = list(range(lo, hi + 1))
    w = lambda a, b: abs(a - b) / (hi - lo)  # noqa: E731
    obs = sum(w(a, b) for a, b in pairs) / n
    pa = Counter(a for a, _ in pairs)
    pb = Counter(b for _, b in pairs)
    exp = sum(pa[i] * pb[j] * w(i, j) for i in cats for j in cats) / (n * n)
    return None if exp == 0 else round(1 - obs / exp, 3)


def krippendorff_alpha_nominal(pairs: list[tuple]) -> float | None:
    """Alpha for two coders, nominal data, no missing values."""
    if not pairs:
        return None
    values = Counter()
    coincide = Counter()
    for a, b in pairs:
        coincide[(a, b)] += 1
        coincide[(b, a)] += 1
        values[a] += 1
        values[b] += 1
    n = sum(values.values())
    if n <= 1:
        return None
    do = sum(c for (a, b), c in coincide.items() if a != b)
    de = sum(values[a] * values[b] for a in values for b in values if a != b) / (n - 1)
    return None if de == 0 else round(1 - do / de, 3)


def jaccard(a: set, b: set) -> float:
    return 1.0 if not a and not b else len(a & b) / len(a | b)


# --- drafting helpers (the model proposes; the script checks) ----------------------------------

def describe_table(table_name: str, table_profile: dict, *, model: str, url: str) -> dict:
    cols = []
    for c, f in table_profile["columns"].items():
        flags = [k for k in ("int", "number", "bool", "date", "url", "list") if f[k] >= 0.8]
        qb = f" quote blocks: {f['quote_blocks']}" if f["quote_blocks"] else ""
        cols.append(f"- {c}: filled {f['fill']:.0%}, distinct {f['distinct']}{' (unique)' if f['unique'] else ''}, "
                    f"length median {f['len_p50']} max {f['len_max']}{', ' + '/'.join(flags) if flags else ''}{qb}; "
                    f"samples: {' | '.join(f['samples'])}")
    columns = list(table_profile["columns"])
    schema = {"type": "object", "properties": {
        "row_is": {"type": "string", "maxLength": 200},
        "columns": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string", "enum": columns},
            "role": {"type": "string", "enum": D.ROLES},
            "speaker_column": {"type": "string", "enum": columns + [""]},
            "note": {"type": "string", "maxLength": 120}},
            "required": ["name", "role", "speaker_column", "note"], "additionalProperties": False}}},
        "required": ["row_is", "columns"], "additionalProperties": False}
    system = ("You label the columns of one table so a research coding tool knows what each holds. Roles: "
              "id = unique key of a row; link = refers to rows of this or another table; text = words a person "
              "wrote that a researcher could quote; short_text = a title or label; speaker = who wrote the text; "
              "datetime; url; category = a small set of repeated values; number; flag = true/false; derived = a "
              "guess or tally computed by a tool (not the source's own words); code_slot = an empty column meant "
              "for coding by hand; other. For text columns name the speaker_column (or \"\"). Say in one sentence "
              "what one row is.")
    user = f"TABLE {table_name} ({table_profile['rows']} rows)\n" + "\n".join(cols)
    res = C.llm_chat(system, user, url=url, model=model, max_tokens=2500, temperature=0, schema=schema, seed=SEED)
    obj = C.parse_json_loose(res["content"]) or {}
    return {"row_is": obj.get("row_is", ""), "columns": {c["name"]: {"role": c["role"],
            "speaker_column": c.get("speaker_column") or None, "note": c.get("note", "")}
            for c in obj.get("columns", []) if c.get("name") in columns},
            "seconds": res["seconds"]}


def draft_parts(spec: dict, codebook: D.Codebook, labelled: list[dict], counts: Counter, *, model: str,
                url: str) -> dict:
    """New codebook parts for relevant rows no part covers. Reuses fields."""
    existing = []
    for p, cp in codebook.parts.items():
        existing.append(f"PART {p}: {cp.get('unit', '')}")
    for name, f in codebook.fields.items():
        vals = ", ".join(list(f["values"] or {})[:24]) if f["values"] else (f"values from {f['lookup']}" if f["lookup"] else "")
        existing.append(f"FIELD {name} ({f['type']}): {f['def'][:160]}{' Values: ' + vals if vals else ''}")
    sample = "\n\n".join(f"[{r['id']}] label: {r['label']} (relevance {r['r']})\n{r['text'][:500]}" for r in labelled)
    labels = "\n".join(f"- {lab}: {n}" for lab, n in counts.most_common(40))
    schema = {"type": "object", "properties": {"parts": {"type": "array", "maxItems": 3, "items": {
        "type": "object", "properties": {
            "name": {"type": "string", "maxLength": 40},
            "unit": {"type": "string", "maxLength": 200},
            "instructions": {"type": "string", "maxLength": 600},
            "reuse_fields": {"type": "array", "items": {"type": "string", "enum": list(codebook.fields)}},
            "new_fields": {"type": "array", "maxItems": 6, "items": {"type": "object", "properties": {
                "name": {"type": "string", "maxLength": 40},
                "type": {"type": "string", "enum": ["single", "multi", "int", "text", "multi_with_quotes"]},
                "def": {"type": "string", "maxLength": 300},
                "values": {"type": "array", "maxItems": 12, "items": {"type": "object", "properties": {
                    "code": {"type": "string", "maxLength": 40}, "meaning": {"type": "string", "maxLength": 160}},
                    "required": ["code", "meaning"], "additionalProperties": False}}},
                "required": ["name", "type", "def", "values"], "additionalProperties": False}},
            "why": {"type": "string", "maxLength": 300}},
        "required": ["name", "unit", "instructions", "reuse_fields", "new_fields", "why"],
        "additionalProperties": False}}}, "required": ["parts"], "additionalProperties": False}
    system = ("You help a researcher extend a codebook. Rows below were screened as relevant to the research "
              "question but no existing part covers them. Propose at most 3 new parts (a part = a kind of unit "
              "with the fields coded on it). Reuse existing fields wherever their definitions fit; add a new field "
              "only for something no existing field captures, with snake_case codes and plain definitions. "
              "Include \"unclear\" among the values of any new single field. Do not invent findings.\n\n"
              f"RESEARCH QUESTION: {spec.get('question', '')}\n\nEXISTING CODEBOOK\n" + "\n".join(existing))
    user = f"LABELS THE SCREEN GAVE (count)\n{labels}\n\nSAMPLE OF RELEVANT ROWS\n{sample}"
    res = C.llm_chat(system, user, url=url, model=model, max_tokens=4000, temperature=0, schema=schema, seed=SEED)
    obj = C.parse_json_loose(res["content"]) or {"parts": []}
    obj["seconds"] = res["seconds"]
    return obj
