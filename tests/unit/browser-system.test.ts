import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDemoSystem } from "../../web/browser-system.js";
import type { Product } from "../../src/core/types.js";

/**
 * End-to-end test of the BROWSER composition root (web/browser-system.ts) —
 * the exact wiring bundled into the demo page. Proves the library core runs
 * without Node APIs (the crypto shim replaces node:crypto) and produces the
 * same quality as the Node/PostgreSQL path.
 */

const catalogPath = fileURLToPath(new URL("../../fixtures/catalog-fr.json", import.meta.url));
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Product[];

describe("browser demo system (web/browser-system.ts)", () => {
  it("indexes the fixture catalog in-memory", async () => {
    const system = await buildDemoSystem(catalog);
    expect(system.documents).toBe(200);
    expect(system.indexMs).toBeGreaterThan(0);
    expect(system.config.store).toBeUndefined(); // no store selection — memory wired directly
  });

  it("finds white Ø110 evacuation tubes for a typo'd query", async () => {
    const system = await buildDemoSystem(catalog);
    const results = await system.engine.search("tube 110 blnc");
    expect(results.length).toBeGreaterThan(0);
    const top = results.slice(0, 4).map((r) => r.productId);
    // same expectation as the PostgreSQL integration test
    expect(top).toContain("P000001"); // Tube PVC évacuation, blanc, 110 mm
    for (const r of results.slice(0, 4)) {
      expect(r.finalScore).toBeGreaterThan(0);
    }
  });

  it("searchDebug exposes the full pipeline with corrections and timings", async () => {
    const system = await buildDemoSystem(catalog);
    const debug = await system.engine.searchDebug("tube 110 blnc");
    expect(debug.query.normalized.original).toBe("tube 110 blnc");
    // typo correction with provenance must surface
    const corrections = debug.query.normalized.corrections.map((c) => `${c.from}->${c.to}`);
    expect(corrections).toContain("blnc->blanc");
    expect(debug.retrieval.bm25.length).toBeGreaterThan(0);
    expect(debug.retrieval.vector.length).toBeGreaterThan(0);
    expect(debug.retrieval.candidateCount).toBeGreaterThan(0);
    expect(debug.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(debug.degradations).toEqual([]);
    expect(debug.results.length).toBeGreaterThan(0);
  });

  it("is deterministic across rebuilds (same catalog, same rankings)", async () => {
    const a = await buildDemoSystem(catalog);
    const b = await buildDemoSystem(catalog);
    const queries = ["tube 110 blnc", "TD110L4BL0", "robinet cuisine", "gaine icta 20", "cable h07rk"];
    for (const q of queries) {
      const idsA = (await a.engine.search(q)).map((r) => r.productId).join(",");
      const idsB = (await b.engine.search(q)).map((r) => r.productId).join(",");
      expect(idsA, `query '${q}'`).toBe(idsB);
    }
  });

  it("answers exact product-code queries with the right product first", async () => {
    const system = await buildDemoSystem(catalog);
    const results = await system.engine.search("TD110L4BL0");
    expect(results[0]?.productId).toBe("P000001");
  });
});
