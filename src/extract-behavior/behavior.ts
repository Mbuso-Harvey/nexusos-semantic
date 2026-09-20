/**
 * Stage 8: behavior extraction — the WebMCP-shaped capability layer.
 *
 * Plan section 8. WebMCP is not available in Firefox 154, so this extractor
 * uses the **fallback catalog** (section 8.2): for every interactive element
 * on the page it synthesizes a capability whose binding points back to the
 * element's ax-node, and whose input/output schema is inferred from the
 * element's role. Capabilities hand-declared by the page author via
 * `/webmcp.json` (if served) are merged in with declared-wins precedence.
 *
 * Pipeline:
 *  1. Run a single callFunction that returns:
 *       - `declared`: parsed contents of /webmcp.json, or null if 404
 *       - `elements`: array of ElementHint (axId, role, name, tagName, id,
 *         hasDataCap, inputKeys) for every interactive element
 *  2. Upsert each declared capability with source "webmcp".
 *  3. For every element not already covered by a declared name, synthesize
 *     a fallback capability and upsert it.
 *  4. Log a one-line summary.
 *
 * Security tier is computed by the existing `tierForCapability` classifier
 * so a button with `aria-label="Delete account"` is correctly promoted to
 * CONFIRM (test #5).
 */
import type { Graph } from "../graph/graph.js";
import type { Page } from "../bidi-client/page.js";
import type {
  PageNode,
  Capability,
  CapabilityBinding,
  Provenance,
} from "../graph/types.js";
import { tierForCapability } from "../graph/security.js";
import type { Extractor, ExtractorContext } from "../crawler/orchestrator.js";

// ----- Hints emitted by the page-side walk -----

export interface ElementHint {
  /** axId assigned on the page side (matches the structural extractor's scheme). */
  axId: string;
  /** Accessible role (button, link, textbox, etc.). */
  role: string;
  /** Accessible name (aria-label, labelledby, text content, etc.). */
  name: string;
  /** Lowercase HTML tag name. */
  tagName: string;
  /** Element id, or null. */
  id: string | null;
  /** True if the element has a `data-cap` attribute (preferred selector hook). */
  hasDataCap: boolean;
  /**
   * For form-like roles: a list of synthetic input keys this element
   * exposes. Always `["value"]` for textbox/searchbox/combobox/listbox,
   * `["checked"]` for checkbox/switch, plus the value-enum for selects.
   */
  inputKeys: string[];
  /**
   * For select/listbox: the option values. Combined into the inputSchema
   * enum by the host-side synthesizer.
   */
  optionValues?: string[];
}

export interface DeclaredCapabilityShape {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
  outputSchema?: Record<string, any>;
  binding?: { kind?: string; axId?: string; selector?: string };
  security?: string;
  confirmOnAct?: boolean;
}

interface WebMcpFile {
  version?: string;
  tools?: DeclaredCapabilityShape[];
}

interface WalkResult {
  declared: DeclaredCapabilityShape[] | null;
  elements: ElementHint[];
}

// ----- Page-side function (serialized via callFunction) -----
//
// Runs in the page. The function body is self-contained (no closure over
// outer JS) because BiDi deserializes it in the target realm.
//
// IMPORTANT: keep this body deterministic. BiDi re-serializes the result via
// its RemoteValue protocol, so we return plain JSON-shaped data only.
const WALK_FN_BODY = `async (pageNodeId) => {
  const out = { declared: null, elements: [] };
  // 1) Pull declared capabilities, if the page served /webmcp.json.
  try {
    const r = await fetch('/webmcp.json', { credentials: 'same-origin' });
    if (r && r.ok) {
      const j = await r.json();
      if (j && Array.isArray(j.tools)) {
        out.declared = j.tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          binding: t.binding,
          security: t.security,
          confirmOnAct: t.confirmOnAct,
        }));
      }
    }
  } catch (e) { /* 404 or CORS — declared stays null */ }

  // 2) Walk every interactive element exactly once.
  const sel = 'button, a, [role=button], [role=link], [role=menuitem], [role=tab], input, select, textarea';
  const all = document.querySelectorAll(sel);
  let counter = 0;
  for (const el of all) {
    const explicitId = el.id ? ('ax:' + pageNodeId + ':' + el.id) : null;
    const axId = explicitId ?? ('ax:' + pageNodeId + ':n' + (counter++));
    const tagName = (el.tagName || '').toLowerCase();
    const role = (
      el.getAttribute('role') ||
      (tagName === 'button' ? 'button'
       : tagName === 'a' ? 'link'
       : tagName === 'select' ? 'combobox'
       : tagName === 'textarea' ? 'textbox'
       : (el.getAttribute('type') === 'checkbox' ? 'checkbox'
          : el.getAttribute('type') === 'radio' ? 'radio'
          : (tagName === 'input' ? 'textbox' : '')))
    ).toLowerCase();
    const name = (el.getAttribute('aria-label')
      || el.getAttribute('aria-labelledby')
      || (el.getAttribute('placeholder') || '')
      || (el.textContent || '').trim()
      || el.getAttribute('title')
      || '').slice(0, 200);
    const hasDataCap = el.hasAttribute('data-cap');
    const id = el.id || null;
    const inputKeys = [];
    let optionValues;
    if (role === 'textbox' || role === 'searchbox') inputKeys.push('value');
    else if (role === 'checkbox' || role === 'switch') inputKeys.push('checked');
    else if (role === 'combobox' || role === 'listbox' || tagName === 'select') {
      inputKeys.push('value');
      if (tagName === 'select') {
        optionValues = Array.from(el.options || []).map(o => o.value);
      } else {
        optionValues = Array.from(el.querySelectorAll('[role=option]'))
          .map(o => o.getAttribute('data-value') || (o.textContent || '').trim())
          .filter(Boolean);
      }
    }
    const hint = { axId, role, name, tagName, id, hasDataCap, inputKeys };
    if (optionValues) hint.optionValues = optionValues;
    out.elements.push(hint);
  }
  return out;
}`;

