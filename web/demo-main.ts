/**
 * Demo page glue: builds the system from the bundled catalog, wires the
 * search box, renders results and the pipeline panel.
 *
 * All rendering uses textContent / createElement — no innerHTML with data
 * (model outputs and catalog strings are treated as untrusted text, per the
 * library's security rules).
 */

import { buildDemoSystem } from "./browser-system.js";
import catalog from "../fixtures/catalog-fr.json" with { type: "json" };
import type { DebugSearchResult, Product, SearchResult } from "../src/core/types.js";

const products = catalog as unknown as Product[];
const byId = new Map(products.map((p) => [p.id, p]));

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`demo: missing element #${id}`);
  return el;
};

const CORRECTION_LABELS: Record<string, string> = {
  typo: "faute de frappe",
  abbreviation: "abréviation",
  unit: "unité",
  accent: "accent",
  whitespace: "espace",
  case: "casse",
  synonym: "synonyme",
};

const SAMPLES = [
  "tube 110 blnc", // typo + attribute
  "TD110L4BL0", // exact product code
  "tuyau evacuation ø110", // synonym + unit
  "robinet mitigeur cuisine",
  "gaine icta 20",
  "cable h07rk 3g2.5",
];

const els = {
  input: document.getElementById("q") as HTMLInputElement | null,
  status: $("status"),
  samples: $("samples"),
  results: $("results"),
  pipeline: $("pipeline"),
  footer: $("footer"),
};

let controller: AbortController | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return `${ms.toFixed(1)} ms`;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------- rendering

function renderResult(r: SearchResult, topScore: number): HTMLElement {
  const product = byId.get(r.productId);
  const card = el("article", "result");

  const head = el("div", "result-head");
  const rank = el("span", "rank", String(r.rank));
  const title = el("h3", "", product?.name ?? r.productId);
  head.append(rank, title);
  if (product?.code) {
    const code = el("code", "code-badge", product.code);
    head.append(code);
  }
  card.append(head);

  if (product) {
    const meta = el("div", "meta");
    const bits = [product.brand, product.category, product.subcategory].filter(Boolean) as string[];
    meta.textContent = bits.join(" · ");
    card.append(meta);

    const chips = el("div", "chips");
    for (const [label, value] of Object.entries(product.attributes ?? {})) {
      chips.append(el("span", "chip", `${label}: ${value}`));
    }
    card.append(chips);
  }

  // score bar (relative to the top hit)
  const bar = el("div", "scorebar");
  const fill = el("div", "scorebar-fill");
  const pct = topScore > 0 ? Math.max(4, Math.round((r.finalScore / topScore) * 100)) : 0;
  fill.style.width = `${pct}%`;
  bar.append(fill);
  card.append(bar);

  const sources = el("div", "sources");
  if (r.retrieval.bm25) sources.append(el("span", "src src-bm25", `BM25 #${r.retrieval.bm25.rank}`));
  if (r.retrieval.vector) sources.append(el("span", "src src-vec", `vecteur #${r.retrieval.vector.rank}`));
  if (r.retrieval.rrf) sources.append(el("span", "src src-rrf", `RRF ${r.retrieval.rrf.score.toFixed(4)}`));
  if (r.reranking) sources.append(el("span", "src src-rerank", `${r.reranking.provider} ${r.reranking.score.toFixed(3)}`));
  card.append(sources);

  return card;
}

