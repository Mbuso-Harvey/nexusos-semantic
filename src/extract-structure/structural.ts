/**
 * Stage 5 — extract-structure: the structural-layer extractor.
 *
 * Walks the document's accessibility tree by recursively running a self-
 * contained JS walker in the page (via `script.callFunction`). The walker
 * produces a JSON tree of nodes annotated with role, accessible name, ARIA
 * states/properties, APG-pattern hints, focusability, and the DOM order.
 *
 * We deliberately do NOT use the BiDi `accessibility.*` module — Firefox 154
 * does not implement it. We also do NOT use the platform `Element.role`
 * computed property — the spec is recent, support is incomplete, and the
 * NodeFilter + explicit role-lookup table gives us stable, predictable roles
 * across browsers and HTML dialects.
 *
 * Each produced node lands in the graph as an `AxNode`. The relations
 * declared via `aria-controls`, `aria-describedby`, `aria-labelledby`,
 * `aria-owns`, `aria-flowsto`, `commandfor`, `popovertarget`, and `<a href>`
 * are emitted as `Edge` records with matching `kind` values.
 */
import type { Extractor } from "../crawler/orchestrator.js";
import type {
  AxNode,
  Edge,
  EdgeKind,
  Provenance,
  AxStates,
  AxProperties,
  AxRole,
  NameSource,
} from "../graph/types.js";

/**
 * Provenance string used for every node and edge this extractor produces.
 * `aria` is the recognized source for tree walks (plan section 4.8); the
 * operation `:tree-walk` records what generated the data.
 */
export const STRUCTURE_PROVENANCE: Provenance = "aria:tree-walk";

/**
 * JSON tree shape returned by the in-page walker. Kept narrow on purpose —
 * anything we don't capture here, we don't have. Conversion to `AxNode`
 * happens in the extractor.
 */
export interface AxTreeNode {
  /** Sequential DOM order across the whole walk (0-based). */
  domOrder: number;
  /** Element tag in lower case (e.g. "button"). */
  tag: string;
  /** Element id attribute, or null. */
  elementId: string | null;
  /** Resolved ARIA role, or "presentation"/"none" if explicit, else the implicit role. */
  role: string;
  /** Computed accessible name. */
  name: string;
  /** Which source supplied the name. */
  nameSource: NameSource;
  /** ARIA + native states. */
  states: AxStates;
  /** ARIA + native properties. */
  properties: AxProperties;
  /** Best-guess APG pattern (tabs/dialog/listbox/menu/combobox/disclosure/accordion/tree/grid), else null. */
  apgPattern: string | null;
  /** True if focusable via tab order (tabindex>=0 or naturally focusable). */
  focusable: boolean;
  /**
   * Computed visibility at walk time. PR-8e: the declared materializer
   * uses this directly when building ElementStateObservations, so the
   * declared and observed paths produce structurally equivalent
   * `visibility` values for the same axId.
   *   "visible"     — computed display !== "none", visibility !== "hidden",
   *                   and the element has a non-zero rect that overlaps the
   *                   viewport
   *   "hidden"      — explicit `hidden` attribute or `display: none` or
   *                   `visibility: hidden` (still in the DOM)
   *   "display-none"— `getComputedStyle().display === "none"` (the
   *                   element is excluded from layout; `display:` is the
   *                   canonical CSS signal)
   *   "offscreen"   — the element has a rect but it is completely outside
   *                   the viewport (computed at walk time)
   * Null is allowed for the root document element, which has no rect.
   */
  visibility: "visible" | "hidden" | "display-none" | "offscreen" | null;
  /** Children in DOM order (depth-first pre-order is preserved via domOrder). */
  children: AxTreeNode[];
}

/** Diagnostic issue captured during in-page DOM walk. */
export interface WalkIssue {
  domOrder: number;
  tag: string;
  elementId: string | null;
  error: string;
}

/** Top-level response from the in-page walker. */
export interface WalkResult {
  root: AxTreeNode | null;
  count: number;
  issues?: WalkIssue[];
}

