/**
 * SQLite Graph Store (Store v2) — durable relational storage for agent-web-graph.
 *
 * Uses Node.js native built-in `node:sqlite` (available in Node >= 22.5.0)
 * to provide high-performance, single-file relational storage (`graph.sqlite3`)
 * for massive web, desktop, and mobile crawls without external dependencies.
 */
import { createRequire } from "node:module";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Graph } from "../graph/graph.js";

const require = createRequire(import.meta.url);
export interface DatabaseSyncInstance {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: any[]): void;
    get(...params: any[]): any;
    all(...params: any[]): any[];
  };
  close(): void;
}

// Dynamic require for node:sqlite to bypass Vite's bundler resolver while utilizing Node 22+ built-in sqlite
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncInstance;
};
import type {
  GraphDocument,
  PageNode,
  AxNode,
  VisualNode,
  StateNode,
  Capability,
  NavElement,
  Edge,
  Transition,
  AuthContextNode,
} from "../graph/types.js";
import type { CrawlMeta } from "./store.js";

export interface SqliteStoreOptions {
  /** Optional custom filename inside outputDir (defaults to "graph.sqlite3"). */
  dbFilename?: string;
}

export class SqliteGraphStore {
  private readonly dbPath: string;

  constructor(
    public readonly outputDir: string,
    options?: SqliteStoreOptions,
  ) {
    const filename = options?.dbFilename ?? "graph.sqlite3";
    this.dbPath = join(outputDir, filename);
  }

  get databasePath(): string {
    return this.dbPath;
  }

  get metaPath(): string {
    return join(this.outputDir, "crawl.cmeta.json");
  }

  get tokensPath(): string {
    return join(this.outputDir, "design-tokens.json");
  }

