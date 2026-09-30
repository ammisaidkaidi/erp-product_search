import { describe, expect, it } from "vitest";
import { createHash as nodeCreateHash } from "node:crypto";
import { createHash as webCreateHash, randomUUID as webRandomUUID, type Hash } from "../../web/shims/node-crypto.js";

/**
 * The browser demo bundles the core library with web/shims/node-crypto.ts
 * replacing node:crypto. These tests prove the shim is BIT-EXACT with Node's
 * implementation, so the demo produces the same feature-hash embeddings,
 * document hashes and cache keys as the Node/PostgreSQL deployment.
 */

const VECTORS: Array<{ name: string; input: string }> = [
  { name: "empty string", input: "" },
  { name: "short ascii", input: "TD110L4BL0" },
  { name: "product feature", input: "name:tube|diameter:110|color:blanc" },
  { name: "french accented", input: "Tube PVC évacuation ø110 — tuyau" },
  { name: "code-fr.jsonl", input: "code:TD" },
  { name: "multi-kb (embedder batches hash long texts)", input: "x".repeat(10_000) },
  { name: "exactly one block boundary (56 bytes)", input: "a".repeat(55) },
  { name: "block boundary +1", input: "a".repeat(56) },
  { name: "block boundary +2", input: "a".repeat(57) },
  { name: "unicode emoji", input: "🔧🔧 plumbing 🚰" },
];

function nodeHex(algorithm: string, input: string): string {
  return nodeCreateHash(algorithm).update(input).digest("hex");
}

function webHex(algorithm: string, input: string): string {
  return webCreateHash(algorithm).update(input).digest("hex") as string;
}

describe("web crypto shim (bit-exact with node:crypto)", () => {
  for (const algorithm of ["sha1", "sha256"] as const) {
    describe(algorithm, () => {
      for (const vector of VECTORS) {
        it(`${algorithm}(${vector.name}) matches node`, () => {
          expect(webHex(algorithm, vector.input)).toBe(nodeHex(algorithm, vector.input));
        });
      }
    });
  }

  it("digest() returns raw bytes identical to node's Buffer", () => {
    const input = "feature-hash-bucket-string";
    const nodeBytes = nodeCreateHash("sha1").update(input).digest();
    const webBytes = webCreateHash("sha1").update(input).digest() as Uint8Array;
    expect(Array.from(webBytes)).toEqual(Array.from(nodeBytes));
    // the hashing embedder reads the first three bytes for bucket index/sign
    expect(webBytes.length).toBe(20);
    expect(webBytes[0]).toBe(nodeBytes[0]);
  });

  it("update() chains like node:crypto", () => {
    const chained: Hash = webCreateHash("sha256").update("part1-").update("part2");
    expect(chained.digest("hex")).toBe(nodeHex("sha256", "part1-part2"));
  });

  it("rejects unsupported algorithms", () => {
    expect(() => webCreateHash("md5")).toThrow(TypeError);
  });

  it("randomUUID returns distinct RFC 4122 v4 UUIDs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = webRandomUUID();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(50);
  });
});