// ----- The Extractor -----

export interface BehaviorExtractorDeps {
  graph: Graph;
  page: Page;
  pageNode: PageNode;
  log: (msg: string) => void;
}

export interface BehaviorExtractorResult {
  declared: number;
  synthesized: number;
  total: number;
}

const BEHAVIOR_PROVENANCE: Provenance = "aria:fallback-catalog";

/** Run the behavior extractor. Exposed for tests so they can pass a stub Page. */
export async function runBehaviorExtractor(deps: BehaviorExtractorDeps): Promise<BehaviorExtractorResult> {
  const { graph, page, pageNode, log } = deps;
  const t0 = Date.now();

  const walk = await page.script.callFunction<WalkResult>(
    page.target,
    // The walker is a self-contained async arrow that takes pageNodeId as
    // its only argument. awaitPromise: true tells BiDi to resolve the
    // returned Promise rather than handing us the Promise object.
    WALK_FN_BODY,
    [pageNode.id],
    { awaitPromise: true },
  );

  // 1) Upsert declared capabilities, if any.
  const declaredNames = new Set<string>();
  let declaredCount = 0;
  if (walk.declared) {
    for (const d of walk.declared) {
      if (!d.name) continue;
      const cap = toDeclaredCapability(d, pageNode);
      graph.upsertCapability(cap);
      declaredNames.add(d.name);
      declaredCount++;
    }
  }

  // 2) Synthesize fallback capabilities for every interactive element.
  let synthesized = 0;
  for (const hint of walk.elements) {
    if (declaredNames.has(slugify(hint.name))) continue;
    const cap = synthesizeCapability(hint, pageNode);
    graph.upsertCapability(cap);
    synthesized++;
  }

  const ms = Date.now() - t0;
  log(`  [behavior] declared=${declaredCount} synthesized=${synthesized} total=${declaredCount + synthesized} (${ms}ms)`);
  return { declared: declaredCount, synthesized, total: declaredCount + synthesized };
}

/** Default Extractor wiring for the orchestrator. */
export const extractBehavior: Extractor = {
  name: "behavior",
  async run(ctx: ExtractorContext): Promise<{ produced: boolean; durationMs: number }> {
    const t0 = Date.now();
    const r = await runBehaviorExtractor({
      graph: ctx.graph,
      page: ctx.page,
      pageNode: ctx.pageNode,
      log: ctx.log,
    });
    return { produced: r.total > 0, durationMs: Date.now() - t0 };
  },
};

// ----- Helpers (exported so tests can call them in isolation) -----

/**
 * Build a Capability from a declared entry in /webmcp.json. Declared entries
 * keep their input/output schema verbatim. Security is taken from the JSON
 * if present, otherwise re-evaluated by `tierForCapability` from the name
 * so destructive verbs still get promoted to CONFIRM.
 */
export function toDeclaredCapability(d: DeclaredCapabilityShape, pageNode: PageNode): Capability {
  const security = (d.security as Capability["security"]) ??
    tierForCapability({ role: "button", name: d.name, inputKeys: Object.keys(d.inputSchema ?? {}) });
  const axId = d.binding?.axId ?? `cap-binding:${d.name}`;
  const selector = d.binding?.selector ?? `[data-cap="${d.name}"]`;
  return {
    id: `cap:${d.name}:declared`,
    type: "capability",
    name: d.name,
    description: d.description ?? d.name,
    inputSchema: d.inputSchema ?? {},
    outputSchema: d.outputSchema ?? {},
    source: "webmcp",
    binding: { kind: "ax-node", axId, selector },
    security,
    provenance: "declared:webmcp.json",
    pageId: pageNode.id,
  };
}

