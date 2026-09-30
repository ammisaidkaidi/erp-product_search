# SPEC.md — implementation ↔ specification conformance map

This document maps each requirement area of the product-search specification
to its implementation and its verification. Section numbers refer to the
interface/functional spec (§46 debug output, §49 acceptance criteria, §50
critical engineering rules, §51 delivery phases).

## Functional pipeline

| Requirement | Implementation | Verified by |
|---|---|---|
| Normalization (typos, abbreviations, units, product codes, French) | `src/normalize/deterministic.ts` + `src/normalize/dictionaries/fr.ts` (corrections carry provenance); `src/normalize/tiny-lm.ts` adapter | `tests/unit/normalizer.test.ts` |
| Tokenization/analysis incl. code folding | `src/analysis/analyzer.ts` | `tests/unit/analyzer.test.ts` |
| Deterministic `search_document` construction from product data (no mutation of source) | `src/document/builder.ts`, `src/document/labels/fr.ts` | `tests/unit/document-builder.test.ts` |
| Lexical retrieval: BM25F with field weights + exact-code/prefix/numeric boosts, never an LLM inside BM25 | `src/retrieval/lexical/bm25f.ts` (inverted index, §50 rule) | `tests/unit/bm25.test.ts` |
| Vector retrieval with pluggable embedder, model versioning | `src/retrieval/vector/*` (hashing deterministic default; transformers opt-in) | integration parity tests |
| Hybrid fusion without mixing BM25/cosine scores (§50) | `src/fusion/rrf.ts` — rank-based RRF only | `tests/unit/rrf.test.ts` |
| Pluggable reranking, bounded candidates, failure isolation | `src/reranking/*` (noop, von, cross-encoder, `FallbackReranker`) | `tests/unit/reranking.test.ts` |
| Engine orchestration: cache, degradation events, per-stage timings, debug output per §46 | `src/engine/search-engine.ts`, `src/cli/output.ts` | `tests/unit/engine.test.ts`, CLI debug output |
| Persistence: derived search documents, pgvector embeddings, query log, behavior events, evaluation queries (`product_search`, `product_embeddings`, `search_log`, `search_events`, `search_evaluation_queries`) | `sql/schema.sql`, `src/store/pg-store.ts` (parameterized SQL only, §50) | integration tests on real PostgreSQL |
| Incremental indexing, re-embedding on model/content change | `src/indexing/indexer.ts`, `src/engine/version-tracker.ts` | integration lifecycle test |

## Non-functional rules (§50 critical engineering rules)

| Rule | Where enforced |
|---|---|
| Never put an LLM inside BM25 | BM25F is pure statistics (`bm25f.ts`); no model import anywhere in `src/retrieval/lexical/` |
| Never run a reranker over the entire catalog | `reranking.candidate_limit` (default 50) caps candidates at fusion output; rerankers receive a bounded slice (`search-engine.ts`) |
| Never mix BM25 and vector scores without normalization | Fusion is RRF on ranks only; no code path combines raw scores (`src/fusion/rrf.ts`) |
| Never hard-code von into the core engine | Engine depends on the `Reranker` interface; von is one implementation wired in `system.ts` behind config |
| Never modify original product data for search | Builder produces a separate `ProductSearchDocument`; `products` table is read-only for the library |
| Never silently invent attributes | Attributes come from parsed label/value pairs only; unknown text stays in the searchable text fields, never fake attributes (`document/builder.ts`) |
| Never hide model failures | `DegradationEvent` per query; `ModelUnavailableError` vs `ModelInferenceError` distinction; failures columns in evaluation output; logs at warn/error |
| No unnecessary microservices | Single Node process; Python isolated behind one stdio-IPC adapter (`src/adapters/python-worker.ts`) |
| No dependency without justification | Runtime deps: `pg` + `yaml` (+ optional `@huggingface/transformers`, `@xenova/transformers` for real models). Everything else is implemented in-repo |
| No optimizing before measuring | `docs/performance.md` optimization log: every change has before/after numbers |
| No performance claims without benchmarks | All numbers in README/docs cite `benchmark`/`evaluate` runs recorded in `docs/performance.md` |

## Deliverables (§51 phases)

| Phase | Scope | Status |
|---|---|---|
| 1 | Domain model, config system, logging, errors | ✅ `src/core`, `src/config`, `src/logging` |
| 2 | Analysis, deterministic search_document builder | ✅ `src/analysis`, `src/document` |
| 3 | Query normalization (deterministic FR + TinyLM adapter) | ✅ `src/normalize` |
| 4 | Lexical BM25F + embedders + stores (pgvector/memory) + incremental indexer | ✅ `src/retrieval`, `src/store`, `src/indexing` |
| 5 | RRF fusion + engine orchestration (cache, degradations, debug) | ✅ `src/fusion`, `src/engine` |
| 6 | Rerankers (noop/von/cross-encoder) + fallback chain + Python IPC adapter | ✅ `src/reranking`, `src/adapters`, `adapters/python/` |
| 7 | IR metrics, evaluator, reranker benchmark on frozen candidates, gold dataset | ✅ `src/evaluation`, `fixtures/gold-fr.jsonl` |
| 8 | Benchmark harness, CLI, public API, default config | ✅ `src/benchmark`, `src/cli`, `src/index.ts`, `search.config.default.yaml` |
| 9 | Performance optimization + documentation | ✅ inverted-index BM25F + Float32/top-K vector store (`docs/performance.md`), `docs/`, README, this file |

## Acceptance criteria (§49) — evidence

1. **Working library, not a POC** — `createSearchSystem()` composes a
   running system from config; 134 automated tests (121 unit incl. CLI +
   13 integration) pass against real PostgreSQL+pgvector; `tsc --noEmit`
   clean in strict mode.
2. **Hybrid quality** — fixture gold dataset: Recall@10 0.928, Recall@20
   0.959, NDCG@10 0.985, MRR@10 1.000 (noop reranker; documented in
   `docs/performance.md`).
3. **Latency** — p50 2.0 ms / p90 3.0 ms per query (200-product fixture,
   PG store, cold CLI process); scaling table up to 50k products in
   `docs/performance.md`.
4. **Determinism** — same catalog + config ⇒ same documents, same
   embeddings (hashing), same rankings (total-order tie-breaking); the
   benchmark catalog generator is seeded.
5. **Degradation semantics** — reranker failures surface per query
   (degradation events + evaluation failures column) and fall back to the
   next reranker / RRF order; store errors propagate, never silently empty.
6. **Interfaces over implementations** — every stage of the pipeline is an
   interface (`Normalizer`, `LexicalRetriever`, `VectorRetriever`, `Fusion`,
   `Reranker`, `Embedder`, `SearchStore`, `ProductProvider`, `Logger`);
   only `system.ts` constructs concrete classes.
7. **Security** — parameterized SQL only; model outputs validated (finite,
   clamped) and never executed; no model-generated SQL/paths.
8. **v1 scope discipline** — no LTR/click-signals/personalization/business
   rules in ranking; only the append-only `search_log`/`search_events` tables
   exist for future use.

## Known limitations (documented, not hidden)

- The von/cross-encoder rerankers need model weights that are not bundled;
  without them the system runs in documented fallback mode (degradation
  events on every affected query).
- The in-memory store brute-forces vector search — fine for tests and
  offline use, not for large production catalogs (use the PG store + HNSW).
- `docs/performance.md` numbers are from a single sandbox machine;
  ratios, not absolutes, are the transferable result.