/**
 * The function declaration that runs in the page. It MUST be self-contained:
 * no closures, no module imports, no `import` statements. The BiDi transport
 * serializes it verbatim into the target realm.
 *
 * Walk strategy:
 *   1. TreeWalker(NodeFilter.SHOW_ELEMENT) for stable, order-preserving iteration.
 *   2. For each element, resolve role (explicit `role` attr wins, else implicit
 *      lookup table for common HTML semantics, else null which the extractor
 *      treats as "presentation").
 *   3. Resolve name via the spec order: aria-label > aria-labelledby >
 *      alt > placeholder > title > textContent.
 *   4. Capture the seven tracked states and the eleven tracked properties.
 *   5. Infer APG pattern from role+parent role (best-effort, minimal set).
 */
export const WALKER_FN = `(_arg) => {
  // ----- implicit-role lookup (HTML element + attributes -> ARIA role) -----
  const ROLE_TABLE = (() => {
    const t = new Map();
    // Landmarks
    t.set("nav", "navigation");
    t.set("main", "main");
    t.set("aside", "complementary");
    t.set("header", "banner");
    t.set("footer", "contentinfo");
    t.set("form", "form");
    t.set("search", "search");
    // Sections
    t.set("article", "article");
    t.set("section", "region");
    t.set("address", "group");
    // Headings
    for (let i = 1; i <= 6; i++) t.set("h" + i, "heading");
    // Lists
    t.set("ul", "list");
    t.set("ol", "list");
    t.set("dl", "list");
    t.set("li", "listitem");
    t.set("dt", "term");
    t.set("dd", "definition");
    // Tables
    t.set("table", "table");
    t.set("thead", "rowgroup");
    t.set("tbody", "rowgroup");
    t.set("tfoot", "rowgroup");
    t.set("tr", "row");
    t.set("th", "columnheader");
    t.set("td", "cell");
    t.set("caption", "caption");
    // Form controls — base
    t.set("button", "button");
    t.set("select", "combobox");
    t.set("textarea", "textbox");
    t.set("output", "status");
    t.set("progress", "progressbar");
    t.set("meter", "progressbar");
    t.set("details", "group");
    t.set("summary", "button");
    t.set("dialog", "dialog");
    // Grouping
    t.set("fieldset", "group");
    t.set("legend", "legend");
    t.set("figure", "figure");
    t.set("figcaption", "caption");
    t.set("hr", "separator");
    // Misc
    t.set("img", "img");
    t.set("area", "link");
    t.set("mark", "mark");
    return t;
  })();

  function inputRole(t) {
    const type = (t.getAttribute("type") || "text").toLowerCase();
    switch (type) {
      case "button":
      case "submit":
      case "reset":
      case "image": return "button";
      case "checkbox": return "checkbox";
      case "radio": return "radio";
      case "range": return "slider";
      case "number": return "spinbutton";
      case "search": return "searchbox";
      case "email":
      case "tel":
      case "text":
      case "url":
      case "password":
      case "color": return "textbox";
      case "date":
      case "datetime-local":
      case "month":
      case "time":
      case "week": return "textbox";
      case "file": return "button";
      case "hidden": return null;
      default: return "textbox";
    }
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return inputRole(el);
    if (tag === "a") {
      // <a> with href is a link; without href it's a generic group
      return el.hasAttribute("href") ? "link" : "generic";
    }
    if (tag === "area") return "link";
    if (tag === "img") {
      if (el.hasAttribute("alt") && el.getAttribute("alt") === "") return "presentation";
      return "img";
    }
    return ROLE_TABLE.get(tag) || null;
  }

  function resolveRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit && explicit.trim() !== "") {
      const v = explicit.trim().toLowerCase();
      if (v === "none" || v === "presentation") return v;
      return v;
    }
    return implicitRole(el);
  }

  // ----- accessible name resolution (spec order) -----
  function textOf(el) {
    let s = "";
    if (!el || !el.childNodes) return s;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeType === 1) s += textOf(n);
    }
    return s;
  }
  function trimmed(s) { return (s || "").replace(/\\s+/g, " ").trim(); }

  function labelledByText(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").trim();
    if (!ids) return null;
    const parts = [];
    for (const id of ids.split(/\\s+/)) {
      const ref = document.getElementById(id);
      if (ref) parts.push(textOf(ref));
    }
    const joined = trimmed(parts.join(" "));
    return joined || null;
  }

  function resolveName(el) {
    // Accessible name resolution (HTML-AAM order): 2A aria-labelledby,
    // 2B aria-label, then native markup. The label[for] association and the
    // wrapping label ancestor are the primary native name sources for the
    // labelable elements (input, textarea, select, button, meter, output,
    // progress). 2026-09-17 finding (ED-10 §6 defect 3): both label
    // associations were missing, so every implicitly-labeled input
    // (<label>Text <input></label>) was reported unlabeled — a false
    // positive that inflated the unlabeled count on our own demo (5
    // textboxes, health 95 instead of 100) and would fire on every customer
    // app using implicit labels. The code also had aria-label before
    // aria-labelledby — the reverse of the spec order; both fixed here.
    const labelledBy = labelledByText(el);
    if (labelledBy) return { name: labelledBy, source: "aria-labelledby" };
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && trimmed(ariaLabel)) {
      return { name: trimmed(ariaLabel), source: "aria-label" };
    }
    const labelable = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.tagName === "BUTTON" || el.tagName === "METER" || el.tagName === "OUTPUT" || el.tagName === "PROGRESS";
    if (labelable) {
      // DOM-contract note (2026-09-17, defect 3 follow-up): both lookups below
      // deliberately avoid closest() and getElementsByTagName() — the unit
      // suite evaluates this walker on a minimal vm DOM facade that implements
      // only attributes/childNodes/parentElement/getElementById/
      // querySelectorAll, so any richer DOM API throws mid-walk and empties
      // the whole graph. A bare-tag querySelectorAll and a parentElement chain
      // are supported by both the facade and the real DOM.
      // 1. label[for=id] association
      if (el.id) {
        const labels = document.querySelectorAll("label");
        for (let li = 0; li < labels.length; li++) {
          const lf = labels[li].getAttribute("for");
          if (lf && lf === el.id) {
            const lt = trimmed(textOf(labels[li]));
            if (lt) return { name: lt, source: "label" };
          }
        }
      }
      // 2. wrapping label ancestor (implicit association) — parentElement
      // chain, equivalent to closest("label") restricted to the first label
      // ancestor. textOf skips the control itself (void element, no text), so
      // <label>Name <input></label> resolves to "Name".
      let anc = el.parentElement;
      while (anc) {
        if (anc.tagName === "LABEL") {
          const lt = trimmed(textOf(anc));
          if (lt) return { name: lt, source: "label" };
          break;
        }
        anc = anc.parentElement;
      }
    }
    if (el.tagName === "IMG" || el.tagName === "AREA") {
      const alt = el.getAttribute("alt");
      if (alt !== null && trimmed(alt) !== "") {
        return { name: trimmed(alt), source: "alt" };
      }
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const ph = el.getAttribute("placeholder");
      if (ph && trimmed(ph)) {
        return { name: trimmed(ph), source: "placeholder" };
      }
    }
    const title = el.getAttribute("title");
    if (title && trimmed(title)) {
      return { name: trimmed(title), source: "title" };
    }
    const t = trimmed(textOf(el));
    if (t) return { name: t, source: "content" };
    return { name: "", source: "content" };
  }

  // ----- states -----
  function resolveStates(el) {
    function tri(attr) {
      if (!el.hasAttribute(attr)) return null;
      const v = el.getAttribute(attr).toLowerCase();
      if (v === "true") return true;
      if (v === "false") return false;
      if (v === "mixed") return true;
      return null;
    }
    function expandedLike() {
      if (el.hasAttribute("aria-expanded")) {
        const v = el.getAttribute("aria-expanded").toLowerCase();
        if (v === "true") return true;
        if (v === "false") return false;
        return null;
      }
      if (el.tagName === "DETAILS") return !!el.open;
      return null;
    }
    let current = null;
    if (el.hasAttribute("aria-current")) {
      const v = el.getAttribute("aria-current").toLowerCase();
      if (v === "true") current = true;
      else if (v === "false") current = false;
      else if (v === "page" || v === "step" || v === "location" || v === "date" || v === "time") current = v;
      else current = true;
    }
    return {
      expanded: expandedLike(),
      disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" ? true
              : el.getAttribute("aria-disabled") === "false" ? false : null,
      pressed: tri("aria-pressed"),
      selected: tri("aria-selected"),
      checked: tri("aria-checked"),
      busy: tri("aria-busy"),
      // PR-8f: capture open for dialog and popover so the
      // declared and observed materializers produce identical state
      // ids when the page's open state is unchanged. Without this,
      // a closed popover was observed as open=false by the rich
      // snapshot walker but open=null by the declared walker
      // (because AxStates had no open field at all), so the two
      // paths always diverged.
      open: (el.tagName === "DIALOG" || el.hasAttribute("popover"))
        ? el.hasAttribute("open")
        : null,
      current: current,
    };
  }

  // ----- properties -----
  function splitIds(v) {
    if (!v) return [];
    return v.trim().split(/\\s+/).filter(Boolean);
  }
  function intAttr(target, attr) {
    if (!target.hasAttribute(attr)) return null;
    const n = parseInt(target.getAttribute(attr), 10);
    return Number.isFinite(n) ? n : null;
  }
  function resolveProperties(el) {
    let live = null;
    if (el.hasAttribute("aria-live")) {
      const v = el.getAttribute("aria-live").toLowerCase();
      if (v === "polite" || v === "assertive" || v === "off") live = v;
    }
    let orientation = null;
    if (el.hasAttribute("aria-orientation")) {
      const v = el.getAttribute("aria-orientation").toLowerCase();
      if (v === "horizontal" || v === "vertical") orientation = v;
    }
    return {
      controls: splitIds(el.getAttribute("aria-controls")),
      describedBy: splitIds(el.getAttribute("aria-describedby")),
      labelledBy: splitIds(el.getAttribute("aria-labelledby")),
      level: /^H[1-6]$/.test(el.tagName) ? parseInt(el.tagName.substring(1), 10) : intAttr(el, "aria-level"),
      live: live,
      orientation: orientation,
      posInSet: intAttr(el, "aria-posinset"),
      setSize: intAttr(el, "aria-setsize"),
      valueNow: intAttr(el, "aria-valuenow"),
      valueMin: intAttr(el, "aria-valuemin"),
      valueMax: intAttr(el, "aria-valuemax"),
      valueText: el.getAttribute("aria-valuetext"),
    };
  }

  // ----- focusable -----
  function isFocusable(el) {
    if (el.hasAttribute("tabindex")) {
      const ti = parseInt(el.getAttribute("tabindex"), 10);
      if (Number.isFinite(ti)) return true; // >=0 reachable; <0 programmatically focusable
    }
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "hidden") return false;
      return !el.disabled;
    }
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.tagName === "BUTTON") {
      return !el.disabled;
    }
    if (el.tagName === "A" || el.tagName === "AREA") {
      return el.hasAttribute("href");
    }
    if (el.tagName === "SUMMARY" || el.tagName === "DETAILS" || el.tagName === "DIALOG") {
      return true;
    }
    if (el.tagName === "IFRAME") return true;
    if (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") return true;
    return false;
  }

  // ----- APG pattern inference -----
  function inferApg(role, el) {
    if (!role) return null;
    if (role === "tab") return "tabs";
    if (role === "dialog" || role === "alertdialog") return "dialog";
    if (role === "listbox" || role === "option") return "listbox";
    if (role === "menu" || role === "menubar" || role === "menuitem" ||
        role === "menuitemcheckbox" || role === "menuitemradio") return "menu";
    if (role === "combobox") return "combobox";
    if (role === "tree" || role === "treeitem") return "tree";
    if (role === "grid" || role === "gridcell" || role === "row") return "grid";
    if (role === "button" && el.hasAttribute("aria-expanded")) return "disclosure";
    if (role === "heading" && el.hasAttribute("aria-expanded")) return "accordion";
    return null;
  }

  // ----- walk -----
  let order = 0;
  function describe(el) {
    const role = resolveRole(el);
    const { name, source } = resolveName(el);
    return {
      domOrder: order++,
      tag: el.tagName.toLowerCase(),
      elementId: el.id || null,
      role: role || "presentation",
      name: name,
      nameSource: source,
      states: resolveStates(el),
      properties: resolveProperties(el),
      apgPattern: inferApg(role || "", el),
      focusable: isFocusable(el),
      visibility: resolveVisibility(el),
      children: [],
    };
  }

  // ----- visibility -----
  // PR-8e: a static analysis of visibility is required so the declared
  // materializer's element observations can include real visibility,
  // not a hard-coded "visible". The computation is intentionally
  // light: it reads 'display', 'visibility', and the [hidden] attribute.
  // getBoundingClientRect is consulted to flag elements that are
  // completely outside the viewport as "offscreen". The root element
  // has no useful rect; we return null and let the consumer default it
  // to "visible".
  function resolveVisibility(el) {
    try {
      // The root <html>/<body> is always "visible" — never goes through
      // this path, but be defensive.
      if (!el || el.nodeType !== 1) return "visible";
      // [hidden] attribute is the canonical "this is hidden" signal
      // (matches HTML5 spec semantics).
      if (el.hasAttribute && el.hasAttribute("hidden")) return "hidden";
      const style = (typeof window !== "undefined" && window.getComputedStyle)
        ? window.getComputedStyle(el) : null;
      if (style) {
        if (style.display === "none") return "display-none";
        if (style.visibility === "hidden" || style.visibility === "collapse") return "hidden";
      }
      // Offscreen: a non-zero rect that is completely outside the
      // viewport. This catches sticky/fixed elements that are still in
      // layout but scrolled out of view.
      try {
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (r && r.width > 0 && r.height > 0) {
          const vw = (window.innerWidth || 0);
          const vh = (window.innerHeight || 0);
          if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) return "offscreen";
        }
      } catch { /* ignore — getBoundingClientRect can throw on detached nodes */ }
      return "visible";
    } catch {
      return "visible";
    }
  }

  const root = document.documentElement;
  // TreeWalker with SHOW_ELEMENT walks in document order, which for a tree
  // is also pre-order. We build a parent map then re-thread. Note that
  // TreeWalker does NOT include the root itself in its iteration; we add it
  // at the head of orderList so the build step has an entry for it.
  // Use the real DOM parentElement to build the parent map. Earlier we
  // tracked the previous yielded node as parent, which only works when the
  // tree has no sibling subtrees — for trees with siblings (e.g. two
  // buttons under the same <main>), the previous yielded node is the
  // previous sibling, not the parent. The DOM parent is authoritative.
  const parentMap = new Map();
  const orderList = [root];
  parentMap.set(root, null);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  let node;
  while ((node = walker.nextNode())) {
    parentMap.set(node, node.parentElement);
    orderList.push(node);
  }

  const created = new Map();
  const issues = [];
  for (const el of orderList) {
    let d;
    try {
      d = describe(el);
    } catch (e) {
      // Best-effort: skip elements that blow up the walker (e.g. a custom
      // accessor throwing). A missing node should not zero the whole tree.
      const tag = (el && el.tagName ? el.tagName.toLowerCase() : "unknown");
      const elementId = (el && el.id) || null;
      issues.push({
        domOrder: order,
        tag: tag,
        elementId: elementId,
        error: (e && e.message) ? String(e.message) : String(e),
      });
      d = {
        domOrder: order++,
        tag: tag,
        elementId: elementId,
        role: "presentation",
        name: "",
        nameSource: "content",
        states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
        properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
        apgPattern: null,
        focusable: false,
        children: [],
      };
    }
    created.set(el, d);
    const p = parentMap.get(el);
    if (p && created.has(p)) {
      created.get(p).children.push(d);
    }
  }

  const top = created.get(root) || null;
  return { root: top, count: orderList.length, issues: issues };
}`;

