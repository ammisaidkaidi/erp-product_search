#!/usr/bin/env node
import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config/loader.js";
import { createSearchSystem, type SearchSystem } from "../system.js";
import { JsonCatalogProvider, parseProduct } from "../indexing/product-provider.js";
import { loadDataset } from "../evaluation/dataset.js";
import { Evaluator } from "../evaluation/evaluator.js";
import { RerankerBenchmark, renderBenchmarkTable } from "../evaluation/reranker-benchmark.js";
import { runBenchmark, renderBenchmarkResults } from "../benchmark/bench.js";
import { renderDebug, renderInspect, renderResults } from "./output.js";
import { NoopReranker } from "../reranking/noop.js";
import { CrossEncoderReranker } from "../reranking/cross-encoder.js";
import { VonReranker } from "../reranking/von/reranker.js";
import { MockVonBackend, PythonVonBackend } from "../reranking/von/backend.js";
import { PythonModelWorker } from "../adapters/python-worker.js";
import type { Reranker } from "../reranking/interfaces.js";
import type { Product } from "../core/types.js";
import { ConfigurationError, errorSummary } from "../core/errors.js";

const program = new Command();

program
  .name("search-index")
  .description("Local-first hybrid semantic product search (BM25F + vector + RRF + reranking)")
  .version("0.1.0")
  .addOption(new Option("--config <path>", "config file (search.config.yaml)").default("search.config.yaml"))
  .addOption(new Option("--store <type>", "storage backend").choices(["postgres", "memory"]).default("postgres"))
  .addOption(new Option("--json", "machine-readable JSON output").default(false));

interface GlobalOptions {
  config: string;
  store: "postgres" | "memory";
  json: boolean;
}

async function withSystem<T>(
  options: GlobalOptions & { catalog?: string; reranker?: string; rerankerModel?: string },
  fn: (system: SearchSystem) => Promise<T>,
  options2?: { skipBootstrap?: boolean },
): Promise<T> {
  const config = await loadConfig({ file: options.config });
  const system = await createSearchSystem({
    config,
    store: options.store,
    skipBootstrap: options2?.skipBootstrap ?? false,
  });
  try {
    return await fn(system);
  } finally {
    await system.close();
  }
}

