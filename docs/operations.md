# Operations guide

How to run `@erp/product-search` in a real deployment: setup, indexing,
queries, evaluation, monitoring, and failure modes.

## Requirements

- Node.js ≥ 20 (ESM, TypeScript strict)
- PostgreSQL ≥ 15 with the `pgvector` extension (production store)
- Python ≥ 3.10 **only if** the von reranker is enabled (see
  [Rerankers](#rerankers))

## 1. Database setup

```bash
psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql -U postgres -f sql/schema.sql          # creates tables + ANN indexes
```

`sql/schema.sql` creates the search-side tables: `product_search`
(the derived `search_document` per product), `product_embeddings` (pgvector,
with an HNSW cosine index), `search_configuration`, `search_log`,
`search_events` (extensible behavior signals), and `search_evaluation_queries`.
Your product catalog itself stays wherever the ERP keeps it — the library
reads it only through a `ProductProvider` you implement and never writes to it.

Connection settings live in the config file (or `PG*` style env overrides in
your loader):

```yaml
database:
  url: "postgres://user:pass@host:5432/db"
```

## 2. Configuration

Copy the annotated reference: [`search.config.default.yaml`](../search.config.default.yaml)
documents every key, its default, and tuning notes. Three presets exist via
`mode: precise | balanced | fast` (they set retrieval widths, reranker
limits, and cache sizes); any key can still be overridden explicitly.

Decisions worth understanding before tuning:

- `retrieval.vector.min_score` — cosine floor before fusion. The deterministic
  hashing embedder needs a low floor (~0.15); e5/BGE models produce usefully
  separated similarities and warrant >0.5. **Check this when you change
  `embedding.provider`.**
- `reranking.candidate_limit` — hard cap on how many fused candidates the
  reranker sees (default 50). Never raise it to "improve quality" without
  benchmarking; reranking the catalog is a design violation.
- `fusion.rrf.k` — 60 is the standard robustness constant; lower it only with
  offline evaluation evidence.

## 3. Indexing

Via CLI (catalog JSON file):

```bash
npx tsx src/cli/index.ts --config search.config.yaml build --catalog products.json --drop
npx tsx src/cli/index.ts update --catalog changed-products.json   # incremental
npx tsx src/cli/index.ts delete --id P000123
```

Or programmatically:

```ts
const system = await createSearchSystem({ config });
await system.indexer.rebuild(myProvider);      // ProductProvider | iterable | async iterable
await system.indexer.upsert(changedProducts);  // incremental
await system.close();
```

`rebuild()` streams the provider, writes `product_search` rows, embeds in
batches (`embedding.batchSize`), and reports throughput. Startup hydrates the
in-memory BM25F index from the store (`inspect` shows the bootstrapped
document count).

### Re-embedding and model versions

Every embedding row records its `model_version` (embedder id + parameters
hash). On startup and on every `upsert`, the indexer compares versions:

- document unchanged, same version → nothing re-embedded (`reused` count in
  the `index rebuild complete` log line);
- model version changed → the whole catalog is re-embedded in batches;
- document content changed (content hash differs) → that document is
  re-embedded.

Switching `embedding.provider: hashing` → `transformers` is therefore safe
and automatic, but budget time for a full re-embed and a larger `workMem`.

## 4. Queries

```ts
const results = await system.engine.search("tube 110 blnc", { limit: 10 });
const debug   = await system.engine.searchDebug("tube 110 blnc");
```

`search()` returns ranked results; `searchDebug()` additionally returns the
normalized query (with corrections and provenance), per-retriever candidates,
fusion scores, reranker scores, per-stage timings, and any degradation
events. The CLI renders this in the format specified by the interface spec:

```bash
npx tsx src/cli/index.ts search "tube 110 blnc" --debug --limit 5
```

Results are cached per normalized query (`cache` section) — for a catalog
browser, call `search()` with `{ noCache: true }` during evaluation runs.

## 5. Evaluation and monitoring

Gold dataset (JSONL: `{"query": "...", "relevant": [{"productId": "...",
"grade": 3}, ...]}`):

```bash
npx tsx src/cli/index.ts evaluate --dataset fixtures/gold-fr.jsonl --store postgres
npx tsx src/cli/index.ts evaluate --dataset gold.jsonl --benchmark   # reranker comparison
```

The evaluator reports Recall@k, MRR@k, NDCG@k, and latency percentiles, and
compares rerankers **on the same frozen candidate sets** so reranker
differences are measured, not retrieval noise. Run it after any config,
normalizer-dictionary, or model change; the numbers are deterministic.

Every query writes a `search_log` row (query, normalized query, top result
ids, latency). Simple health queries:

```sql
-- query volume and p50/p90 latency over the last hour
SELECT count(*),
       percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms),
       percentile_disc(0.9) WITHIN GROUP (ORDER BY latency_ms)
FROM search_log
WHERE created_at > now() - interval '1 hour';

-- most frequent queries (cache tuning / gold-dataset candidates)
SELECT query, count(*) AS n
FROM search_log
WHERE created_at > now() - interval '7 days'
GROUP BY query ORDER BY n DESC LIMIT 25;
```

Degradation events (reranker failures, retriever fallbacks) are attached to
each `searchDebug()` response and logged as structured warnings — aggregate
them from the application log stream; rising counts are the earliest signal
that a model process is unhealthy.

## 6. Rerankers

| Provider | Process | Requirements |
|---|---|---|
| `noop` | in-process | none — RRF order (always the last resort in any chain) |
| `von` | Python worker via stdio IPC | `pip install -r adapters/python/requirements.txt`, configured model path |
| `cross-encoder` / `bge` / `minilm` | in-process (transformers.js) | `npm i @huggingface/transformers`, model download on first use |

The worker is spawned and supervised by `PythonModelWorker` (JSONL requests,
heartbeats, restart with backoff, clean shutdown on `close()`). If Python or
the model weights are unavailable, the chain falls back and **every affected
query records a degradation** — check `evaluate --benchmark`'s failures
column and the log; do not silence it.

## 7. Benchmarks

```bash
npx tsx src/cli/index.ts benchmark --sizes 1000,5000,10000,20000,50000 --queries 200
```

Generates deterministic synthetic catalogs and reports indexing throughput,
per-stage latency, p50/p90, QPS, heap delta, and the bottleneck stage per
size. Methodology and current numbers: [`docs/performance.md`](performance.md).

## 8. Failure modes and recovery

| Symptom | Cause | Recovery |
|---|---|---|
| `ModelUnavailableError` in degradations | reranker weights/worker missing | install dependencies or switch provider; queries keep working on fallback |
| `StoreError: connection refused` | PG down / wrong `database.url` | fix config; engine fails closed on store errors (empty results are NOT silently returned for store failures — the error propagates) |
| Slow queries after catalog growth | brute-force vector scan (memory store) or missing HNSW index | use the PG store (HNSW index is created by `sql/schema.sql`); check `benchmark` output and [`performance.md`](performance.md) scaling notes |
| Recall drop after embedder change | `min_score` mismatch | re-tune `retrieval.vector.min_score`, re-embed, re-run evaluation |
| Index and store disagree | writes bypassed the indexer | always mutate through `indexer.upsert/delete/rebuild`; `build --drop` rebuilds from scratch |

## 9. Backups and consistency

Your ERP catalog is the source of truth — back it up as part of the ERP.
`product_search`/`product_embeddings` are derived data: they can always be
rebuilt with `build --drop` (or `rebuild()` without drop for in-place
refresh). Keep gold datasets in version control; they are the regression
baseline for configuration changes.
