import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSearchSystem } from "../../src/system.js";
import { JsonCatalogProvider } from "../../src/indexing/product-provider.js";
void JsonCatalogProvider;
import { PgProductProvider, StaticProductProvider } from "../../src/indexing/product-provider.js";
import { Pool } from "pg";
import { dropAllTables, ensureTestDatabase, integrationConfig, TEST_DATABASE_URL } from "./helpers.js";

async function collect(provider: { fetchAll(): AsyncIterable<import("../../src/core/types.js").Product> }) {
  const out: import("../../src/core/types.js").Product[] = [];
  for await (const p of provider.fetchAll()) out.push(p);
  return out;
}
import { loadDataset } from "../../src/evaluation/dataset.js";
import { Evaluator } from "../../src/evaluation/evaluator.js";

const dbAvailable = await ensureTestDatabase().catch(() => false);

describe.skipIf(!dbAvailable)("SearchEngine over PostgreSQL/pgvector (end-to-end)", () => {
  beforeAll(async () => {
    await dropAllTables(TEST_DATABASE_URL);
  }, 60_000);

  it("full lifecycle: build, search, debug, update, delete, rebuild", async () => {
    const config = integrationConfig();
    config.logging.events.enabled = true;
    const system = await createSearchSystem({ config, store: "postgres", skipBootstrap: true });
    try {
      // build from the ERP-style products table
      await seedProductsTable();
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
      const provider = new PgProductProvider(pool, "products");
      const build = await system.indexer.rebuild(provider);
      expect(build.upserted).toBeGreaterThan(100);
      await system.documentCache.preload();
      await pool.end();

      // search
      const results = await system.engine.search("tube 110 blanc", { noCache: true });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.product.name).toContain("Tube");
      const byCode = await system.engine.search("TD110L4BL0", { noCache: true });
      expect(byCode[0]!.productId).toBe("P000001");

      // debug pipeline
      const debug = await system.engine.searchDebug("tube 110 blnc");
      expect(debug.query.normalized.normalized).toBe("tube 110 blanc");
      expect(debug.retrieval.candidateCount).toBeGreaterThan(0);
      expect(debug.retrieval.candidateCount).toBeLessThanOrEqual(50);
      expect(debug.timings.totalMs).toBeGreaterThanOrEqual(0);
      expect(debug.config.indexVersion).toBeGreaterThan(0);

      // incremental update + cache invalidation
      await system.indexer.upsert({
        id: "P999999",
        code: "ZZTOP42",
        name: "Tube spécial chantier",
        attributes: { diameter: "110 mm", color: "blanc", material: "PVC" },
      });
      await system.documentCache.preload();
      const found = await system.engine.search("tube spécial chantier", { noCache: true });
      expect(found[0]?.productId).toBe("P999999");

      // delete: the product itself must never come back
      await system.indexer.delete("P999999");
      await system.documentCache.preload();
      const afterDelete = await system.engine.search("tube spécial chantier ZZTOP42", { noCache: true });
      expect(afterDelete.map((r) => r.productId)).not.toContain("P999999");

      // search events were logged
      const pool2 = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
      const events = await pool2.query("SELECT count(*)::int AS n FROM search_log");
      expect(events.rows[0]!.n).toBeGreaterThan(0);
      await pool2.end();
    } finally {
      await system.close();
    }
  }, 180_000);

  it("evaluation runs against the PG-backed engine", async () => {
    const config = integrationConfig();
    const system = await createSearchSystem({ config, store: "postgres" });
    try {
      const dataset = await loadDataset("fixtures/gold-fr.jsonl");
      const report = await new Evaluator(system.engine).evaluate(dataset);
      expect(report.queryCount).toBe(28);
      expect(report.metrics.recallAt10).toBeGreaterThan(0.5);
    } finally {
      await system.close();
    }
  }, 120_000);

  it("single product upsert + static provider flows", async () => {
    const config = integrationConfig();
    const system = await createSearchSystem({ config, store: "postgres", skipBootstrap: true });
    try {
      const products = await collect(new JsonCatalogProvider("fixtures/catalog-fr.json"));
      const first20 = products.slice(0, 20);
      const event = await system.indexer.upsertBatch(first20);
      expect(event.upserted).toBe(20);
      await system.documentCache.preload();
      const results = await system.engine.search("raccord pvc", { noCache: true });
      expect(Array.isArray(results)).toBe(true);
    } finally {
      await system.close();
    }
  }, 120_000);
});

async function seedProductsTable(): Promise<void> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  await pool.query(`DROP TABLE IF EXISTS products`);
  await pool.query(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      attributes JSONB NOT NULL DEFAULT '{}',
      brand TEXT,
      category TEXT,
      subcategory TEXT
    )`);
  const { generateFixtureCatalog } = await import("../../src/benchmark/catalog-generator.js");
  for (const p of generateFixtureCatalog()) {
    await pool.query(
      `INSERT INTO products (id, code, name, attributes, brand, category, subcategory)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [p.id, p.code, p.name, JSON.stringify(p.attributes ?? {}), p.brand ?? null, p.category ?? null, p.subcategory ?? null],
    );
  }
  await pool.end();
}