/**
 * Build a Capability from an ElementHint. The `name` is a kebab-cased slug
 * of the accessible name; the description is the raw name. Roles that take
 * input get the right inputSchema per the spec.
 */
export function synthesizeCapability(hint: ElementHint, pageNode: PageNode): Capability {
  const slug = slugify(hint.name) || "element";
  // The counter suffix is used to disambiguate collisions on a page; the
  // host wires the actual counter (so the same hint in tests gets a
  // stable id).
  const capName = hint.hasDataCap && hint.id ? hint.id : slug;
  const inputSchema = inputSchemaFor(hint);
  const binding: CapabilityBinding = {
    kind: "ax-node",
    axId: hint.axId,
    selector: buildSelector(hint),
  };
  return {
    id: `cap:${capName}:${stableHash(hint.axId)}`,
    type: "capability",
    name: capName,
    description: hint.name || capName,
    inputSchema,
    outputSchema: {},
    source: "fallback",
    binding,
    security: tierForCapability({
      role: hint.role || "button",
      name: hint.name,
      inputKeys: Object.keys(inputSchema),
    }),
    provenance: BEHAVIOR_PROVENANCE,
    pageId: pageNode.id,
  };
}

function inputSchemaFor(hint: ElementHint): Record<string, any> {
  const role = hint.role;
  // textbox / searchbox: free-form text
  if (role === "textbox" || role === "searchbox") {
    return { value: { type: "string" } };
  }
  // combobox / listbox / <select>: text with optional enum constraint
  if (role === "combobox" || role === "listbox" || hint.tagName === "select") {
    if (hint.optionValues && hint.optionValues.length > 0) {
      return { value: { type: "string", enum: hint.optionValues } };
    }
    return { value: { type: "string" } };
  }
  if (role === "checkbox" || role === "switch") {
    return { checked: { type: "boolean" } };
  }
  if (role === "button" || role === "link" || role === "menuitem" || role === "tab") {
    return {};
  }
  // Default: include whatever inputKeys the hint advertised.
  if (hint.inputKeys.length > 0) {
    return Object.fromEntries(hint.inputKeys.map((k) => [k, { type: "string" }]));
  }
  return {};
}

/**
 * Build the most-specific-yet-minimal CSS selector for the element. The
 * caller passes in the path hints (`id`, `hasDataCap`, `tagName`) plus the
 * ancestor chain (from page-side walk) so we don't have to re-walk the
 * DOM in the host.
 */
export function buildSelector(hint: ElementHint & {
  /**
   * Ancestor role or id hints, innermost first. Each entry is
   * `{id?, role?, tagName?}`. We use the first one that has an `id` or
   * `role` and stop there; everything deeper is relative to it.
   */
  ancestors?: Array<{ id?: string | null; role?: string | null; tagName?: string | null; index?: number }>;
}): string {
  // Prefer element id.
  if (hint.id) return `#${cssEscape(hint.id)}`;
  // Then the data-cap hook the page author may have set.
  if (hint.hasDataCap) return `${hint.tagName}[data-cap]`;
  // Walk the ancestor chain. Prefer an ancestor with an `id` (most stable
  // hook) over one with a `role` (less stable but still scoped).
  const parts: string[] = [];
  if (hint.ancestors) {
    // First pass: look for the nearest ancestor with an id.
    const idHook = hint.ancestors.find((a) => a.id);
    if (idHook && idHook.id) {
      parts.push(`#${cssEscape(idHook.id)}`);
    } else {
      // Second pass: fall back to the nearest ancestor with a role.
      const roleHook = hint.ancestors.find((a) => a.role);
      if (roleHook && roleHook.role) {
        const tag = roleHook.tagName ?? "*";
        const idx = typeof roleHook.index === "number" ? `:nth-of-type(${roleHook.index + 1})` : "";
        parts.push(`${tag}[role="${roleHook.role}"]${idx}`);
      }
    }
  }
  // Add the element itself with nth-of-type if we don't have a stable
  // parent hook.
  const leaf = `${hint.tagName || "*"}${parts.length === 0 ? ":nth-of-type(1)" : ""}`;
  return parts.length === 0 ? leaf : `${parts.join(" > ")} > ${leaf}`;
}

/** Stable, kebab-cased, max-32-char slug for an accessible name. */
export function slugify(name: string): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** Tiny stable hash so the same axId always maps to the same cap counter. */
function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // FNV-1a, return 32-bit unsigned.
  return h >>> 0;
}

/** Minimal CSS.escape polyfill — we never want an unescaped id breaking selectors. */
function cssEscape(s: string): string {
  if (typeof (globalThis as any).CSS !== "undefined" && typeof (globalThis as any).CSS.escape === "function") {
    return (globalThis as any).CSS.escape(s);
  }
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}
