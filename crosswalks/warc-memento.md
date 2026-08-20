# Crosswalk: UPC ⇄ WARC / Memento (deferred)

Two web-archiving standards that could strengthen UPC's historical-web capture:

- **[WARC](https://iipc.github.io/warc-specifications/)** aggregates harvested web
  resources with their HTTP request/response records and related capture context.
- **[Memento](https://datatracker.ietf.org/doc/html/rfc7089)** (RFC 7089) relates
  an *original resource*, its archived prior states (*Mementos*), archival
  datetimes, and TimeMaps/TimeGates.

**Status: deferred (not in UPC 1.3.0).** UPC already preserves enough for many
tasks — raw HTML, retrieval URL, HTTP status, content type, fetch timestamp, and a
byte `sha256` (`source.retrieval`, §02) — and the **clean Markdown representation
remains the preferred quotation substrate**. Neither is required; both are optional
enrichments a web-capable tool may add later.

## Sketch of the eventual mapping

### WARC
| UPC | WARC | Notes |
|---|---|---|
| `raw_html` representation | WARC `response` record payload | |
| `source.retrieval` (url/status/content_type/fetched_at) | WARC `response`/`request` headers | |
| a new `role: web_archive` representation | a `.warc`/`.warc.gz` file | optional richer capture |
| `ext.<tool>.warc_record_id` | WARC-Record-ID | link a rep to its WARC record |

### Memento (historical captures)
| UPC | Memento | Notes |
|---|---|---|
| `source.retrieval.original_url` | Original Resource (URI-R) | |
| `ext.<tool>.archival.memento_url` | Memento (URI-M) | e.g. an Internet Archive URL |
| `ext.<tool>.archival.memento_datetime` | Memento-Datetime | |

**Do not** treat an archive URL as identical to the original URL without recording
the archival relationship. Until first-class fields exist, this metadata lives in
the namespaced `ext` object; the hop-B/C gate and derivation graph remain
**UPC-only**.
