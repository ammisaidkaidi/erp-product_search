# @erp/product-search

Modular, local-first semantic **product search** for an ERP catalog:
hybrid retrieval (BM25F + vector similarity over pgvector), Reciprocal Rank
Fusion, and pluggable rerankers — as a **library**, not a microservice.

```ts
import { createSearchSystem, loadConfig } from "@erp/product-search";

const config = await loadConfig({ file: "search.config.yaml" });
const system = await createSearchSystem({ config });
await system.indexer.rebuild(myProductProvider);     // from your ERP catalog

const results = await system.engine.search("tube 110 blnc");   // typo-tolerant, hybrid
const debug   = await system.engine.searchDebug("tube 110 blnc");
await system.close();
```

## Why

Product search has two failure modes a generic engine answers badly: exact
signals (product codes like `TD110L4BL0`, diameters, brands) and messy human
queries ("tube evac 110 blnc", "tuyau pv Ø110"). This library combines:

- **BM25F lexical retrieval** with field weights (code > name > attributes)
  and deterministic product signals: exact-code, code-prefix and
  numeric-attribute boosts;
- **Vector similarity** behind a pluggable embedder (deterministic hashing by
  default; e5/BGE via transformers.js as opt-in);
- **RRF fusion** — ranks only, so BM25 and cosine scores are never mixed;
- **Bounded reranking** (noop / von / cross-encoder) over the top-N fused
  candidates, never the catalog, with explicit fallback and per-query
  degradation events when a model is unavailable;
- **Deterministic French query normalization**: typo correction, product-code
  detection, unit/abbreviation folding — with provenance for every correction.

Everything runs in-process against PostgreSQL+pgvector (or a pure in-memory
store for tests and offline work). No Elasticsearch, no network hops, no
hidden model calls.

## Install & run

```bash
psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql -U postgres -f sql/schema.sql
cp search.config.default.yaml search.config.yaml   # annotated reference

# index a catalog and query it
npx tsx src/cli/index.ts build --catalog products.json --drop
npx tsx src/cli/index.ts search "tube 110 blanc" --debug
npx tsx src/cli/index.ts evaluate --dataset fixtures/gold-fr.jsonl --store postgres
npx tsx src/cli/index.ts benchmark --sizes 1000,5000,10000,20000,50000
```

CLI: `build` · `update` · `delete` · `search [--debug] [--limit n]` ·
`evaluate [--dataset …] [--reranker …] [--benchmark]` · `benchmark` ·
`inspect`. Global flags: `--config <file>`, `--store postgres|memory`,
`--json`.

## Measured results

Fixture gold dataset (28 French queries, PostgreSQL store, hybrid + noop
reranker): **Recall@10 0.928 · Recall@20 0.959 · NDCG@10 0.985 ·
MRR@10 1.000 · p50 2.0 ms · 419 qps**.

Benchmark (memory store, 200 queries, hashing embedder):

| Catalog | 1k | 5k | 10k | 20k | 50k |
|---|---|---|---|---|---|
| Query p50 | 2.0 ms | 7.5 ms | 15.8 ms | 33.6 ms | 106.6 ms |
| QPS | 344 | 126 | 59 | 27 | 8 |
| Indexing | 2,076 docs/s | 2,446 | 2,362 | 2,034 | 2,156 |

Methodology, optimization log and scaling analysis: [`docs/performance.md`](docs/performance.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — module map, data flow, key decisions
- [`docs/operations.md`](docs/operations.md) — setup, indexing, re-embedding, monitoring, failure modes
- [`docs/performance.md`](docs/performance.md) — benchmarks and optimization notes
- [`SPEC.md`](SPEC.md) — requirement ↔ implementation conformance map
- [`search.config.default.yaml`](search.config.default.yaml) — every config key annotated
- [`adapters/python/README.md`](adapters/python/README.md) — the von reranker worker

## Development

```bash
npm test                    # full suite; integration tests skip automatically if PostgreSQL is unavailable
npm run test:integration    # only the PostgreSQL+pgvector integration tests
npx tsc --noEmit            # strict mode, zero errors
```

Test totals: **134 passing** (121 unit incl. CLI, 13 integration).
Determinism is a design constraint: same catalog + config ⇒ same documents,
embeddings, and rankings — which is what makes the evaluation and benchmark
runs reproducible.

## Status and scope

v1 is complete (spec phases 1–9, see `SPEC.md`). Deliberately out of scope:
learning-to-rank, click/purchase signals, personalization, business-rule
boosting — the event tables exist so they can be added later without schema
surgery, but the ranking pipeline stays signal-free.
