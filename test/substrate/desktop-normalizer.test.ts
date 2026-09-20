import { describe, it, expect } from "vitest";
import {
  mapWindowsControlToRole,
  mapMacOSRoleToCanonical,
  normalizeWindowsUIANode,
  normalizeMacOSAXNode,
  type RawWindowsUIANode,
  type RawMacOSAXNode,
} from "../../src/substrate/desktop-normalizer.js";

describe("Desktop Accessibility Normalizer (NexusOS)", () => {
  describe("Role Mapping", () => {
    it("maps Windows UIA control types to canonical roles", () => {
      expect(mapWindowsControlToRole("UIA_ButtonControlTypeId")).toBe("button");
      expect(mapWindowsControlToRole("Edit")).toBe("textbox");
      expect(mapWindowsControlToRole("CheckBox")).toBe("checkbox");
      expect(mapWindowsControlToRole("RadioButton")).toBe("radio");
      expect(mapWindowsControlToRole("ComboBox")).toBe("combobox");
      expect(mapWindowsControlToRole("Tab")).toBe("tablist");
      expect(mapWindowsControlToRole("TabItem")).toBe("tab");
      expect(mapWindowsControlToRole("DataGrid")).toBe("grid");
      expect(mapWindowsControlToRole("Tree")).toBe("tree");
      expect(mapWindowsControlToRole("Window")).toBe("dialog");
      expect(mapWindowsControlToRole("Menu")).toBe("menu");
      expect(mapWindowsControlToRole("MenuItem")).toBe("menuitem");
    });

    it("maps macOS AX roles to canonical roles", () => {
      expect(mapMacOSRoleToCanonical("AXButton")).toBe("button");
      expect(mapMacOSRoleToCanonical("AXTextField")).toBe("textbox");
      expect(mapMacOSRoleToCanonical("AXCheckBox")).toBe("checkbox");
      expect(mapMacOSRoleToCanonical("AXRadioButton")).toBe("radio");
      expect(mapMacOSRoleToCanonical("AXPopUpButton")).toBe("combobox");
      expect(mapMacOSRoleToCanonical("AXTabGroup")).toBe("tablist");
      expect(mapMacOSRoleToCanonical("AXTable")).toBe("grid");
      expect(mapMacOSRoleToCanonical("AXOutline")).toBe("tree");
      expect(mapMacOSRoleToCanonical("AXWindow")).toBe("dialog");
      expect(mapMacOSRoleToCanonical("AXMenu")).toBe("menu");
    });
  });

  describe("Windows UIA Tree Normalization", () => {
    it("normalizes a native Windows app hierarchy (Excel/Notepad)", () => {
      const rawTree: RawWindowsUIANode = {
        controlType: "Window",
        name: "Financial Report - Excel",
        automationId: "ExcelMainWindow",
        children: [
          {
            controlType: "Tab",
            automationId: "RibbonTabs",
            children: [
              {
                controlType: "TabItem",
                name: "Home",
                isSelectionItemPatternSelected: true,
              },
              {
                controlType: "TabItem",
                name: "Insert",
                isSelectionItemPatternSelected: false,
              },
            ],
          },
          {
            controlType: "Edit",
            name: "Formula Bar",
            automationId: "FormulaBarEdit",
            value: "=SUM(A1:A10)",
            isEnabled: true,
            hasKeyboardFocus: true,
          },
          {
            controlType: "Button",
            name: "Calculate Now",
            automationId: "btn_calculate",
            isEnabled: true,
          },
        ],
      };

      const normalized = normalizeWindowsUIANode(rawTree);

      expect(normalized.domOrder).toBe(0);
      expect(normalized.role).toBe("dialog");
      expect(normalized.name).toBe("Financial Report - Excel");
      expect(normalized.elementId).toBe("ExcelMainWindow");
      expect(normalized.children.length).toBe(3);

      const [tablist, edit, button] = normalized.children;

      expect(tablist?.role).toBe("tablist");
      expect(tablist?.children.length).toBe(2);
      expect(tablist?.children[0]?.role).toBe("tab");
      expect(tablist?.children[0]?.name).toBe("Home");
      expect(tablist?.children[0]?.states.selected).toBe(true);

      expect(edit?.role).toBe("textbox");
      expect(edit?.name).toBe("Formula Bar");
      expect(edit?.elementId).toBe("FormulaBarEdit");
      expect(edit?.properties.valueText).toBe("=SUM(A1:A10)");
      expect(edit?.focusable).toBe(true);

      expect(button?.role).toBe("button");
      expect(button?.name).toBe("Calculate Now");
      expect(button?.states.disabled).toBe(false);
    });
  });

  describe("macOS AX Tree Normalization", () => {
    it("normalizes a native macOS app hierarchy (Settings/Finder)", () => {
      const rawTree: RawMacOSAXNode = {
        role: "AXWindow",
        title: "System Settings",
        identifier: "settings_window",
        children: [
          {
            role: "AXTextField",
            description: "Search Settings",
            identifier: "search_input",
            value: "Wi-Fi",
            enabled: true,
            focused: true,
          },
          {
            role: "AXCheckBox",
            title: "Ask to join networks",
            value: 1,
            enabled: true,
          },
          {
            role: "AXPopUpButton",
            description: "Security Protocol",
            title: "WPA3 Personal",
            enabled: true,
          },
        ],
      };

      const normalized = normalizeMacOSAXNode(rawTree);

      expect(normalized.domOrder).toBe(0);
      expect(normalized.role).toBe("dialog");
      expect(normalized.name).toBe("System Settings");
      expect(normalized.children.length).toBe(3);

      const [search, checkbox, popup] = normalized.children;

      expect(search?.role).toBe("textbox");
      expect(search?.name).toBe("Search Settings");
      expect(search?.properties.valueText).toBe("Wi-Fi");

      expect(checkbox?.role).toBe("checkbox");
      expect(checkbox?.name).toBe("Ask to join networks");
      expect(checkbox?.states.checked).toBe(true);

      expect(popup?.role).toBe("combobox");
      expect(popup?.name).toBe("WPA3 Personal");
    });
  });
});
