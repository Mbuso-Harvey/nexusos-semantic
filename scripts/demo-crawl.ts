/**
 * demo-crawl — integration smoke for the synthetic SaaS demo. Boots the
 * static server, opens a real BiDi session against it, navigates each page,
 * and writes a minimal Graph document. This is the first end-to-end check
 * that the contract substrate + the demo surface are compatible.
 */
import { BiDiSession } from "../src/bidi-client/session.js";
import { Page } from "../src/bidi-client/page.js";
import { Graph } from "../src/graph/graph.js";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEMO_PORT = 7311;
const DEMO_BASE = `http://127.0.0.1:${DEMO_PORT}`;
const PAGES = [
  "/index.html",
  "/projects.html",
  "/tickets.html",
  "/settings.html",
  "/docs.html",
  "/about.html",
];

async function main() {
  const g = new Graph();
  const session = await BiDiSession.create();
  const page = await session.newPage();

  console.log(`[demo-crawl] starting at ${new Date().toISOString()}`);
  const startedAt = new Date().toISOString();

  for (const path of PAGES) {
    const url = DEMO_BASE + path;
    console.log(`[demo-crawl] navigating ${url}`);
    await page.navigate(url);
    const title = await page.title;
    const finalUrl = await page.url;
    const html = await page.script.evaluate<string>({ context: page.context },
      "document.documentElement.outerHTML");
    const axCount = await page.script.evaluate<number>({ context: page.context },
      "document.querySelectorAll('[role],h1,h2,h3,button,a,input,nav,main,aside,dialog,[popover]').length");
    console.log(`[demo-crawl]   title="${title}" final=${finalUrl} axNodes~${axCount} html=${html.length}b`);

    // Page node (provenance: html)
    g.upsertPage({
      id: `page:${path}`,
      type: "page",
      url: finalUrl,
      title,
      discoveredVia: ["seed:demo"],
      loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:root", provenance: "html:crawl" },
      viewport: { w: 1280, h: 800, dpr: 1 },
      tokensOverride: null,
      screenshotRef: null,
      canonicalUrl: url,
      crawledAt: new Date().toISOString(), parentPageId: null,
    });
  }

  // Read the sidecar tokens (provenance: token-walk)
  const tokensUrl = `${DEMO_BASE}/design-tokens.json`;
  const tokensRes = await fetch(tokensUrl);
  const tokens = await tokensRes.json() as any;
  flattenTokens(tokens, g);
  console.log(`[demo-crawl] ingested ${g.tokenCount} design tokens from sidecar`);

  // Read the sidecar WebMCP capabilities (provenance: declared)
  const mcpRes = await fetch(`${DEMO_BASE}/webmcp.json`);
  const mcp = await mcpRes.json() as { tools: any[] };
  for (const t of mcp.tools) {
    g.upsertCapability({
      id: `cap:${t.name}`,
      type: "capability",
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      source: "webmcp",
      binding: t.binding,
      security: t.security,
      provenance: "declared:webmcp",
      pageId: pageForCapability(t.name, g),
    });
  }
  console.log(`[demo-crawl] ingested ${g.capabilityCount} capabilities from sidecar`);

  // Materialize + write
  const doc = g.toDocument({
    rootUrl: DEMO_BASE,
    startedAt,
    finishedAt: new Date().toISOString(),
    browser: { engine: "firefox", version: "154" },
    pages: g.pageCount,
    tokens: g.tokenCount,
  });
  const out = join(process.cwd(), "demo-crawl.json");
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.log(`[demo-crawl] wrote ${out} (${g.pageCount} pages, ${g.tokenCount} tokens, ${g.capabilityCount} capabilities)`);

  await page.close();
  await session.close();
}

function flattenTokens(node: any, g: Graph, path: string[] = []) {
  if (node && typeof node === "object" && "$value" in node) {
    g.upsertToken(path.join("."), {
      $value: node.$value,
      $type: node.$type,
      $description: node.$description,
      $extensions: node.$extensions,
    });
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      flattenTokens(v, g, [...path, k]);
    }
  }
}

function pageForCapability(toolName: string, g: Graph): string {
  // Heuristic binding: the sidecar declares the axId; the pageId is the first
  // page whose HTML contains the matching element. For this demo the tools
  // are bound to elements that appear on a specific page.
  const binding: Record<string, string> = {
    "create_ticket":     "page:/tickets.html",
    "search_docs":       "page:/index.html",
    "delete_workspace":  "page:/settings.html",
  };
  return binding[toolName] ?? g.pages().next().value?.id ?? "page:/index.html";
}

main().catch((e) => {
  console.error("[demo-crawl] FAILED", e);
  process.exit(1);
});
