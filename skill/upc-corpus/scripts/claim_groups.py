#!/usr/bin/env python3
"""Group a theme's passages that make the same claim, so an overview can cite every
paper that independently says it (criteria-v2.1).

    python3 claim_groups.py --corpus <dir> --codes slug:code,… [--plan]   (inspect; synthesize.py --v2 calls it)

Most overview statements rest on one paper, because the writer is handed passages one
at a time and can't see which papers say the same thing. Here, for one theme:

  1. Only passages that can count as independent support take part, the same ones the
     statement confidence counts: everything but relayed claims ("reported",
     "background") and speculation, from a rated paper. At most MAX_POOL of them, the
     strongest first and at most 3 per paper.
  2. Embeddings (the embeddings server, cached by passage id) only ORDER that list, each
     passage beside its nearest neighbour, so like claims sit together. Within one theme
     every passage is about the same topic (cosine 0.75-0.9 throughout), so similarity
     alone can't tell a shared claim from a shared subject (tried 10-05).
  3. The model decides: it reads the whole list and says which passages truly make
     the same claim, in one sentence each. Similar topic is not enough; it must be the
     same claim. One call misses groups by chance (10-05: Electric vehicles got none
     on one seed and two good ones on another), so it is asked ROUNDS times and every
     checked group is kept, a passage in the first (largest) group that has it.
  4. Code checks: every key is one it was given, every group spans at least two papers,
     no passage is in two groups. A group is a hint to the writer, not evidence: the
     statement check afterwards asks each cited passage whether it supports the
     statement, and only then does it count.

Results are saved per theme under <corpus>/.upc/upc-corpus/claim-groups/ (resumable).
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402

MAX_POOL = 70         # passages the model reads per theme
PER_PAPER = 3
ROUNDS = 3            # calls per theme, each with its own seed; their checked groups are pooled
NOT_INDEPENDENT = {"reported", "background", "speculation", None}
VERSION = "claim-groups.v3"

SYS_GROUP = """You help write an evidence overview. You will see a list of short passages from research papers on one theme; passages that look alike are placed next to each other. Your job: find groups of passages from DIFFERENT papers that make the SAME claim: the same finding or argument about the same thing, not merely the same topic.

Rules:
- A group needs passages from at least two different papers (the paper is the name before the colon).
- A passage belongs to at most one group. Most passages belong to none: leave out any passage that only shares a topic.
- For each group, write the shared claim in one plain sentence that every passage in the group supports. Do not add anything none of them says.
- Prefer a few solid groups over many loose ones.
Answer with JSON only."""


def vectors(corpus: Path, ids: list[str], text_of) -> dict[str, "list[float]"]:
    """Embedding per passage id, cached in the corpus's tool state."""
    import numpy as np
    d = C.state_dir(corpus, "claim-groups", "vectors")
    idx_f, vec_f = d / "ids.json", d / "vectors.f32"
    known = C.load_json(idx_f, []) or []
    mat = np.fromfile(vec_f, dtype="<f4").reshape(-1, C.EMBED_DIMS) if vec_f.exists() and known else \
        np.zeros((0, C.EMBED_DIMS), dtype="<f4")
    pos = {e: i for i, e in enumerate(known)}
    need = [e for e in ids if e not in pos]
    if need:
        got = []
        for i in range(0, len(need), C.EMBED_BATCH):
            batch = need[i:i + C.EMBED_BATCH]
            got += C.embed_resilient([text_of(e)[:1400] for e in batch])
        new = [(e, v) for e, v in zip(need, got) if v is not None]
        if new:
            mat = np.vstack([mat, np.array([v for _, v in new], dtype="<f4")])
            known += [e for e, _ in new]
            mat.astype("<f4").tofile(vec_f)
            C.save_json(idx_f, known)
            pos = {e: i for i, e in enumerate(known)}
    out = {}
    for e in ids:
        if e in pos:
            v = mat[pos[e]]
            out[e] = v / (np.linalg.norm(v) or 1.0)
    return out


def pool(ids: list[str], source_of, strength, origin_of) -> list[str]:
    """The strongest independent passages, at most PER_PAPER per paper and MAX_POOL in all."""
    per: dict[str, int] = {}
    out = []
    for e in sorted(ids, key=strength, reverse=True):
        if origin_of(e) in NOT_INDEPENDENT or per.get(source_of(e), 0) >= PER_PAPER:
            continue
        per[source_of(e)] = per.get(source_of(e), 0) + 1
        out.append(e)
        if len(out) >= MAX_POOL:
            break
    return out


