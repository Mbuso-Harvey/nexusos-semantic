/**
 * Web CDP Substrate Surface — NexusOS.
 *
 * Implements the universal `SubstrateSurface` contract over Chrome DevTools
 * Protocol so Chrome is reachable through the same substrate-neutral MCP tools
 * as Firefox/BiDi, desktop UIA/AX, and Android/iOS. This is an adapter only —
 * the transport (`ChromeCdpClient` / `CdpSession`) already existed; it is not
 * rebuilt here.
 *
 * CDP specifics:
 *   - route/title come from the live target descriptor (no JS needed)
 *   - screenshots use Page.captureScreenshot
 *   - the accessibility tree uses Accessibility.getFullAXTree
 *   - input uses Input.dispatchMouseEvent / Input.insertText / key events
 *   - metrics use Runtime.evaluate (innerWidth / innerHeight / devicePixelRatio)
 */
import type { ChromeCdpClient, CdpTarget, CdpSession } from "../desktop/chrome-cdp.js";
import type { Source } from "../bidi-client/input.js";
import type { AxTreeNode } from "../extract-structure/structural.js";
import type { SubstrateSurface, SubstrateKind, DisplayMetrics } from "./types.js";

/** Minimal shape of CDP Accessibility.getFullAXTree nodes we consume. */
interface CdpAxNode {
  nodeId: string;
  parentId?: string | null;
  role?: { value?: string } | string;
  name?: { value?: string } | string;
  value?: { value?: unknown } | unknown;
  description?: { value?: string } | string;
  focusable?: boolean;
  ignored?: boolean;
  childIds?: string[];
}

/** Map a CDP role string onto the canonical ARIA-role vocabulary used by AxTreeNode. */
export function mapCdpRoleToCanonical(role: string | undefined): string {
  const r = (role ?? "").toLowerCase();
  if (!r) return "generic";
  if (r === "rootwebarea" || r === "webarea") return "region";
  if (r === "statictext" || r === "inlinetextbox") return "text";
  if (r === "button" || r === "buttonandsplitbutton") return "button";
  if (r === "checkbox" || r === "checkbutton") return "checkbox";
  if (r === "radiobutton") return "radio";
  if (r === "combobox" || r === "popupbutton") return "combobox";
  if (r === "textbox" || r === "searchbox") return "textbox";
  if (r === "link") return "link";
  if (r === "image" || r === "imagebutton") return "img";
  if (r === "heading") return "heading";
  if (r === "list") return "list";
  if (r === "listitem" || r === "listmarker") return "listitem";
  if (r === "table" || r === "grid") return "grid";
  if (r === "row") return "row";
  if (r === "cell" || r === "gridcell") return "cell";
  if (r === "tab") return "tab";
  if (r === "tablist" || r === "tabpanel") return "tablist";
  if (r === "menubar" || r === "menu") return "menu";
  if (r === "menuitem" || r === "menuitemcheckbox" || r === "menuitemradio") return "menuitem";
  if (r === "dialog" || r === "alertdialog") return "dialog";
  if (r === "scrollbar" || r === "scrollarea") return "scrollbar";
  if (r === "slider") return "slider";
  if (r === "progressbar") return "progressbar";
  if (r === "switch") return "switch";
  if (r === "tree") return "tree";
  if (r === "treeitem") return "treeitem";
  return "generic";
}

function cdpValue(v: { value?: string } | string | undefined): string {
  if (typeof v === "string") return v;
  return v?.value ?? "";
}

/**
 * Normalize a flat CDP accessibility tree (nodes + parentId/childIds) into the
 * nested `AxTreeNode` shape used everywhere else in Nexus. Mirrors the
 * mobile/desktop normalizers: one canonical tree, one vocabulary.
 */
export function normalizeCdpAxTree(
  nodes: CdpAxNode[],
  counter: { order: number } = { order: 0 },
): AxTreeNode[] {
  const byId = new Map<string, CdpAxNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const roots = nodes.filter((n) => !n.ignored && (!n.parentId || !byId.has(n.parentId)));

  const build = (n: CdpAxNode): AxTreeNode => {
    const order = counter.order++;
    const role = mapCdpRoleToCanonical(typeof n.role === "string" ? n.role : n.role?.value);
    const name = cdpValue(typeof n.name === "string" ? n.name : (n.name as { value?: string } | undefined));
    const value = n.value && typeof n.value === "object" && "value" in (n.value as object)
      ? (n.value as { value?: unknown }).value
      : undefined;
    const focusable = n.focusable ?? (role === "button" || role === "link" || role === "textbox");
    const children = (n.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is CdpAxNode => !!c && !c.ignored)
      .map((c) => build(c));
    return {
      domOrder: order,
      tag: role,
      elementId: null,
      role,
      name,
      nameSource: name ? "text-content" : "implicit",
      states: {
        disabled: false,
        checked: typeof value === "boolean" ? value : null,
        selected: null,
        expanded: null,
        pressed: null,
        busy: false,
        open: null,
        current: null,
      },
      properties: {
        controls: [],
        describedBy: [],
        labelledBy: [],
        level: null,
        live: null,
        orientation: null,
        posInSet: null,
        setSize: null,
        valueNow: null,
        valueMin: null,
        valueMax: null,
        valueText: value !== undefined ? String(value) : null,
      },
      apgPattern: null,
      focusable,
      visibility: "visible",
      children,
    };
  };

  return roots.map((r) => build(r));
}

