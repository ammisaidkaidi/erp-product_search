# Architecture

`@erp/product-search` is a modular, local-first semantic product-search library.
It plugs into an ERP catalog, builds a search index over it, and answers
queries through a hybrid retrieval pipeline (lexical BM25F + vector
similarity) fused with Reciprocal Rank Fusion and optionally refined by a
pluggable reranker. Everything runs in-process: no search microservice, no
external engine (Elasticsearch, Vespa, …), no network hop for ranking.

```
            ┌────────────────────────────────────────────────────────────┐
 query ───► │ Normalizer (deterministic FR / TinyLM)                      │
            │   typo correction · abbreviations · units · code detection  │
            ├────────────────────────────────────────────────────────────┤
            │ Retrieval (concurrent)                                     │
            │   BM25F inverted index ──┐                                 │
            │   pgvector / in-memory ──┤  candidate lists (topK each)    │
            ├──────────────────────────┼─────────────────────────────────┤
            │ Fusion: Reciprocal Rank Fusion (RRF) ── rank-based only,   │
            │        never mixes raw BM25 and cosine scores              │
            ├────────────────────────────────────────────────────────────┤
            │ Reranker (pluggable, bounded to top-N candidates)           │
            │   noop · von (python IPC) · cross-encoder (transformers)    │
            ├────────────────────────────────────────────────────────────┤
            │ SearchEngine: cache, degradation events, timings, logging   │
            └────────────────────────────────────────────────────────────┘
```

## Module map

| Path | Responsibility |
|---|---|
| `src/core` | Domain types (`Product`, `NormalizedQuery`, `SearchResult`, …), typed error hierarchy, ids, version |
| `src/config` | `SearchEngineConfig` schema, defaults + mode presets, YAML loader, structural validation with fingerprints |
| `src/logging` | Structured logger interface; console implementation (JSON to stderr) |
| `src/analysis` | Tokenizer/analyzer: text & product-code analyzers, canonical code folding, French stopwords |
| `src/normalize` | Query normalization contracts + implementations: deterministic French (typos/abbreviations/units/codes with provenance), TinyLM adapter, tokenizing normalizer, mock |
| `src/document` | Deterministic `search_document` builder (code, name, attributes, brand, category fields) with French attribute labels |
| `src/retrieval/lexical` | BM25F inverted index (per-field tf postings, code index, numeric/code boosts) and its retriever wrapper |
| `src/retrieval/vector` | `Embedder` interface + hashing (deterministic, zero-dependency), transformers (e5/BGE), mock; vector retriever |
| `src/store` | `SearchStore` interface; PostgreSQL+pgvector implementation (`product_search` + `product_embeddings` tables, HNSW index); in-memory implementation (tests/benchmarks/offline) |
| `src/indexing` | Incremental indexer (upsert/delete/rebuild/bootstrap), `ProductProvider` interface, embedding version tracking with re-embedding on model change |
| `src/fusion` | Fusion interface + RRF implementation |
| `src/reranking` | `Reranker` interface + noop, von, cross-encoder implementations, `FallbackReranker` chain |
| `src/adapters` | `PythonModelWorker`: JSONL-over-stdio IPC to the Python process (`adapters/python/model_worker.py`) hosting von |
| `src/engine` | `SearchEngine`: pipeline orchestration, result cache, degradation recording, per-stage timings, debug output |
| `src/evaluation` | IR metrics (recall@k, MRR@k, NDCG@k, latency percentiles), gold-dataset evaluator, reranker benchmark on frozen candidates |
| `src/benchmark` | Deterministic synthetic catalog generator + end-to-end pipeline benchmark |
| `src/cli` | `search-index` command line (build/update/delete/search/evaluate/benchmark/inspect) |
| `src/system.ts` | Composition root: `createSearchSystem()` wires config → components, exposes `SearchSystem` |