/**
 * Build an `AxNode` from a walker node, registering it in the graph under
 * `ax:<pageId>:<elementId>` when the element has an `id`, otherwise
 * `ax:<pageId>:n<domOrder>`. The pageId here is the full `page:<url>` form
 * which matches the existing orchestrator convention.
 */
function buildAxNode(
  pageNodeId: string,
  n: AxTreeNode,
  index: number,
  parentAxId: string | null,
): AxNode {
  const id = n.elementId
    ? `ax:${pageNodeId}:${n.elementId}`
    : `ax:${pageNodeId}:n${index}`;
  return {
    id,
    type: "ax-node",
    pageId: pageNodeId,
    role: n.role as AxRole,
    name: n.name,
    nameSource: n.nameSource,
    states: n.states,
    properties: n.properties,
    apgPattern: n.apgPattern,
    focusable: n.focusable,
    visibility: n.visibility ?? "visible",
    inPageDomOrder: n.domOrder,
    parentAxId,
    provenance: STRUCTURE_PROVENANCE,
  };
}

/**
 * Resolve an `aria-controls`/`describedby`/etc id-reference against the axId
 * space. We translate by element id (because the walker records `elementId`
 * and we used `ax:<pageId>:<elementId>` as the id). If the target element
 * has no `id`, we can't resolve — return null and skip the edge.
 */
