/**
 * Desktop Accessibility Normalizer — NexusOS.
 * Translates Windows UI Automation and macOS AX hierarchies into AxTreeNode.
 */
import type { AxTreeNode } from "../extract-structure/structural.js";
import type { AxStates, AxProperties } from "../graph/types.js";

export interface RawWindowsUIANode {
  controlType: string;
  name?: string | null;
  automationId?: string | null;
  className?: string | null;
  isEnabled?: boolean;
  isOffscreen?: boolean;
  hasKeyboardFocus?: boolean;
  isTogglePatternOn?: boolean | null;
  isSelectionItemPatternSelected?: boolean | null;
  isExpandCollapsePatternExpanded?: boolean | null;
  value?: string | null;
  boundingRectangle?: { x: number; y: number; width: number; height: number };
  children?: RawWindowsUIANode[];
}

export interface RawMacOSAXNode {
  role: string;
  subrole?: string | null;
  title?: string | null;
  value?: string | number | boolean | null;
  identifier?: string | null;
  description?: string | null;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  expanded?: boolean | null;
  frame?: { x: number; y: number; width: number; height: number };
  children?: RawMacOSAXNode[];
}

export function mapWindowsControlToRole(controlType: string): string {
  const ct = (controlType ?? "")
    .replace(/^ControlType\./i, "")
    .replace(/^UIA_/, "")
    .replace(/ControlTypeId$/i, "")
    .toLowerCase();
  if (ct === "button") return "button";
  if (ct === "edit" || ct === "document") return "textbox";
  if (ct === "checkbox") return "checkbox";
  if (ct === "radiobutton") return "radio";
  if (ct === "combobox") return "combobox";
  if (ct === "tab") return "tablist";
  if (ct === "tabitem") return "tab";
  if (ct === "datagrid" || ct === "table") return "grid";
  if (ct === "dataitem") return "row";
  if (ct === "tree") return "tree";
  if (ct === "treeitem") return "treeitem";
  if (ct === "list") return "list";
  if (ct === "listitem") return "listitem";
  if (ct === "window") return "dialog";
  if (ct === "text") return "text";
  if (ct === "menu" || ct === "menubar") return "menu";
  if (ct === "menuitem") return "menuitem";
  if (ct === "hyperlink") return "link";
  if (ct === "slider") return "slider";
  if (ct === "progressbar") return "progressbar";
  return "generic";
}

export function mapMacOSRoleToCanonical(role: string): string {
  const r = role.replace(/^AX/, "").toLowerCase();
  if (r === "button") return "button";
  if (r === "textfield" || r === "textarea") return "textbox";
  if (r === "checkbox") return "checkbox";
  if (r === "radiobutton") return "radio";
  if (r === "popupbutton" || r === "combobox") return "combobox";
  if (r === "tabgroup") return "tablist";
  if (r === "table") return "grid";
  if (r === "row") return "row";
  if (r === "outline") return "tree";
  if (r === "outlineitem") return "treeitem";
  if (r === "list") return "list";
  if (r === "window" || r === "sheet") return "dialog";
  if (r === "statictext") return "text";
  if (r === "menu" || r === "menubar") return "menu";
  if (r === "menuitem") return "menuitem";
  if (r === "link") return "link";
  if (r === "slider") return "slider";
  if (r === "progressindicator") return "progressbar";
  return "generic";
}

export function normalizeWindowsUIANode(raw: RawWindowsUIANode, counter = { order: 0 }): AxTreeNode {
  const order = counter.order++;
  const rawAny = raw as any;
  const rawControlType = raw.controlType ?? rawAny.ControlType ?? rawAny.LocalizedControlType ?? "generic";
  const role = mapWindowsControlToRole(rawControlType);
  const name = raw.name ?? rawAny.Name ?? raw.automationId ?? rawAny.AutomationId ?? "";
  const nameSource = (raw.name ?? rawAny.Name) ? "aria-label" : "implicit";
  const rawChildren = raw.children ?? rawAny.Children ?? [];

  const isEnabled = raw.isEnabled ?? rawAny.IsEnabled;
  const isOffscreen = raw.isOffscreen ?? rawAny.IsOffscreen;

  const states: AxStates = {
    disabled: isEnabled === false,
    checked: raw.isTogglePatternOn ?? rawAny.IsTogglePatternOn ?? null,
    selected: raw.isSelectionItemPatternSelected ?? rawAny.IsSelectionItemPatternSelected ?? null,
    expanded: raw.isExpandCollapsePatternExpanded ?? rawAny.IsExpandCollapsePatternExpanded ?? null,
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
    valueText: raw.value ?? rawAny.Value ?? null,
  };

  const children: AxTreeNode[] = (Array.isArray(rawChildren) ? rawChildren : []).map((c: any) =>
    normalizeWindowsUIANode(c, counter)
  );

  return {
    domOrder: order,
    tag: (raw.className ?? rawAny.ClassName)?.toLowerCase() ?? rawControlType.toLowerCase(),
    elementId: raw.automationId ?? rawAny.AutomationId ?? null,
    role,
    name,
    nameSource,
    states,
    properties,
    apgPattern: null,
    focusable: raw.hasKeyboardFocus ?? rawAny.HasKeyboardFocus ?? true,
    visibility: isOffscreen ? "offscreen" : "visible",
    children,
  };
}

export function normalizeMacOSAXNode(raw: RawMacOSAXNode, counter = { order: 0 }): AxTreeNode {
  const order = counter.order++;
  const role = mapMacOSRoleToCanonical(raw.role);
  const name = raw.title || raw.description || raw.identifier || "";
  const nameSource = raw.title ? "text-content" : raw.description ? "aria-label" : "implicit";
  const isChecked = raw.value === 1 || raw.value === true || raw.value === "1";

  const states: AxStates = {
    disabled: raw.enabled === false,
    checked: role === "checkbox" || role === "radio" ? isChecked : null,
    selected: raw.selected ?? null,
    expanded: raw.expanded ?? null,
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
    valueNow: typeof raw.value === "number" ? raw.value : null,
    valueMin: null,
    valueMax: null,
    valueText: typeof raw.value === "string" ? raw.value : null,
  };

  const children: AxTreeNode[] = (raw.children ?? []).map((c) => normalizeMacOSAXNode(c, counter));

  return {
    domOrder: order,
    tag: raw.role.toLowerCase(),
    elementId: raw.identifier ?? null,
    role,
    name,
    nameSource,
    states,
    properties,
    apgPattern: null,
    focusable: raw.focused ?? true,
    visibility: "visible",
    children,
  };
}
