# Performance

Methodology, measured numbers, and the optimizations behind them.
Reproduce everything with:

```bash
npx tsx src/cli/index.ts benchmark --sizes 1000,5000,10000,20000,50000 --queries 200 --store memory
npx tsx src/cli/index.ts evaluate --dataset fixtures/gold-fr.jsonl --store postgres
```

## Methodology

- **Catalog**: deterministic synthetic generator (`src/benchmark/catalog-generator.ts`)
  — same seed ⇒ same catalog, French product names/codes/attributes.
- **Queries**: 12 fixed French product queries, varied per run, executed with
  the result cache disabled (`noCache`).
- **Reported per stage**: mean latency of normalization, BM25, vector, RRF,
  reranker (noop), plus end-to-end total, p50, p90, queries/sec, indexing
  throughput, and heap delta. Bottleneck = stage with the largest mean share.
- **Environment**: single Node.js process, hashing embedder (384-dim),
  memory store, this repository's test sandbox — absolute numbers are
  machine-relative; the *ratios* are what transfer.

## Results (v1 final, memory store, 200 queries)

| Catalog | Index (s) | docs/s | Heap Δ (MB) | norm ms | BM25 ms | vector ms | RRF ms | total ms | p50 ms | p90 ms | QPS | bottleneck |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1,000 | 0.5 | 2,076 | 7 | 0.36 | 0.65 | 1.71 | 0.07 | 2.9 | 2.0 | 3.8 | 344 | vector |
| 5,000 | 2.0 | 2,446 | 19 | 1.27 | 1.47 | 5.10 | 0.01 | 7.9 | 7.5 | 9.6 | 126 | vector |
| 10,000 | 4.2 | 2,362 | 20 | 2.90 | 3.08 | 10.74 | 0.04 | 16.9 | 15.8 | 21.8 | 59 | vector |
| 20,000 | 9.8 | 2,034 | 67 | 5.52 | 7.63 | 23.59 | 0.05 | 36.8 | 33.6 | 47.3 | 27 | vector |
| 50,000 | 23.2 | 2,156 | 166 | 29.33 | 27.81 | 66.95 | 0.15 | 124.1 | 106.6 | 221.7 | 8 | vector |

End-to-end quality on the 200-product fixture gold dataset (PostgreSQL store,
hybrid retrieval, noop reranker): **Recall@1 0.409 / @5 0.829 / @10 0.928 /
@20 0.959, MRR@10 1.000, NDCG@10 0.985, p50 2.0 ms, 419 qps** (28 queries).

## Optimization log (measured before → after, 50k catalog)

Both retrievers originally scanned the entire catalog per query. After
measuring (per the no-optimizing-without-measuring rule), two structural
changes landed:

1. **BM25F: full scan → inverted index** (`src/retrieval/lexical/bm25f.ts`).
   Postings map term → doc → per-field tf; a code index answers exact/prefix
   code boosts by lookup; average field lengths update incrementally on
   upsert/delete. Scoring now visits only documents containing query terms.
   BM25 stage at 50k: **74.8 → 27.8 ms** (2.7×); indexing throughput
   unaffected.
2. **Memory vector store: float64 rows + full sort → normalized Float32 +
   bounded top-K** (`src/store/memory-store.ts`).
   - embeddings stored once as L2-normalized `Float32Array` (cosine = dot
     product; 8 → 4 bytes/component, heap at 50k: 331 → 166 MB);
   - dot product unrolled ×4 to break the accumulator dependency chain
     (isolated kernel: 49 → 35 ms);
   - iteration via `values()` instead of `entries()` (the latter allocates a
     tuple per entry per scan: 5M allocations per benchmark);
   - bounded top-K buffer (score desc, productId asc — a total order, so the
     result set is bit-identical to a full sort) instead of materializing and
     sorting 50k result objects.

   Vector stage at 50k: **91.4 → 67.0 ms**; overall at 50k: **194 → 124 ms
   (5 → 8 QPS)**; at 20k: **72 → 37 ms (14 → 27 QPS)**.

A mid-course regression was caught by re-measuring: an intermediate version
stored vectors in *both* representations and did two extra Map lookups per
document (vector stage 91 → 142 ms, heap +85 MB). Kernel isolation
(scratch micro-benchmark, since removed) separated loop cost from allocation
cost and pointed at the tuple-allocating iteration. Lesson recorded: measure
after every change, not just before optimizing.

## Scaling notes

- **Vector search is the measured bottleneck** at every size ≥ 1k in the
  memory store — it is an exact brute-force scan, O(N·d) per query. That is
  intentional for a test/offline store. The production answer is the
  PostgreSQL store: pgvector's HNSW index makes vector retrieval sublinear
  (`CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` in
  `sql/schema.sql`), at the cost of approximate recall.
- **BM25F scales with posting-list sizes**, i.e. with how many documents
  actually contain the query terms — broad one-word queries remain linear in
  their match count, which is the honest floor for exact lexical scoring.
- **Normalization cost grows with catalog size** in these numbers because the
  deterministic normalizer consults the BM25 vocabulary (built from the
  catalog) for typo correction. This is one reason `mode: fast` narrows it.
- **Reranking is O(candidate_limit)**, independent of catalog size — the
  pipeline was designed so that adding a slow reranker never makes queries
  scale with N.

## Production sizing guidance (qualitative)

Up to ~10k products the in-memory store is comfortable for offline tooling
(17 ms/query). Beyond that, or for any concurrent service, use the PG store:
BM25F still runs in-process (hydrated at boot, milliseconds per boot per 10k
docs), vectors go through HNSW. Re-run `evaluate` (quality) and `benchmark`
(latency) after switching stores or embedders — quality numbers from the
fixture dataset transfer, absolute latencies do not.