function refToAxId(pageNodeId: string, ref: string): string | null {
  if (!ref) return null;
  return `ax:${pageNodeId}:${ref}`;
}

/**
 * Emit one edge of `kind` from `fromAxId` to `toAxId`. Returns 1 on success,
 * 0 on failure. The id format matches the orchestrator's
 * `edge:<from>-><to>:<kind>` convention.
 */
function emitEdge(
  graph: { upsertEdge: (e: Edge) => void },
  fromAxId: string,
  toAxId: string,
  kind: EdgeKind,
): number {
  if (!fromAxId || !toAxId) return 0;
  const edge: Edge = {
    id: `edge:${fromAxId}->${toAxId}:${kind}`,
    type: "edge",
    from: fromAxId,
    to: toAxId,
    kind,
    provenance: STRUCTURE_PROVENANCE,
  };
  graph.upsertEdge(edge);
  return 1;
}

/**
 * The extractor — a single Extractor that:
 *   1. Runs the in-page walker
 *   2. Flattens the returned tree and writes one AxNode per element
 *   3. Emits edges for the tracked aria-* / declarative-relation kinds
 *   4. Sets `pageNode.axTreeRef` so the page links back to the tree root
 *   5. Logs a one-line summary
 */
export const structuralExtractor: Extractor = {
  name: "structure",

  async run({ graph, page, pageNode, log }) {
    const t0 = Date.now();

    // 1. Run the walker in the page. The walker is an arrow that takes one
    //    arg (currently unused; reserved for future walk-config). BiDi
    //    `callFunction` requires we pass it as a string.
    const result = await page.script.callFunction<WalkResult>(page.target, WALKER_FN, []);

    if (!result || !result.root) {
      log(`  [structure] ax-nodes=0 edges=0 (walker returned no tree)`);
      return { produced: false, durationMs: Date.now() - t0 };
    }

    // 2. Flatten pre-order (document order) so `inPageDomOrder` is dense and
    //    the order-based axIds are stable across re-runs. We also carry the
    //    index of each node's parent in `parentIndex` so we can later emit
    //    `a11y:child-of` edges (per ED-04) without re-walking the tree.
    //    ED-04: the a11y tree is a tree — every non-root ax-node has exactly
    //    one parent, and the parent pointer lives on the node itself.
    const flat: AxTreeNode[] = [];
    const parentIndex: Array<number | null> = [];
    (function walk(n: AxTreeNode, parentIdx: number | null) {
      const myIdx = flat.length;
      flat.push(n);
      parentIndex.push(parentIdx);
      for (const c of n.children) walk(c, myIdx);
    })(result.root, null);

    // 3. Build ids: explicit `elementId` wins; otherwise use n<domOrder>.
    const pageNodeId = pageNode.id; // "page:https://..."

    let edgeCount = 0;

    for (let i = 0; i < flat.length; i++) {
      const n = flat[i]!;
      const pIdx = parentIndex[i]!;
      // The parent's axId is the axId of the flat[pIdx] node. We have to
      // build it the same way `buildAxNode` does (id format depends on
      // elementId vs. domOrder), so resolve it inline. pIdx === null means
      // this is the document root.
      const parentAxId =
        pIdx === null
          ? null
          : (() => {
              const p = flat[pIdx]!;
              return p.elementId
                ? `ax:${pageNodeId}:${p.elementId}`
                : `ax:${pageNodeId}:n${pIdx}`;
            })();
      const ax = buildAxNode(pageNodeId, n, i, parentAxId);
      graph.upsertAx(ax);

      // a11y:child-of edge: parent → child (ED-04). Emitted only for
      // non-root nodes. The reverse lookup (parent of a node) is provided
      // by `AxNode.parentAxId` and by `g.edgesTo(child, "a11y:child-of")`.
      if (parentAxId !== null) {
        edgeCount += emitEdge(graph, parentAxId, ax.id, "a11y:child-of");
      }

      // aria-controls edges
      for (const ref of n.properties.controls) {
        const target = refToAxId(pageNodeId, ref);
        if (target) edgeCount += emitEdge(graph, ax.id, target, "aria-controls");
      }
      // aria-describedBy edges
      for (const ref of n.properties.describedBy) {
        const target = refToAxId(pageNodeId, ref);
        if (target) edgeCount += emitEdge(graph, ax.id, target, "aria-describedBy");
      }
      // aria-labelledBy edges
      for (const ref of n.properties.labelledBy) {
        const target = refToAxId(pageNodeId, ref);
        if (target) edgeCount += emitEdge(graph, ax.id, target, "aria-labelledBy");
      }
    }

    // 4. Second in-page pass for relations that are cheap and don't justify
    //    bloating the main walker payload: aria-owns, aria-flowsTo,
    //    commandfor, popovertarget, and <a href>. This keeps the main
    //    walker focused on the per-element a11y tree and avoids re-walking
    //    the document. We only invoke it if the first pass produced at
    //    least one element with an `id` (i.e. edges would be resolvable).
    const hasAnyId = flat.some((n) => n.elementId !== null);
    if (hasAnyId) {
      const extras = await page.script.callFunction<Array<{
        fromId: string; toId: string; kind: EdgeKind;
      }>>(page.target, EXTRACT_EDGES_FN, []);

      for (const e of extras) {
        const from = `ax:${pageNodeId}:${e.fromId}`;
        const to = e.kind === "link"
          ? `ax:${pageNodeId}:href:${e.toId}`
          : `ax:${pageNodeId}:${e.toId}`;
        edgeCount += emitEdge(graph, from, to, e.kind);
      }
    }

    // 5. Set the page's axTreeRef. Root is the first (document-order) node.
    const rootAxId = flat.length > 0
      ? (flat[0]!.elementId
          ? `ax:${pageNodeId}:${flat[0]!.elementId}`
          : `ax:${pageNodeId}:n0`)
      : `ax:${pageNodeId}:empty`;
    graph.upsertPage({
      ...pageNode,
      axTreeRef: { rootAxId, provenance: STRUCTURE_PROVENANCE },
    });

    if (result.issues && result.issues.length > 0) {
      log(`  [structure] WARNING: ${result.issues.length} element(s) had extraction errors (degraded to presentation fallback)`);
      for (const iss of result.issues) {
        if (typeof (graph as any).recordExtractionWarning === "function") {
          (graph as any).recordExtractionWarning(pageNodeId, {
            tag: iss.tag,
            elementId: iss.elementId,
            error: iss.error,
          });
        }
      }
    }

    log(`  [structure] ax-nodes=${flat.length} edges=${edgeCount}`);

    return {
      produced: flat.length > 0,
      durationMs: Date.now() - t0,
      issues: result.issues,
    };
  },
};

