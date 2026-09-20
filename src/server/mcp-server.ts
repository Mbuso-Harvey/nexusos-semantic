/**
 * MCP-native server — the public face of Nexus over the official Model
 * Context Protocol stdio transport. Real MCP clients (Claude Desktop,
 * Claude Code, any MCP-speaking agent) speak this protocol directly.
 *
 * This is the public face of the server. v1 transport is stdio (the MCP
 * standard); v2 adds streamable-HTTP for hosted deployments. The TCP/JSON-RPC
 * server in `server.ts` remains for in-process tests and ad-hoc scripting.
 *
 * Tool surface: 18 tools by default — 6 core graph tools + `substrate_info`
 * (R2 provenance) + `graph_diagnostics` + 10 visual/token tools. Opt-in
 * substrates extend the surface to 33: desktop UIA (+3), chrome/CDP (+6),
 * mobile ADB (+3), async crawl jobs (+3, `--allow-crawl`). Core:
 *   graph.query    — find nodes by where-clause
 *   graph.path     — graph-traversal surface (children | parent | descendants
 *                    | ancestors | path) per ED-04 / user decision 2026-08-30
 *   graph.tool     — list capabilities
 *   graph.act      — invoke a capability (decision only in v1; `graph_invoke`
 *                    is the execute path)
 *   graph.explain  — neighborhood walk + provenance
 *   graph.invoke   — execute a capability on the live session (ED-02)
 *   graph.diagnostics — extraction health + substrate status
 *
 * Crawl is deliberately NOT an MCP tool (minutes-long, browser-bound): it is a
 * job via the CLI/library (`nexus crawl`). R5 may add async `crawl_start`.
 *
 * Each tool has a zod input schema and a zod output schema. The MCP SDK
 * validates inputs on the way in and surfaces a structured error to the
 * client if validation fails.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Graph } from "../graph/graph.js";
import { query, type WhereClause, type SelectKind } from "../graph/query.js";
import { findPath, findStatePath, relate, listTools, prepareAct, explain, type TraversalRelation } from "../graph/tools.js";
import { decide } from "../graph/security.js";
import type { EdgeKind } from "../graph/types.js";
import { diffPageVisualRegression } from "../extract-visual/index.js";
import { invokeCapability, type InvokeRequest, type InvokeResult } from "./invoke.js";
import { CrawlJobManager, CrawlJobError } from "../crawler/jobs.js";
import { NEXUS_VERSION } from "../version.js";
import {
  enforcementActor,
  withToolEnforcement,
  type EnforcementAdapterOptions,
} from "./enforcement.js";
import { configureEnforcementFromEnv } from "../security/index.js";
import { assertGraphHashBinding } from "../store/index.js";
import type { BidiContext } from "./server.js";
import { WindowsUiaDaemon } from "../desktop/windows/uia-daemon.js";
import { ChromeCdpClient, launchChromeWithDebug, type ChromeCdpOptions } from "../desktop/chrome-cdp.js";
import { AndroidClient } from "../mobile/android/uia2-client.js";
import { MobileSubstrateSurface } from "../substrate/mobile-surface.js";

// SecurityTier is a string-literal type, not a runtime enum. Mirror the
// values here so zod can validate at the wire.
const SECURITY_TIERS = ["DISCOVER", "READ", "PROPOSE", "EXECUTE", "CONFIRM"] as const;

// ---- zod schemas mirroring the graph types ----

const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

const AxRoleSchema = z.string(); // plan: open string union; allow extensions

const InTetherSchema = z.object({
  axId: z.string(),
  relation: z.enum(["children", "siblings", "parent", "anchors"]),
});

// RegExp is a first-class value in our query DSL (it serializes to a real
// regex on the JS side), but JSON Schema can't represent it. On the wire
// we accept a string and parse it as a regex; the agent caller is expected
// to send a regex-like pattern. The "string OR regex" semantics collapse to
// "string" at the wire and the server side re-wraps as RegExp.
const StringOrRegexSchema = z.union([
  z.string(),
  z.object({ source: z.string(), flags: z.string().optional() }).transform(
    (o) => new RegExp(o.source, o.flags),
  ),
]);

const WhereSchema: z.ZodType<WhereClause> = z.object({
  pageUrl: StringOrRegexSchema.optional(),
  role: z.union([AxRoleSchema, z.array(AxRoleSchema)]).optional(),
  name: StringOrRegexSchema.optional(),
  state: z.record(z.string(), z.any()).optional(),
  hasCapability: z.string().optional(),
  designToken: z.string().optional(),
  inTether: InTetherSchema.optional(),
  withinViewport: RectSchema.optional(),
  reachableFrom: z.object({
    axId: z.string(),
    via: z.array(z.string()).optional(),
    maxHops: z.number().int().positive().optional(),
  }).optional(),
  visualStyle: z.record(z.string(), z.string()).optional()
    .describe("Match VisualNode by computedStyle key/value pairs (e.g. { position: 'sticky' })"),
  // VI-01: Multi-viewport predicates.
  viewport: z.union([
    z.string(),
    z.object({
      w: z.number().optional(),
      h: z.number().optional(),
      dpr: z.number().optional(),
    }),
  ]).optional().describe("VI-01: match VisualNode or AxNode by viewport profile name (e.g. 'desktop', 'mobile') or dimensions"),
  visualHiddenAtViewport: z.string().optional()
    .describe("VI-01: match VisualNode or AxNode that becomes hidden at a specific viewport (e.g. 'mobile')"),
  // VI-02: Layout box evidence predicates.
  isVisualContainer: z.boolean().optional()
    .describe("VI-02: match visual containers / layout wrappers (hero, grid, flex, card, section, scroll, container)"),
  containerType: z.union([
    z.enum(["hero", "grid", "flex", "card", "section", "scroll", "container", "wrapper", "none"]),
    z.array(z.enum(["hero", "grid", "flex", "card", "section", "scroll", "container", "wrapper", "none"])),
  ]).optional()
    .describe("VI-02: match visual containers by classified containerType"),
  isScrollContainer: z.boolean().optional()
    .describe("VI-02: match scroll containers (isScrollContainer === true/false)"),
  isStackingContext: z.boolean().optional()
    .describe("VI-02: match stacking contexts (isStackingContext === true/false)"),
  hasTransform: z.boolean().optional()
    .describe("VI-02: match elements with CSS transforms (hasTransform === true/false)"),
  boxSizing: z.string().optional()
    .describe("VI-02: match elements by box-sizing mode ('border-box' | 'content-box')"),
  // VI-03: Occlusion and clipping predicates.
  isOccluded: z.boolean().optional()
    .describe("VI-03: match elements that are occluded (visibleRatio < 0.5 or covered by other elements)"),
  minVisibleRatio: z.number().min(0).max(1).optional()
    .describe("VI-03: match elements with visibleRatio >= minVisibleRatio (0.0 to 1.0)"),
  maxVisibleRatio: z.number().min(0).max(1).optional()
    .describe("VI-03: match elements with visibleRatio <= maxVisibleRatio (0.0 to 1.0)"),
  isOffscreen: z.boolean().optional()
    .describe("VI-03: match elements that are offscreen / outside viewport bounds"),
  // VI-04: Semantic visual pattern predicates.
  visualPattern: z.union([
    z.enum([
      "fab", "modal-backdrop", "dialog-overlay", "sticky-header",
      "sticky-footer", "dismiss-button", "form-group", "toast-notification",
    ]),
    z.array(
      z.enum([
        "fab", "modal-backdrop", "dialog-overlay", "sticky-header",
        "sticky-footer", "dismiss-button", "form-group", "toast-notification",
      ]),
    ),
  ]).optional()
    .describe("VI-04: match semantic visual patterns (fab, modal-backdrop, sticky-header, sticky-footer, dismiss-button, form-group, toast-notification)"),
  hasPattern: z.boolean().optional()
    .describe("VI-04: match elements having any detected semantic visual pattern"),
  isFab: z.boolean().optional()
    .describe("VI-04: match floating action buttons"),
  isModalBackdrop: z.boolean().optional()
    .describe("VI-04: match modal backdrops"),
  isStickyHeader: z.boolean().optional()
    .describe("VI-04: match sticky headers"),
  isStickyFooter: z.boolean().optional()
    .describe("VI-04: match sticky footers"),
  isDismissButton: z.boolean().optional()
    .describe("VI-04: match dismiss/close buttons"),
  isFormGroup: z.boolean().optional()
    .describe("VI-04: match form groupings"),
  // PR-8a: NavElement predicates.
  navKind: z.union([
    z.enum(["menu", "menubar", "tablist", "tab", "breadcrumb", "nav-link-set"]),
    z.array(z.enum(["menu", "menubar", "tablist", "tab", "breadcrumb", "nav-link-set"])),
  ]).optional()
    .describe("PR-8a: match NavElement by kind (e.g. 'menu', 'tablist', 'breadcrumb')."),
  navInPage: z.string().optional()
    .describe("PR-8a: match NavElements by pageId (`page:<canonicalUrl>`)."),
  // PR-8: StateNode predicates.
  stateOnPage: z.string().optional()
    .describe("PR-8: match StateNodes by pageId (`page:<canonicalUrl>`)."),
  stateAuthKind: z.enum([
    "anonymous", "authenticated", "administrator", "custom-role",
  ]).optional()
    .describe("PR-8: match StateNodes by AuthContext kind."),
  stateNetworkEvidence: z.enum([
    "bidi:network", "page-instrumented", "static",
  ]).optional()
    .describe("PR-8: match StateNodes by the network-evidence kind at observation time."),
  stateHasOpenDialog: z.string().optional()
    .describe("PR-8: match StateNodes whose `payload.openDialogIds` includes this id."),
  stateHasOpenPopover: z.string().optional()
    .describe("PR-8: match StateNodes whose `payload.openPopoverIds` includes this id."),
  stateRoute: StringOrRegexSchema.optional()
    .describe("PR-8: match StateNodes by `payload.route` (the canonical route at observation time)."),
});

const SelectKindSchema = z.enum([
  "page", "ax-node", "visual-node", "edge", "capability", "transition", "nav-element", "state", "any",
]);

// ---- server factory ----

export interface McpServerOptions {
  /** Name + version reported during the MCP initialize handshake. */
  name?: string;
  version?: string;
  /**
   * ED-02 / PR-9: BiDi session + Page the server owns for the
   * lifetime of the MCP connection. When present, the
   * `graph_invoke` MCP tool routes through `invokeCapability`
   * and performs the action on the live page. When absent,
   * `graph_invoke` returns a clear "no BiDi session attached"
   * error so offline / no-geckodriver use gets a deterministic
   * result.
   */
  bidi?: BidiContext;
  /**
   * §10–§12 enforcement: every MCP tool call is classified by the
   * `EnforcementRegistry` and routed through the `EnforcementGateway`. Pass an
   * explicit gateway/actor when embedding the server; the default is the
   * process-wide fail-closed gateway with an `mcp-client` actor.
   */
  enforcement?: EnforcementAdapterOptions;
  /**
   * Phase D3: Desktop UIA Daemon for native OS window scraping
   * and kinetic dispatch.
   */
  desktop?: boolean | WindowsUiaDaemon;
  /**
   * Phase M3: Mobile ADB/UIAutomator2 Client for mobile device
   * scraping and kinetic touch dispatch.
   */
  mobile?: boolean | AndroidClient;
  /**
   * Phase D4: Chrome DevTools Protocol attachment. When truthy, exposes
   * CDP tools (chrome_targets, chrome_read_tab, chrome_snapshot_tab,
   * chrome_get_cookies, chrome_navigate, chrome_launch) so agents can
   * read page DOM/storage/cookies of ALREADY-AUTHENTICATED Chrome tabs.
   * Pass `true` for defaults (port 9222) or a ChromeCdpOptions object.
   */
  chrome?: boolean | ChromeCdpOptions;
  /**
   * R5: async substrate production. When truthy, exposes crawl_start /
   * crawl_status / crawl_cancel so an agent can trigger a crawl as a
   * background job and receive a `{jobId, outputDir, graphHash, ...}`
   * handle. Opt-in (fail closed): producing a substrate is an
   * impact-`modify` act, gated by the enforcement gateway as the `crawl`
   * operation, and the CLI only enables it with `--allow-crawl`.
   * Pass `true` for a fresh manager or an explicit CrawlJobManager.
   */
  crawlJobs?: boolean | CrawlJobManager;
}