/** Key-name → CDP windowsVirtualKeyCode for the small set we dispatch. */
const CDP_KEY_CODES: Readonly<Record<string, number>> = Object.freeze({
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
});

/**
 * A Chrome tab exposed through the universal SubstrateSurface contract.
 * Each operation attaches a short-lived CDP session via the existing
 * `ChromeCdpClient.withSession` helper (connect → job → close).
 */
export class WebCdpSurface implements SubstrateSurface {
  readonly substrateKind: SubstrateKind = "web-cdp";
  readonly surfaceId: string;

  constructor(
    private readonly client: ChromeCdpClient,
    private readonly target: CdpTarget,
  ) {
    this.surfaceId = target.id;
  }

  /** The live target descriptor (url/title refresh on every access). */
  private async freshTarget(): Promise<CdpTarget> {
    const pages = await this.client.listPages();
    const live = pages.find((p) => p.id === this.target.id);
    return live ?? this.target;
  }

  private withSession<T>(job: (s: CdpSession) => Promise<T>): Promise<T> {
    return this.client.withSession(this.target, job);
  }

  async getRoute(): Promise<string> {
    return (await this.freshTarget()).url;
  }

  async getTitle(): Promise<string> {
    return (await this.freshTarget()).title;
  }

  async captureScreenshot(): Promise<{ data: Buffer; mimeType: string }> {
    const base64 = await this.withSession(async (s) => s.screenshot("png"));
    return { data: Buffer.from(base64, "base64"), mimeType: "image/png" };
  }

  async extractAccessibilityTree(): Promise<AxTreeNode[]> {
    try {
      const raw = await this.withSession(async (s) =>
        s.send<{ nodes: CdpAxNode[] }>("Accessibility.getFullAXTree", {}),
      );
      return raw?.nodes ? normalizeCdpAxTree(raw.nodes) : [];
    } catch {
      // Older/headless Chromium without the Accessibility domain: report an
      // empty tree rather than failing the whole inspect.
      return [];
    }
  }

  async performActions(actions: Source[]): Promise<void> {
    await this.withSession(async (s) => {
      for (const source of actions) {
        if (source.type === "pointer") {
          // BiDi pointerDown/pointerUp are position-less: the position comes
          // from the preceding pointerMove. Track it across the sequence so
          // every CDP mouse event lands at the right coordinates (a naive
          // down/up translation would press at 0,0). Button follows the BiDi
          // code: 0 = primary/left, 1 = middle, 2 = secondary/right.
          const CDP_BUTTON = ["left", "middle", "right"] as const;
          let x = 0;
          let y = 0;
          let clicks = 0;
          for (const a of source.actions) {
            if (a.type === "pointerMove") {
              x = a.x;
              y = a.y;
              await s.send("Input.dispatchMouseEvent", {
                type: "mouseMoved", x, y, button: "none",
              });
            } else if (a.type === "pointerDown") {
              clicks += 1;
              await s.send("Input.dispatchMouseEvent", {
                type: "mousePressed", x, y,
                button: CDP_BUTTON[a.button], clickCount: Math.max(clicks, 1),
              });
            } else if (a.type === "pointerUp") {
              await s.send("Input.dispatchMouseEvent", {
                type: "mouseReleased", x, y,
                button: CDP_BUTTON[a.button], clickCount: Math.max(clicks, 1),
              });
            }
            // "pause" needs no CDP event.
          }
        } else if (source.type === "key") {
          for (const a of source.actions) {
            if (a.type === "keyDown") {
              const code = CDP_KEY_CODES[a.value];
              if (code !== undefined) {
                await s.send("Input.dispatchKeyEvent", {
                  type: "rawKeyDown", key: a.value, windowsVirtualKeyCode: code,
                });
              } else {
                await s.send("Input.insertText", { text: a.value });
              }
            } else if (a.type === "keyUp" && CDP_KEY_CODES[a.value] !== undefined) {
              await s.send("Input.dispatchKeyEvent", {
                type: "keyUp", key: a.value, windowsVirtualKeyCode: CDP_KEY_CODES[a.value],
              });
            }
          }
        } else if (source.type === "wheel") {
          for (const a of source.actions) {
            await s.send("Input.dispatchMouseEvent", {
              type: "mouseWheel", x: a.x, y: a.y,
              deltaX: a.deltaX ?? 0, deltaY: a.deltaY ?? 0,
            });
          }
        }
      }
    });
  }

  async getDisplayMetrics(): Promise<DisplayMetrics> {
    const raw = await this.withSession(async (s) =>
      s.evaluate<{ width: number; height: number; density: number }>(
        "({ width: window.innerWidth, height: window.innerHeight, density: window.devicePixelRatio || 1 })",
      ),
    );
    const width = raw?.width ?? 1280;
    const height = raw?.height ?? 800;
    return {
      width,
      height,
      density: raw?.density ?? 1,
      orientation: width >= height ? "landscape" : "portrait",
      safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    };
  }
}

