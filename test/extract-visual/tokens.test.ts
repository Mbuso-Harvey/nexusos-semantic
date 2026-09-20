import { describe, it, expect } from "vitest";
import {
  parseCssColor,
  colorDistanceRgb,
  parseDimensionPx,
  normalizeTokenEntries,
  bindTokensToNode,
  detectTokenDrifts,
  exportDtcgBundle,
} from "../../src/extract-visual/tokens.js";
import type { DtcgToken } from "../../src/graph/types.js";

describe("Design Token Binding & DTCG Export (VI-05)", () => {
  describe("parseCssColor", () => {
    it("parses 6-digit hex colors", () => {
      const parsed = parseCssColor("#0066cc");
      expect(parsed).toEqual({ r: 0, g: 102, b: 204, a: 1 });
    });

    it("parses 3-digit hex colors", () => {
      const parsed = parseCssColor("#06c");
      expect(parsed).toEqual({ r: 0, g: 102, b: 204, a: 1 });
    });

    it("parses rgb and rgba string representations", () => {
      expect(parseCssColor("rgb(255, 0, 128)")).toEqual({ r: 255, g: 0, b: 128, a: 1 });
      expect(parseCssColor("rgba(255, 0, 128, 0.5)")).toEqual({ r: 255, g: 0, b: 128, a: 0.5 });
    });

    it("parses named CSS colors", () => {
      expect(parseCssColor("white")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
      expect(parseCssColor("black")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    });

    it("returns null for invalid color formats", () => {
      expect(parseCssColor("not-a-color")).toBeNull();
      expect(parseCssColor("")).toBeNull();
    });
  });

  describe("colorDistanceRgb", () => {
    it("returns 0 for identical colors", () => {
      const c = { r: 100, g: 150, b: 200, a: 1 };
      expect(colorDistanceRgb(c, c)).toBe(0);
    });

    it("calculates Euclidean distance accurately", () => {
      const c1 = { r: 0, g: 0, b: 0, a: 1 };
      const c2 = { r: 3, g: 4, b: 0, a: 1 };
      expect(colorDistanceRgb(c1, c2)).toBe(5);
    });
  });

  describe("parseDimensionPx", () => {
    it("parses px values", () => {
      expect(parseDimensionPx("16px")).toBe(16);
      expect(parseDimensionPx("24.5px")).toBe(24.5);
    });

    it("parses rem and em assuming 16px base", () => {
      expect(parseDimensionPx("1rem")).toBe(16);
      expect(parseDimensionPx("1.5rem")).toBe(24);
      expect(parseDimensionPx("2em")).toBe(32);
    });

    it("parses pt values assuming 1pt = 1.333px", () => {
      expect(Math.round(parseDimensionPx("12pt")!)).toBe(16);
    });

    it("parses unitless numbers", () => {
      expect(parseDimensionPx("32")).toBe(32);
    });

    it("returns null for non-dimension strings", () => {
      expect(parseDimensionPx("auto")).toBeNull();
      expect(parseDimensionPx("none")).toBeNull();
    });
  });

  describe("normalizeTokenEntries", () => {
    it("normalizes Map of DtcgToken", () => {
      const map = new Map<string, DtcgToken>([
        ["color.brand.primary", { $value: "#0066cc", $type: "color" }],
      ]);
      const normalized = normalizeTokenEntries(map);
      expect(normalized).toHaveLength(1);
      expect(normalized[0]![0]).toBe("color.brand.primary");
      expect(normalized[0]![1].$value).toBe("#0066cc");
    });

    it("normalizes Record of DtcgToken", () => {
      const rec: Record<string, DtcgToken> = {
        "spacing.sm": { $value: "8px", $type: "dimension" },
      };
      const normalized = normalizeTokenEntries(rec);
      expect(normalized).toHaveLength(1);
      expect(normalized[0]![0]).toBe("spacing.sm");
      expect(normalized[0]![1].$value).toBe("8px");
    });
  });

  describe("bindTokensToNode", () => {
    const tokens = new Map<string, DtcgToken>([
      ["color.primary", { $value: "#0066cc", $type: "color" }],
      ["color.background", { $value: "#ffffff", $type: "color" }],
      ["spacing.md", { $value: "16px", $type: "dimension" }],
      ["font.family.base", { $value: "Inter, sans-serif", $type: "fontFamily" }],
    ]);

    it("binds exact color matches with confidence 1.0", () => {
      const style = {
        color: "#0066cc",
      };
      const bindings = bindTokensToNode(style, tokens);
      const colorBinding = bindings.find((b) => b.property === "color");
      expect(colorBinding).toBeDefined();
      expect(colorBinding?.tokenPath).toBe("color.primary");
      expect(colorBinding?.confidence).toBe(1.0);
      expect(colorBinding?.matchType).toBe("exact");
    });

    it("binds normalized color matches (hex <-> rgb)", () => {
      // rgb(0, 102, 204) matches #0066cc under rgb normalization
      const style = {
        color: "rgb(0, 102, 204)",
      };
      const bindings = bindTokensToNode(style, tokens);
      const colorBinding = bindings.find((b) => b.property === "color");
      expect(colorBinding).toBeDefined();
      expect(colorBinding?.tokenPath).toBe("color.primary");
      expect(colorBinding?.confidence).toBeGreaterThan(0.9);
      expect(colorBinding?.matchType).toBe("normalized");
    });

    it("binds dimension tokens correctly", () => {
      const style = {
        paddingTop: "16px",
        marginRight: "1rem", // 16px
      };
      const bindings = bindTokensToNode(style, tokens);
      expect(bindings.some((b) => b.property === "paddingTop" && b.tokenPath === "spacing.md")).toBe(true);
      expect(bindings.some((b) => b.property === "marginRight" && b.tokenPath === "spacing.md")).toBe(true);
    });

    it("binds font family tokens with exact match", () => {
      const style = {
        fontFamily: "Inter, sans-serif",
      };
      const bindings = bindTokensToNode(style, tokens);
      const fontBinding = bindings.find((b) => b.property === "fontFamily");
      expect(fontBinding).toBeDefined();
      expect(fontBinding?.tokenPath).toBe("font.family.base");
      expect(fontBinding?.confidence).toBe(1.0);
    });
  });

  describe("detectTokenDrifts", () => {
    const tokens = new Map<string, DtcgToken>([
      ["color.primary", { $value: "#0066cc", $type: "color" }], // rgb(0, 102, 204)
      ["spacing.md", { $value: "16px", $type: "dimension" }],
    ]);

    it("flags slight color deviations as design token drift", () => {
      // rgb(0, 105, 206) is slightly off rgb(0, 102, 204), distance ≈ 3.6
      const style = {
        backgroundColor: "rgb(0, 105, 206)",
      };
      const drifts = detectTokenDrifts("ax:btn", "page:/", style, tokens);
      expect(drifts).toHaveLength(1);
      expect(drifts[0]!.property).toBe("backgroundColor");
      expect(drifts[0]!.suggestedToken).toBe("color.primary");
      expect(drifts[0]!.severity).toBe("low");
      expect(drifts[0]!.driftDelta).toBeGreaterThan(0);
    });

    it("flags slight dimension deviations as design token drift", () => {
      // 15px is 1px off 16px spacing.md
      const style = {
        paddingLeft: "15px",
      };
      const drifts = detectTokenDrifts("ax:card", "page:/", style, tokens);
      expect(drifts).toHaveLength(1);
      expect(drifts[0]!.property).toBe("paddingLeft");
      expect(drifts[0]!.suggestedToken).toBe("spacing.md");
      expect(drifts[0]!.severity).toBe("low");
    });

    it("does not report drift when value matches exactly", () => {
      const style = {
        backgroundColor: "rgb(0, 102, 204)",
        paddingLeft: "16px",
      };
      const drifts = detectTokenDrifts("ax:btn", "page:/", style, tokens);
      expect(drifts).toHaveLength(0);
    });
  });

  describe("exportDtcgBundle", () => {
    it("bundles tokens in W3C DTCG format with hierarchical groups", () => {
      const tokens = new Map<string, DtcgToken>([
        ["color.brand.primary", { $value: "#0066cc", $type: "color", $description: "Brand primary" }],
        ["spacing.container.padding", { $value: "24px", $type: "dimension" }],
      ]);

      const bundle = exportDtcgBundle(tokens);
      expect(bundle.version).toBe("1.0.0");
      expect(bundle.metadata.totalTokens).toBe(2);
      expect(bundle.metadata.tokenTypes.color).toBe(1);
      expect(bundle.metadata.tokenTypes.dimension).toBe(1);

      // Check hierarchical group tree in bundle.tokens
      expect(bundle.tokens.color.brand.primary.$value).toBe("#0066cc");
      expect(bundle.tokens.spacing.container.padding.$value).toBe("24px");
    });
  });

});
