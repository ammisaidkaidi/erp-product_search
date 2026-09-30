import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSearchStore } from "../../src/store/pg-store.js";
import { MemorySearchStore, cosineSimilarity } from "../../src/store/memory-store.js";
import { SearchIndexer } from "../../src/indexing/indexer.js";
import { SearchDocumentBuilder } from "../../src/document/builder.js";
import { FRENCH_ATTRIBUTE_LABELS } from "../../src/document/labels/fr.js";
import { HashingEmbedder } from "../../src/retrieval/vector/hashing-embedder.js";
import { InMemoryBm25Index } from "../../src/retrieval/lexical/bm25f.js";
import { IndexVersionTracker } from "../../src/engine/version-tracker.js";
import { NoopLogger } from "../../src/logging/logger.js";
import { generateFixtureCatalog } from "../../src/benchmark/catalog-generator.js";
import { integrationConfig, dropAllTables, ensureTestDatabase, TEST_DATABASE_URL } from "./helpers.js";
import { StoreError } from "../../src/core/errors.js";

const dbAvailable = await ensureTestDatabase().catch(() => false);

describe.skipIf(!dbAvailable)("PgSearchStore (PostgreSQL + pgvector)", () => {
  let store: PgSearchStore;
  const builder = new SearchDocumentBuilder({ labelMap: FRENCH_ATTRIBUTE_LABELS });
  const embedder = new HashingEmbedder({ dimensions: 64 });
  const logger = new NoopLogger();

  beforeAll(async () => {
    await dropAllTables(TEST_DATABASE_URL);
    store = new PgSearchStore({
      config: integrationConfig().database,
      embeddingDimensions: 64,
      metric: "cosine",
    });
    await store.init();
  }, 60_000);

  afterAll(async () => {
    await store?.close();
  });

  it("creates the schema (tables + hnsw index)", async () => {
    const tables = await rawQuery(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
    );
    const names = tables.rows.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "product_search",
        "product_embeddings",
        "search_configuration",
        "search_evaluation_queries",
        "search_log",
        "search_events",
      ]),
    );
    const indexes = await rawQuery(
      `SELECT indexname FROM pg_indexes WHERE tablename='product_embeddings'`,
    );
    expect(indexes.rows.map((r) => r.indexname)).toContain("idx_product_embeddings_hnsw");
  });

  it("indexer rebuild persists documents + embeddings and skips unchanged embeddings", async () => {
    let embedCalls = 0;
    const countingEmbedder = new (class extends HashingEmbedder {
      override async embedBatch(texts: string[]): Promise<number[][]> {
        embedCalls += texts.length;
        return super.embedBatch(texts);
      }
    })({ dimensions: 64 });

    const bm25 = new InMemoryBm25Index(integrationConfig().retrieval.bm25, builder);
    const indexVersion = new IndexVersionTracker(store);
    const indexer = new SearchIndexer({
      store,
      builder,
      embedder: countingEmbedder,
      bm25,
      config: integrationConfig(),
      indexVersion,
      logger,
    });

    const products = generateFixtureCatalog();
    const first = await indexer.rebuild(products);
    expect(first.upserted).toBe(products.length);
    expect(first.embedded).toBe(products.length);
    expect(await store.countSearchDocs()).toBe(products.length);
    expect(await store.countEmbeddings(countingEmbedder.modelVersion)).toBe(products.length);

    // rebuild with identical products: hashes match => embeddings reused
    const second = await indexer.rebuild(products);
    expect(second.embedded).toBe(0);
    expect(second.reusedEmbeddings).toBe(products.length);
    expect(embedCalls).toBe(products.length);

    // update one product => exactly one embedding recomputed
    const changed = { ...products[0]!, name: "Tube PVC évacuation renforcé" };
    const third = await indexer.upsertBatch([changed]);
    expect(third.embedded).toBe(1);
    expect(third.upserted).toBe(1);
  }, 120_000);

  it("deletes documents and cascades embeddings", async () => {
    await store.deleteSearchDocs(["P000200"]);
    expect(await store.countSearchDocs()).toBe(199);
    expect(await store.countEmbeddings(embedder.modelVersion)).toBe(199);
  });

  it("pgvector cosine search matches in-memory brute force (parity)", async () => {
    // self-contained: same 100 docs + same embedding model version on both sides
    const parityEmbedder = new HashingEmbedder({ dimensions: 64, modelVersion: "parity-v1" });
    const products = generateFixtureCatalog().slice(0, 100);

    const memory = new MemorySearchStore();
    const docs = products.map((p) => builder.build(p));
    const vectors = await parityEmbedder.embedBatch(docs.map((d) => d.searchDocument));
    await memory.upsertSearchDocs(docs.map((product) => ({
      productId: product.productId, searchDocument: product.searchDocument,
      documentHash: product.documentHash, builderVersion: product.builderVersion,
      product, updatedAt: new Date(),
    })));
    await memory.upsertEmbeddings(docs.map((d, i) => ({
      productId: d.productId, embedding: vectors[i]!, modelVersion: parityEmbedder.modelVersion, documentHash: d.documentHash,
    })));
    await store.upsertSearchDocs(docs.map((product) => ({
      productId: product.productId, searchDocument: product.searchDocument,
      documentHash: product.documentHash, builderVersion: product.builderVersion,
      product, updatedAt: new Date(),
    })));
    await store.upsertEmbeddings(docs.map((d, i) => ({
      productId: d.productId, embedding: vectors[i]!, modelVersion: parityEmbedder.modelVersion, documentHash: d.documentHash,
    })));

    const queryVector = await parityEmbedder.embed("tube pvc évacuation diamètre 110");
    const pgResults = await store.searchVectors(queryVector, parityEmbedder.modelVersion, 10);
    const memoryResults = await memory.searchVectors(queryVector, parityEmbedder.modelVersion, 10);

    // brute-force in-memory cosine must agree with pgvector ordering/scores
    expect(pgResults.length).toBe(10);
    expect(pgResults.map((r) => r.productId)).toEqual(memoryResults.map((r) => r.productId));
    for (let i = 0; i < pgResults.length; i++) {
      expect(pgResults[i]!.score).toBeCloseTo(memoryResults[i]!.score, 5);
    }
    // direct sanity: similarity function agrees with pgvector scores
    const first = pgResults[0]!;
    const vector = vectors[docs.findIndex((d) => d.productId === first.productId)]!;
    expect(first.score).toBeCloseTo(cosineSimilarity(queryVector, vector), 5);
  });

  it("filters out embeddings from other model versions", async () => {
    const otherModel = new HashingEmbedder({ dimensions: 64, modelVersion: "other-model-v1" });
    const vector = await otherModel.embed("tube");
    await store.upsertEmbeddings([
      { productId: "P000001", embedding: vector, modelVersion: otherModel.modelVersion, documentHash: "x" },
    ]);
    // P000001 now has TWO embedding rows? No: single PK row is overwritten.
    // The old model row replaced the current one => P000001 must disappear
    // from current-model search results.
    const results = await store.searchVectors(await embedder.embed("tube"), embedder.modelVersion, 200);
    expect(results.map((r) => r.productId)).not.toContain("P000001");
  });

  it("persists evaluation queries and lists them back", async () => {
    await store.saveEvaluationQueries([
      { query: "tube 110", relevantProductIds: ["P000001"], notes: "integration" },
    ]);
    const listed = await store.listEvaluationQueries();
    expect(listed.some((q) => q.query === "tube 110" && q.relevantProductIds.includes("P000001"))).toBe(true);
  });

  it("writes search log events", async () => {
    await store.logSearchEvent({
      searchId: "test-search-1",
      query: "tube 110",
      normalizedQuery: "tube 110",
      resultProductIds: ["P000001"],
      latencyMs: 12.5,
    });
    const rows = await rawQuery(`SELECT search_id, latency_ms FROM search_log WHERE search_id = 'test-search-1'`);
    expect(rows.rows[0]!.latency_ms).toBe(13);
  });

  it("rejects non-finite embedding values (no SQL injection surface)", async () => {
    await expect(
      store.upsertEmbeddings([
        { productId: "X", embedding: [1, Number.NaN, 3], modelVersion: "m", documentHash: "h" },
      ]),
    ).rejects.toThrow(StoreError);
  });

  it("detects embedding dimension mismatch with an actionable error", async () => {
    const wrongDimStore = new PgSearchStore({
      config: integrationConfig().database,
      embeddingDimensions: 32,
      metric: "cosine",
    });
    await expect(wrongDimStore.init()).rejects.toThrow(/dimension/);
    await wrongDimStore.close().catch(() => {});
  });

  it("keyset iteration is complete and ordered", async () => {
    const ids: string[] = [];
    for await (const row of store.iterateSearchDocs(7)) {
      ids.push(row.productId);
    }
    expect(ids.length).toBe(199);
    expect([...ids].sort()).toEqual(ids);
  });
});

async function rawQuery(sql: string) {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    return await pool.query(sql);
  } finally {
    await pool.end();
  }
}
