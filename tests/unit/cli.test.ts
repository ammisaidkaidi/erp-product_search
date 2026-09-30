import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CLI = "src/cli/index.ts";

/** CLI smoke tests run against the in-memory store + fixture catalog. */
async function cli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("npx", ["tsx", CLI, "--store", "memory", ...args], {
    cwd: process.cwd(),
    timeout: 120_000,
  });
}

describe("CLI (search-index)", () => {
  it("--help lists all commands", async () => {
    const { stdout } = await cli(["--help"]);
    for (const command of ["build", "update", "delete", "search", "evaluate", "benchmark", "inspect"]) {
      expect(stdout).toContain(command);
    }
  }, 120_000);

  it("build + search + inspect + debug lifecycle (memory store)", async () => {
    // note: memory store does not persist between invocations; build then
    // search must therefore happen within ONE command for real PG. For the
    // in-memory smoke test we verify each command runs and reports correctly
    // with an empty index (graceful) and use search on a built index via
    // the postgres store in integration tests.
    const { stdout } = await cli(["inspect"]);
    expect(stdout).toContain("store:");
    expect(stdout).toMatch(/documents:\s+0/);

    const search = await cli(["search", "tube 110 blanc"]);
    expect(search.stdout).toContain("No results");

    const debug = await cli(["search", "tube 110 blnc", "--debug"]);
    expect(debug.stdout).toContain("QUERY");
    expect(debug.stdout).toContain("RETRIEVAL");
    expect(debug.stdout).toContain("TIMINGS");
  }, 180_000);

  it("evaluate on the fixture gold dataset works with the noop reranker", async () => {
    // evaluate builds its own in-memory system via config? No: CLI uses the
    // configured store. The memory store starts empty => metrics are 0 but the
    // command must run cleanly. Real evaluation coverage lives in integration tests.
    const { stdout } = await cli(["evaluate", "--dataset", "fixtures/gold-fr.jsonl"]);
    expect(stdout).toContain("Queries: 28");
    expect(stdout).toContain("Recall@10:");
  }, 180_000);

  it("benchmark runs a small size end-to-end", async () => {
    const { stdout } = await cli(["benchmark", "--sizes", "1000", "--queries", "20"]);
    expect(stdout).toContain("1,000");
    expect(stdout).toContain("bottleneck");
  }, 300_000);

  it("rejects invalid config with a clear error", async () => {
    // non-existent reranker provider
    const badConfig = "search.config.broken.yaml";
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(badConfig, "reranking:\n  provider: magic\n  fallback: [noop]\n");
    try {
      await exec("npx", ["tsx", CLI, "--store", "memory", "--config", badConfig, "inspect"]);
      expect.unreachable("should have failed");
    } catch (e) {
      const err = e as { stderr: string };
      expect(err.stderr).toContain("reranking.provider");
    } finally {
      await rm(badConfig, { force: true });
    }
  }, 120_000);
});
