import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Smoke test of the SHIPPED demo artifact: executes the real minified bundle
 * extracted from docs/index.html against a minimal DOM stub. Verifies the
 * page boots (indexes the catalog), answers the pre-filled query and renders
 * results + pipeline — i.e. the file a user downloads actually works.
 */

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  value = "";
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  listeners: Array<[string, () => void]> = [];

  constructor(tag: string) {
    this.tagName = tag;
  }
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  appendChild(node: FakeElement): void {
    this.children.push(node);
  }
  replaceChildren(...nodes: FakeElement[]): void {
    this.children = [...nodes];
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.push([type, fn]);
  }
  focus(): void {}
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  text(): string {
    const own = this.textContent;
    const kids = this.children.map((c) => c.text()).join(" ");
    return [own, kids].filter(Boolean).join(" ");
  }
}

function buildDom(): { root: Record<string, FakeElement>; input: FakeElement } {
  const ids = ["q", "status", "samples", "results", "pipeline", "footer"];
  const registry: Record<string, FakeElement> = {};
  for (const id of ids) registry[id] = new FakeElement("div");
  const input = registry["q"]!;
  const doc = {
    getElementById: (id: string): FakeElement | null => registry[id] ?? null,
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    createDocumentFragment: (): FakeElement => new FakeElement("#fragment"),
  };
  (globalThis as Record<string, unknown>).document = doc;
  return { root: registry, input };
}

function extractBundle(html: string): string {
  const start = html.indexOf("<script>");
  const end = html.lastIndexOf("</script>");
  if (start < 0 || end < 0) throw new Error("no inline script found in docs/index.html");
  return html.slice(start + "<script>".length, end);
}

describe("demo page artifact (docs/index.html)", () => {
  it("boots, indexes the catalog and renders the first search", async () => {
    const page = fileURLToPath(new URL("../../docs/index.html", import.meta.url));
    const html = readFileSync(page, "utf8");
    const bundle = extractBundle(html);
    expect(bundle.length).toBeGreaterThan(10_000); // real bundle, not the marker

    const dom = buildDom();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(bundle)();

    // async main(): build system (indexes 200 products) + pre-filled search.
    // Poll until the first search has rendered (status settles on "N résultats").
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (dom.root["results"]!.children.length > 0 && dom.root["status"]!.text().includes("résultats")) break;
    }

    expect(dom.root["status"]!.text()).toMatch(/\d+ résultats · [\d.]+ ms/);
    const resultsText = dom.root["results"]!.text();
    expect(resultsText).toContain("Tube");
    expect(resultsText).toContain("TD110L4BL0");
    // pipeline panel rendered with corrections and timings
    const pipelineText = dom.root["pipeline"]!.text();
    expect(pipelineText).toContain("blnc");
    expect(pipelineText).toContain("blanc");
    expect(pipelineText).toContain("faute de frappe");
    expect(pipelineText).toContain("BM25");
    // footer stats (stable across searches — where the catalog size lives)
    expect(dom.root["footer"]!.text()).toContain("Catalogue: 200 produits");
    // sample query chips rendered
    expect(dom.root["samples"]!.children.length).toBe(6);
  }, 15_000);
});