Dependency direction is strictly downward: `cli`/`system` → `engine`/`indexing`
→ `retrieval`/`fusion`/`reranking` → `analysis`/`document` → `core`. The engine
depends only on interfaces (`LexicalRetriever`, `VectorRetriever`, `Fusion`,
`Reranker`, `Normalizer`, `Logger`, caches); concrete implementations are
injected by the composition root. `system.ts` is the only file allowed to
construct concrete components.

## Key decisions

### Hybrid retrieval, rank-based fusion
BM25F answers exact signals (product codes, diameters, brands) that dense
embeddings blur, while vector search covers paraphrases ("tuyau
d'évacuation" vs "tube PVC"). Raw BM25 scores (unbounded, corpus-dependent)
and cosine similarities ([-1, 1]) are **never mixed**: fusion operates purely
on ranks via RRF (`1/(k + rank)`), which needs no score normalization and is
robust to score-scale drift across models and corpora.

### BM25F with explicit product signals
The lexical index is a field-weighted BM25 (weights: code 4, name 2,
attributes 1.5, brand/category 1) implemented as an inverted index
(term → doc → per-field tf), so scoring visits only documents containing
query terms. Three deterministic, configurable boosts are added on top of —
never inside — the BM25F formula: exact product code, code prefix, and
numeric attribute match. Average field lengths are maintained incrementally,
keeping upserts O(doc length).

### Vectors behind the store contract
Both stores expose `searchVectors(embedding, modelVersion, limit)`. The
PostgreSQL store uses pgvector (`<=>` cosine); the in-memory store
brute-forces pre-normalized Float32 vectors. Embeddings are stamped with a
`model_version`; the indexer re-embeds only documents whose version differs
(see [operations](operations.md#re-embedding-and-model-versions)).

### Reranking is optional, bounded, and never hides failure
Rerankers see only the top `reranking.candidate_limit` (default 50) fused
candidates — never the catalog. If a reranker fails (model missing, worker
crash), the engine records a `DegradationEvent`, falls back to the next
reranker in a `FallbackReranker` chain (RRF order as last resort), and the
failure surfaces in debug output, logs, and evaluation "failures" columns.
`ModelUnavailableError`/`ModelInferenceError` are distinct: the first is
"model cannot answer", the second "model answered garbage".

### Determinism first
Given the same catalog and configuration, the pipeline is reproducible end to
end: deterministic document builder, deterministic hashing embedder
(production embeddings require explicit opt-in), deterministic synthetic
catalog generator, total-order tie-breaking (score desc, productId asc)
everywhere. The gold-dataset evaluation and the benchmark are therefore
repeatable and diffable.

### Python isolated behind one adapter
The von reranker runs in a Python process (transformers ecosystem) reached
exclusively through `PythonModelWorker` — JSONL over stdio, one request in
flight, heartbeat + restart, no network socket, no microservice. The rest of
the system never sees Python; if the worker dies, von degrades to the next
reranker in the chain.

### Security posture
All SQL is parameterized (no string interpolation of values, identifiers
quoted at startup from a fixed allowlist). Model outputs are treated as
untrusted data: reranker scores are validated as finite numbers and clamped
into `[0,1]`; no model-generated string is ever executed, interpolated into
SQL, or followed as a path.

## Data flow (indexing)

```
ProductProvider ──► Indexer ──► SearchDocumentBuilder ──► SearchStore
 (ERP catalog)        │           (product_search row)        │
                      └─► Embedder (batched, version-checked)┴─► product_embeddings row
                      └─► search_log / search_events (append-only, query-time)
```

The indexer is incremental: `upsert(products)` writes changed documents,
re-embeds only stale embeddings, and keeps the in-memory BM25 index in sync
(hydrated from the store at startup). `rebuild()` reprocesses the whole
provider and can drop first.

## What is deliberately NOT here (v1 scope)

Learning-to-rank, click/purchase signals, personalization, and business-rule
boosting are excluded from v1 by design. The only concession to the future is
the data model: the `search_log` and `search_events` tables exist and are
written, so historical signals can be mined later without schema surgery. The
ranking pipeline itself stays signal-free.