  /** Initialize SQLite database schema and indices. */
  private initSchema(db: DatabaseSyncInstance): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crawl_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        root_url TEXT NOT NULL,
        browser_engine TEXT NOT NULL,
        browser_version TEXT NOT NULL,
        pages_count INTEGER NOT NULL,
        tokens_count INTEGER NOT NULL,
        diagnostics_json TEXT
      );

      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        canonical_url TEXT,
        title TEXT NOT NULL,
        discovered_via TEXT,
        load_status TEXT,
        ax_root_id TEXT,
        parent_page_id TEXT,
        crawled_at TEXT,
        viewport_w INTEGER,
        viewport_h INTEGER,
        viewport_dpr REAL,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(url);

      CREATE TABLE IF NOT EXISTS ax_nodes (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_ax_id TEXT,
        apg_pattern TEXT,
        focusable INTEGER,
        visibility TEXT,
        in_page_dom_order INTEGER,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ax_nodes_page ON ax_nodes(page_id);
      CREATE INDEX IF NOT EXISTS idx_ax_nodes_role ON ax_nodes(role);
      CREATE INDEX IF NOT EXISTS idx_ax_nodes_parent ON ax_nodes(parent_ax_id);

      CREATE TABLE IF NOT EXISTS visual_nodes (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL,
        ax_id TEXT NOT NULL,
        rect_x REAL,
        rect_y REAL,
        rect_w REAL,
        rect_h REAL,
        is_container INTEGER DEFAULT 0,
        container_type TEXT,
        is_scroll INTEGER DEFAULT 0,
        is_stacking INTEGER DEFAULT 0,
        is_occluded INTEGER DEFAULT 0,
        visible_ratio REAL DEFAULT 1.0,
        primary_pattern TEXT,
        has_tokens INTEGER DEFAULT 0,
        has_drifts INTEGER DEFAULT 0,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_visual_nodes_page ON visual_nodes(page_id);
      CREATE INDEX IF NOT EXISTS idx_visual_nodes_ax ON visual_nodes(ax_id);
      CREATE INDEX IF NOT EXISTS idx_visual_nodes_container ON visual_nodes(is_container);
      CREATE INDEX IF NOT EXISTS idx_visual_nodes_scroll ON visual_nodes(is_scroll);
      CREATE INDEX IF NOT EXISTS idx_visual_nodes_occluded ON visual_nodes(is_occluded);
      CREATE INDEX IF NOT EXISTS idx_visual_nodes_pattern ON visual_nodes(primary_pattern);
      CREATE INDEX IF NOT EXISTS idx_visual_nodes_tokens ON visual_nodes(has_tokens);
      CREATE INDEX IF NOT EXISTS idx_visual_nodes_drifts ON visual_nodes(has_drifts);

      CREATE TABLE IF NOT EXISTS nav_elements (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        container_ax_id TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nav_elements_page ON nav_elements(page_id);

      CREATE TABLE IF NOT EXISTS state_nodes (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL,
        auth_kind TEXT NOT NULL,
        network_kind TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_state_nodes_page ON state_nodes(page_id);

      CREATE TABLE IF NOT EXISTS auth_context_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        principal TEXT,
        role TEXT,
        session TEXT,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS capability_nodes (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL,
        name TEXT NOT NULL,
        security TEXT NOT NULL,
        ax_id TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_capabilities_page ON capability_nodes(page_id);
      CREATE INDEX IF NOT EXISTS idx_capabilities_name ON capability_nodes(name);

      CREATE TABLE IF NOT EXISTS transitions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        trigger TEXT NOT NULL,
        from_ax_id TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transitions_from ON transitions(from_ax_id);

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        page_id TEXT,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
      CREATE INDEX IF NOT EXISTS idx_edges_page ON edges(page_id);

      CREATE TABLE IF NOT EXISTS design_tokens (
        path TEXT PRIMARY KEY,
        raw_json TEXT NOT NULL
      );
    `);
  }

  /**
   * Save a Graph instance into the SQLite database file and write DTCG sidecar.
   */
  async save(
    g: Graph,
    crawlInfo: Omit<GraphDocument["crawl"], "pages" | "tokens">,
  ): Promise<GraphDocument> {
    await mkdir(this.outputDir, { recursive: true });
    const doc = g.toDocument({
      ...crawlInfo,
      pages: g.pageCount,
      tokens: g.tokenCount,
    });

    const db = new DatabaseSync(this.dbPath);
    try {
      this.initSchema(db);

      db.exec("BEGIN TRANSACTION;");

      const insertMeta = db.prepare(`
        INSERT OR REPLACE INTO crawl_meta (
          id, started_at, finished_at, root_url, browser_engine, browser_version, pages_count, tokens_count, diagnostics_json
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      insertMeta.run(
        crawlInfo.startedAt,
        crawlInfo.finishedAt,
        crawlInfo.rootUrl,
        crawlInfo.browser.engine,
        crawlInfo.browser.version,
        g.pageCount,
        g.tokenCount,
        doc.diagnostics ? JSON.stringify(doc.diagnostics) : null,
      );

      const insertPage = db.prepare(`
        INSERT OR REPLACE INTO pages (
          id, url, canonical_url, title, discovered_via, load_status,
          ax_root_id, parent_page_id, crawled_at, viewport_w, viewport_h, viewport_dpr, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      for (const p of doc.pages) {
        insertPage.run(
          p.id,
          p.url,
          p.canonicalUrl ?? null,
          p.title,
          JSON.stringify(p.discoveredVia ?? []),
          p.loadStatus,
          p.axTreeRef?.rootAxId ?? null,
          p.parentPageId ?? null,
          p.crawledAt ?? null,
          p.viewport?.w ?? null,
          p.viewport?.h ?? null,
          p.viewport?.dpr ?? null,
          JSON.stringify(p),
        );
      }

      const insertAx = db.prepare(`
        INSERT OR REPLACE INTO ax_nodes (
          id, page_id, role, name, parent_ax_id, apg_pattern, focusable, visibility, in_page_dom_order, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      for (const ax of doc.axNodes) {
        insertAx.run(
          ax.id,
          ax.pageId,
          ax.role,
          ax.name,
          ax.parentAxId ?? null,
          ax.apgPattern ?? null,
          ax.focusable ? 1 : 0,
          ax.visibility ?? null,
          ax.inPageDomOrder ?? null,
          JSON.stringify(ax),
        );
      }

      const insertVisual = db.prepare(`
        INSERT OR REPLACE INTO visual_nodes (
          id, page_id, ax_id, rect_x, rect_y, rect_w, rect_h, is_container, container_type, is_scroll, is_stacking, is_occluded, visible_ratio, primary_pattern, has_tokens, has_drifts, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      for (const v of doc.visualNodes) {
        insertVisual.run(
          v.id,
          v.pageId,
          v.axId,
          v.rect?.x ?? null,
          v.rect?.y ?? null,
          v.rect?.w ?? null,
          v.rect?.h ?? null,
          v.isVisualContainer ? 1 : 0,
          v.containerType ?? null,
          v.scrollClippingContext?.isScrollContainer ? 1 : 0,
          v.stackingContext?.isStackingContext ? 1 : 0,
          v.occlusion?.isOccluded ? 1 : 0,
          v.occlusion?.visibleRatio ?? 1.0,
          v.primaryPattern ?? null,
          (v.designTokenBindings && v.designTokenBindings.length > 0) ? 1 : 0,
          (v.tokenDrifts && v.tokenDrifts.length > 0) ? 1 : 0,
          JSON.stringify(v),
        );
      }
      const insertNav = db.prepare(`
        INSERT OR REPLACE INTO nav_elements (
          id, page_id, kind, container_ax_id, raw_json
        ) VALUES (?, ?, ?, ?, ?);
      `);
      for (const n of doc.navElements ?? []) {
        insertNav.run(
          n.id,
          n.pageId,
          n.kind,
          n.containerAxId,
          JSON.stringify(n),
        );
      }

      const insertState = db.prepare(`
        INSERT OR REPLACE INTO state_nodes (
          id, page_id, auth_kind, network_kind, raw_json
        ) VALUES (?, ?, ?, ?, ?);
      `);
      for (const s of doc.states ?? []) {
        insertState.run(
          s.id,
          s.pageId,
          s.authContext?.kind ?? "anonymous",
          s.networkContext?.evidence ?? "static",
          JSON.stringify(s),
        );
      }

      const insertAuthCtx = db.prepare(`
        INSERT OR REPLACE INTO auth_context_nodes (
          id, kind, principal, role, session, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?);
      `);
      for (const a of doc.authContexts ?? []) {
        insertAuthCtx.run(
          a.id,
          a.context.kind,
          "principal" in a.context ? a.context.principal : null,
          "role" in a.context ? (a.context as any).role : null,
          "session" in a.context ? (a.context as any).session : null,
          JSON.stringify(a),
        );
      }

      const insertCap = db.prepare(`
        INSERT OR REPLACE INTO capability_nodes (
          id, page_id, name, security, ax_id, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?);
      `);
      for (const c of doc.capabilities) {
        insertCap.run(
          c.id,
          c.pageId,
          c.name,
          c.security,
          c.binding.axId,
          JSON.stringify(c),
        );
      }

      const insertTrans = db.prepare(`
        INSERT OR REPLACE INTO transitions (
          id, kind, trigger, from_ax_id, raw_json
        ) VALUES (?, ?, ?, ?, ?);
      `);
      for (const t of doc.transitions ?? []) {
        insertTrans.run(
          t.id,
          t.kind,
          t.trigger,
          t.fromAxId,
          JSON.stringify(t),
        );
      }

      db.exec("DELETE FROM edges;");
      const insertEdge = db.prepare(`
        INSERT INTO edges (from_id, to_id, kind, page_id, raw_json)
        VALUES (?, ?, ?, ?, ?);
      `);
      for (const e of doc.edges) {
        insertEdge.run(
          e.from,
          e.to,
          e.kind,
          "pageId" in e ? (e as any).pageId : null,
          JSON.stringify(e),
        );
      }

      db.exec("DELETE FROM design_tokens;");
      const insertToken = db.prepare(`
        INSERT INTO design_tokens (path, raw_json)
        VALUES (?, ?);
      `);
      for (const [path, token] of iterateTokensMap(doc.designTokens, "")) {
        insertToken.run(path, JSON.stringify(token));
      }

      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    } finally {
      db.close();
    }

    await writeFile(this.tokensPath, JSON.stringify(doc.designTokens, null, 2), "utf8");

    const meta: CrawlMeta = {
      startedAt: crawlInfo.startedAt,
      finishedAt: crawlInfo.finishedAt,
      rootUrl: crawlInfo.rootUrl,
      browser: { ...crawlInfo.browser },
      pageHashes: {},
      frontierHash: "",
    };
    await writeFile(this.metaPath, JSON.stringify(meta, null, 2), "utf8");

    return doc;
  }
  /**
   * Reconstruct a Graph from the SQLite database file.
   */
  async load(): Promise<Graph> {
    if (!existsSync(this.dbPath)) {
      throw new Error(`SQLite database not found at: ${this.dbPath}`);
    }

    const db = new DatabaseSync(this.dbPath);
    try {
      const g = new Graph();

      const pages = db.prepare("SELECT raw_json FROM pages ORDER BY id ASC").all() as Array<{ raw_json: string }>;
      for (const row of pages) {
        g.upsertPage(JSON.parse(row.raw_json) as PageNode);
      }

      const axNodes = db.prepare("SELECT raw_json FROM ax_nodes ORDER BY in_page_dom_order ASC").all() as Array<{ raw_json: string }>;
      for (const row of axNodes) {
        g.upsertAx(JSON.parse(row.raw_json) as AxNode);
      }

      const visualNodes = db.prepare("SELECT raw_json FROM visual_nodes ORDER BY id ASC").all() as Array<{ raw_json: string }>;
      for (const row of visualNodes) {
        g.upsertVisual(JSON.parse(row.raw_json) as VisualNode);
      }

      const navElements = db.prepare("SELECT raw_json FROM nav_elements ORDER BY id ASC").all() as Array<{ raw_json: string }>;
      for (const row of navElements) {
        g.upsertNavElement(JSON.parse(row.raw_json) as NavElement);
      }

      const authContexts = db.prepare("SELECT raw_json FROM auth_context_nodes ORDER BY id ASC").all() as Array<{ raw_json: string }>;
      for (const row of authContexts) {
        g.upsertAuthContext(JSON.parse(row.raw_json) as AuthContextNode);
      }

      const stateNodes = db.prepare("SELECT raw_json FROM state_nodes ORDER BY id ASC").all() as Array<{ raw_json: string }>;
      for (const row of stateNodes) {
        g.upsertState(JSON.parse(row.raw_json) as StateNode);
      }

      const capabilities = db.prepare("SELECT raw_json FROM capability_nodes ORDER BY id ASC").all() as Array<{ raw_json: string }>;
      for (const row of capabilities) {
        g.upsertCapability(JSON.parse(row.raw_json) as Capability);
      }

      const transitions = db.prepare("SELECT raw_json FROM transitions ORDER BY id ASC").all() as Array<{ raw_json: string }>;
      for (const row of transitions) {
        g.upsertTransition(JSON.parse(row.raw_json) as Transition);
      }

      const edges = db.prepare("SELECT raw_json FROM edges ORDER BY id ASC").all() as Array<{ raw_json: string }>;
      for (const row of edges) {
        g.upsertEdge(JSON.parse(row.raw_json) as Edge);
      }

      const tokens = db.prepare("SELECT path, raw_json FROM design_tokens").all() as Array<{ path: string; raw_json: string }>;
      for (const t of tokens) {
        g.upsertToken(t.path, JSON.parse(t.raw_json));
      }

      const metaRow = db.prepare("SELECT diagnostics_json FROM crawl_meta WHERE id = 1").get() as { diagnostics_json?: string } | undefined;
      if (metaRow?.diagnostics_json) {
        g.setDiagnostics(JSON.parse(metaRow.diagnostics_json));
      }

      return g;
    } finally {
      db.close();
    }
  }

  /** Check if the SQLite database file exists. */
  async exists(): Promise<boolean> {
    return existsSync(this.dbPath);
  }

  /** Read crawl meta from the SQLite database or fallback to meta JSON. */
  async readMeta(): Promise<CrawlMeta | null> {
    if (!existsSync(this.dbPath)) return null;

    const db = new DatabaseSync(this.dbPath);
    try {
      const row = db.prepare(`
        SELECT started_at, finished_at, root_url, browser_engine, browser_version
        FROM crawl_meta WHERE id = 1;
      `).get() as {
        started_at: string;
        finished_at: string;
        root_url: string;
        browser_engine: string;
        browser_version: string;
      } | undefined;

      if (!row) return null;
      return {
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        rootUrl: row.root_url,
        browser: { engine: row.browser_engine, version: row.browser_version },
        pageHashes: {},
        frontierHash: "",
      };
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  /** Directly query AxNodes by role from the SQLite store. */
  queryAxNodesByRole(role: string): AxNode[] {
    if (!existsSync(this.dbPath)) return [];
    const db = new DatabaseSync(this.dbPath);
    try {
      const rows = db.prepare("SELECT raw_json FROM ax_nodes WHERE role = ?").all(role) as Array<{ raw_json: string }>;
      return rows.map((r) => JSON.parse(r.raw_json) as AxNode);
    } finally {
      db.close();
    }
  }

  /** Directly query Edges by kind from the SQLite store. */
  queryEdgesByKind(kind: string): Edge[] {
    if (!existsSync(this.dbPath)) return [];
    const db = new DatabaseSync(this.dbPath);
    try {
      const rows = db.prepare("SELECT raw_json FROM edges WHERE kind = ?").all(kind) as Array<{ raw_json: string }>;
      return rows.map((e) => JSON.parse(e.raw_json) as Edge);
    } finally {
      db.close();
    }
  }
}

function* iterateTokensMap(node: any, prefix: string): Generator<[string, { $value: any; $type: any; $description?: string; $extensions?: any }]> {
  if (!node || typeof node !== "object") return;
  if ("$value" in node && "$type" in node) {
    yield [prefix, node];
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("$")) continue;
    const next = prefix ? `${prefix}.${k}` : k;
    yield* iterateTokensMap(v, next);
  }
}


