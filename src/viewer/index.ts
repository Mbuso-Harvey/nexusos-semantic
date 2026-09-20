/**
 * awg-viewer — self-contained trace viewer server.
 *
 * Serves a crawl output directory (GraphStore layout) to a browser:
 *
 *   GET /             index.html (zero-CDN, single-file viewer page)
 *   GET /graph.json   the raw GraphDocument
 *   GET /summary.json the rendered viewer model (summarizeGraph)
 *   GET /trace.json   demo.trace.json (eval trace) when present, else 404
 *   GET /meta.json    crawl.cmeta.json when present, else 404
 *
 * Deliberately minimal — `node:http`, no dependencies, mirroring the
 * `demo/saas/server.cjs` pattern. The HTML page is read from disk next
 * to this module (`viewer.html`) so the heavy lifting stays in plain
 * browser JS over the JSON endpoints above.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphDocument } from "../graph/types.js";
import type { TraceFile } from "../eval/runner.js";
import { summarizeGraph } from "./summarize.js";

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "viewer.html");

export interface StartViewerOptions {
  graphDir: string;
  port?: number;
  host?: string;
}

export interface ViewerHandle {
  host: string;
  port: number;
  url: string;
  stop(): Promise<void>;
}

/** Easy JSON response with the right content-type and no-store. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Load a crawl-output directory's artifacts. graph.json is required;
 * demo.trace.json and crawl.cmeta.json are optional.
 */
async function loadArtifacts(graphDir: string): Promise<{
  doc: GraphDocument;
  trace: TraceFile | null;
  meta: unknown | null;
}> {
  const doc = JSON.parse(
    await readFile(join(graphDir, "graph.json"), "utf8"),
  ) as GraphDocument;

  let trace: TraceFile | null = null;
  try {
    trace = JSON.parse(await readFile(join(graphDir, "demo.trace.json"), "utf8")) as TraceFile;
  } catch { trace = null; }

  let meta: unknown | null = null;
  try {
    meta = JSON.parse(await readFile(join(graphDir, "crawl.cmeta.json"), "utf8"));
  } catch { meta = null; }

  return { doc, trace, meta };
}

export async function startViewer(opts: StartViewerOptions): Promise<ViewerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const html = await readFile(HTML_PATH, "utf8");

  // Read the graph once at startup so a missing graph.json fails fast
  // with a clear error instead of 404-ing every request.
  const artifacts = await loadArtifacts(opts.graphDir);

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    try {
      switch (url) {
        case "/":
        case "/index.html":
          sendText(res, 200, html);
          return;
        case "/graph.json":
          sendJson(res, 200, artifacts.doc);
          return;
        case "/summary.json":
          sendJson(res, 200, summarizeGraph(artifacts.doc));
          return;
        case "/trace.json":
          if (artifacts.trace) { sendJson(res, 200, artifacts.trace); return; }
          sendJson(res, 404, { error: "no demo.trace.json in this output dir" });
          return;
        case "/meta.json":
          if (artifacts.meta !== null) { sendJson(res, 200, artifacts.meta); return; }
          sendJson(res, 404, { error: "no crawl.cmeta.json in this output dir" });
          return;
        default:
          sendText(res, 404, "not found");
      }
    } catch (e) {
      sendJson(res, 500, { error: String((e as Error).message) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, resolve);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);

  return {
    host,
    port,
    url: `http://${host}:${port}/`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}