function renderPipeline(debug: DebugSearchResult): void {
  const box = els.pipeline;
  box.replaceChildren();

  const nq = debug.query.normalized;
  box.append(el("h2", "", "Pipeline (searchDebug)"));

  // normalized query
  const q1 = el("div", "pblock");
  q1.append(el("h3", "", "Requête normalisée"));
  q1.append(el("p", "mono", nq.normalized || "(vide)"));
  const prov = el("p", "small", `normalizer: ${nq.normalizerId} v${nq.normalizerVersion}`);
  q1.append(prov);
  box.append(q1);

  // corrections
  const q2 = el("div", "pblock");
  q2.append(el("h3", "", `Corrections (${nq.corrections.length})`));
  if (nq.corrections.length === 0) {
    q2.append(el("p", "small", "aucune"));
  } else {
    for (const c of nq.corrections) {
      const line = el("p", "corr");
      line.append(el("span", "from", c.from), el("span", "arrow", "→"), el("span", "to", c.to));
      line.append(el("span", "kind", `${CORRECTION_LABELS[c.kind] ?? c.kind}${c.rule ? ` · ${c.rule}` : ""}`));
      q2.append(line);
    }
  }
  box.append(q2);

  // extracted attributes + codes
  const attrEntries = Object.entries(nq.attributeValues);
  if (attrEntries.length > 0 || nq.codes.length > 0) {
    const q3 = el("div", "pblock");
    q3.append(el("h3", "", "Attributs & codes détectés"));
    const chips = el("div", "chips");
    for (const [k, v] of attrEntries) chips.append(el("span", "chip chip-attr", `${k}: ${v}`));
    for (const c of nq.codes) chips.append(el("span", "chip chip-code", c));
    q3.append(chips);
    box.append(q3);
  }

  // candidates
  const q4 = el("div", "pblock");
  q4.append(el("h3", "", "Candidats"));
  q4.append(
    el(
      "p",
      "small",
      `BM25: ${debug.retrieval.bm25.length} · vecteur: ${debug.retrieval.vector.length} · fusionnés: ${debug.retrieval.fused.length} · rerankés: ${debug.retrieval.candidateCount}`,
    ),
  );
  box.append(q4);

  // timings
  const q5 = el("div", "pblock");
  q5.append(el("h3", "", "Temps par étape"));
  const t = debug.timings;
  const rows: Array<[string, string]> = [
    ["normalisation", fmtMs(t.normalizationMs)],
    ["BM25", fmtMs(t.bm25Ms)],
    ["vecteur", fmtMs(t.vectorMs)],
    ["fusion RRF", fmtMs(t.fusionMs)],
    ["reranker", fmtMs(t.rerankerMs)],
    ["total", fmtMs(t.totalMs)],
  ];
  for (const [name, value] of rows) {
    const line = el("p", "trow");
    line.append(el("span", "", name), el("span", "mono", value));
    q5.append(line);
  }
  box.append(q5);

  // degradations
  const q6 = el("div", "pblock");
  q6.append(el("h3", "", `Dégradations (${debug.degradations.length})`));
  if (debug.degradations.length === 0) {
    q6.append(el("p", "small", "aucune — pipeline nominal"));
  } else {
    for (const d of debug.degradations) q6.append(el("p", "corr bad", `${d.stage}: ${d.message}`));
  }
  box.append(q6);
}

function renderEmpty(message: string): void {
  els.results.replaceChildren(el("p", "empty", message));
  els.pipeline.replaceChildren();
}

// ---------------------------------------------------------------- search

async function runSearch(rawQuery: string): Promise<void> {
  if (!system) return;
  const query = rawQuery.trim();
  if (query.length < 2) {
    renderEmpty("Tapez au moins 2 caractères…");
    return;
  }

  controller?.abort();
  controller = new AbortController();
  const token = controller;

  els.status.textContent = "recherche…";
  try {
    const debug = await system.engine.searchDebug(query, { limit: 8 });
    if (token.signal.aborted) return;

    els.status.textContent =
      debug.results.length > 0
        ? `${debug.results.length} résultats · ${debug.timings.totalMs.toFixed(1)} ms (cache: ${debug.cache.hit ? "hit" : "miss"})`
        : "aucun résultat";

    if (debug.results.length === 0) {
      renderEmpty(`Aucun produit pour « ${query} »`);
    } else {
      const topScore = debug.results[0]?.finalScore ?? 1;
      const frag = document.createDocumentFragment();
      for (const r of debug.results) frag.append(renderResult(r, topScore));
      els.results.replaceChildren(frag);
    }
    renderPipeline(debug);
  } catch (error) {
    if (token.signal.aborted) return;
    els.status.textContent = "erreur";
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    renderEmpty(`Erreur: ${message}`);
  }
}

function scheduleSearch(): void {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runSearch(els.input?.value ?? ""), 160);
}

// ---------------------------------------------------------------- boot

let system: Awaited<ReturnType<typeof buildDemoSystem>> | null = null;

async function main(): Promise<void> {
  system = await buildDemoSystem(products);

  for (const sample of SAMPLES) {
    const chip = el("button", "sample", sample);
    chip.addEventListener("click", () => {
      if (els.input) els.input.value = sample;
      void runSearch(sample);
    });
    els.samples.append(chip);
  }

  els.status.textContent = `prêt — ${system.documents} produits indexés en ${system.indexMs.toFixed(0)} ms`;
  els.footer.textContent =
    `Catalogue: ${system.documents} produits · indexation ${system.indexMs.toFixed(0)} ms · ` +
    `embedder ${system.config.embedding.provider} (${system.config.embedding.dimensions}d) · ` +
    `fusion RRF (k=${system.config.fusion.k}) · reranker noop · ` +
    `jeu d'évaluation: Recall@10 0.928, NDCG@10 0.985`;

  const input = els.input;
  if (input) {
    input.addEventListener("input", scheduleSearch);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        clearTimeout(debounceTimer);
        void runSearch(input.value);
      }
    });
    input.focus();
    // first query pre-filled so the demo works with zero clicks
    input.value = "tube 110 blnc";
    await runSearch("tube 110 blnc");
  }
}

void main();
