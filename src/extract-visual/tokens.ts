/**
 * DTCG Design Token Binding & Drift Linting Engine — NexusOS / VI-05.
 *
 * Implements:
 * 1. Deep token binding with confidence scores across color, dimension, and typography.
 * 2. Token drift detection and design debt linting (near-token values).
 * 3. W3C DTCG Token bundle export for Figma, iOS, and Android cross-platform sync.
 */
import type {
  ComputedStyleSnapshot,
  DtcgToken,
  DtcgType,
  TokenBindingEvidence,
  TokenDriftReport,
  DtcgExportBundle,
} from "../graph/types.js";
import { rgbToHex, guessDtcgType } from "./visual.js";

// ============================================================================
// Color Parsing & Distance Metrics
// ============================================================================

export interface ParsedRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  transparent: "rgba(0, 0, 0, 0)",
};

/** Parse CSS color string (hex, rgb, rgba, or named) to RGBA. */
export function parseCssColor(colorStr: string): ParsedRgba | null {
  if (!colorStr) return null;
  const s = colorStr.trim().toLowerCase();

  // Named color
  if (NAMED_COLORS[s]) {
    return parseCssColor(NAMED_COLORS[s]);
  }

  // Hex (#rgb, #rgba, #rrggbb, #rrggbbaa)
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      return { r, g, b, a: 1 };
    }
    if (hex.length === 4) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      const a = parseInt(hex[3]! + hex[3]!, 16) / 255;
      return { r, g, b, a: Math.round(a * 100) / 100 };
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return { r, g, b, a: 1 };
    }
    if (hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = parseInt(hex.slice(6, 8), 16) / 255;
      return { r, g, b, a: Math.round(a * 100) / 100 };
    }
    return null;
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const m = s.match(/^rgba?\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (m) {
    const r = Math.max(0, Math.min(255, Number(m[1]!)));
    const g = Math.max(0, Math.min(255, Number(m[2]!)));
    const b = Math.max(0, Math.min(255, Number(m[3]!)));
    const a = m[4] !== undefined ? Math.max(0, Math.min(1, Number(m[4]))) : 1;
    return { r, g, b, a };
  }

  return null;
}

/** Compute Euclidean distance between two colors in RGB space (0 = identical, max ≈ 441.67). */
export function colorDistanceRgb(c1: ParsedRgba, c2: ParsedRgba): number {
  const dr = c1.r - c2.r;
  const dg = c1.g - c2.g;
  const db = c1.b - c2.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// ============================================================================
// Dimension Parsing & Distance Metrics
// ============================================================================

/** Parse CSS dimension string into pixel value. */
export function parseDimensionPx(dimStr: string, rootFontSize = 16): number | null {
  if (!dimStr) return null;
  const s = dimStr.trim().toLowerCase();
  if (s === "0") return 0;
  const m = s.match(/^(-?\d+(?:\.\d+)?)(px|rem|em|pt)?$/);
  if (!m) return null;
  const val = parseFloat(m[1]!);
  const unit = m[2] || "px";
  if (unit === "px") return val;
  if (unit === "rem" || unit === "em") return val * rootFontSize;
  if (unit === "pt") return val * (4 / 3);
  return null;
}


// ============================================================================
// Token Binding Engine
// ============================================================================

/** Normalizes token dictionary into an iterable list of [path, DtcgToken]. */
export function normalizeTokenEntries(
  tokens: Map<string, DtcgToken> | Record<string, DtcgToken | any>,
): Array<[string, DtcgToken]> {
  if (tokens instanceof Map) {
    return Array.from(tokens.entries());
  }
  const result: Array<[string, DtcgToken]> = [];
  function recurse(obj: Record<string, any>, prefix: string) {
    for (const [k, v] of Object.entries(obj)) {
      const fullPath = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && "$value" in v) {
        result.push([fullPath, v as DtcgToken]);
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        recurse(v, fullPath);
      }
    }
  }
  recurse(tokens, "");
  return result;
}