export function buildMcpServer(graph: Graph, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: opts.name ?? "agent-web-graph", version: opts.version ?? NEXUS_VERSION },
    { capabilities: { tools: {} } },
  );
  // §10: enforcement sits below the transport. Every tool registered from here
  // on is classified + gated by the gateway before its handler can run.
  withToolEnforcement(server, {
    ...opts.enforcement,
    actor:
      opts.enforcement?.actor ??
      enforcementActor({ id: "mcp-client", name: "MCP Client", type: "agent" }),
  });
  const bidi = opts.bidi ?? null;

  // graph.query
  server.registerTool(
    "graph_query",
    {
      title: "Graph query",
      description: "Find nodes in the graph by where-clause (role, name, pageUrl, state, inTether, withinViewport, reachableFrom).",
      inputSchema: {
        select: SelectKindSchema.describe("Which node kind to return"),
        where: WhereSchema.optional(),
        limit: z.number().int().positive().max(1000).optional().describe("Max hits to return (default 50)"),
      },
    },
    async (args) => {
      const result = query(graph, {
        select: args.select as SelectKind,
        where: args.where as WhereClause,
        limit: args.limit,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  // graph.path
  // Per ED-04 + user surface decision 2026-08-30: this tool owns graph
  // traversal. Pass a `relation` (children | parent | descendants |
  // ancestors | path) to enumerate neighbors. When `relation` is absent
  // (or "path") the tool falls back to the original shortest-path BFS,
  // which requires `to` and may use `via` and `maxHops`.
  //
  // The `target` field (PR-7 / ED-03) picks the node kind the traversal
  // operates on. Default is "ax-node" (the PR-6 behavior); "page" walks
  // the navigation hierarchy using nav:child-of edges + PageNode.parentPageId;
  // "state" (PR-8) walks the Interaction/State Graph using state:successor
  // edges. The target is also inferred from the `from` id prefix: ids
  // starting with "page:" are treated as page-level, "state:" as state-
  // level, everything else as ax-node.
  //
  // PR-8a adds four page-level Layer 1 relations: `nav-links`
  // (page-to-page navigation), `breadcrumbs` (the breadcrumb items
  // in trail order), `menu` (the members of a menu / menubar /
  // tablist NavElement), and `tab-of` (the tablist NavElement that
  // contains a given tab axId). These four are dispatched through
  // the page-level traversal regardless of the `from` id prefix.
  //
  // PR-8 adds three state-level relations: `successors` (1-hop
  // outgoing state:successor), `predecessors` (1-hop incoming), and
  // `reachable` (bounded BFS over state:successor). The state target
  // is a directed reachability graph, not a tree, so `children`,
  // `parent`, `descendants`, and `ancestors` are rejected.
  server.registerTool(
    "graph_path",
    {
      title: "Graph traversal surface (ED-04 + ED-03 + PR-8a + PR-8)",
      description: "Traverse the graph from `from`. Without a `relation`, runs a shortest-path BFS to `to`. With `relation`, enumerates neighbors: 'children' (immediate), 'parent' (the single parent), 'descendants' (bounded BFS, default depth 5, max 20), 'ancestors' (bounded reverse BFS), or 'path' (explicit shortest-path). The `target` field picks the node kind: 'ax-node' walks the a11y tree (a11y:child-of edges), 'page' walks the navigation hierarchy (nav:child-of edges), 'state' walks the Interaction/State Graph (state:successor edges). Default is inferred from the `from` id prefix. PR-8a adds four page-level relations: 'nav-links' (pages reachable from a source page via nav-link edges), 'breadcrumbs' (breadcrumb items in trail order from a container axId), 'menu' (members of a menu/menubar/tablist NavElement from the container axId), and 'tab-of' (the tablist NavElement that contains a tab axId). PR-8 adds three state-level relations: 'successors' (1-hop outgoing state:successor), 'predecessors' (1-hop incoming), 'reachable' (bounded BFS).",
      inputSchema: {
        from: z.string().describe("Source node id. When target is 'ax-node' (default), this is an axId; when target is 'page', this is a pageId; when target is 'state' (PR-8), this is a stateId. For PR-8a relations, the `from` is a pageId (nav-links) or an axId (breadcrumbs / menu / tab-of)."),
        target: z.enum(["ax-node", "page", "state"]).optional()
          .describe("Node kind to traverse. Default: 'ax-node' (or inferred from the `from` id prefix). PR-8a nav-level relations are dispatched through the page-level path regardless."),
        relation: z.enum([
          "children", "parent", "descendants", "ancestors", "path",
          "nav-links", "breadcrumbs", "menu", "tab-of",
          "successors", "predecessors", "reachable",
        ]).optional()
          .describe("Traversal relation (default: shortest-path to `to`). The four PR-8a relations are page-level Layer 1 relations; the three PR-8 relations (successors / predecessors / reachable) are state-level. Note: children / parent / descendants / ancestors are tree-style and are rejected when target is 'state'."),
        to: z.string().optional().describe("Target node id (required for path/shortest-path; same kind as `from`)"),
        via: z.array(z.string()).optional().describe("Restrict traversal to these edge kinds (path only)"),
        maxHops: z.number().int().positive().max(50).optional().describe("Max BFS depth (path only; default 5)"),
        depth: z.number().int().positive().max(20).optional().describe("Bounded depth for descendants/ancestors (default 5, max 20)"),
      },
    },
    async (args) => {
      if (args.relation && args.relation !== "path") {
        // Enumeration mode. `to` is not used; the start node is `from`.
        const result = relate(graph, args.from, args.relation as TraversalRelation, {
          depth: args.depth,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      // Shortest-path mode: `to` is required.
      if (!args.to) {
        return { isError: true, content: [{ type: "text", text: "graph.path: `to` is required for the shortest-path mode" }] };
      }
      // PR-8: dispatch by inferred target. The state target uses
      // findStatePath which walks state:successor edges (findPath
      // calls g.getAx which returns undefined for state ids).
      const fromIsState = args.from.startsWith("state:");
      if (fromIsState) {
        const result = findStatePath(graph, args.from, args.to, { maxHops: args.maxHops });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      const result = findPath(graph, args.from, args.to, { via: args.via as EdgeKind[] | undefined, maxHops: args.maxHops });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  // graph.tool (capability discovery)
  server.registerTool(
    "graph_tool",
    {
      title: "List capabilities",
      description: "List WebMCP-shaped capabilities, optionally filtered by page, name, and security tier ceiling.",
      inputSchema: {
        pageId: z.string().optional(),
        pageUrl: StringOrRegexSchema.optional(),
        name: StringOrRegexSchema.optional(),
        securityAtMost: z.enum(SECURITY_TIERS).optional(),
      },
    },
    async (args) => {
      const result = listTools(graph, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  // graph.act (decision-only, v1 alias)
  // ED-02 / PR-9: `graph.act` is the backward-compat decision-only
  // surface. It returns the same `ActResult` shape (decision +
  // binding) and does NOT execute the action. The new
  // `graph_invoke` tool is the execute path.
  server.registerTool(
    "graph_act",
    {
      title: "Invoke a capability (decision only — ED-02 alias)",
      description: "Returns the security-tier decision. The server does NOT execute the action via this tool; use `graph_invoke` for the execute path. Pre-PR-9 clients keep working unchanged.",
      inputSchema: {
        capabilityId: z.string().describe("cap:<name>:<n>"),
        input: z.record(z.string(), z.any()).optional(),
        confirm: z.boolean().optional().describe("Required when the capability tier is CONFIRM"),
      },
    },
    async (args) => {
      const result = prepareAct(graph, {
        capabilityId: args.capabilityId,
        input: args.input ?? {},
        confirm: args.confirm,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  // graph.invoke (execute path — ED-02 / PR-9)
  // This is the new surface that closes the ED-02 gap: the server
  // owns the BiDi session, runs the security gate, and (when the
  // decision is ok) fires the action on the live page. The result
  // is a structured `InvokeResult` (decision + binding + observe
  // block with post-action URL, elapsedMs, and optional screenshot
  // base64). The MCP tool returns the result as JSON text.
  //
  // When the server was constructed without a `bidi` option
  // (offline / no-geckodriver), the call returns a clean
  // `isError: true` response with a "no BiDi session attached"
  // message rather than hanging.
  server.registerTool(
    "graph_invoke",
    {
      title: "Invoke a capability on the live page (ED-02 / PR-9)",
      description: "Gate + execute. The server owns the BiDi session for the lifetime of the MCP connection. The security tier gate runs first; CONFIRM capabilities require `confirm: true`. On success, returns the binding, the decision, and an `observe` block with the post-action URL, elapsedMs, and (when `evidence: true`) a base64 screenshot. Use `execute: false` for a dry-run that returns the decision + binding without firing any action.",
      inputSchema: {
        capabilityId: z.string().describe("cap:<name>:<n>"),
        input: z.record(z.string(), z.any()).optional().describe("For textbox/searchbox/combobox, the `text` field is the string to type. Other roles ignore this field."),
        confirm: z.boolean().optional().describe("Required when the capability tier is CONFIRM"),
        execute: z.boolean().optional().describe("When false, return the decision + binding without firing any BiDi action (dry-run). Default true."),
        evidence: z.boolean().optional().describe("When true, capture a post-action screenshot and include the base64 in `observe.screenshotRef`. Default false."),
      },
    },
    async (args) => {
      if (!bidi) {
        return {
          isError: true,
          content: [{ type: "text", text: "graph_invoke: no BiDi session attached — server was started without a `bidi` option; the ED-02 execute path requires a live geckodriver" }],
        };
      }
      const invokeReq: InvokeRequest = {
        capabilityId: args.capabilityId,
        input: args.input ?? {},
        confirm: args.confirm,
        execute: args.execute,
        evidence: args.evidence,
      };
      const result: InvokeResult = await invokeCapability(graph, bidi.page, invokeReq);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  // Read a fresh, bounded snapshot from the attached page. The selector is
  // passed as a BiDi argument to a fixed function; callers cannot supply
  // executable JavaScript through this read-only surface.
  if (bidi) {
    server.registerTool(
      "graph_live_read",
      {
        title: "Read live page and element state",
        description: "Optionally navigate the attached BiDi page, then re-resolve a CSS selector and return bounded document and element state without accepting JavaScript expressions.",
        inputSchema: {
          pageUrl: z.string().url().optional().describe("Optional canonical URL already present in the loaded graph; arbitrary navigation is rejected"),
          selector: z.string().min(1).max(1024).describe("CSS selector to re-resolve on the live page"),
        },
      },
      async (args) => {
        try {
          if (args.pageUrl) {
            const target = Array.from(graph.pages()).find((page) => page.canonicalUrl === args.pageUrl);
            if (!target) throw new Error("pageUrl is not present in the loaded graph");
            const protocol = new URL(target.canonicalUrl).protocol;
            if (protocol !== "http:" && protocol !== "https:") {
              throw new Error("only graph-approved HTTP(S) pages may be read live");
            }
            if (await bidi.page.url !== target.canonicalUrl) {
              await bidi.page.navigate(target.canonicalUrl);
            }
          }
          const result = await bidi.page.script.callFunction<{
            url: string;
            title: string;
            document: { theme: string | null; openDialogIds: string[] };
            element: {
              found: boolean;
              tag: string | null;
              id: string | null;
              role: string | null;
              name: string | null;
              text: string | null;
              value: string | null;
              checked: boolean | "mixed" | null;
              expanded: boolean | null;
              open: boolean | null;
              hidden: boolean | null;
            };
          }>(
            bidi.page.target,
            `(selector) => {
              const normalize = (value) => {
                const text = value == null ? "" : String(value).replace(/\\s+/g, " ").trim().slice(0, 4096);
                return text || null;
              };
              const parseBoolean = (value) => value === "true" ? true : value === "false" ? false : null;
              const implicitRole = (el) => {
                const tag = el.tagName.toLowerCase();
                if (tag === "a" && el.hasAttribute("href")) return "link";
                if (tag === "button") return "button";
                if (tag === "select") return "combobox";
                if (tag === "textarea") return "textbox";
                if (tag === "input") {
                  const type = (el.getAttribute("type") || "text").toLowerCase();
                  if (type === "checkbox") return "checkbox";
                  if (type === "radio") return "radio";
                  if (type === "search") return "searchbox";
                  if (["button", "submit", "reset", "image"].includes(type)) return "button";
                  if (!["hidden", "file", "color", "range"].includes(type)) return "textbox";
                }
                return null;
              };
              const accessibleName = (el) => {
                const direct = normalize(el.getAttribute("aria-label"));
                if (direct) return direct;
                const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean)
                  .map((id) => document.getElementById(id))
                  .filter(Boolean)
                  .map((node) => node.textContent || "")
                  .join(" ");
                if (normalize(labelledBy)) return normalize(labelledBy);
                if (el.labels && el.labels.length) {
                  const labels = Array.from(el.labels).map((label) => label.textContent || "").join(" ");
                  if (normalize(labels)) return normalize(labels);
                }
                return normalize(el.getAttribute("alt"))
                  || normalize(el.getAttribute("title"))
                  || normalize(el.getAttribute("placeholder"))
                  || normalize(el.textContent);
              };
              const openDialogIds = Array.from(document.querySelectorAll("dialog[open][id], [role='dialog'][id][open], [role='dialog'][id][aria-modal='true']"))
                .filter((dialog) => !dialog.hidden && dialog.getAttribute("aria-hidden") !== "true")
                .map((dialog) => dialog.id);
              const documentSnapshot = {
                theme: document.documentElement.dataset.theme || null,
                openDialogIds,
              };
              const el = document.querySelector(selector);
              if (!el) {
                return {
                  url: location.href,
                  title: document.title,
                  document: documentSnapshot,
                  element: { found: false, tag: null, id: null, role: null, name: null, text: null, value: null, checked: null, expanded: null, open: null, hidden: null },
                };
              }
              const style = getComputedStyle(el);
              const hiddenByAncestor = Boolean(el.closest("[hidden], [aria-hidden='true']"))
                || (() => {
                  for (let node = el.parentElement; node; node = node.parentElement) {
                    const ancestorStyle = getComputedStyle(node);
                    if (ancestorStyle.display === "none" || ancestorStyle.visibility === "hidden") return true;
                  }
                  return false;
                })();
              const ariaChecked = el.getAttribute("aria-checked");
              const checked = typeof el.checked === "boolean"
                ? el.checked
                : ariaChecked === "mixed" ? "mixed" : parseBoolean(ariaChecked);
              let open = ["dialog", "details"].includes(el.tagName.toLowerCase())
                ? el.hasAttribute("open")
                : null;
              try { if (el.matches(":popover-open")) open = true; } catch {}
              return {
                url: location.href,
                title: document.title,
                document: documentSnapshot,
                element: {
                  found: true,
                  tag: el.tagName.toLowerCase(),
                  id: el.id || null,
                  role: el.getAttribute("role") || implicitRole(el),
                  name: accessibleName(el),
                  text: normalize(el.textContent),
                  value: "value" in el ? String(el.value) : normalize(el.getAttribute("aria-valuenow")),
                  checked,
                  expanded: parseBoolean(el.getAttribute("aria-expanded")),
                  open,
                  hidden: hiddenByAncestor || !el.isConnected || el.hidden || el.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden",
                },
              };
            }`,
            [args.selector],
          );
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `graph_live_read failed: ${err.message}` }] };
        }
      },
    );
  }

  // graph.explain
  server.registerTool(
    "graph_explain",
    {
      title: "Explain a node's neighborhood",
      description: "Forward/backward edge walk from an axId plus same-page capabilities.",
      inputSchema: {
        id: z.string().describe("axId to explain"),
        depth: z.number().int().positive().max(10).optional(),
      },
    },
    async (args) => {
      const result = explain(graph, { id: args.id, depth: args.depth });
      if (result === null) {
        return { isError: true, content: [{ type: "text", text: `id not found: ${args.id}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
  // substrate.info (R2 — provable freshness): provenance of the graph this
  // server serves. Agents call this FIRST and assert rootUrl + graphHash
  // against the substrate they (or their operator) produced; the hash is
  // computed from the loaded graph.json bytes, never operator-supplied.
  server.registerTool(
    "substrate_info",
    {
      title: "Identify the loaded substrate",
      description:
        "Provenance of the graph this server serves: root URL, crawl timestamps, browser version, computed graph hash (sha256 of graph.json), frontier hash, and Nexus build version. Call this before acting and verify the rootUrl and graphHash match the substrate you intend — a mismatch means you are acting on the wrong substrate and must fail closed.",
      inputSchema: {},
    },
    async () => {
      const prov = graph.substrateProvenance;
      const result = prov
        ? {
            bound: true,
            outputDir: prov.outputDir,
            graphPath: prov.graphPath,
            graphHash: prov.graphHash,
            rootUrl: prov.crawl?.rootUrl ?? null,
            crawlStartedAt: prov.crawl?.startedAt ?? null,
            crawlFinishedAt: prov.crawl?.finishedAt ?? null,
            browser: prov.crawl?.browser ?? null,
            pages: prov.crawl?.pages ?? graph.pageCount,
            tokens: prov.crawl?.tokens ?? graph.tokenCount,
            frontierHash: prov.frontierHash,
            buildVersion: prov.buildVersion,
            substrates: {
              web: bidi ? "online (BiDi attached)" : "offline (no BiDi session attached)",
              desktop: desktop ? "online (Windows UIA daemon active)" : "disabled",
              mobile: opts.mobile ? "online (Android ADB client active)" : "disabled",
            },
          }
        : {
            bound: false,
            warning:
              "This server was started with an in-memory graph that has no substrate provenance. Every result is unattributed: there is no recorded rootUrl, crawl time, or content hash. Ask the operator to serve a real substrate directory (`nexus serve --graph <dir>`).",
            pages: graph.pageCount,
            tokens: graph.tokenCount,
            buildVersion: NEXUS_VERSION,
          };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // R5: async substrate production (opt-in via --allow-crawl / crawlJobs).
  // The handle's producer block records WHO produced the substrate so
  // consumers can apply trust policy per mode; the enforcement gateway gates
  // crawl_start/crawl_cancel as the `crawl` operation (impact modify) and
  // crawl_status as a read.
  const crawlJobs =
    opts.crawlJobs === true
      ? new CrawlJobManager()
      : opts.crawlJobs instanceof CrawlJobManager
        ? opts.crawlJobs
        : null;
  if (crawlJobs) {
    const jobActorId = opts.enforcement?.actor?.id ?? "mcp-client";
    server.registerTool(
      "crawl_start",
      {
        title: "Start an async crawl job",
        description:
          "Start a background crawl of rootUrl and publish the substrate atomically to outputDir when complete. Returns a job handle {jobId, outputDir, graphHash, ...} — poll with crawl_status. outputDir is required (no default substrate); an existing outputDir is never overwritten. Gated as the `crawl` operation (impact modify).",
        inputSchema: {
          rootUrl: z.string().describe("Root URL to crawl"),
          outputDir: z.string().describe("Directory to publish the finished substrate into (must not already exist)"),
          maxPages: z.number().int().positive().max(10000).optional().describe("Page budget (default 50)"),
          scope: z.enum(["same-origin", "same-site", "any"]).optional().describe("BFS scope (default same-origin)"),
        },
      },
      async (args) => {
        try {
          const handle = crawlJobs.start({
            rootUrl: args.rootUrl,
            outputDir: args.outputDir,
            maxPages: args.maxPages,
            scope: args.scope,
            producer: { actorId: jobActorId, authorizationId: null, mode: "delegated" },
          });
          return { content: [{ type: "text", text: JSON.stringify(handle, null, 2) }] };
        } catch (err) {
          const code = err instanceof CrawlJobError ? err.code : "CRAWL_START_FAILED";
          return { isError: true, content: [{ type: "text", text: `${code}: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );
    server.registerTool(
      "crawl_status",
      {
        title: "Poll a crawl job",
        description:
          "Return the current handle for a crawl job: state (running|complete|failed|cancelled), published outputDir, computed graphHash (once complete), page counts, and producer identity.",
        inputSchema: { jobId: z.string().describe("Job id returned by crawl_start") },
      },
      async (args) => {
        const handle = crawlJobs.status(args.jobId);
        if (!handle) {
          return { isError: true, content: [{ type: "text", text: `JOB_NOT_FOUND: no crawl job ${args.jobId}` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(handle, null, 2) }] };
      },
    );
    server.registerTool(
      "crawl_cancel",
      {
        title: "Cancel a crawl job",
        description:
          "Request cooperative cancellation of a running crawl job. Nothing partial is ever published: the staging directory is discarded and the outputDir never appears.",
        inputSchema: { jobId: z.string().describe("Job id returned by crawl_start") },
      },
      async (args) => {
        try {
          const handle = crawlJobs.cancel(args.jobId);
          return { content: [{ type: "text", text: JSON.stringify(handle, null, 2) }] };
        } catch (err) {
          const code = err instanceof CrawlJobError ? err.code : "CRAWL_CANCEL_FAILED";
          return { isError: true, content: [{ type: "text", text: `${code}: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );
  }

  server.registerTool(
    "graph_diagnostics",
    {
      title: "Query extraction health, failures, and substrate diagnostics",
      description: "Returns health metrics, load failures, degraded fallback elements, unlabeled interactive elements, substrate status, and actionable recommendations for agent navigation.",
      inputSchema: {
        includeUnlabeledInteractive: z.boolean().optional().describe("Include list of interactive elements lacking accessible names (default true)"),
      },
    },
    async (args) => {
      const diag = typeof graph.getDiagnostics === "function" ? graph.getDiagnostics() : { extractorFailures: [], pageErrors: [], extractionWarnings: [] };
      const pages = Array.from(graph.pages());
      const loadedPages = pages.filter((p) => p.loadStatus === "complete" || p.loadStatus === "interactive");
      const failedPages = pages.filter((p) => p.loadStatus === "spa-error" || p.loadStatus === "timeout");

      const INTERACTIVE_ROLES = new Set([
        "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
        "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "slider",
      ]);

      const unlabeled: Array<{ id: string; role: string; pageId: string }> = [];
      if (args.includeUnlabeledInteractive !== false) {
        for (const node of graph.allNodes()) {
          if (node.type === "ax-node") {
            const ax = node as import("../graph/types.js").AxNode;
            if (INTERACTIVE_ROLES.has(ax.role) && (!ax.name || ax.name.trim() === "")) {
              unlabeled.push({ id: ax.id, role: ax.role, pageId: ax.pageId });
            }
          }
        }
      }

      const recommendations: string[] = [];
      if (failedPages.length > 0) {
        recommendations.push(`${failedPages.length} page(s) failed to load or timed out. Check \`failedPages\` for error details.`);
      }
      if (diag.extractorFailures.length > 0) {
        recommendations.push(`${diag.extractorFailures.length} extractor exception(s) occurred during crawl. Inspect \`extractorFailures\`.`);
      }
      if (diag.extractionWarnings.length > 0) {
        recommendations.push(`${diag.extractionWarnings.length} DOM elements had extraction issues and degraded to presentation fallbacks. Inspect \`extractionWarnings\`.`);
      }
      if (unlabeled.length > 0) {
        recommendations.push(`${unlabeled.length} interactive elements lack accessible names. Consider using coordinate clicks or container queries for them.`);
      }
      if (recommendations.length === 0) {
        recommendations.push("Substrate extraction is 100% healthy with zero degraded elements or crawl errors.");
      }

      const result = {
        summary: {
          pagesTotal: pages.length,
          pagesLoaded: loadedPages.length,
          pagesFailed: failedPages.length,
          axNodesTotal: graph.axCount,
          capabilitiesTotal: graph.capabilityCount,
          statesTotal: graph.stateCount,
          healthScorePercent: pages.length > 0 ? Math.round((loadedPages.length / pages.length) * 100) : 100,
        },
        substrates: {
          web: bidi ? "online (BiDi attached)" : "offline (no BiDi session attached)",
          desktop: desktop ? "online (Windows UIA daemon active)" : "disabled",
          mobile: opts.mobile ? "online (Android ADB client active)" : "disabled",
        },
        failedPages: failedPages.map((p) => {
          const err = diag.pageErrors.find((e) => e.url === p.url);
          return { url: p.url, status: p.loadStatus, error: err?.error ?? "Unknown page failure" };
        }),
        extractorFailures: diag.extractorFailures,
        extractionWarnings: diag.extractionWarnings,
        unlabeledInteractive: unlabeled.slice(0, 50),
        recommendations,
        // R2 (additive, optional): substrate identity so a diagnostics read is
        // attributable. Never removed/reordered fields above.
        substrate: {
          rootUrl: graph.substrateProvenance?.crawl?.rootUrl ?? null,
          graphHash: graph.substrateProvenance?.graphHash ?? null,
          crawlFinishedAt: graph.substrateProvenance?.crawl?.finishedAt ?? null,
          buildVersion: graph.substrateProvenance?.buildVersion ?? NEXUS_VERSION,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // VI-01: get_visual
  server.registerTool(
    "get_visual",
    {
      title: "Get visual element snapshot or viewport observation (VI-01)",
      description: "Returns the visual snapshot (rect, computedStyle, visibility, tethers) of an element, optionally at a specific viewport profile.",
      inputSchema: {
        axId: z.string().describe("Accessibility node ID (e.g. ax:btn)"),
        viewport: z.union([z.string(), z.number()]).optional().describe("Optional viewport profile name (e.g. 'desktop', 'mobile') or width in px"),
      },
    },
    async (args) => {
      if (args.viewport !== undefined) {
        const obs = graph.visualByAxAndViewport(args.axId, args.viewport);
        if (!obs) {
          return {
            isError: true,
            content: [{ type: "text", text: `No visual observation found for element '${args.axId}' at viewport '${args.viewport}'` }],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(obs, null, 2) }] };
      }
      const vis = graph.visualByAx(args.axId);
      if (!vis) {
        return {
          isError: true,
          content: [{ type: "text", text: `No visual node found for element '${args.axId}'` }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(vis, null, 2) }] };
    },
  );

  // VI-01: query_viewport_diff
  server.registerTool(
    "query_viewport_diff",
    {
      title: "Query responsive difference between two viewports (VI-01)",
      description: "Directly answers: 'What happens to this element between 1440px and 390px?' without taking a new screenshot. Returns geometric deltas, percent changes, visibility changes, computed style diffs, and synthesized summary.",
      inputSchema: {
        axId: z.string().describe("Accessibility node ID (e.g. ax:btn)"),
        fromViewport: z.union([z.string(), z.number()]).describe("Baseline viewport name (e.g. 'desktop', '1440') or width in px"),
        toViewport: z.union([z.string(), z.number()]).describe("Target viewport name (e.g. 'mobile', '390') or width in px"),
      },
    },
    async (args) => {
      const diff = graph.queryViewportDiff(args.axId, args.fromViewport, args.toViewport);
      if (!diff) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `No observations found for element '${args.axId}' between viewports '${args.fromViewport}' and '${args.toViewport}'`,
          }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(diff, null, 2) }] };
    },
  );


  // VI-04: get_visual_patterns
  server.registerTool(
    "get_visual_patterns",
    {
      title: "Get semantic visual patterns (VI-04)",
      description: "Finds high-level UI component patterns (fab, modal-backdrop, dialog-overlay, sticky-header, sticky-footer, dismiss-button, form-group, toast-notification) across the page.",
      inputSchema: {
        pageId: z.string().optional().describe("Optional pageId to filter on"),
        pattern: z.enum([
          "fab", "modal-backdrop", "dialog-overlay", "sticky-header",
          "sticky-footer", "dismiss-button", "form-group", "toast-notification",
        ]).optional().describe("Specific pattern to filter on"),
        minConfidence: z.number().min(0).max(1).optional().describe("Minimum confidence score threshold (default: 0.5)"),
      },
    },
    async (args) => {
      const results = graph.visualPatterns(args.pageId, args.pattern, args.minConfidence ?? 0.5);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  // VI-04: query_page_layout_mutations
  server.registerTool(
    "query_page_layout_mutations",
    {
      title: "Query responsive layout mutations across viewports (VI-04)",
      description: "Classifies responsive mutations (reflow, hide, show, reorder, reposition, unchanged) for all elements on a page between two viewports.",
      inputSchema: {
        pageId: z.string().describe("Page ID to analyze"),
        fromViewport: z.union([z.string(), z.number()]).describe("Baseline viewport name (e.g. 'desktop') or width"),
        toViewport: z.union([z.string(), z.number()]).describe("Target viewport name (e.g. 'mobile') or width"),
      },
    },
    async (args) => {
      const result = graph.queryPageLayoutMutations(args.pageId, args.fromViewport, args.toViewport);
      if (!result) {
        return {
          isError: true,
          content: [{ type: "text", text: `No layout mutations found for page '${args.pageId}' between viewports` }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // VI-02: get_visual_containers
  server.registerTool(
    "get_visual_containers",
    {
      title: "Get visual layout containers (VI-02)",
      description: "Returns all visual nodes that act as layout containers or visual wrappers (hero, grid, flex, card, section, scroll, container, wrapper).",
      inputSchema: {
        pageId: z.string().optional().describe("Optional pageId to filter on"),
      },
    },
    async (args) => {
      const results = graph.visualContainers(args.pageId);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  // VI-03: get_spatial_neighbors
  server.registerTool(
    "get_spatial_neighbors",
    {
      title: "Get spatial proximity neighbors (VI-03)",
      description: "Returns adjacent visual nodes positioned above, below, left-of, right-of, or nested-in relative to a target visual node.",
      inputSchema: {
        visId: z.string().describe("Target visual node ID (e.g. vis:page:ax1)"),
        direction: z.enum(["above", "below", "left-of", "right-of", "nested-in"]).optional().describe("Direction filter"),
      },
    },
    async (args) => {
      const results = graph.spatialNeighbors(args.visId, args.direction);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  // VI-03: get_occluded_nodes
  server.registerTool(
    "get_occluded_nodes",
    {
      title: "Get occluded visual nodes (VI-03)",
      description: "Returns visual nodes that are partially or fully occluded by higher paint-order elements or clipped by ancestors.",
      inputSchema: {
        pageId: z.string().optional().describe("Optional pageId to filter on"),
        minRatio: z.number().min(0).max(1).optional().describe("Occlusion threshold: nodes with visibleRatio below this value (default: 0.5)"),
      },
    },
    async (args) => {
      const results = graph.occludedNodes(args.pageId, args.minRatio ?? 0.5);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  // VI-05: query_visual_regression
  server.registerTool(
    "query_visual_regression",
    {
      title: "Query visual regression between baseline and candidate (VI-05)",
      description: "Performs layout shift, computed style drift, token detachment, occlusion change, and pattern degradation diffing between baseline and candidate VisualNodes.",
      inputSchema: {
        pageId: z.string().describe("Page identifier to compare"),
        baselineNodes: z.array(z.any()).optional().describe("Optional explicit baseline VisualNode array"),
        candidateNodes: z.array(z.any()).optional().describe("Optional candidate VisualNode array (defaults to current page visual nodes)"),
        minShiftThresholdPx: z.number().optional().describe("Minimum pixel shift threshold (default 1.0)"),
        minDimensionThresholdPx: z.number().optional().describe("Minimum dimension delta in px (default 1.0)"),
      },
    },
    async (args) => {
      const baseNodes = args.baselineNodes ?? [];
      const candNodes = args.candidateNodes ?? graph.visualByPage(args.pageId);
      const report = diffPageVisualRegression(baseNodes, candNodes, args.pageId, {
        minShiftThresholdPx: args.minShiftThresholdPx,
        minDimensionThresholdPx: args.minDimensionThresholdPx,
      });
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    },
  );

  // VI-05: lint_design_tokens
  server.registerTool(
    "lint_design_tokens",
    {
      title: "Lint design token drift across page visual nodes (VI-05)",
      description: "Identifies hardcoded CSS values that deviate slightly from nearest design tokens or lack token bindings, surfacing design debt.",
      inputSchema: {
        pageId: z.string().optional().describe("Optional pageId to filter on"),
        maxColorDriftDistance: z.number().optional().describe("Color distance threshold for drift detection"),
        maxDimensionDriftPx: z.number().optional().describe("Dimension tolerance in px for drift detection"),
      },
    },
    async (args) => {
      const drifts = graph.lintTokenDrift(args.pageId, {
        maxColorDriftDistance: args.maxColorDriftDistance,
        maxDimensionDriftPx: args.maxDimensionDriftPx,
      });
      return { content: [{ type: "text", text: JSON.stringify(drifts, null, 2) }] };
    },
  );

  // VI-05: export_dtcg_tokens
  server.registerTool(
    "export_dtcg_tokens",
    {
      title: "Export design tokens bundle in standard W3C DTCG format (VI-05)",
      description: "Exports design tokens collected during crawl as a standardized W3C Design Tokens Community Group (DTCG) bundle.",
      inputSchema: {},
    },
    async () => {
      const bundle = graph.exportDtcgTokens();
      return { content: [{ type: "text", text: JSON.stringify(bundle, null, 2) }] };
    },
  );


  // ---- Phase D3: Desktop UIA Substrate Tools ----
  const desktop = opts.desktop === true
    ? new WindowsUiaDaemon()
    : opts.desktop instanceof WindowsUiaDaemon
      ? opts.desktop
      : null;

  if (desktop) {
    // desktop_list_windows
    server.registerTool(
      "desktop_list_windows",
      {
        title: "List desktop windows (Phase D3)",
        description: "List all active application windows on the host desktop (windowId, title, processName, bounds).",
        inputSchema: {},
      },
      async () => {
        try {
          const windows = await desktop.listWindows();
          return { content: [{ type: "text", text: JSON.stringify(windows, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `desktop_list_windows failed: ${err.message}` }] };
        }
      },
    );

    // desktop_scrape_window
    server.registerTool(
      "desktop_scrape_window",
      {
        title: "Scrape desktop window UI automation tree (Phase D3)",
        description: "Scrapes the accessibility hierarchy of a targeted desktop window (e.g. GitHub Copilot, VS Code, Chrome) and normalizes it into Universal Substrate AxTreeNode hierarchy.",
        inputSchema: {
          pattern: z.string().optional().describe("Window title or process name substring (e.g. 'Copilot', 'Code', 'Antigravity')"),
          windowId: z.string().optional().describe("Native window handle id (from desktop_list_windows)"),
          maxDepth: z.number().int().positive().max(20).optional().describe("Max tree depth to walk (default: 8)"),
        },
      },
      async (args) => {
        try {
          const target = args.windowId ? { windowId: args.windowId } : { titlePattern: args.pattern ?? "Code" };
          const surface = await desktop.createSurface(target);
          const [route, metrics, title, axTree] = await Promise.all([
            surface.getRoute(),
            surface.getDisplayMetrics(),
            surface.getTitle(),
            surface.extractAccessibilityTree(),
          ]);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                title,
                route,
                metrics,
                elementCount: axTree.length,
                axTree,
              }, null, 2),
            }],
          };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `desktop_scrape_window failed: ${err.message}` }] };
        }
      },
    );

    // desktop_read_text / desktop_replace_text
    server.registerTool(
      "desktop_read_text",
      {
        title: "Read text from a desktop editor",
        description: "Freshly resolves a Windows window and reads its editable Document/Edit element through UI Automation TextPattern with ValuePattern fallback.",
        inputSchema: {
          windowId: z.string().min(1).describe("Explicit native window handle id from desktop_list_windows"),
        },
      },
      async (args) => {
        try {
          const result = await desktop.readText({ windowId: args.windowId });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `desktop_read_text failed: ${err.message}` }] };
        }
      },
    );

    server.registerTool(
      "desktop_replace_text",
      {
        title: "Replace text in a desktop editor",
        description: "Freshly resolves a Windows window, targets its editable Document/Edit element, replaces all text semantically, and returns the actual UI Automation read-back.",
        inputSchema: {
          text: z.string().max(12000).describe("Complete replacement text"),
          expectedCurrentText: z.string().max(12000).describe("Required optimistic-concurrency precondition; replacement fails if the selected editor does not currently contain this text"),
          windowId: z.string().min(1).describe("Explicit native window handle id from desktop_list_windows"),
        },
      },
      async (args) => {
        try {
          const decision = decide({
            tier: "PROPOSE",
            capabilityId: "desktop_replace_text",
            role: "textbox",
            name: "Replace text in an explicitly selected desktop editor",
            confirm: false,
          });
          if (!decision.ok) {
            return { isError: true, content: [{ type: "text", text: JSON.stringify({ decision }) }] };
          }
          const result = await desktop.replaceText(
            args.text,
            args.expectedCurrentText,
            { windowId: args.windowId },
          );
          return { content: [{ type: "text", text: JSON.stringify({ decision, ...result }, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `desktop_replace_text failed: ${err.message}` }] };
        }
      },
    );

    // desktop_kinetic_action
    server.registerTool(
      "desktop_kinetic_action",
      {
        title: "Dispatch kinetic action to desktop window (Phase D3)",
        description: "Dispatches native mouse click, right click, keyboard typing, hotkey combinations, or window focus/state to the desktop.",
        inputSchema: {
          type: z.enum(["click", "rightClick", "type", "hotkey", "focus", "windowState"]),
          x: z.number().optional().describe("Screen X coordinate for click or rightClick"),
          y: z.number().optional().describe("Screen Y coordinate for click or rightClick"),
          text: z.string().optional().describe("Text string to type or hotkey sequence (e.g. '^c')"),
          windowId: z.string().optional().describe("Native window handle for focus or windowState"),
          state: z.enum(["Minimize", "Maximize", "Restore"]).optional().describe("Window state target"),
        },
      },
      async (args) => {
        try {
          await desktop.dispatchKineticAction(args);
          return { content: [{ type: "text", text: JSON.stringify({ status: "ok", action: args }) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `desktop_kinetic_action failed: ${err.message}` }] };
        }
      },
    );
  }

  // ---- Phase D4: Chrome DevTools Protocol (CDP) Tools ----
  const cdpClient: ChromeCdpClient | null =
    opts.chrome === true
      ? new ChromeCdpClient()
      : opts.chrome && typeof opts.chrome === "object"
        ? new ChromeCdpClient(opts.chrome)
        : null;

  if (cdpClient) {
    // chrome_targets
    server.registerTool(
      "chrome_targets",
      {
        title: "List open Chrome tabs (Phase D4)",
        description: "List all open Chrome page targets (title, url) reachable via the CDP debug endpoint `--remote-debugging-port`.",
        inputSchema: {},
      },
      async () => {
        try {
          if (!(await cdpClient.isReachable())) {
            return { isError: true, content: [{ type: "text", text: `chrome_targets failed: Chrome is not reachable on ${cdpClient.baseHttp}. Launch Chrome with --remote-debugging-port=${cdpClient.port} or use chrome_launch.` }] };
          }
          const pages = await cdpClient.listPages();
          return { content: [{ type: "text", text: JSON.stringify(pages, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `chrome_targets failed: ${err.message}` }] };
        }
      },
    );

    // chrome_read_tab
    server.registerTool(
      "chrome_read_tab",
      {
        title: "Read Chrome tab DOM text (Phase D4)",
        description: "Attach to an authenticated Chrome tab by URL substring and read its visible text, title, and URL — closing the UIA gap where Chromium hides page content from the OS accessibility bridge.",
        inputSchema: {
          urlPattern: z.string().describe("URL substring to match the target tab (e.g. 'console.anthropic.com')"),
          port: z.number().optional().describe("CDP debug port (default: 9222)"),
        },
      },
      async (args) => {
        try {
          const target = (await cdpClient.listPages()).find((p) => p.url.includes(args.urlPattern));
          if (!target) {
            const pages = await cdpClient.listPages();
            return { isError: true, content: [{ type: "text", text: `chrome_read_tab: no open tab matches '${args.urlPattern}'. Open tabs: ${pages.map((p) => p.url).join(", ")}` }] };
          }
          const snap = await cdpClient.withSession(target, async (s) => ({
            title: await s.getTitle(),
            url: await s.getUrl(),
            text: (await s.getPageText()).slice(0, 40_000),
          }));
          return { content: [{ type: "text", text: JSON.stringify(snap, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `chrome_read_tab failed: ${err.message}` }] };
        }
      },
    );
    // chrome_snapshot_tab
    server.registerTool(
      "chrome_snapshot_tab",
      {
        title: "Snapshot Chrome tab state (Phase D4)",
        description: "Capture a full browser-state snapshot of a matched tab: title, URL, visible text, localStorage, sessionStorage, and document cookies.",
        inputSchema: {
          urlPattern: z.string().describe("URL substring to match the target tab"),
          port: z.number().optional().describe("CDP debug port (default: 9222)"),
        },
      },
      async (args) => {
        try {
          const target = (await cdpClient.listPages()).find((p) => p.url.includes(args.urlPattern));
          if (!target) {
            return { isError: true, content: [{ type: "text", text: `chrome_snapshot_tab: no open tab matches '${args.urlPattern}'` }] };
          }
          const snap = await cdpClient.withSession(target, async (s) => s.snapshot());
          return { content: [{ type: "text", text: JSON.stringify(snap, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `chrome_snapshot_tab failed: ${err.message}` }] };
        }
      },
    );

    // chrome_get_cookies
    server.registerTool(
      "chrome_get_cookies",
      {
        title: "Extract Chrome cookies (Phase D4)",
        description: "Extract the full cookie jar (including httpOnly) from Chrome via CDP Network.getAllCookies, optionally filtered by domain substring.",
        inputSchema: {
          domainFilter: z.string().optional().describe("Domain substring filter (e.g. 'anthropic.com'); omit for all cookies"),
          port: z.number().optional().describe("CDP debug port (default: 9222)"),
        },
      },
      async (args) => {
        try {
          const pages = await cdpClient.listPages();
          const first = pages[0];
          if (!first) {
            return { isError: true, content: [{ type: "text", text: "chrome_get_cookies: no page targets" }] };
          }
          const domainFilter = args.domainFilter;
          const cookies = await cdpClient.withSession(first, async (s) => {
            const all = await s.getAllCookies();
            if (!domainFilter) return all;
            return all.filter((c) => c.domain.includes(domainFilter));
          });
          return { content: [{ type: "text", text: JSON.stringify(cookies, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `chrome_get_cookies failed: ${err.message}` }] };
        }
      },
    );
    // chrome_navigate
    server.registerTool(
      "chrome_navigate",
      {
        title: "Navigate a Chrome tab (Phase D4)",
        description: "Navigate a matched Chrome tab to a target URL via CDP Page.navigate (execution; advances an authenticated session).",
        inputSchema: {
          urlPattern: z.string().describe("URL substring to match the target tab"),
          url: z.string().describe("Destination URL to navigate to"),
          port: z.number().optional().describe("CDP debug port (default: 9222)"),
        },
      },
      async (args) => {
        try {
          const target = (await cdpClient.listPages()).find((p) => p.url.includes(args.urlPattern));
          if (!target) {
            return { isError: true, content: [{ type: "text", text: `chrome_navigate: no open tab matches '${args.urlPattern}'` }] };
          }
          await cdpClient.withSession(target, async (s) => s.navigate(args.url));
          return { content: [{ type: "text", text: JSON.stringify({ status: "ok", navigated: args.url }) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `chrome_navigate failed: ${err.message}` }] };
        }
      },
    );

    // chrome_launch
    server.registerTool(
      "chrome_launch",
      {
        title: "Launch Chrome with CDP port (Phase D4)",
        description: "Spawn a Chrome instance with --remote-debugging-port so CDP tools can attach, optionally headless with a dedicated user-data-dir.",
        inputSchema: {
          port: z.number().optional().describe("Debug port (default: 9222)"),
          headless: z.boolean().optional().describe("Launch headless (default: false)"),
          userDataDir: z.string().optional().describe("Dedicated profile dir (default: temp)"),
          url: z.string().optional().describe("Initial URL to open"),
          timeoutMs: z.number().optional().describe("Wait timeout for the debug endpoint (default: 20000)"),
        },
      },
      async (args) => {
        try {
          const launched = await launchChromeWithDebug({
            port: args.port,
            headless: args.headless,
            userDataDir: args.userDataDir,
            url: args.url,
            timeoutMs: args.timeoutMs,
          });
          return { content: [{ type: "text", text: JSON.stringify({ status: "launched", pid: launched.pid, port: launched.port }) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `chrome_launch failed: ${err.message}` }] };
        }
      },
    );
  }

  // --- Phase M3 Mobile Tools ---
  if (opts.mobile) {
    const mobileClient: AndroidClient =
      typeof opts.mobile === "object" ? (opts.mobile as AndroidClient) : new AndroidClient();

    server.registerTool(
      "mobile_list_devices",
      {
        title: "List connected mobile devices (Phase M3)",
        description: "List all connected Android / iOS devices or emulators.",
        inputSchema: {},
      },
      async () => {
        try {
          const devices = await mobileClient.listDevices();
          return { content: [{ type: "text", text: JSON.stringify(devices, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `mobile_list_devices failed: ${err.message}` }] };
        }
      },
    );

    server.registerTool(
      "mobile_scrape_device",
      {
        title: "Scrape mobile device accessibility tree (Phase M3)",
        description: "Scrapes the accessibility hierarchy of an Android device or emulator screen and normalizes into AxTreeNode format.",
        inputSchema: {
          deviceId: z.string().optional().describe("Target device serial / ID (defaults to first attached device)"),
        },
      },
      async (args) => {
        try {
          if (args.deviceId) {
            mobileClient.setDevice(args.deviceId);
          }
          const surface = new MobileSubstrateSurface("mobile-android", args.deviceId ?? "default-device", mobileClient);
          const [route, metrics, title, axTree] = await Promise.all([
            surface.getRoute(),
            surface.getDisplayMetrics(),
            surface.getTitle(),
            surface.extractAccessibilityTree(),
          ]);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                title,
                route,
                metrics,
                elementCount: axTree.length,
                axTree,
              }, null, 2),
            }],
          };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `mobile_scrape_device failed: ${err.message}` }] };
        }
      },
    );

    server.registerTool(
      "mobile_touch_action",
      {
        title: "Dispatch kinetic touch action to mobile device (Phase M3)",
        description: "Dispatches native touch tap, swipe, text entry, or keyevent to connected mobile device.",
        inputSchema: {
          type: z.enum(["tap", "swipe", "type", "keyevent"]),
          x: z.number().optional().describe("Screen X coordinate for tap or swipe start"),
          y: z.number().optional().describe("Screen Y coordinate for tap or swipe start"),
          x2: z.number().optional().describe("Screen X coordinate for swipe end"),
          y2: z.number().optional().describe("Screen Y coordinate for swipe end"),
          text: z.string().optional().describe("Text string to input"),
          keyCode: z.number().int().optional().describe("Android key event code (e.g. 3 for Home, 4 for Back, 66 for Enter)"),
        },
      },
      async (args) => {
        try {
          if (args.type === "tap") {
            await mobileClient.tap(args.x ?? 0, args.y ?? 0);
          } else if (args.type === "swipe") {
            await mobileClient.swipe(args.x ?? 0, args.y ?? 0, args.x2 ?? 0, args.y2 ?? 0);
          } else if (args.type === "type") {
            await mobileClient.typeText(args.text ?? "");
          } else if (args.type === "keyevent") {
            await mobileClient.keyevent(args.keyCode ?? 4);
          }
          return { content: [{ type: "text", text: JSON.stringify({ status: "ok", action: args }) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: `mobile_touch_action failed: ${err.message}` }] };
        }
      },
    );
  }

  return server;
}

/** Start the MCP server on stdio. Resolves once the transport is connected. */
export async function startMcpServer(graph: Graph, opts: McpServerOptions = {}): Promise<{ server: McpServer; stop: () => Promise<void> }> {
  // §12: bind posture/authorization/audit before the transport accepts calls.
  // Default `AWG_POSTURE=audit` → read-only until an operator authorizes more.
  if (opts.enforcement?.gateway) {
    await configureEnforcementFromEnv(process.env, opts.enforcement.gateway);
  } else {
    await configureEnforcementFromEnv(process.env);
  }
  // R2: the enforcement manifest must bind to the substrate actually loaded.
  // An operator-asserted AWG_GRAPH_HASH that does not match the computed hash
  // of the served graph.json is a silent substitution — refuse to start.
  assertGraphHashBinding(graph.substrateProvenance, process.env.AWG_GRAPH_HASH);
  const server = buildMcpServer(graph, opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    server,
    stop: async () => { await server.close(); },
  };
}
