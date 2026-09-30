import { describe, expect, it } from "vitest";
import { InMemoryBm25Index } from "../../src/retrieval/lexical/bm25f.js";
import { SearchDocumentBuilder } from "../../src/document/builder.js";
import { FRENCH_ATTRIBUTE_LABELS } from "../../src/document/labels/fr.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import type { NormalizedQuery, Product } from "../../src/core/types.js";

const builder = new SearchDocumentBuilder({ labelMap: FRENCH_ATTRIBUTE_LABELS });
const config = DEFAULT_CONFIG.retrieval.bm25;

function makeIndex(products: Product[]): InMemoryBm25Index {
  const index = new InMemoryBm25Index(config, builder);
  index.upsertMany(products.map((p) => builder.build(p)));
  return index;
}

function nq(text: string, codes: string[] = []): NormalizedQuery {
  return {
    original: text,
    normalized: text,
    tokens: text.toLowerCase().split(/\s+/).filter(Boolean),
    attributes: {},
    attributeValues: {},
    codes,
    tokenProvenance: {},
    corrections: [],
    normalizerId: "test",
    normalizerVersion: "test",
    isEmpty: text.trim().length === 0,
    notes: [],
  };
}

const catalog: Product[] = [
  { id: "P1", code: "T110B45", name: "Tube PVC évacuation", attributes: { diameter: "110 mm", length: "4 m", color: "blanc", material: "PVC" } },
  { id: "P2", code: "T110G45", name: "Tube PVC évacuation", attributes: { diameter: "110 mm", length: "4 m", color: "gris", material: "PVC" } },
  { id: "P3", code: "T125B45", name: "Tube PVC évacuation", attributes: { diameter: "125 mm", length: "4 m", color: "blanc", material: "PVC" } },
  { id: "P4", code: "R110B45", name: "Raccord PVC à bague", attributes: { diameter: "110 mm", color: "blanc", material: "PVC" } },
  { id: "P5", code: "C3G15", name: "Câble rigide 3G", attributes: { section: "1.5 mm²", color: "gris" } },
  { id: "P6", code: "TUB110XL", name: "Tube flexible", attributes: { diameter: "110 mm", color: "noir" } },
];

describe("InMemoryBm25Index", () => {
  it("exact product code ranks first with the exact-code boost", () => {
    const index = makeIndex(catalog);
    const results = index.search(nq("T110B45", ["T110B45"]), 10);
    expect(results[0]?.productId).toBe("P1");
    const debug = index.searchDebug(nq("T110B45", ["T110B45"]), 10);
    expect(debug[0]?.debug.exactCodeBoost).toBe(config.boosts.exactCode);
  });

  it("separated code variants (T-110-B45) match the canonical code", () => {
    const index = makeIndex(catalog);
    const results = index.search(nq("T-110-B45", ["T110B45"]), 10);
    expect(results[0]?.productId).toBe("P1");
  });

  it("partial code gets the prefix boost", () => {
    const index = makeIndex(catalog);
    const debug = index.searchDebug(nq("T110", []), 10);
    const top = debug.find((d) => d.productId === "P1");
    expect(top?.debug.codePrefixBoost).toBe(config.boosts.codePrefix);
  });

  it("diameter query ranks matching diameter above other diameters", () => {
    const index = makeIndex(catalog);
    const results = index.search(nq("tube 110"), 10).map((r) => r.productId);
    expect(results).toContain("P1");
    expect(results.indexOf("P1")).toBeLessThan(results.indexOf("P3"));
  });

  it("numeric terms matching attributes receive the numeric boost", () => {
    const index = makeIndex(catalog);
    const debug = index.searchDebug(nq("110"), 10);
    for (const d of debug) {
      if (["P1", "P2", "P4", "P6"].includes(d.productId)) {
        expect(d.debug.numericBoost).toBeGreaterThan(0);
      }
    }
  });

  it("dimension composites match formatted docs (110x45 vs '110 x 45')", () => {
    const index = makeIndex([
      { id: "D1", code: "G11045", name: "Goulotte", attributes: { size: "110 x 45 mm" } },
      { id: "D2", code: "G45110", name: "Goulotte", attributes: { size: "45 x 110 mm" } },
    ]);
    const r = index.search(nq("goulotte 110x45"), 10).map((x) => x.productId);
    expect(r[0]).toBe("D1");
    // D2 also contains the parts, but the composite only matches D1 => D1 strictly first
    expect(index.search(nq("110x45"), 10)[0]?.productId).toBe("D1");
  });

  it("attached unit queries (110mm) rank matching diameters above non-matching", () => {
    const index = makeIndex(catalog);
    const r = index.search(nq("tube 110mm"), 10).map((x) => x.productId);
    expect(r).toContain("P1");
    expect(r).toContain("P2");
    // every 110mm product must rank above the 125mm product (P3)
    for (const pid of ["P1", "P2", "P6"]) {
      expect(r.indexOf(pid)).toBeLessThan(r.indexOf("P3"));
      expect(r.indexOf(pid)).toBeGreaterThanOrEqual(0);
    }
  });

  it("plural queries match singular documents (tubes -> tube)", () => {
    const index = makeIndex(catalog);
    const r = index.search(nq("tubes pvc"), 10).map((x) => x.productId);
    expect(r.length).toBeGreaterThan(0);
  });

  it("accent-insensitive matching (evacuation vs évacuation)", () => {
    const index = makeIndex(catalog);
    expect(index.search(nq("evacuation"), 10).length).toBeGreaterThan(0);
    expect(index.search(nq("ÉVACUATION"), 10).length).toBeGreaterThan(0);
  });

  it("empty query returns nothing", () => {
    const index = makeIndex(catalog);
    expect(index.search(nq(""), 10)).toEqual([]);
  });

  it("unknown product returns nothing (graceful degradation)", () => {
    const index = makeIndex(catalog);
    expect(index.search(nq("xyzabc999"), 10)).toEqual([]);
  });

  it("delete removes the document", () => {
    const index = makeIndex(catalog);
    expect(index.documentCount).toBe(6);
    index.delete("P1");
    expect(index.documentCount).toBe(5);
    expect(index.search(nq("T110B45", ["T110B45"]), 10).map((r) => r.productId)).not.toContain("P1");
  });

  it("re-upserting replaces the old posting (no duplicate growth)", () => {
    const index = makeIndex([catalog[0]!]);
    const before = index.search(nq("tube"), 10)[0]?.score;
    index.upsert(builder.build({ ...catalog[0]!, name: "Tube PVC évacuation nouvelle génération" }));
    const after = index.search(nq("tube"), 10);
    expect(index.documentCount).toBe(1);
    expect(after[0]?.productId).toBe("P1");
    expect(after.length).toBe(1);
    expect(before).toBeGreaterThan(0);
  });

  it("scores are deterministic across identical index builds", () => {
    const a = makeIndex(catalog).search(nq("tube pvc 110 blanc"), 10);
    const b = makeIndex(catalog).search(nq("tube pvc 110 blanc"), 10);
    expect(a.map((r) => [r.productId, r.score])).toEqual(b.map((r) => [r.productId, r.score]));
  });

  it("vocabulary exposes frequent terms for typo correction", () => {
    const index = makeIndex(catalog);
    const vocab = index.vocabulary();
    expect(vocab).toContain("tube");
    expect(vocab).toContain("evacuation");
  });

  it("codes exposes canonical codes", () => {
    const index = makeIndex(catalog);
    expect(index.codes()).toContain("T110B45");
  });
});