/** Bind computed styles to defined design tokens with confidence scoring. */
export function bindTokensToNode(
  computedStyle: ComputedStyleSnapshot,
  tokens: Map<string, DtcgToken> | Record<string, DtcgToken | any>,
): TokenBindingEvidence[] {
  const tokenList = normalizeTokenEntries(tokens);
  if (tokenList.length === 0) return [];

  const bindings: TokenBindingEvidence[] = [];
  const boundProperties = new Set<string>();

  for (const [prop, valRaw] of Object.entries(computedStyle)) {
    if (valRaw == null || valRaw === "") continue;
    const actualValue = String(valRaw).trim();
    if (!actualValue) continue;

    // 1. Exact string match
    for (const [tokenPath, token] of tokenList) {
      const tokenValStr = String(token.$value).trim();
      if (actualValue === tokenValStr) {
        bindings.push({
          property: prop,
          tokenPath,
          tokenValue: token.$value,
          actualValue,
          matchType: "exact",
          confidence: 1.0,
        });
        boundProperties.add(prop);
        break;
      }
    }
    if (boundProperties.has(prop)) continue;

    // 2. Color normalization (hex <-> rgb)
    const actualRgba = parseCssColor(actualValue);
    if (actualRgba) {
      for (const [tokenPath, token] of tokenList) {
        const tokenRgba = parseCssColor(String(token.$value));
        if (tokenRgba) {
          const dist = colorDistanceRgb(actualRgba, tokenRgba);
          if (dist === 0) {
            bindings.push({
              property: prop,
              tokenPath,
              tokenValue: token.$value,
              actualValue,
              matchType: "normalized",
              confidence: 0.98,
            });
            boundProperties.add(prop);
            break;
          }
        }
      }
    }
    if (boundProperties.has(prop)) continue;

    // 3. Dimension normalization (px <-> rem/pt)
    const actualPx = parseDimensionPx(actualValue);
    if (actualPx !== null) {
      for (const [tokenPath, token] of tokenList) {
        const tokenPx = parseDimensionPx(String(token.$value));
        if (tokenPx !== null && Math.abs(actualPx - tokenPx) < 0.01) {
          bindings.push({
            property: prop,
            tokenPath,
            tokenValue: token.$value,
            actualValue,
            matchType: "normalized",
            confidence: 0.95,
          });
          boundProperties.add(prop);
          break;
        }
      }
    }
  }

  return bindings;
}

// ============================================================================
// Token Drift Linting Engine
// ============================================================================

export interface TokenDriftLintOptions {
  maxColorDriftDistance?: number;    // default 35.0
  maxDimensionDriftPx?: number;       // default 3.0
}

