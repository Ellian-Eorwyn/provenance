// UPC → RO-Crate export (spec/09 projection; crosswalks/ro-crate.md).
//
// A deterministic, zero-dependency projection of a UPC corpus into RO-Crate 1.3
// flattened JSON-LD. Export only: the UPC objects remain canonical, this is a
// regenerable view like index.html / the CSV mirrors. No JSON-LD processor and no
// network are needed — a consumer that wants RDF runs its own processor against
// the referenced @context.
//
// Guarantees preserved, not overloaded:
//   * @id is a *locator* (File = crate-relative path; abstract = "#<upc-id>").
//     The UPC content-addressed id is ALWAYS also carried in `identifier` +
//     `upc:<kind>Id`, so consumers key on those, never on @id.
//   * The quotation gate is UPC-only. Gated extractions get a companion Web
//     Annotation flagged `upc:interopOnly:true`; the UPC char_range stays
//     `upc:gateAuthoritative:true`. See spec/11 and crosswalks/web-annotation.md.
//   * Output is byte-identical across runs: sorted @graph, sorted ref arrays,
//     fixed key order, and NO wall-clock / random in the emitted document.

import fs from "node:fs";
import path from "node:path";
import * as U from "./upc_common.mjs";

const RO_CRATE_SPEC = "https://w3id.org/ro/crate/1.3";
const RO_CRATE_CONTEXT = "https://w3id.org/ro/crate/1.3/context";
const UPC_TERMS = "https://provenance.dev/upc/terms#";
const CONTEXT_LEN = 32; // codepoints of prefix/suffix for TextQuoteSelector

const isTextual = (mt) =>
  /^text\//.test(mt || "") || mt === "application/json" || mt === "application/xml";

/** schema.org type for a source, from its CSL item_type. Always adds upc:Source. */
function sourceTypes(itemType) {
  const map = {
    "article-journal": "ScholarlyArticle",
    "paper-conference": "ScholarlyArticle",
    book: "Book",
    chapter: "Chapter",
    report: "Report",
    thesis: "Thesis",
    webpage: "WebPage",
    dataset: "Dataset",
  };
  return [map[itemType] || "CreativeWork", "upc:Source"];
}

function authorNames(bib) {
  const list = bib && bib.authors;
  if (!Array.isArray(list)) return [];
  return list
    .map((a) => (a.literal ? a.literal : [a.family, a.given].filter(Boolean).join(", ")))
    .filter(Boolean);
}

function issuedYear(bib) {
  const d = bib && bib.issued;
  if (!d) return null;
  if (typeof d === "string") return d;
  if (d.date_parts && d.date_parts[0]) return String(d.date_parts[0][0]);
  if (d.raw) return d.raw;
  if (d.literal) return d.literal;
  return null;
}

const sortRefs = (arr) => arr.slice().sort((a, b) => (a["@id"] < b["@id"] ? -1 : a["@id"] > b["@id"] ? 1 : 0));

/**
 * Build the RO-Crate graph object from a loaded corpus (U.loadCorpus result).
 * Pure: no IO beyond U.getRepFile (reading representation bytes to derive verified
 * prefix/suffix, exactly as the browser does), no clock, no random. Deterministic.
 */
