import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, deepMerge } from "../../src/config/schema.js";
import { assertValidConfig, validateConfig } from "../../src/config/validate.js";
import { loadConfig } from "../../src/config/loader.js";
import { ConfigurationError } from "../../src/core/errors.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config defaults", () => {
  it("matches the documented top-k policy (50/50/50 -> 10)", () => {
    expect(DEFAULT_CONFIG.retrieval.bm25.topK).toBe(50);
    expect(DEFAULT_CONFIG.retrieval.vector.topK).toBe(50);
    expect(DEFAULT_CONFIG.fusion.topK).toBe(50);
    expect(DEFAULT_CONFIG.reranking.candidateLimit).toBe(50);
    expect(DEFAULT_CONFIG.reranking.resultLimit).toBe(10);
    expect(DEFAULT_CONFIG.search.defaultLimit).toBe(10);
    expect(DEFAULT_CONFIG.fusion.k).toBe(60);
  });

  it("passes validation", () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual([]);
  });

  it("has no hard-coded reranker provider (noop default, von opt-in)", () => {
    expect(DEFAULT_CONFIG.reranking.provider).toBe("noop");
    expect(DEFAULT_CONFIG.reranking.fallback).toEqual(["noop"]);
  });
});

describe("deepMerge", () => {
  it("deep merges nested objects and replaces arrays", () => {
    const merged = deepMerge(DEFAULT_CONFIG, {
      fusion: { k: 10 },
      retrieval: { bm25: { stopwords: ["x"] } },
    });
    expect(merged.fusion.k).toBe(10);
    expect(merged.retrieval.bm25.stopwords).toEqual(["x"]);
    // untouched nested values survive
    expect(merged.fusion.topK).toBe(50);
    // base not mutated
    expect(DEFAULT_CONFIG.fusion.k).toBe(60);
  });
});

describe("validateConfig", () => {
  it("rejects unknown reranker provider", () => {
    const bad = deepMerge(DEFAULT_CONFIG, { reranking: { provider: "magic" as never } });
    expect(validateConfig(bad).some((e) => e.includes("reranking.provider"))).toBe(true);
  });

  it("rejects both retrievers disabled", () => {
    const bad = deepMerge(DEFAULT_CONFIG, { retrieval: { bm25: { enabled: false }, vector: { enabled: false } } });
    expect(validateConfig(bad).some((e) => e.includes("at least one"))).toBe(true);
  });

  it("rejects fusion k < 1", () => {
    const bad = deepMerge(DEFAULT_CONFIG, { fusion: { k: 0 } });
    expect(validateConfig(bad).some((e) => e.includes("fusion.k"))).toBe(true);
  });

  it("throws ConfigurationError with all messages", () => {
    const bad = deepMerge(DEFAULT_CONFIG, { fusion: { k: -1 }, search: { defaultLimit: 0 } });
    expect(() => assertValidConfig(bad)).toThrow(ConfigurationError);
    expect(() => assertValidConfig(bad)).toThrow(/search\.default_limit/);
  });
});

describe("loadConfig", () => {
  it("loads YAML file over defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cfg-"));
    const file = join(dir, "search.config.yaml");
    await writeFile(file, [
      "mode: production",
      "fusion:",
      "  k: 42",
      "reranking:",
      "  provider: von",
      "  fallback: [noop]",
      "",
    ].join("\n"), "utf8");
    const cfg = await loadConfig({ file });
    expect(cfg.fusion.k).toBe(42);
    expect(cfg.reranking.provider).toBe("von");
    // production preset applied beneath file patch
    expect(cfg.logging.pretty).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("missing optional file yields defaults", async () => {
    const cfg = await loadConfig({ file: "/nonexistent/search.config.yaml" });
    expect(cfg.fusion.k).toBe(60);
  });

  it("missing required file throws", async () => {
    await expect(loadConfig({ file: "/nonexistent/search.config.yaml", required: true })).rejects.toThrow(ConfigurationError);
  });

  it("applies overrides last", async () => {
    const cfg = await loadConfig({ overrides: { fusion: { k: 7 } } });
    expect(cfg.fusion.k).toBe(7);
  });
});
