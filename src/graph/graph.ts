/**
 * In-memory graph per plan section 10.1. Backed by maps for O(1) lookup by id
 * and secondary indexes for the predicates in section 9.1.
 *
 * Design notes:
 * - All writes are idempotent on `id`. Calling upsertAx twice with the same id
 *   replaces the node; this lets the extractors re-run during a crawl.
 * - Secondary indexes are maintained on write so query time stays bounded.
 * - The graph does NOT enforce uniqueness of (from,to,kind) edges — the same
 *   edge can appear with different provenance and that's intentional.
 */
import type {
  PageNode, AxNode, VisualNode, NavElement,
  Edge, Capability, Transition, StateNode,
  DtcgToken, GraphDocument, GraphHit, AnyNode, EdgeKind, AxRole,
  AuthContextNode, AuthContext, GraphDiagnostics,
  ViewportProfile, ViewportObservation, ViewportDiff,
  VisualPatternType, PageLayoutMutations, LayoutMutation,
  VisualRegressionReport, TokenDriftReport, DtcgExportBundle,
  SubstrateProvenance,
} from "./types.js";
import { DEFAULT_VIEWPORT_PROFILES } from "./types.js";
import { classifyLayoutMutation, computePageLayoutMutations } from "../extract-visual/patterns.js";
import {
  diffPageVisualRegression,
  detectTokenDrifts,
  exportDtcgBundle,
  type VisualRegressionOptions,
  type TokenDriftLintOptions,
} from "../extract-visual/index.js";

export class Graph {
  // Primary stores
  private _pages = new Map<string, PageNode>();
  private _axNodes = new Map<string, AxNode>();
  private _visualNodes = new Map<string, VisualNode>();
  private _navElements = new Map<string, NavElement>();
  private _edges = new Map<string, Edge>();
  private _capabilities = new Map<string, Capability>();
  private _transitions = new Map<string, Transition>();
  private _states = new Map<string, StateNode>();
  private _authContexts = new Map<string, AuthContextNode>(); // PR-8c T6
  private _tokens = new Map<string, DtcgToken>();
  private _bindingCache = new Map<string, Map<string, number>>(); // pageId -> (selector -> domNodeId)
  // R2: substrate provenance (null = in-memory, unattributed graph).
  private _substrate: SubstrateProvenance | null = null;
  private _diagnostics: GraphDiagnostics = {
    extractorFailures: [],
    pageErrors: [],
    extractionWarnings: [],
  };

  // Secondary indexes for predicates
  private _axByPage = new Map<string, Set<string>>();        // pageId -> axIds
  private _axByRole = new Map<string, Set<string>>();        // role -> axIds
  private _visByAx = new Map<string, string>();              // axId -> visId
  private _visByPage = new Map<string, Set<string>>();       // pageId -> visIds
  private _visByAxAndViewport = new Map<string, Map<string, string>>(); // VI-01: axId -> (viewportKey -> visId)
  private _obsByAx = new Map<string, Map<string, ViewportObservation>>(); // VI-01: axId -> (viewportKey -> ViewportObservation)
  private _navByPage = new Map<string, Set<string>>();       // pageId -> navElementIds (PR-8a)
  private _capsByPage = new Map<string, Set<string>>();     // pageId -> capIds
  private _edgesByFrom = new Map<string, Set<string>>();     // axId -> edgeIds
  private _edgesByTo = new Map<string, Set<string>>();       // axId -> edgeIds
  private _transitionsByFrom = new Map<string, Set<string>>(); // axId -> transIds
  // PR-8: state secondary indexes
  private _statesByPage = new Map<string, Set<string>>();    // pageId -> stateIds
  private _statesByRoute = new Map<string, Set<string>>();   // route -> stateIds
  private _statesByAuth = new Map<string, Set<string>>();    // authKind:principal -> stateIds

  // ---- Counts (cheap accessors) ----
  get pageCount(): number { return this._pages.size; }
  get axCount(): number { return this._axNodes.size; }
  get visualCount(): number { return this._visualNodes.size; }
  get navElementCount(): number { return this._navElements.size; }
  get edgeCount(): number { return this._edges.size; }
  get capabilityCount(): number { return this._capabilities.size; }
  get transitionCount(): number { return this._transitions.size; }
  get stateCount(): number { return this._states.size; }
  get authContextCount(): number { return this._authContexts.size; }
  get tokenCount(): number { return this._tokens.size; }

  get diagnostics(): GraphDiagnostics { return this.getDiagnostics(); }

  // ---- Substrate provenance (R2: freshness provable, not assumed) ----
  get substrateProvenance(): SubstrateProvenance | null { return this._substrate; }
  setSubstrateProvenance(p: SubstrateProvenance | null): void { this._substrate = p; }

