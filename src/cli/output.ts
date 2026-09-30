import type { DebugSearchResult, SearchResult } from "../core/types.js";

/** Console rendering: normal results (spec §46) and the full debug pipeline. */

export function renderResults(results: SearchResult[], limit: number): string {
  if (results.length === 0) return "No results.";
  const lines: string[] = [];
  results.slice(0, limit).forEach((result) => {
    const name = result.product.name;
    const attrs = Object.entries(result.product.attributes)
      .slice(0, 4)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    lines.push(`${result.rank}. ${name}${attrs ? ` (${attrs})` : ""}`);
    lines.push(`   ${result.product.code} — Score: ${result.finalScore.toFixed(2)}`);
  });
  return lines.join("\n");
}

export function renderDebug(debug: DebugSearchResult): string {
  const out: string[] = [];
  out.push("QUERY");
  out.push(`  original:   ${debug.query.original}`);
  out.push(`  normalized: ${debug.query.normalized.normalized}`);
  if (debug.query.normalized.corrections.length > 0) {
    const corrections = debug.query.normalized.corrections
      .map((c) => `${c.from} -> ${c.to} (${c.kind})`)
      .join(", ");
    out.push(`  corrections: ${corrections}`);
  }
  if (Object.keys(debug.query.normalized.attributeValues).length > 0) {
    out.push(`  attributes: ${JSON.stringify(debug.query.normalized.attributeValues)}`);
  }
  out.push("");
  out.push("RETRIEVAL");
  out.push(`  BM25:   ${debug.retrieval.bm25.length}${debug.retrieval.bm25.length > 0 ? ` (top: ${debug.retrieval.bm25[0]!.productId} ${debug.retrieval.bm25[0]!.score.toFixed(2)})` : ""}`);
  out.push(`  Vector: ${debug.retrieval.vector.length}${debug.retrieval.vector.length > 0 ? ` (top: ${debug.retrieval.vector[0]!.productId} ${debug.retrieval.vector[0]!.score.toFixed(3)})` : ""}`);
  out.push(`  RRF:    ${debug.retrieval.candidateCount} candidates (k=${debug.config.fusionK})`);
  out.push("");
  out.push("RERANKER");
  out.push(`  provider: ${debug.reranking.provider}${debug.reranking.fallbackFor ? ` (fallback for ${debug.reranking.fallbackFor})` : ""}`);
  if (debug.reranking.degraded) out.push("  DEGRADED: primary reranker failed, fallback used");
  out.push("");
  out.push("TOP RESULTS");
  for (const result of debug.results.slice(0, 5)) {
    out.push(
      `  ${result.rank}. ${result.productId} ${result.product.name}` +
        ` [bm25: ${result.retrieval.bm25 ? `#${result.retrieval.bm25.rank}` : "-"} | ` +
        `vector: ${result.retrieval.vector ? `#${result.retrieval.vector.rank}` : "-"} | ` +
        `rrf: ${result.retrieval.rrf?.score.toFixed(4) ?? "-"} | ` +
        `reranker: ${result.reranking ? result.reranking.score.toFixed(3) : "-"} | ` +
        `final: ${result.finalScore.toFixed(3)}]`,
    );
  }
  out.push("");
  out.push("TIMINGS");
  out.push(`  Normalization: ${debug.timings.normalizationMs} ms`);
  out.push(`  BM25:          ${debug.timings.bm25Ms ?? "-"} ms`);
  out.push(`  Vector:        ${debug.timings.vectorMs ?? "-"} ms`);
  out.push(`  Retrieval:     ${debug.timings.retrievalMs} ms`);
  out.push(`  Fusion (RRF):  ${debug.timings.fusionMs} ms`);
  out.push(`  Reranker:      ${debug.timings.rerankerMs} ms`);
  out.push(`  Total:         ${debug.timings.totalMs} ms`);
  if (debug.degradations.length > 0) {
    out.push("");
    out.push("DEGRADATIONS");
    for (const d of debug.degradations) out.push(`  [${d.stage}] ${d.message}`);
  }
  out.push("");
  out.push(`  search_id: ${debug.searchId}  index_version: ${debug.config.indexVersion}`);
  return out.join("\n");
}

export function renderInspect(info: {
  store: string;
  documents: number;
  embeddings: number;
  indexVersion: number;
  embedder: string;
  embeddingModel: string;
  reranker: string;
  normalizer: string;
  sample?: { productId: string; searchDocument: string } | null;
}): string {
  const lines = [
    `store:            ${info.store}`,
    `documents:        ${info.documents}`,
    `embeddings:       ${info.embeddings} (model: ${info.embeddingModel})`,
    `index_version:    ${info.indexVersion}`,
    `embedder:         ${info.embedder}`,
    `reranker:         ${info.reranker}`,
    `normalizer:       ${info.normalizer}`,
  ];
  if (info.sample) {
    lines.push("", "sample document", `  ${info.sample.productId}: ${info.sample.searchDocument}`);
  }
  return lines.join("\n");
}