/** Detect styling values that are close to design tokens but deviate (token drift / styling debt). */
export function detectTokenDrifts(
  axId: string,
  pageId: string,
  computedStyle: ComputedStyleSnapshot,
  tokens: Map<string, DtcgToken> | Record<string, DtcgToken | any>,
  options: TokenDriftLintOptions = {},
): TokenDriftReport[] {
  const maxColorDist = options.maxColorDriftDistance ?? 35.0;
  const maxDimDist = options.maxDimensionDriftPx ?? 3.0;

  const tokenList = normalizeTokenEntries(tokens);
  if (tokenList.length === 0) return [];

  // Identify already exact-bound properties
  const exactBindings = bindTokensToNode(computedStyle, tokens);
  const exactProps = new Set(exactBindings.map((b) => b.property));

  const reports: TokenDriftReport[] = [];

  for (const [prop, valRaw] of Object.entries(computedStyle)) {
    if (exactProps.has(prop)) continue;
    if (valRaw == null || valRaw === "") continue;
    const actualValue = String(valRaw).trim();
    if (!actualValue) continue;

    // Check color drift
    const actualRgba = parseCssColor(actualValue);
    if (actualRgba) {
      let closestToken: { path: string; value: string | number | boolean; dist: number } | null = null;
      for (const [tokenPath, token] of tokenList) {
        const tokenRgba = parseCssColor(String(token.$value));
        if (tokenRgba) {
          const dist = colorDistanceRgb(actualRgba, tokenRgba);
          if (dist > 0 && dist <= maxColorDist) {
            if (!closestToken || dist < closestToken.dist) {
              closestToken = { path: tokenPath, value: token.$value, dist };
            }
          }
        }
      }
      if (closestToken) {
        const severity: "low" | "medium" | "high" =
          closestToken.dist <= 15 ? "low" : closestToken.dist <= 25 ? "medium" : "high";
        reports.push({
          axId,
          pageId,
          property: prop,
          actualValue,
          suggestedToken: closestToken.path,
          suggestedValue: closestToken.value,
          driftDelta: Math.round(closestToken.dist * 100) / 100,
          severity,
          message: `Color '${actualValue}' drifts by distance ${Math.round(closestToken.dist * 10) / 10} from token '${closestToken.path}' (${closestToken.value})`,
        });
      }
      continue;
    }

    // Check dimension drift
    const actualPx = parseDimensionPx(actualValue);
    if (actualPx !== null && actualPx > 0) {
      let closestDim: { path: string; value: string | number | boolean; delta: number } | null = null;
      for (const [tokenPath, token] of tokenList) {
        const tokenPx = parseDimensionPx(String(token.$value));
        if (tokenPx !== null && tokenPx > 0) {
          const diff = Math.abs(actualPx - tokenPx);
          if (diff > 0 && diff <= maxDimDist) {
            if (!closestDim || diff < closestDim.delta) {
              closestDim = { path: tokenPath, value: token.$value, delta: diff };
            }
          }
        }
      }
      if (closestDim) {
        const severity: "low" | "medium" | "high" =
          closestDim.delta <= 1.0 ? "low" : closestDim.delta <= 2.0 ? "medium" : "high";
        reports.push({
          axId,
          pageId,
          property: prop,
          actualValue,
          suggestedToken: closestDim.path,
          suggestedValue: closestDim.value,
          driftDelta: Math.round(closestDim.delta * 100) / 100,
          severity,
          message: `Dimension '${actualValue}' drifts by ${Math.round(closestDim.delta * 10) / 10}px from token '${closestDim.path}' (${closestDim.value})`,
        });
      }
    }
  }

  return reports;
}

// ============================================================================
// W3C DTCG Token Bundle Export
// ============================================================================

/** Export tokens into standard W3C DTCG structured bundle with metadata. */
export function exportDtcgBundle(
  tokens: Map<string, DtcgToken> | Record<string, DtcgToken | any>,
): DtcgExportBundle {
  const tokenList = normalizeTokenEntries(tokens);
  const rootTree: Record<string, any> = {};
  const typeCounts: Record<DtcgType, number> = {
    color: 0,
    dimension: 0,
    fontFamily: 0,
    fontWeight: 0,
    duration: 0,
    cubicBezier: 0,
    number: 0,
    string: 0,
    boolean: 0,
  };

  for (const [path, token] of tokenList) {
    const inferredType: DtcgType = token.$type || guessDtcgType(String(token.$value));
    if (typeCounts[inferredType] !== undefined) {
      typeCounts[inferredType]++;
    } else {
      typeCounts.string++;
    }

    const segments = path.split(".");
    let curr = rootTree;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      if (!curr[seg] || typeof curr[seg] !== "object") {
        curr[seg] = {};
      }
      curr = curr[seg];
    }
    const lastSeg = segments[segments.length - 1]!;
    curr[lastSeg] = {
      $value: token.$value,
      $type: inferredType,
      ...(token.$description ? { $description: token.$description } : {}),
      ...(token.$extensions ? { $extensions: token.$extensions } : {}),
    };
  }

  return {
    version: "1.0.0",
    tokens: rootTree,
    metadata: {
      totalTokens: tokenList.length,
      tokenTypes: typeCounts,
      exportedAt: new Date().toISOString(),
      generator: "NexusOS Design System Token Engine v0.2.0",
    },
  };
}