  // ---- Diagnostics ----
  recordExtractorFailure(pageId: string, extractor: string, error: string): void {
    this._diagnostics.extractorFailures.push({
      pageId,
      extractor,
      error,
      timestamp: new Date().toISOString(),
    });
  }

  recordPageError(url: string, error: string, status: "timeout" | "spa-error"): void {
    this._diagnostics.pageErrors.push({
      url,
      error,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  recordExtractionWarning(pageId: string, warning: { tag: string; elementId: string | null; error: string }): void {
    this._diagnostics.extractionWarnings.push({
      pageId,
      ...warning,
    });
  }

  getDiagnostics(): GraphDiagnostics {
    return {
      extractorFailures: [...this._diagnostics.extractorFailures],
      pageErrors: [...this._diagnostics.pageErrors],
      extractionWarnings: [...this._diagnostics.extractionWarnings],
    };
  }

  setDiagnostics(diag?: GraphDiagnostics): void {
    if (diag) {
      this._diagnostics = {
        extractorFailures: diag.extractorFailures ? [...diag.extractorFailures] : [],
        pageErrors: diag.pageErrors ? [...diag.pageErrors] : [],
        extractionWarnings: diag.extractionWarnings ? [...diag.extractionWarnings] : [],
      };
    }
  }

  // ---- Page ----
  upsertPage(node: PageNode): void { this._pages.set(node.id, node); }

  getPage(id: string): PageNode | undefined { return this._pages.get(id); }
  getPageByUrl(url: string): PageNode | undefined {
    for (const p of this._pages.values()) if (p.canonicalUrl === url) return p;
    return undefined;
  }
  pages(): IterableIterator<PageNode> { return this._pages.values(); }

  // ---- AX ----
  upsertAx(node: AxNode): void {
    const prev = this._axNodes.get(node.id);
    if (prev) this.removeFromIndex(this._axByPage, prev.pageId, node.id);
    this._axNodes.set(node.id, node);
    this.addToIndex(this._axByPage, node.pageId, node.id);
    this.addToIndex(this._axByRole, node.role, node.id);
  }

  getAx(id: string): AxNode | undefined { return this._axNodes.get(id); }
  axNodes(): IterableIterator<AxNode> { return this._axNodes.values(); }
  axByPage(pageId: string): AxNode[] {
    const ids = this._axByPage.get(pageId);
    if (!ids) return [];
    const out: AxNode[] = [];
    for (const id of ids) {
      const n = this._axNodes.get(id);
      if (n) out.push(n);
    }
    return out;
  }
  axByRole(role: AxRole): AxNode[] {
    const ids = this._axByRole.get(role);
    if (!ids) return [];
    const out: AxNode[] = [];
    for (const id of ids) {
      const n = this._axNodes.get(id);
      if (n) out.push(n);
    }
    return out;
  }

  // ---- Visual ----
  upsertVisual(node: VisualNode): void {
    this._visualNodes.set(node.id, node);
    this.addToIndex(this._visByPage, node.pageId, node.id);

    // VI-01: Index by viewport profile name or dimensions
    const vpKey = node.viewport?.name?.toLowerCase() || (node.viewport?.w ? `${node.viewport.w}x${node.viewport.h}` : undefined);
    if (vpKey) {
      let vpMap = this._visByAxAndViewport.get(node.axId);
      if (!vpMap) {
        vpMap = new Map();
        this._visByAxAndViewport.set(node.axId, vpMap);
      }
      vpMap.set(vpKey, node.id);
      if (node.viewport?.w) {
        vpMap.set(String(node.viewport.w), node.id);
      }
    }

    // Canonical primary resolution: if no primary exists or node is the baseline, record as primary
    const existingPrimaryId = this._visByAx.get(node.axId);
    if (!existingPrimaryId || existingPrimaryId === node.id || (!node.viewport && this._visualNodes.get(existingPrimaryId)?.viewport)) {
      this._visByAx.set(node.axId, node.id);
    }

    // Merge viewportObservations onto the canonical node so no observation is lost
    const primaryId = this._visByAx.get(node.axId)!;
    const primary = this._visualNodes.get(primaryId);
    if (primary) {
      if (!primary.viewportObservations) {
        primary.viewportObservations = {};
      }
      if (node.viewport) {
        const key = node.viewport.name.toLowerCase();
        primary.viewportObservations[key] = {
          viewport: node.viewport,
          rect: node.rect,
          computedStyle: node.computedStyle,
          visibility: node.computedStyle?.display === "none" || node.computedStyle?.visibility === "hidden" ? "hidden" : "visible",
          tethers: node.tethers,
          interpretation: node.interpretation,
          crawledAt: new Date().toISOString(),
          isVisualContainer: node.isVisualContainer,
          containerType: node.containerType,
          boxModel: node.boxModel,
          scrollClippingContext: node.scrollClippingContext,
          stackingContext: node.stackingContext,
          renderBounds: node.renderBounds,
          occlusion: node.occlusion,
        };
      }
      if (node.occlusion && !primary.occlusion) {
        primary.occlusion = node.occlusion;
      }
      if (node.viewportObservations) {
        for (const [k, obs] of Object.entries(node.viewportObservations)) {
          primary.viewportObservations[k.toLowerCase()] = obs;
        }
      }
    }
  }

  getVisual(id: string): VisualNode | undefined { return this._visualNodes.get(id); }

  visualByAx(axId: string): VisualNode | undefined {
    const id = this._visByAx.get(axId);
    return id ? this._visualNodes.get(id) : undefined;
  }

  visualByPage(pageId: string): VisualNode[] {
    const ids = this._visByPage.get(pageId);
    if (!ids) return [];
    const out: VisualNode[] = [];
    for (const id of ids) {
      const n = this._visualNodes.get(id);
      if (n) out.push(n);
    }
    return out;
  }

  /**
   * VI-02: Returns all visual nodes that act as layout containers / visual wrappers.
   */
  visualContainers(pageId?: string): VisualNode[] {
    const list = pageId ? this.visualByPage(pageId) : [...this._visualNodes.values()];
    return list.filter((v) => Boolean(v.isVisualContainer));
  }

  /**
   * VI-02: Returns all visual layout containers on a given page.
   */
  visualContainersByPage(pageId: string): VisualNode[] {
    return this.visualContainers(pageId);
  }

  /**
   * VI-03: Returns visual nodes that are occluded (visibleRatio < minVisibleRatio, default 0.5).
   */
  occludedNodes(pageId?: string, minVisibleRatio: number = 0.5): VisualNode[] {
    const list = pageId ? this.visualByPage(pageId) : [...this._visualNodes.values()];
    return list.filter((v) => {
      if (!v.occlusion) return false;
      return v.occlusion.isOccluded || v.occlusion.visibleRatio < minVisibleRatio;
    });
  }

  /**
   * VI-03: Retrieve spatial neighbors positioned relative to `visId`.
   * Direction can be "above", "below", "left-of", "right-of", or "nested-in".
   */
  spatialNeighbors(
    visId: string,
    direction?: "above" | "below" | "left-of" | "right-of" | "nested-in",
  ): Array<{ node: VisualNode; edge: Edge }> {
    const targetKind = direction ? (`visual:${direction}` as EdgeKind) : undefined;
    const edges = this.edgesFrom(visId, targetKind);
    const spatialKinds = new Set([
      "visual:above",
      "visual:below",
      "visual:left-of",
      "visual:right-of",
      "visual:nested-in",
    ]);

    const matchingEdges = edges.filter((e) => targetKind ? e.kind === targetKind : spatialKinds.has(e.kind));
    const out: Array<{ node: VisualNode; edge: Edge }> = [];

    for (const edge of matchingEdges) {
      const node = this.getVisual(edge.to);
      if (node) {
        out.push({ node, edge });
      }
    }

    // Sort by distance ascending if available
    out.sort((a, b) => (a.edge.spatial?.distance ?? 0) - (b.edge.spatial?.distance ?? 0));
    return out;
  }

  /**
   * VI-04: Returns all visual nodes matching a semantic visual pattern (fab, sticky-header, modal-backdrop, etc.).
   */
  visualPatterns(pageId?: string, pattern?: VisualPatternType, minConfidence: number = 0.5): VisualNode[] {
    const list = pageId ? this.visualByPage(pageId) : [...this._visualNodes.values()];
    return list.filter((v) => {
      if (!v.patterns || v.patterns.length === 0) return false;
      if (!pattern) return v.patterns.some((p) => p.confidence >= minConfidence);
      return v.patterns.some((p) => p.pattern === pattern && p.confidence >= minConfidence);
    });
  }

  /**
   * VI-04: Query page-level responsive layout mutations across two viewports.
   */
  queryPageLayoutMutations(
    pageId: string,
    fromViewport: string | number | ViewportProfile,
    toViewport: string | number | ViewportProfile,
  ): PageLayoutMutations | null {
    const visNodes = this.visualByPage(pageId);
    if (visNodes.length === 0) return null;

    const fromVpProfile: ViewportProfile =
      typeof fromViewport === "object"
        ? fromViewport
        : (DEFAULT_VIEWPORT_PROFILES as any)[String(fromViewport).toLowerCase()] ?? {
            name: String(fromViewport),
            w: typeof fromViewport === "number" ? fromViewport : 1440,
            h: 900,
            dpr: 1,
          };
    const toVpProfile: ViewportProfile =
      typeof toViewport === "object"
        ? toViewport
        : (DEFAULT_VIEWPORT_PROFILES as any)[String(toViewport).toLowerCase()] ?? {
            name: String(toViewport),
            w: typeof toViewport === "number" ? toViewport : 390,
            h: 844,
            dpr: 1,
          };

    const elementDiffs: Array<{ axId: string; diff: ViewportDiff; mutation: LayoutMutation }> = [];
    const seenAxIds = new Set<string>();

    for (const v of visNodes) {
      if (seenAxIds.has(v.axId)) continue;
      seenAxIds.add(v.axId);
      const diff = this.queryViewportDiff(v.axId, fromViewport, toViewport);
      if (diff && diff.mutation) {
        elementDiffs.push({
          axId: v.axId,
          diff,
          mutation: diff.mutation,
        });
      }
    }

    return computePageLayoutMutations(pageId, fromVpProfile, toVpProfile, elementDiffs);
  }

  /**
   * VI-05: Visual regression diffing against a baseline Graph instance for a given page.
   */
  diffVisualRegression(
    baselineGraph: Graph,
    pageId: string,
    options?: VisualRegressionOptions,
  ): VisualRegressionReport {
    const baselineNodes = baselineGraph.visualByPage(pageId);
    const candidateNodes = this.visualByPage(pageId);
    return diffPageVisualRegression(baselineNodes, candidateNodes, pageId, options);
  }

  /**
   * VI-05: Lint design token drifts (deviations / styling debt) across visual elements.
   */
  lintTokenDrift(
    pageId?: string,
    options?: TokenDriftLintOptions,
  ): TokenDriftReport[] {
    const nodes = pageId ? this.visualByPage(pageId) : [...this._visualNodes.values()];
    const reports: TokenDriftReport[] = [];
    for (const v of nodes) {
      const nodeDrifts = detectTokenDrifts(v.axId, v.pageId, v.computedStyle, this._tokens, options);
      reports.push(...nodeDrifts);
    }
    return reports;
  }

  /**
   * VI-05: Export graph tokens as a standard W3C DTCG Token Bundle with metadata.
   */
  exportDtcgTokens(): DtcgExportBundle {
    return exportDtcgBundle(this._tokens);
  }

  /**
   * Return a copy of the tokens map.
   */
  getTokens(): Map<string, DtcgToken> {
    return new Map(this._tokens);
  }




  /**
   * VI-01: Record a multi-viewport visual observation for a semantic element (axId).
   */
  addViewportObservation(axId: string, obs: ViewportObservation): void {
    const vpKey = obs.viewport.name.toLowerCase();
    let obsMap = this._obsByAx.get(axId);
    if (!obsMap) {
      obsMap = new Map();
      this._obsByAx.set(axId, obsMap);
    }
    obsMap.set(vpKey, obs);
    obsMap.set(String(obs.viewport.w), obs);

    const primaryId = this._visByAx.get(axId);
    if (primaryId) {
      const primary = this._visualNodes.get(primaryId);
      if (primary) {
        if (!primary.viewportObservations) primary.viewportObservations = {};
        primary.viewportObservations[vpKey] = obs;
      }
    }
  }

  /**
   * VI-01: Retrieve all multi-viewport visual observations recorded for an element.
   */
  visualObservationsByAx(axId: string): ViewportObservation[] {
    const out: ViewportObservation[] = [];
    const seen = new Set<string>();

    const primaryId = this._visByAx.get(axId);
    if (primaryId) {
      const primary = this._visualNodes.get(primaryId);
      if (primary?.viewportObservations) {
        for (const obs of Object.values(primary.viewportObservations)) {
          const key = obs.viewport.name.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            out.push(obs);
          }
        }
      } else if (primary && out.length === 0) {
        const vp = primary.viewport ?? DEFAULT_VIEWPORT_PROFILES.desktop;
        out.push({
          viewport: vp,
          rect: primary.rect,
          computedStyle: primary.computedStyle,
          visibility: primary.computedStyle?.display === "none" || primary.computedStyle?.visibility === "hidden" ? "hidden" : "visible",
          tethers: primary.tethers,
          interpretation: primary.interpretation,
          crawledAt: new Date().toISOString(),
        });
      }
    }

    const obsMap = this._obsByAx.get(axId);
    if (obsMap) {
      for (const obs of obsMap.values()) {
        const key = obs.viewport.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(obs);
        }
      }
    }

    out.sort((a, b) => b.viewport.w - a.viewport.w);
    return out;
  }

  /**
   * VI-01: Retrieve a specific visual node or observation for an element at a given viewport.
   * Matches by viewport name ("desktop", "mobile", etc.) or numeric width (1440, 390, etc.).
   */
  visualByAxAndViewport(axId: string, viewport: string | number): ViewportObservation | VisualNode | undefined {
    const vpKey = String(viewport).toLowerCase();

    // 1. Check direct observation map
    const obsMap = this._obsByAx.get(axId);
    if (obsMap?.has(vpKey)) return obsMap.get(vpKey);

    // 2. Check discrete visual node index
    const nodeMap = this._visByAxAndViewport.get(axId);
    if (nodeMap?.has(vpKey)) {
      const visId = nodeMap.get(vpKey)!;
      return this._visualNodes.get(visId);
    }

    // 3. Check primary node's viewportObservations
    const primaryId = this._visByAx.get(axId);
    if (primaryId) {
      const primary = this._visualNodes.get(primaryId);
      if (primary?.viewportObservations) {
        if (primary.viewportObservations[vpKey]) return primary.viewportObservations[vpKey];
        for (const obs of Object.values(primary.viewportObservations)) {
          if (String(obs.viewport.w) === vpKey || obs.viewport.name.toLowerCase() === vpKey) {
            return obs;
          }
        }
      }
      if (primary?.viewport) {
        if (primary.viewport.name.toLowerCase() === vpKey || String(primary.viewport.w) === vpKey) {
          return primary;
        }
      }
    }

    return undefined;
  }

  /**
   * VI-01: Query the visual/responsive diff between two viewport observations for an element.
   * Directly answers: "What happens to this element between 1440px and 390px?" without
   * taking a new screenshot.
   */
  queryViewportDiff(
    axId: string,
    fromViewport: string | number | ViewportProfile,
    toViewport: string | number | ViewportProfile,
  ): ViewportDiff | null {
    const resolveObs = (vp: string | number | ViewportProfile): ViewportObservation | null => {
      let obs: any = null;
      if (typeof vp === "object" && "w" in vp && "rect" in (vp as any)) {
        obs = vp as any;
      } else {
        const vpKey = typeof vp === "object" ? vp.name : vp;
        obs = this.visualByAxAndViewport(axId, vpKey);
        if (!obs) {
          const all = this.visualObservationsByAx(axId);
          if (typeof vp === "number") {
            obs = all.find((o) => o.viewport.w === vp) ?? null;
          } else if (typeof vp === "string") {
            obs = all.find((o) => o.viewport.name.toLowerCase() === vp.toLowerCase()) ?? null;
          }
        }
      }
      if (!obs || !("rect" in obs) || !("computedStyle" in obs)) return null;

      const viewport: ViewportProfile =
        obs.viewport ?? (typeof vp === "object" ? vp : DEFAULT_VIEWPORT_PROFILES.desktop);
      const visibility =
        obs.visibility ??
        (obs.computedStyle?.display === "none" || obs.computedStyle?.visibility === "hidden"
          ? "hidden"
          : "visible");

      return {
        viewport,
        rect: obs.rect,
        computedStyle: obs.computedStyle,
        visibility,
        tethers: obs.tethers,
        interpretation: obs.interpretation,
        crawledAt: obs.crawledAt ?? new Date().toISOString(),
      };
    };

    const fromObs = resolveObs(fromViewport);
    const toObs = resolveObs(toViewport);
    if (!fromObs || !toObs) return null;

    const dx = toObs.rect.x - fromObs.rect.x;
    const dy = toObs.rect.y - fromObs.rect.y;
    const dw = toObs.rect.w - fromObs.rect.w;
    const dh = toObs.rect.h - fromObs.rect.h;
    const widthPercentChange = fromObs.rect.w > 0 ? (dw / fromObs.rect.w) * 100 : 0;
    const heightPercentChange = fromObs.rect.h > 0 ? (dh / fromObs.rect.h) * 100 : 0;

    const fromVis = fromObs.visibility;
    const toVis = toObs.visibility;
    const visibilityChanged = fromVis !== toVis;

    const styleDeltas: Record<string, { from: string | null; to: string | null }> = {};
    const checkedKeys = new Set([
      ...Object.keys(fromObs.computedStyle || {}),
      ...Object.keys(toObs.computedStyle || {}),
    ]);
    for (const k of checkedKeys) {
      const fVal = fromObs.computedStyle?.[k] ?? null;
      const tVal = toObs.computedStyle?.[k] ?? null;
      if (fVal !== tVal) {
        styleDeltas[k] = { from: fVal, to: tVal };
      }
    }

    const parts: string[] = [];
    if (visibilityChanged) {
      parts.push(`Visibility changed from ${fromVis} to ${toVis}`);
    } else {
      parts.push(`Remained ${fromVis}`);
    }

    if (dw !== 0 || dh !== 0) {
      const signW = dw >= 0 ? `+${dw}` : `${dw}`;
      const signH = dh >= 0 ? `+${dh}` : `${dh}`;
      parts.push(
        `resized from ${fromObs.rect.w}×${fromObs.rect.h} at ${fromObs.viewport.name}(${fromObs.viewport.w}px) to ${toObs.rect.w}×${toObs.rect.h} at ${toObs.viewport.name}(${toObs.viewport.w}px) (${signW}px / ${widthPercentChange.toFixed(1)}% width, ${signH}px / ${heightPercentChange.toFixed(1)}% height)`,
      );
    } else {
      parts.push(`dimensions unchanged (${fromObs.rect.w}×${fromObs.rect.h})`);
    }

    if (dx !== 0 || dy !== 0) {
      const signX = dx >= 0 ? `+${dx}` : `${dx}`;
      const signY = dy >= 0 ? `+${dy}` : `${dy}`;
      parts.push(`offset shifted by dx=${signX}px, dy=${signY}px`);
    }

    const significantStyles = ["display", "flex-direction", "grid-template-columns", "position", "font-size"].filter(
      (k) => k in styleDeltas,
    );
    if (significantStyles.length > 0) {
      const styleDesc = significantStyles.map((k) => `${k}: ${styleDeltas[k]?.from} → ${styleDeltas[k]?.to}`).join("; ");
      parts.push(`computed style updates: [${styleDesc}]`);
    }

    const mutation = classifyLayoutMutation(fromObs, toObs);
    const summary = parts.join("; ") + ".";

    return {
      axId,
      fromViewport: fromObs.viewport,
      toViewport: toObs.viewport,
      rectDelta: {
        dx,
        dy,
        dw,
        dh,
        widthPercentChange,
        heightPercentChange,
      },
      fromRect: fromObs.rect,
      toRect: toObs.rect,
      visibilityChange: {
        from: fromVis,
        to: toVis,
        changed: visibilityChanged,
      },
      styleDeltas,
      summary,
      mutation,
    };
  }

  // ---- NavElement (PR-8a, Layer 1 finalization) ----
  upsertNavElement(node: NavElement): void {
    const prev = this._navElements.get(node.id);
    if (prev) this.removeFromIndex(this._navByPage, prev.pageId, node.id);
    this._navElements.set(node.id, node);
    this.addToIndex(this._navByPage, node.pageId, node.id);
  }
  getNavElement(id: string): NavElement | undefined { return this._navElements.get(id); }
  navElements(): IterableIterator<NavElement> { return this._navElements.values(); }
  navElementsByPage(pageId: string): NavElement[] {
    const ids = this._navByPage.get(pageId);
    if (!ids) return [];
    const out: NavElement[] = [];
    for (const id of ids) {
      const n = this._navElements.get(id);
      if (n) out.push(n);
    }
    return out;
  }

  // ---- Edge ----
  upsertEdge(node: Edge): void {
    this._edges.set(node.id, node);
    this.addToIndex(this._edgesByFrom, node.from, node.id);
    this.addToIndex(this._edgesByTo, node.to, node.id);
  }
  getEdge(id: string): Edge | undefined { return this._edges.get(id); }
  edgesFrom(axId: string, kind?: EdgeKind): Edge[] {
    const ids = this._edgesByFrom.get(axId);
    if (!ids) return [];
    const out: Edge[] = [];
    for (const id of ids) {
      const e = this._edges.get(id);
      if (e && (!kind || e.kind === kind)) out.push(e);
    }
    return out;
  }
  edgesTo(axId: string, kind?: EdgeKind): Edge[] {
    const ids = this._edgesByTo.get(axId);
    if (!ids) return [];
    const out: Edge[] = [];
    for (const id of ids) {
      const e = this._edges.get(id);
      if (e && (!kind || e.kind === kind)) out.push(e);
    }
    return out;
  }

  /**
   * Iterate every Edge in the graph. Used by the nav-link resolver
   * (PR-8a) which needs to walk edges whose `from` is a synthetic
   * axId that may not be present in the ax table.
   */
  allEdges(): IterableIterator<Edge> { return this._edges.values(); }

  /**
   * PR-8b (item 4): remove an edge by id. Returns true if the edge
   * existed and was removed, false if it was not present. The
   * secondary indexes (`_edgesByFrom`, `_edgesByTo`) are also
   * updated so the edge no longer appears in `edgesFrom` /
   * `edgesTo`. Used by the `state:cause` resolver to drop
   * unresolved edges without re-pointing them at a random state.
   */
  removeEdge(id: string): boolean {
    const e = this._edges.get(id);
    if (!e) return false;
    this._edges.delete(id);
    this.removeFromIndex(this._edgesByFrom, e.from, id);
    this.removeFromIndex(this._edgesByTo, e.to, id);
    return true;
  }

  // ---- Capability ----
  upsertCapability(node: Capability): void {
    this._capabilities.set(node.id, node);
    this.addToIndex(this._capsByPage, node.pageId, node.id);
  }
  getCapability(id: string): Capability | undefined { return this._capabilities.get(id); }
  capabilities(): IterableIterator<Capability> { return this._capabilities.values(); }
  capabilitiesByPage(pageId: string): Capability[] {
    const ids = this._capsByPage.get(pageId);
    if (!ids) return [];
    const out: Capability[] = [];
    for (const id of ids) {
      const n = this._capabilities.get(id);
      if (n) out.push(n);
    }
    return out;
  }

  // ---- Transition ----
  upsertTransition(node: Transition): void {
    this._transitions.set(node.id, node);
    this.addToIndex(this._transitionsByFrom, node.fromAxId, node.id);
  }
  getTransition(id: string): Transition | undefined { return this._transitions.get(id); }
  transitions(): IterableIterator<Transition> { return this._transitions.values(); }
  transitionsFrom(axId: string): Transition[] {
    const ids = this._transitionsByFrom.get(axId);
    if (!ids) return [];
    const out: Transition[] = [];
    for (const id of ids) {
      const n = this._transitions.get(id);
      if (n) out.push(n);
    }
    return out;
  }

  // ---- Tokens ----
  upsertToken(path: string, token: DtcgToken): void {
    this._tokens.set(path, token);
  }
  getToken(path: string): DtcgToken | undefined { return this._tokens.get(path); }
  tokens(): IterableIterator<[string, DtcgToken]> { return this._tokens.entries(); }

  // ---- State (PR-8) ----
  //
  // The Interaction/State Graph is a finite state machine. State nodes
  // are first-class; their ids are derived from the canonical payload
  // (see `deriveStateId` in `state-id.ts`). Upsert is idempotent on
  // id; re-inserting a state preserves the first `firstObservedAt`
  // timestamp and unions the new evidence with the existing one.
  upsertState(node: StateNode): void {
    const prev = this._states.get(node.id);
    if (prev) {
      this.removeFromIndex(this._statesByPage, prev.pageId, node.id);
      this.removeFromIndex(this._statesByRoute, prev.payload.route, node.id);
      this.removeFromIndex(this._statesByAuth, authKey(prev.authContext), node.id);
      // Union evidence; preserve firstObservedAt.
      const existingKinds = new Set(prev.evidence.map((e) => `${e.kind}|${e.sourceAxId}`));
      const merged: typeof prev.evidence = [...prev.evidence];
      for (const e of node.evidence) {
        const k = `${e.kind}|${e.sourceAxId}`;
        if (!existingKinds.has(k)) {
          merged.push(e);
          existingKinds.add(k);
        }
      }
      // Convergence: if we have BOTH declared and observed evidence
      // kinds from any source, the evidence[].kind is updated to
      // "declared+observed" (the convergence flag).
      const hasDeclared = merged.some((e) => e.kind === "declared" || e.kind === "declared+observed");
      const hasObserved = merged.some((e) => e.kind === "observed" || e.kind === "declared+observed");
      if (hasDeclared && hasObserved) {
        for (let i = 0; i < merged.length; i++) {
          if (merged[i]!.kind === "declared" || merged[i]!.kind === "observed") {
            merged[i] = { ...merged[i]!, kind: "declared+observed" };
          }
        }
      }
      this._states.set(node.id, {
        ...node,
        firstObservedAt: prev.firstObservedAt,
        evidence: merged,
      });
    } else {
      this._states.set(node.id, node);
    }
    this.addToIndex(this._statesByPage, node.pageId, node.id);
    this.addToIndex(this._statesByRoute, node.payload.route, node.id);
    this.addToIndex(this._statesByAuth, authKey(node.authContext), node.id);
  }
  getState(id: string): StateNode | undefined { return this._states.get(id); }
  states(): IterableIterator<StateNode> { return this._states.values(); }
  statesByPage(pageId: string): StateNode[] {
    return this.collectByIndex(this._statesByPage, pageId);
  }
  statesByRoute(route: string): StateNode[] {
    return this.collectByIndex(this._statesByRoute, route);
  }
  statesByAuthKind(kind: string): StateNode[] {
    const out: StateNode[] = [];
    for (const [k, ids] of this._statesByAuth.entries()) {
      if (!k.startsWith(`${kind}:`)) continue;
      for (const id of ids) {
        const s = this._states.get(id);
        if (s) out.push(s);
      }
    }
    return out;
  }
  private collectByIndex(idx: Map<string, Set<string>>, k: string): StateNode[] {
    const ids = idx.get(k);
    if (!ids) return [];
    const out: StateNode[] = [];
    for (const id of ids) {
      const s = this._states.get(id);
      if (s) out.push(s);
    }
    return out;
  }

  // ---- AuthContext (PR-8c T6) ----
  //
  // AuthContextNodes are first-class graph entities. The id is the
  // same string the materializer's `authIdFor` produces, so the
  // `state:auth` edge's `to` is always resolvable via
  // `graph.getAuthContext(id)`. Re-inserting the same context unions
  // `observationCount` and preserves the first `firstObservedAt`.
  upsertAuthContext(node: AuthContextNode): void {
    const prev = this._authContexts.get(node.id);
    if (prev) {
      this._authContexts.set(node.id, {
        ...node,
        firstObservedAt: prev.firstObservedAt,
        observationCount: prev.observationCount + 1,
      });
    } else {
      this._authContexts.set(node.id, { ...node, observationCount: 1 });
    }
  }
  getAuthContext(id: string): AuthContextNode | undefined {
    return this._authContexts.get(id);
  }
  authContexts(): IterableIterator<AuthContextNode> {
    return this._authContexts.values();
  }

  // ---- Binding cache (selector re-resolve) ----
  setBinding(pageId: string, selector: string, domNodeId: number): void {
    let m = this._bindingCache.get(pageId);
    if (!m) { m = new Map(); this._bindingCache.set(pageId, m); }
    m.set(selector, domNodeId);
  }
  getBinding(pageId: string, selector: string): number | undefined {
    return this._bindingCache.get(pageId)?.get(selector);
  }

  // ---- Materialize a GraphDocument for serialization (plan section 4 top-level) ----
  toDocument(crawlInfo: GraphDocument["crawl"]): GraphDocument {
    const designTokens: Record<string, any> = {};
    for (const [path, t] of this._tokens.entries()) {
      const parts = path.split(".");
      let cursor = designTokens;
      for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i]!;
        if (!(k in cursor)) cursor[k] = {};
        cursor = cursor[k] as Record<string, any>;
      }
      cursor[parts[parts.length - 1]!] = t;
    }
    return {
      version: "1.0.0",
      crawl: crawlInfo,
      diagnostics: this.getDiagnostics(),

      designTokens,
      pages: [...this._pages.values()],
      axNodes: [...this._axNodes.values()],
      visualNodes: [...this._visualNodes.values()],
      navElements: [...this._navElements.values()],
      edges: [...this._edges.values()],
      capabilities: [...this._capabilities.values()],
      transitions: [...this._transitions.values()],
      states: [...this._states.values()],
      authContexts: [...this._authContexts.values()],
    };
  }

  // ---- Iteration helpers ----
  *allNodes(): IterableIterator<AnyNode> {
    yield* this._pages.values();
    yield* this._axNodes.values();
    yield* this._visualNodes.values();
    yield* this._navElements.values();
    yield* this._edges.values();
    yield* this._capabilities.values();
    yield* this._transitions.values();
    yield* this._states.values();
    yield* this._authContexts.values();
  }

  // ---- Internal ----
  private addToIndex<K, V>(m: Map<K, Set<V>>, k: K, v: V): void {
    let s = m.get(k);
    if (!s) { s = new Set(); m.set(k, s); }
    s.add(v);
  }
  private removeFromIndex<K, V>(m: Map<K, Set<V>>, k: K, v: V): void {
    const s = m.get(k);
    if (!s) return;
    s.delete(v);
    if (s.size === 0) m.delete(k);
  }
}

/** Build the secondary-index key for an AuthContext (PR-8). */
export function authKey(a: { kind: string; principal?: string; role?: string; session?: string }): string {
  switch (a.kind) {
    case "anonymous": return "anonymous:";
    case "authenticated": return `authenticated:${a.principal}:${a.session}`;
    case "administrator": return `administrator:${a.principal}:${a.session}`;
    case "custom-role": return `custom-role:${a.role}:${a.principal}:${a.session}`;
    default: return `${a.kind}:`;
  }
}