/**
 * Second-pass walker that returns only the relations the main walker omits:
 * aria-owns, aria-flowsto, commandfor, popovertarget, and <a href> link edges.
 * Kept separate so the main walker payload stays compact and serializable.
 *
 * Like the main walker, this is a function declaration that the BiDi
 * `callFunction` API will invoke (with no args). The shape mirrors the
 * walker: `(_arg) => { ... return out; }` so the same test harness works
 * for both.
 *
 * Returns one entry per (fromId, toId, kind) tuple. The `toId` for `link`
 * edges is the href string verbatim (caller encodes it as `href:<href>` to
 * mark it as not yet resolved to an axId).
 */
export const EXTRACT_EDGES_FN = `(_arg) => {
  const out = [];
  const all = document.querySelectorAll("[id]");
  for (const el of all) {
    const fromId = el.id;
    if (!fromId) continue;
    const owns = el.getAttribute("aria-owns");
    if (owns) {
      for (const t of owns.trim().split(/\\s+/).filter(Boolean)) {
        out.push({ fromId: fromId, toId: t, kind: "aria-owns" });
      }
    }
    const flows = el.getAttribute("aria-flowsto");
    if (flows) {
      for (const t of flows.trim().split(/\\s+/).filter(Boolean)) {
        out.push({ fromId: fromId, toId: t, kind: "aria-flowsTo" });
      }
    }
    const cmd = el.getAttribute("commandfor");
    if (cmd) {
      out.push({ fromId: fromId, toId: cmd, kind: "commandfor" });
    }
    const pop = el.getAttribute("popovertarget");
    if (pop) {
      out.push({ fromId: fromId, toId: pop, kind: "popovertarget" });
    }
    if (el.tagName === "A") {
      const href = el.getAttribute("href");
      if (href) {
        out.push({ fromId: fromId, toId: href, kind: "link" });
      }
    }
  }
  return out;
}`;

/**
 * Test-exported helpers. Imported by `structural.test.ts` so the JS walker
 * logic can be unit-tested against a hand-built minimal DOM.
 */
export const __test = { WALKER_FN, EXTRACT_EDGES_FN };