export function buildRoCrateGraph(loaded) {
  const corpus = loaded.corpus || {};
  const upcVer = /^1\./.test(corpus.upc_spec_version || "") ? corpus.upc_spec_version : "1.2.0";
  const profileId = `https://provenance.dev/upc/${upcVer}/profiles/ro-crate`;

  // rep-id -> relative path (File @id) and the cached record for context reads.
  const repIdToPath = new Map();
  const repRecById = new Map();
  for (const r of loaded.representations) {
    if (r.obj && r.obj.path) repIdToPath.set(r.obj.representation_id, r.obj.path);
    repRecById.set(r.obj.representation_id, r);
  }

  const idRef = (id) => {
    if (!id) return null;
    if (id.startsWith("rep-") || id.startsWith("img-")) return { "@id": repIdToPath.get(id) || "#" + id };
    return { "@id": "#" + id };
  };
  const derivedRefs = (df) => {
    const d = df || {};
    const ids = [].concat(
      d.source_ids || [], d.representation_refs || [], d.extraction_ids || [],
      d.generation_ids || [], d.synthesis_ids || []
    );
    return sortRefs(ids.map(idRef).filter(Boolean));
  };

  // Collectors keyed for de-duplication / determinism.
  const files = new Map();   // relPath -> File entity
  const tools = new Map();   // "#tool-slug" -> entity
  const persons = new Map(); // "#person-slug" -> entity
  const abstract = [];       // source/extraction/annotation/generation/synthesis/event entities

  const addFile = (relPath, patch) => {
    if (!relPath) return;
    let f = files.get(relPath);
    if (!f) { f = { "@id": relPath, "@type": "File", name: path.basename(relPath) }; files.set(relPath, f); }
    Object.assign(f, patch, { "@id": relPath, "@type": "File", name: f.name });
    // merge identifier when two representation records share one physical path
    if (patch && patch.identifier && f.__ids) {
      f.__ids.add(patch.identifier);
    } else if (patch && patch.identifier) {
      f.__ids = new Set([patch.identifier]);
    }
  };

  const toolRef = (pb) => {
    if (!pb || !pb.tool) return null;
    const slug = U.slugify(pb.tool + (pb.tool_version ? "-" + pb.tool_version : ""));
    const id = "#tool-" + slug;
    if (!tools.has(id)) {
      const e = { "@id": id, "@type": "SoftwareApplication", name: pb.tool };
      if (pb.tool_version) e.softwareVersion = pb.tool_version;
      tools.set(id, e);
    }
    return { "@id": id };
  };
  const personRef = (pb) => {
    if (!pb || !pb.person) return null;
    const id = "#person-" + U.slugify(pb.person);
    if (!persons.has(id)) persons.set(id, { "@id": id, "@type": "Person", name: pb.person });
    return { "@id": id };
  };

  // --- Representation File entities ---
  for (const r of loaded.representations) {
    const o = r.obj;
    const patch = { identifier: o.representation_id, encodingFormat: o.media_type };
    if (typeof o.bytes === "number") patch.contentSize = o.bytes;
    patch["upc:sha256"] = U.bareHash(o.sha256);
    patch["upc:role"] = o.role;
    patch["upc:representationId"] = o.representation_id;
    if (o.parent_representation_ref) {
      const pref = idRef(o.parent_representation_ref);
      if (pref) patch["upc:derivedFrom"] = pref;
    }
    addFile(o.path, patch);
  }

  // --- Source entities (+ their representation hasPart) ---
  const repsBySource = new Map();
  for (const r of loaded.representations) {
    const arr = repsBySource.get(r.sourceId) || [];
    if (r.obj && r.obj.path) arr.push({ "@id": r.obj.path });
    repsBySource.set(r.sourceId, arr);
  }
  for (const s of loaded.sources) {
    if (!s.obj) continue;
    const o = s.obj, bib = o.bibliographic || {}, ret = o.retrieval || {};
    const e = {
      "@id": "#" + o.source_id,
      "@type": sourceTypes(bib.item_type),
      identifier: o.source_id,
      "upc:sourceId": o.source_id,
      name: o.title || bib.title || o.source_id,
    };
    const url = bib.url || ret.original_url || ret.final_url;
    if (url) e.url = url;
    const authors = authorNames(bib);
    if (authors.length) e.author = authors;
    const yr = issuedYear(bib);
    if (yr) e.datePublished = yr;
    if (o.source_kind) e["upc:sourceKind"] = o.source_kind;
    const parts = sortRefs(repsBySource.get(o.source_id) || []);
    if (parts.length) e.hasPart = parts;
    if (o.aliases) e["upc:aliases"] = o.aliases;
    if (ret.original_url || ret.fetch_status || ret.fetched_at || ret.sha256) {
      e["upc:retrieval"] = {
        ...(ret.original_url ? { "upc:originalUrl": ret.original_url } : {}),
        ...(ret.fetch_status ? { "upc:fetchStatus": ret.fetch_status } : {}),
        ...(ret.fetched_at ? { "upc:fetchedAt": ret.fetched_at } : {}),
        ...(ret.sha256 ? { "upc:sha256": U.bareHash(ret.sha256) } : {}),
      };
    }
    abstract.push(e);
  }

  // --- Extraction entities (+ companion Annotation for gated ones) ---
  for (const x of loaded.extractions) {
    const o = x.obj;
    const status = o.status || "active";
    const e = {
      "@id": "#" + o.extraction_id,
      "@type": "upc:Extraction",
      identifier: o.extraction_id,
      "upc:extractionId": o.extraction_id,
      "upc:sourceId": o.source_id,
      "upc:type": o.type,
      "upc:status": status,
    };
    const repRefEntity = idRef(o.representation_ref);
    if (repRefEntity) e["upc:representation"] = repRefEntity;
    if (o.text != null) e.text = o.text;
    if (o.query) e["upc:query"] = o.query;

    const gated =
      status === "active" &&
      o.direct_quote != null &&
      o.locator && o.locator.type === "char_range";

    if (o.direct_quote != null) e["upc:directQuote"] = o.direct_quote;
    if (o.locator && o.locator.type === "char_range" && o.locator.value) {
      e["upc:charRange"] = { start: o.locator.value.start, end: o.locator.value.end };
    }

    if (gated) {
      e["upc:gateAuthoritative"] = true;
      const annoId = "#" + o.extraction_id + "-anno";
      e["upc:annotation"] = { "@id": annoId };

      // Build the companion Annotation. TextQuoteSelector.exact is always the
      // verbatim quote; the position selector + prefix/suffix are read from the
      // representation bytes when available (never fabricated).
      const v = o.locator.value;
      const position = { "@type": "TextPositionSelector", start: v.start, end: v.end, "upc:unit": "codepoint" };
      const quoteSel = { "@type": "TextQuoteSelector", exact: o.direct_quote };
      const rr = repRecById.get(o.representation_ref);
      if (rr && rr.contained && fs.existsSync(rr.abs)) {
        const rec = U.getRepFile(rr.abs);
        if (rec.utf8ok && rec.cps && v.start <= rec.cps.length && v.end <= rec.cps.length) {
          const prefix = rec.cps.slice(Math.max(0, v.start - CONTEXT_LEN), v.start).join("");
          const suffix = rec.cps.slice(v.end, v.end + CONTEXT_LEN).join("");
          if (prefix) quoteSel.prefix = prefix;
          if (suffix) quoteSel.suffix = suffix;
        }
      }
      const target = { source: repRefEntity, selector: [position, quoteSel] };
      abstract.push({
        "@id": annoId,
        "@type": "Annotation",
        "upc:interopOnly": true,
        target,
        body: { "@type": "TextualBody", value: o.direct_quote },
      });
    }
    abstract.push(e);
  }

  // --- Generation & Synthesis entities (+ their output Files) ---
  const addOutputFile = (out, ownerId) => {
    if (!out || !out.path) return out && out.value !== undefined ? { "upc:outputValue": out.value } : null;
    addFile(out.path, {
      encodingFormat: out.media_type,
      ...(out.sha256 ? { "upc:sha256": U.bareHash(out.sha256) } : {}),
      "upc:outputOf": { "@id": "#" + ownerId },
    });
    return { "upc:output": { "@id": out.path } };
  };

  for (const g of loaded.generations) {
    const o = g.obj, pv = o.provenance || {};
    const e = {
      "@id": "#" + o.generation_id,
      "@type": ["CreativeWork", "upc:Generation"],
      identifier: o.generation_id,
      "upc:generationId": o.generation_id,
      "upc:type": o.type,
    };
    if (o.title) e.name = o.title;
    const outPatch = addOutputFile(o.output, o.generation_id);
    if (outPatch) Object.assign(e, outPatch);
    e["upc:derivedFrom"] = derivedRefs(pv.derived_from);
    if (pv.input_digest) e["upc:inputDigest"] = pv.input_digest;
    if (typeof o.stale === "boolean") e["upc:stale"] = o.stale;
    const t = toolRef(pv.produced_by); if (t) e["upc:producedBy"] = t;
    const p = personRef(pv.produced_by); if (p) e["upc:producedByPerson"] = p;
    if (pv.produced_by && pv.produced_by.model) e["upc:model"] = pv.produced_by.model;
    if (pv.activity_ref) e["upc:activity"] = { "@id": "#" + pv.activity_ref };
    abstract.push(e);
  }

  for (const y of loaded.syntheses) {
    const o = y.obj, pv = o.provenance || {};
    const e = {
      "@id": "#" + o.synthesis_id,
      "@type": ["CreativeWork", "upc:Synthesis"],
      identifier: o.synthesis_id,
      "upc:synthesisId": o.synthesis_id,
      "upc:type": o.type,
    };
    if (o.title) e.name = o.title;
    if (o.question) e["upc:question"] = o.question;
    if (Array.isArray(o.claims) && o.claims.length) {
      e["upc:claims"] = o.claims
        .slice()
        .sort((a, b) => (String(a.claim_id) < String(b.claim_id) ? -1 : 1))
        .map((c) => {
          const cl = { "upc:claimId": c.claim_id, text: c.text };
          if (c.evidence_ids) cl["upc:evidence"] = sortRefs((c.evidence_ids || []).map(idRef));
          if (c.source_ids) cl["upc:source"] = sortRefs((c.source_ids || []).map(idRef));
          if (c.confidence) cl["upc:confidence"] = c.confidence;
          return cl;
        });
    }
    const outPatch = addOutputFile(o.output, o.synthesis_id);
    if (outPatch) Object.assign(e, outPatch);
    e["upc:derivedFrom"] = derivedRefs(pv.derived_from);
    if (pv.input_digest) e["upc:inputDigest"] = pv.input_digest;
    if (typeof o.stale === "boolean") e["upc:stale"] = o.stale;
    const t = toolRef(pv.produced_by); if (t) e["upc:producedBy"] = t;
    const p = personRef(pv.produced_by); if (p) e["upc:producedByPerson"] = p;
    if (pv.produced_by && pv.produced_by.model) e["upc:model"] = pv.produced_by.model;
    if (pv.activity_ref) e["upc:activity"] = { "@id": "#" + pv.activity_ref };
    abstract.push(e);
  }

  // --- Activity events → CreateAction ---
  const bucketRefs = (grp) => {
    if (!grp) return [];
    const ids = [];
    for (const arr of Object.values(grp)) for (const id of arr || []) ids.push(id);
    return sortRefs(ids.map(idRef).filter(Boolean));
  };
  for (const ev of loaded.events) {
    const e = {
      "@id": "#" + ev.event_id,
      "@type": "CreateAction",
      identifier: ev.event_id,
      "upc:eventId": ev.event_id,
      "upc:activityType": ev.activity_type,
    };
    if (ev.started_at) e.startTime = ev.started_at;
    if (ev.ended_at) e.endTime = ev.ended_at;
    const agent = toolRef({ tool: ev.tool, tool_version: ev.tool_version });
    if (agent) e.agent = agent;
    if (ev.model) e["upc:model"] = ev.model;
    const obj = bucketRefs(ev.inputs); if (obj.length) e.object = obj;
    const res = bucketRefs(ev.outputs); if (res.length) e.result = res;
    if (ev.status) e["upc:status"] = ev.status;
    abstract.push(e);
  }

  // --- Finalize File entities (materialize merged identifiers, drop scratch) ---
  const fileEntities = [];
  for (const f of files.values()) {
    if (f.__ids && f.__ids.size > 1) f.identifier = Array.from(f.__ids).sort();
    delete f.__ids;
    fileEntities.push(f);
  }

  // --- Metadata descriptor + root Dataset ---
  const descriptor = {
    "@id": "ro-crate-metadata.json",
    "@type": "CreativeWork",
    conformsTo: { "@id": RO_CRATE_SPEC },
    about: { "@id": "./" },
  };
  const root = {
    "@id": "./",
    "@type": "Dataset",
    identifier: corpus.corpus_id || "",
    name: corpus.title || corpus.corpus_id || "UPC corpus",
    conformsTo: [{ "@id": RO_CRATE_SPEC }, { "@id": profileId }],
    "upc:specVersion": corpus.upc_spec_version || upcVer,
  };
  if (corpus.readme) root.description = corpus.readme;
  const datePublished = corpus.modified || corpus.created ||
    loaded.events.map((e) => e.ended_at).filter(Boolean).sort().slice(-1)[0] || null;
  if (datePublished) root.datePublished = datePublished;
  if (corpus.license) root.license = corpus.license;
  const hasPart = sortRefs(fileEntities.map((f) => ({ "@id": f["@id"] })));
  if (hasPart.length) root.hasPart = hasPart;
  const mentions = sortRefs(
    loaded.sources.filter((s) => s.obj).map((s) => ({ "@id": "#" + s.obj.source_id }))
      .concat(loaded.syntheses.map((y) => ({ "@id": "#" + y.obj.synthesis_id })))
  );
  if (mentions.length) root.mentions = mentions;

  // --- Assemble: descriptor + root first, then everything sorted by @id ---
  const rest = fileEntities
    .concat(abstract, Array.from(tools.values()), Array.from(persons.values()))
    .sort((a, b) => (a["@id"] < b["@id"] ? -1 : a["@id"] > b["@id"] ? 1 : 0));

  return {
    "@context": [RO_CRATE_CONTEXT, { upc: UPC_TERMS }],
    "@graph": [descriptor, root, ...rest],
  };
}

