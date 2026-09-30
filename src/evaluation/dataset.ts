import { readFile } from "node:fs/promises";
import type { EvaluationQuery, GoldLabel } from "../core/types.js";

/**
 * Evaluation datasets.
 *
 * Two supported formats:
 *  1. JSON array of { query, relevant_product_ids }  (binary relevance)
 *  2. JSONL of { query, product_id, label }         (graded gold labels 0-4)
 *
 * Both normalize to per-query relevant sets + graded gains. The label scale is
 * configurable (relevantThreshold: labels >= threshold count as "relevant"
 * for recall/MRR; default 1).
 */
export interface NormalizedDataset {
  queries: Array<{
    query: string;
    relevantProductIds: string[];
    gains: Map<string, number>;
    notes?: string;
  }>;
  format: "binary" | "graded";
}

export interface DatasetOptions {
  /** labels >= threshold count as relevant for recall/MRR (default 1). */
  relevantThreshold?: number;
}

export async function loadDataset(file: string, options: DatasetOptions = {}): Promise<NormalizedDataset> {
  const threshold = options.relevantThreshold ?? 1;
  const raw = await readFile(file, "utf8");

  if (file.endsWith(".jsonl") || file.endsWith(".ndjson")) {
    return { queries: parseGraded(raw, threshold), format: "graded" };
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`Dataset ${file} must be a JSON array or JSONL`);
  if (parsed.length > 0 && isGoldLabel(parsed[0])) {
    // JSON array of graded records
    return { queries: parseGraded(parsed.map((r) => JSON.stringify(r)).join("\n"), threshold), format: "graded" };
  }
  const queries: NormalizedDataset["queries"] = [];
  for (const item of parsed) {
    const record = item as Partial<EvaluationQuery>;
    if (typeof record.query !== "string" || !Array.isArray(record.relevantProductIds)) {
      throw new Error(`Invalid dataset record (need query + relevant_product_ids): ${JSON.stringify(item).slice(0, 120)}`);
    }
    queries.push({
      query: record.query,
      relevantProductIds: record.relevantProductIds.filter((id): id is string => typeof id === "string"),
      gains: new Map(record.relevantProductIds.map((id) => [id, 1])),
      ...(typeof record.notes === "string" ? { notes: record.notes } : {}),
    });
  }
  return { queries, format: "binary" };
}

function isGoldLabel(value: unknown): value is Partial<GoldLabel> {
  return (
    typeof value === "object" &&
    value !== null &&
    "label" in value &&
    "product_id" in value
  );
}

function parseGraded(raw: string, threshold: number): NormalizedDataset["queries"] {
  const byQuery = new Map<string, { gains: Map<string, number>; notes?: string }>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Invalid JSONL line in dataset: ${trimmed.slice(0, 120)}`);
    }
    const record = parsed as Partial<GoldLabel>;
    if (typeof record.query !== "string" || typeof record.productId !== "string" || typeof record.label !== "number") {
      throw new Error(
        `Graded dataset records need { query, productId (or product_id), label }: ${trimmed.slice(0, 120)}`,
      );
    }
    let entry = byQuery.get(record.query);
    if (!entry) {
      entry = { gains: new Map() };
      byQuery.set(record.query, entry);
    }
    entry.gains.set(record.productId, record.label);
  }
  return [...byQuery.entries()].map(([query, entry]) => ({
    query,
    relevantProductIds: [...entry.gains.entries()].filter(([, label]) => label >= threshold).map(([id]) => id),
    gains: entry.gains,
  }));
}

/** Render a small human-labeled gold file skeleton for a set of queries. */
export function goldTemplate(queries: string[]): string {
  return queries.map((query) => JSON.stringify({ query, productId: "P...", label: 3 })).join("\n") + "\n";
}
