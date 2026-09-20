import { describe, it, expect } from "vitest";
import {
  normalizeAndroidNode,
  normalizeIOSNode,
  mapAndroidClassToRole,
  mapIOSTypeToRole,
  type RawAndroidNode,
  type RawIOSNode,
} from "../../src/substrate/mobile-normalizer.js";

describe("Mobile Accessibility Normalizer (NexusOS)", () => {
  describe("Role Mapping", () => {
    it("maps Android classes to ARIA equivalent roles", () => {
      expect(mapAndroidClassToRole("android.widget.Button")).toBe("button");
      expect(mapAndroidClassToRole("android.widget.EditText")).toBe("textbox");
      expect(mapAndroidClassToRole("android.widget.Switch")).toBe("switch");
      expect(mapAndroidClassToRole("androidx.recyclerview.widget.RecyclerView")).toBe("list");
      expect(mapAndroidClassToRole("android.widget.TextView", false)).toBe("text");
      expect(mapAndroidClassToRole("android.widget.TextView", true)).toBe("button");
    });

    it("maps iOS element types to ARIA equivalent roles", () => {
      expect(mapIOSTypeToRole("XCUIElementTypeButton")).toBe("button");
      expect(mapIOSTypeToRole("XCUIElementTypeTextField")).toBe("textbox");
      expect(mapIOSTypeToRole("XCUIElementTypeSwitch")).toBe("switch");
      expect(mapIOSTypeToRole("XCUIElementTypeTable")).toBe("list");
      expect(mapIOSTypeToRole("XCUIElementTypeCell")).toBe("listitem");
      expect(mapIOSTypeToRole("XCUIElementTypeSheet")).toBe("dialog");
    });
  });

  describe("Android Tree Normalization", () => {
    it("normalizes nested Android view hierarchy into canonical AxTreeNode", () => {
      const rawTree: RawAndroidNode = {
        className: "android.widget.LinearLayout",
        children: [
          {
            className: "android.widget.TextView",
            text: "Account Balance",
            resourceId: "com.bank.app:id/title",
          },
          {
            className: "android.widget.Button",
            text: "Transfer Funds",
            resourceId: "com.bank.app:id/btn_transfer",
            clickable: true,
            enabled: true,
          },
          {
            className: "android.widget.Switch",
            contentDescription: "Enable biometric login",
            checked: true,
            enabled: true,
          },
        ],
      };

      const normalized = normalizeAndroidNode(rawTree);

      expect(normalized.domOrder).toBe(0);
      expect(normalized.role).toBe("generic");
      expect(normalized.children.length).toBe(3);

      const [header, button, toggle] = normalized.children;

      expect(header?.role).toBe("text");
      expect(header?.name).toBe("Account Balance");
      expect(header?.domOrder).toBe(1);

      expect(button?.role).toBe("button");
      expect(button?.name).toBe("Transfer Funds");
      expect(button?.states.disabled).toBe(false);
      expect(button?.domOrder).toBe(2);

      expect(toggle?.role).toBe("switch");
      expect(toggle?.name).toBe("Enable biometric login");
      expect(toggle?.states.checked).toBe(true);
      expect(toggle?.domOrder).toBe(3);
    });
  });

  describe("iOS Tree Normalization", () => {
    it("normalizes nested iOS element hierarchy into canonical AxTreeNode", () => {
      const rawTree: RawIOSNode = {
        type: "XCUIElementTypeWindow",
        children: [
          {
            type: "XCUIElementTypeNavigationBar",
            title: "Settings",
          },
          {
            type: "XCUIElementTypeTable",
            children: [
              {
                type: "XCUIElementTypeCell",
                label: "Dark Mode",
                children: [
                  {
                    type: "XCUIElementTypeSwitch",
                    identifier: "switch_dark_mode",
                    value: "1",
                    enabled: true,
                  },
                ],
              },
            ],
          },
        ],
      };

      const normalized = normalizeIOSNode(rawTree);

      expect(normalized.domOrder).toBe(0);
      expect(normalized.children.length).toBe(2);

      const [nav, table] = normalized.children;
      expect(nav?.role).toBe("navigation");
      expect(nav?.name).toBe("Settings");

      expect(table?.role).toBe("list");
      const cell = table?.children[0];
      expect(cell?.role).toBe("listitem");
      expect(cell?.name).toBe("Dark Mode");

      const switchEl = cell?.children[0];
      expect(switchEl?.role).toBe("switch");
      expect(switchEl?.elementId).toBe("switch_dark_mode");
      expect(switchEl?.states.checked).toBe(true);
    });
  });
});
