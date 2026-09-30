import { describe, expect, it } from "vitest";
import { SearchDocumentBuilder } from "../../src/document/builder.js";
import { FRENCH_ATTRIBUTE_LABELS } from "../../src/document/labels/fr.js";
import type { Product } from "../../src/core/types.js";

const builder = new SearchDocumentBuilder({ labelMap: FRENCH_ATTRIBUTE_LABELS });

const product: Product = {
  id: "P001245",
  code: "T110B45",
  name: "Tube PVC évacuation",
  attributes: {
    diameter: "110 mm",
    length: "4 m",
    color: "blanc",
    material: "PVC",
  },
};

describe("SearchDocumentBuilder", () => {
  it("produces the canonical search document", () => {
    const doc = builder.build(product);
    // attributes sorted by key: color, diameter, length, material
    expect(doc.searchDocument).toBe(
      "T110B45 | Tube PVC évacuation | couleur blanc | diamètre 110 mm | longueur 4 m | matière PVC",
    );
  });

  it("is deterministic regardless of attribute key order", () => {
    const a = builder.build(product);
    const b = builder.build({
      ...product,
      attributes: {
        material: "PVC",
        length: "4 m",
        diameter: "110 mm",
        color: "blanc",
      },
    });
    expect(a.searchDocument).toBe(b.searchDocument);
    expect(a.documentHash).toBe(b.documentHash);
  });

  it("changes hash when any searchable input changes", () => {
    const base = builder.build(product);
    const changed = builder.build({ ...product, name: "Tube PVC assainissement" });
    expect(changed.documentHash).not.toBe(base.documentHash);
    const changedAttr = builder.build({ ...product, attributes: { ...product.attributes!, color: "gris" } });
    expect(changedAttr.documentHash).not.toBe(base.documentHash);
  });

  it("hash is stable across runs (version pinning)", () => {
    const b1 = new SearchDocumentBuilder({ labelMap: FRENCH_ATTRIBUTE_LABELS });
    const b2 = new SearchDocumentBuilder({ labelMap: FRENCH_ATTRIBUTE_LABELS });
    expect(b1.build(product).documentHash).toBe(b2.build(product).documentHash);
    expect(b1.version).toBe(b2.version);
  });

  it("never mutates the original product", () => {
    const snapshot = JSON.stringify(product);
    builder.build(product);
    expect(JSON.stringify(product)).toBe(snapshot);
  });

  it("handles missing attributes, brand and category", () => {
    const doc = builder.build({ id: "X1", code: "ABC123", name: "Chose" });
    expect(doc.searchDocument).toBe("ABC123 | Chose");
    const withBrand = builder.build({ id: "X2", code: "ABC124", name: "Chose", brand: "Sombrand", category: "Plomberie" });
    expect(withBrand.searchDocument).toBe("ABC124 | Chose | Sombrand | Plomberie");
  });

  it("falls back to humanized keys for unknown attributes", () => {
    const doc = builder.build({ id: "X3", code: "A1", name: "N", attributes: { torque_nominal: "12 Nm" } });
    expect(doc.searchDocument).toContain("torque nominal 12 Nm");
  });

  it("skips empty attribute values deterministically", () => {
    const doc = builder.build({ id: "X4", code: "A2", name: "N", attributes: { color: "", material: "PE" } });
    expect(doc.searchDocument).toBe("A2 | N | matière PE");
  });

  it("rejects invalid products", () => {
    expect(() => builder.build({ id: "", code: "A", name: "N" })).toThrow(TypeError);
    // @ts-expect-error runtime guard test
    expect(() => builder.build(null)).toThrow(TypeError);
  });
});