def neighbour_order(ids: list[str], vecs: dict) -> list[str]:
    """A nearest-neighbour chain: start at the first passage, always step to the most
    similar one not yet placed, so like passages sit side by side."""
    import numpy as np
    ids = [e for e in ids if e in vecs] + [e for e in ids if e not in vecs]
    have = [e for e in ids if e in vecs]
    if len(have) < 3:
        return ids
    M = np.vstack([vecs[e] for e in have])
    S = M @ M.T
    order, left = [0], set(range(1, len(have)))
    while left:
        i = order[-1]
        j = max(left, key=lambda k: S[i, k])
        order.append(j)
        left.discard(j)
    return [have[i] for i in order] + [e for e in ids if e not in vecs]


def group_task(ordered: list[str], label_of, quote_of) -> tuple[str, dict, dict]:
    keys, lines = {}, []
    for e in ordered:
        k = f"p{len(keys) + 1}"
        keys[k] = e
        lines.append(f"[{k}] {label_of(e)}: \"{' '.join(quote_of(e).split())[:600]}\"")
    schema = {"type": "object", "properties": {"groups": {"type": "array", "items": {
        "type": "object", "properties": {"claim": {"type": "string"}, "keys": {"type": "array", "items": {"type": "string"}}},
        "required": ["claim", "keys"]}}}, "required": ["groups"]}
    task = "PASSAGES:\n" + "\n".join(lines) + "\n\nReturn {\"groups\": [{\"claim\": \"...\", \"keys\": [\"p1\", \"p4\"]}, ...]}."
    return task, schema, keys


def checked(groups: list[dict], keys: dict, source_of) -> tuple[list[dict], list[str]]:
    """Code's word on the model's groups."""
    out, notes, seen = [], [], set()
    for g in groups or []:
        es = [keys[k] for k in dict.fromkeys(g.get("keys") or []) if k in keys]
        bad = [k for k in (g.get("keys") or []) if k not in keys]
        if bad:
            notes.append(f"unknown keys dropped: {', '.join(bad)}")
        es = [e for e in es if e not in seen]
        by_paper = {}
        for e in es:
            by_paper.setdefault(source_of(e), e)          # one passage per paper
        if len(by_paper) < 2:
            continue
        claim = " ".join(str(g.get("claim") or "").split())[:300]
        if not claim:
            continue
        seen.update(by_paper.values())
        out.append({"claim": claim, "passages": list(by_paper.values()), "papers": len(by_paper)})
    out.sort(key=lambda g: -g["papers"])
    return out, notes


def merged(rounds: list[list[dict]]) -> list[dict]:
    """Every round's checked groups, most papers first. A passage stays in the first group
    that has it; a group left with passages from fewer than two papers is dropped."""
    out, seen = [], set()
    for g in sorted((g for r in rounds for g in r), key=lambda g: -g["papers"]):
        es = [e for e in g["passages"] if e not in seen]     # already one passage per paper
        if len(es) < 2:
            continue
        seen.update(es)
        out.append({**g, "passages": es, "papers": len(es)})
    return out


def groups_for(corpus: Path, theme_key: str, ids: list[str], exts: dict, ratings: dict, papers: dict,
               url: str, rank: dict) -> dict:
    """{"groups": [...], "candidates": n, "sets": n} for one theme, cached by its inputs."""
    import appraise as A  # noqa: E402
    origin = lambda e: ((ratings.get(exts[e]["source_id"]) or {}).get("passages") or {}).get(e, {}).get("origin")  # noqa: E731
    source_of = lambda e: exts[e]["source_id"]  # noqa: E731
    rated = [e for e in ids if (ratings.get(source_of(e)) or {}).get("grade")]
    indep = pool(rated, source_of, lambda e: rank.get(e, -10 ** 6), origin)
    digest = hashlib.sha256(json.dumps([VERSION, MAX_POOL, ROUNDS, indep]).encode()).hexdigest()[:16]
    f = C.state_dir(corpus, "claim-groups") / f"{theme_key.replace(':', '-')}.json"
    prior = C.load_json(f) or {}
    if prior.get("digest") == digest:
        return prior
    vecs = vectors(corpus, indep, lambda e: exts[e]["direct_quote"])
    ordered = neighbour_order(indep, vecs)
    rec = {"digest": digest, "version": VERSION, "independent": len(indep), "sets": 1 if len(ordered) >= 2 else 0,
           "groups": [], "notes": []}
    if len(ordered) >= 2:
        task, schema, keys = group_task(ordered, lambda e: A.author_year(papers.get(source_of(e), {})),
                                        lambda e: exts[e]["direct_quote"])
        rounds, rec["meta"] = [], []
        for r in range(ROUNDS):
            out, meta = A.chat_json(url, SYS_GROUP, task, schema, 2500, seed=int(digest[:8], 16) + r, model="chat", effort="")
            got, notes = checked(out.get("groups"), keys, source_of)
            rounds.append(got)
            rec["notes"] += notes
            rec["meta"].append(meta)
        rec["groups"] = merged(rounds)
        rec["per_round"] = [len(g) for g in rounds]
    C.save_json(f, rec)
    return rec