function parseSizes(raw: string): number[] {
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function buildReranker(name: string, system: SearchSystem): Reranker {
  switch (name) {
    case "noop":
    case "hybrid-only":
      return new NoopReranker();
    case "von": {
      const vonConfig = system.config.reranking.von;
      const backend =
        vonConfig.backend === "mock"
          ? new MockVonBackend()
          : new PythonVonBackend({
              model: vonConfig.model,
              worker: new PythonModelWorker({
                pythonPath: vonConfig.pythonPath,
                workerPath: vonConfig.workerPath,
                args: ["--model", vonConfig.model],
                timeoutMs: vonConfig.timeoutMs,
                warmupTimeoutMs: vonConfig.warmupTimeoutMs,
                logger: system.logger.child({ component: "von-cli" }),
              }),
            });
      return new VonReranker({ backend, config: vonConfig });
    }
    case "cross-encoder":
    case "bge":
    case "minilm":
      return new CrossEncoderReranker({
        ...system.config.reranking.crossEncoder,
        ...(name === "bge" ? { model: "Xenova/bge-reranker-base" } : {}),
        ...(name === "minilm" ? { model: "Xenova/ms-marco-MiniLM-L-6-v2" } : {}),
      });
    default:
      throw new ConfigurationError(`unknown reranker: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

program
  .command("build")
  .description("full index rebuild from a product catalog (JSON array file)")
  .requiredOption("--catalog <path>", "catalog JSON file")
  .option("--drop", "drop existing search data first", false)
  .action(async (cmdOptions) => {
    const global = program.opts<GlobalOptions>();
    await withSystem(global, async (system) => {
      const provider = new JsonCatalogProvider(cmdOptions.catalog);
      const event = await system.indexer.rebuild(provider, { dropFirst: cmdOptions.drop });
      if (global.json) {
        console.log(JSON.stringify(event));
      } else {
        console.log(
          `Rebuilt: ${event.upserted} upserted, ${event.embedded} embedded, ` +
            `${event.reusedEmbeddings} reused, ${event.deleted} deleted in ${Math.round(event.durationMs)} ms ` +
            `(index_version=${event.indexVersion})`,
        );
      }
    }, { skipBootstrap: true });
  });

program
  .command("update")
  .description("incremental batch upsert from a JSON array of products")
  .requiredOption("--catalog <path>", "products JSON file")
  .action(async (cmdOptions) => {
    const global = program.opts<GlobalOptions>();
    await withSystem(global, async (system) => {
      const raw: unknown = JSON.parse(await readFile(cmdOptions.catalog, "utf8"));
      if (!Array.isArray(raw)) throw new ConfigurationError("catalog must be a JSON array");
      const products = (raw as unknown[]).map(parseProduct);
      const event = await system.indexer.upsertBatch(products as Product[]);
      console.log(
        global.json
          ? JSON.stringify(event)
          : `Updated: ${event.upserted} upserted, ${event.embedded} embedded, ${event.reusedEmbeddings} reused`,
      );
    });
  });

program
  .command("delete")
  .description("remove a product from the search index")
  .requiredOption("--id <productId>", "product id")
  .action(async (cmdOptions) => {
    const global = program.opts<GlobalOptions>();
    await withSystem(global, async (system) => {
      const event = await system.indexer.delete(cmdOptions.id);
      console.log(global.json ? JSON.stringify(event) : `Deleted ${cmdOptions.id} (index_version=${event.indexVersion})`);
    });
  });

program
  .command("search")
  .description("run a search query")
  .argument("<query>", "search query")
  .option("--debug", "show the complete pipeline (normalized query, stages, scores, timings)", false)
  .option("--limit <n>", "number of results", "10")
  .action(async (query: string, cmdOptions) => {
    const global = program.opts<GlobalOptions>();
    const limit = Number(cmdOptions.limit) || 10;
    await withSystem(global, async (system) => {
      if (cmdOptions.debug) {
        const debug = await system.engine.searchDebug(query, { limit, noCache: true });
        console.log(global.json ? JSON.stringify(debug, null, 2) : renderDebug(debug));
        return;
      }
      const results = await system.engine.search(query, { limit, noCache: true });
      if (global.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(renderResults(results, limit));
      }
    });
  });

program
  .command("evaluate")
  .description("run offline evaluation on a gold dataset")
  .requiredOption("--dataset <path>", "dataset file (JSON or JSONL)")
  .option("--reranker <provider>", "override reranker (noop|von|cross-encoder|bge|minilm)")
  .option("--reranker-model <model>", "override cross-encoder model id")
  .option("--benchmark", "compare rerankers on the same candidate sets", false)
  .action(async (cmdOptions) => {
    const global = program.opts<GlobalOptions>();
    await withSystem(global, async (system) => {
      const dataset = await loadDataset(cmdOptions.dataset);
      if (cmdOptions.benchmark) {
        const rerankers: Reranker[] = [];
        for (const name of cmdOptions.reranker ? [cmdOptions.reranker] : ["noop", "von", "cross-encoder"]) {
          try {
            rerankers.push(buildReranker(name, system));
          } catch (e) {
            console.error(`skipping reranker ${name}: ${errorSummary(e).message}`);
          }
        }
        try {
          const report = await new RerankerBenchmark(system).run(dataset, rerankers);
          console.log(renderBenchmarkTable(report));
          if (global.json) console.log(JSON.stringify(report, null, 2));
        } finally {
          for (const reranker of rerankers) await reranker.dispose?.().catch(() => {});
        }
        return;
      }
      if (cmdOptions.reranker) {
        system.config.reranking.provider = cmdOptions.reranker as never;
      }
      const evaluator = new Evaluator(system.engine);
      const report = await evaluator.evaluate(dataset);
      if (global.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(`Queries: ${report.queryCount}`);
      console.log(`Recall@1:  ${report.metrics.recallAt1.toFixed(3)}`);
      console.log(`Recall@5:  ${report.metrics.recallAt5.toFixed(3)}`);
      console.log(`Recall@10: ${report.metrics.recallAt10.toFixed(3)}`);
      console.log(`Recall@20: ${report.metrics.recallAt20.toFixed(3)}`);
      console.log(`MRR@10:    ${report.metrics.mrrAt10.toFixed(3)}`);
      console.log(`NDCG@10:   ${report.metrics.ndcgAt10.toFixed(3)}`);
      console.log(
        `Latency: p50=${report.latency.p50Ms}ms p90=${report.latency.p90Ms}ms qps=${report.latency.queriesPerSecond}`,
      );
    });
  });

program
  .command("benchmark")
  .description("performance benchmark over synthetic catalogs")
  .option("--sizes <list>", "comma-separated catalog sizes", "1000,5000,10000,20000,50000")
  .option("--queries <n>", "queries per size", "200")
  .action(async (cmdOptions) => {
    const global = program.opts<GlobalOptions>();
    const sizes = parseSizes(cmdOptions.sizes);
    const results = await runBenchmark({
      sizes,
      queryCount: Number(cmdOptions.queries) || 200,
      store: global.store,
    });
    if (global.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(renderBenchmarkResults(results));
      console.log("\nBottleneck column = stage with the highest mean latency share.");
    }
  });

program
  .command("inspect")
  .description("show index state and a sample document")
  .action(async () => {
    const global = program.opts<GlobalOptions>();
    await withSystem(global, async (system) => {
      const documents = await system.store.countSearchDocs();
      const embeddings = await system.store.countEmbeddings(system.embedder.modelVersion);
      const info = {
        store: system.store.id,
        documents,
        embeddings,
        indexVersion: system.indexVersion.get(),
        embedder: system.embedder.id,
        embeddingModel: system.embedder.modelVersion,
        reranker: system.reranker.provider,
        normalizer: (await system.normalizer.normalize("tube 110")).normalizerId,
        sample: null as { productId: string; searchDocument: string } | null,
      };
      for await (const row of system.store.iterateSearchDocs()) {
        info.sample = { productId: row.productId, searchDocument: row.searchDocument };
        break;
      }
      console.log(global.json ? JSON.stringify(info, null, 2) : renderInspect(info));
    });
  });

program.parseAsync().catch((e: unknown) => {
  console.error(errorSummary(e).message);
  process.exit(1);
});
