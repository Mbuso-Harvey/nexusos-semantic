/**
 * Mobile Accessibility Normalizer — NexusOS.
 *
 * Translates raw Android AccessibilityNodeInfo dumps and iOS XCUITest
 * element hierarchies into canonical, platform-agnostic AxTreeNode structures.
 */
import type { AxTreeNode } from "../extract-structure/structural.js";
import type { AxStates, AxProperties } from "../graph/types.js";

export interface RawAndroidNode {
  className: string;
  text?: string | null;
  contentDescription?: string | null;
  resourceId?: string | null;
  clickable?: boolean;
  checkable?: boolean;
  checked?: boolean;
  enabled?: boolean;
  focused?: boolean;
  scrollable?: boolean;
  selected?: boolean;
  bounds?: { left: number; top: number; right: number; bottom: number };
  children?: RawAndroidNode[];
}

export interface RawIOSNode {
  type: string;
  label?: string | null;
  title?: string | null;
  identifier?: string | null;
  value?: string | number | boolean | null;
  enabled?: boolean;
  selected?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  children?: RawIOSNode[];
}

/**
 * Maps Android class names to canonical ARIA-equivalent roles.
 */
export function mapAndroidClassToRole(className?: string | null, clickable: boolean = false): string {
  const cls = (className ?? "").toLowerCase();
  if (cls.includes("button") || cls.includes("imagebutton")) return "button";
  if (cls.includes("edittext")) return "textbox";
  if (cls.includes("checkbox")) return "checkbox";
  if (cls.includes("switch") || cls.includes("togglebutton")) return "switch";
  if (cls.includes("radiobutton")) return "radio";
  if (cls.includes("radiogroup")) return "radiogroup";
  if (cls.includes("recyclerview") || cls.includes("listview")) return "list";
  if (cls.includes("tablayout") || cls.includes("tabbar")) return "tablist";
  if (cls.includes("dialog") || cls.includes("alertdialog")) return "dialog";
  if (cls.includes("textview")) return clickable ? "button" : "text";
  if (cls.includes("imageview")) return clickable ? "button" : "img";
  return clickable ? "button" : "generic";
}

/**
 * Maps iOS XCUIElement types to canonical ARIA-equivalent roles.
 */
export function mapIOSTypeToRole(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("window")) return "window";
  if (t.includes("button")) return "button";
  if (t.includes("textfield") || t.includes("securetextfield")) return "textbox";
  if (t.includes("switch")) return "switch";
  if (t.includes("table") || t.includes("collectionview")) return "list";
  if (t.includes("cell")) return "listitem";
  if (t.includes("tabbar") || t.includes("segmentedcontrol")) return "tablist";
  if (t.includes("sheet") || t.includes("alert")) return "dialog";
  if (t.includes("navigationbar")) return "navigation";
  if (t.includes("statictext")) return "text";
  if (t.includes("image")) return "img";
  return "generic";
}

/**
 * Recursively normalizes an Android accessibility tree into an AxTreeNode.
 */
export function normalizeAndroidNode(raw: RawAndroidNode, counter = { order: 0 }): AxTreeNode {
  const order = counter.order++;
  const className = raw.className || (raw as any).class || "";
  const resourceId = raw.resourceId || (raw as any).resource_id || (raw as any).id || null;
  const role = mapAndroidClassToRole(className, raw.clickable ?? false);
  const name = raw.contentDescription || raw.text || resourceId || "";
  const nameSource = raw.contentDescription ? "aria-label" : raw.text ? "text-content" : "implicit";

  const states: AxStates = {
    disabled: raw.enabled === false,
    checked: raw.checked ?? null,
    selected: raw.selected ?? null,
    expanded: null,
    pressed: null,
    busy: false,
    open: null,
    current: null,
  };

  const properties: AxProperties = {
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
    valueText: null,
  };

  const children: AxTreeNode[] = (raw.children ?? []).map((c) => normalizeAndroidNode(c, counter));

  return {
    domOrder: order,
    tag: (className.split(".").pop() || "view").toLowerCase(),
    elementId: resourceId,
    role,
    name,
    nameSource,
    states,
    properties,
    apgPattern: null,
    focusable: raw.focused ?? false,
    visibility: "visible",
    children,
  };
}

/**
 * Recursively normalizes an iOS XCUITest accessibility tree into an AxTreeNode.
 */
export function normalizeIOSNode(raw: RawIOSNode, counter = { order: 0 }): AxTreeNode {
  const order = counter.order++;
  const role = mapIOSTypeToRole(raw.type);
  const name = raw.label || raw.title || raw.identifier || "";
  const nameSource = raw.label ? "aria-label" : raw.title ? "text-content" : "implicit";

  const isChecked = raw.value === "1" || raw.value === true || raw.value === 1;

  const states: AxStates = {
    disabled: raw.enabled === false,
    checked: isChecked,
    selected: raw.selected ?? null,
    expanded: null,
    pressed: null,
    busy: false,
    open: null,
    current: null,
  };

  const properties: AxProperties = {
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
    valueText: null,
  };

  const children: AxTreeNode[] = (raw.children ?? []).map((c) => normalizeIOSNode(c, counter));

  return {
    domOrder: order,
    tag: raw.type.replace(/^XCUIElementType/, "").toLowerCase(),
    elementId: raw.identifier ?? null,
    role,
    name,
    nameSource,
    states,
    properties,
    apgPattern: null,
    focusable: true,
    visibility: "visible",
    children,
  };
}