/**
 * Write ro-crate-metadata.json for a corpus.
 *   default            -> writes <root>/ro-crate-metadata.json (zero-copy; File
 *                         @ids are the existing corpus-relative paths).
 *   { copy, outDir }   -> a detached, self-contained crate: copies every File's
 *                         bytes to <outDir>/<relpath> and writes the metadata there.
 * Returns { status, mode, wrote: [...] }.
 */
export function writeRoCrate(root, opts = {}) {
  const loaded = U.loadCorpus(root);
  U.clearRepCache();
  const graph = buildRoCrateGraph(loaded);
  const json = JSON.stringify(graph, null, 2) + "\n";

  if (opts.copy) {
    const outDir = opts.outDir;
    if (!outDir) throw new Error("ro-crate --copy requires -o <dir>");
    const wrote = [];
    for (const ent of graph["@graph"]) {
      if (ent["@type"] !== "File") continue;
      const rel = ent["@id"];
      const { abs, contained } = U.resolveInside(loaded.root, rel);
      if (!contained || !fs.existsSync(abs)) continue;
      const dest = path.join(path.resolve(outDir), rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      U.atomicWriteFile(dest, fs.readFileSync(abs));
      wrote.push(rel);
    }
    const metaAbs = path.join(path.resolve(outDir), "ro-crate-metadata.json");
    fs.mkdirSync(path.dirname(metaAbs), { recursive: true });
    U.atomicWriteFile(metaAbs, json);
    wrote.push("ro-crate-metadata.json");
    return { status: "ok", mode: "detached", out: path.resolve(outDir), wrote };
  }

  // Zero-copy default: the corpus directory itself becomes the crate root.
  const metaAbs = path.join(loaded.root, "ro-crate-metadata.json");
  U.atomicWriteFile(metaAbs, json);
  return { status: "ok", mode: "in-place", wrote: ["ro-crate-metadata.json"] };
}
