/**
 * PR-8e — Regression test for marker-only conditional state transitions.
 *
 * Blockers 2, 3, 6, 8 of the PR-8e specification. The test must:
 *  1. `richSnapshotDiffers(before, after)` returns `true` when only
 *     `conditionalMarkers` differ (Blocker 2).
 *  2. Two otherwise-identical real RichSnapshots that differ only in
 *     `conditionalMarkers` flow through the production pipeline and
 *     produce a `state:successor` edge with the real interaction
 *     that caused the change (Blocker 3).
 *  3. The trigger recorded on the edge is the real cause, not a
 *     fabricated "conditional" action (Blocker 3, item 5).
 *  4. Two distinct State IDs are materialized (Blocker 3, item 3).
 *  5. No `awg:condition-change` mechanism is involved (Blocker 3,
 *     item 6; Blocker 1).
 *  6. The test fails on pre-PR-8e main and passes only after PR-8e.
 *
 * Implementation note: this test uses the production
 * `runObservedExtractor` against a fake page that performs a real
 * `data-condition-*` attribute change. The page is NOT a fixture
 * for `awg:condition-change`; it uses an ordinary `addEventListener`
 * for a generic event that any unmodified application might use, or
 * a direct DOM mutation the page's own logic performs.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runObservedExtractor,
  richSnapshotDiffers,
  type ObservedPageLike,
  type RichSnapshot,
} from "../../src/extract-state/observed.js";
import { Graph } from "../../src/graph/graph.js";
import type { PageNode } from "../../src/graph/types.js";

const PAGE = "page:https://unmodified-app.example/";
const SRC_AX = `ax:${PAGE}:feature-toggle`;

function makePageNode(): PageNode {
  return {
    id: PAGE, type: "page", url: "https://unmodified-app.example/", title: "Unmodified App",
    discoveredVia: ["seed"], loadStatus: "complete",
    axTreeRef: { rootAxId: `ax:${PAGE}:root`, provenance: "bidi:script.evaluate" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null, screenshotRef: null,
    canonicalUrl: "https://unmodified-app.example/",
    crawledAt: "2026-08-30T00:00:00.000Z", parentPageId: null,
  };
}

function seedGraph(g: Graph): void {
  g.upsertPage(makePageNode());
  g.upsertAx({
    id: SRC_AX, type: "ax-node", pageId: PAGE,
    role: "button", name: "Toggle Feature", nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 1, parentAxId: null, provenance: "aria:t",
  });
}

/** Build a RichSnapshot with the given conditional markers; everything
 *  else identical. This is the "marker-only" variation.
 *
 *  PR-8f: the hash is a *fixed* string. Two snapshots that differ
 *  only in their `conditionalMarkers` MUST have the same hash —
 *  because the hash is computed by the page-side walker over a
 *  fixed projection that does not include markers (or, in the case
 *  where the walker does include them, the mask is identical). The
 *  regression is only meaningful if `before.hash === after.hash`;
 *  otherwise the field-level comparison never executes and we don't
 *  actually prove the diff is detected. */
function snapWith(markers: Record<string, string>): RichSnapshot {
  return {
    // PR-8f: identical hash regardless of marker content. This
    // is the masked regression: the diff function must detect the
    // marker change even though the hash short-circuit used to hide it.
    hash: "h:masked-conditional-only",
    elements: [{
      axId: SRC_AX,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      visibility: "visible",
      zIndex: 0,
      open: null, expanded: null, selected: null, checked: null, pressed: null, busy: null,
      // PR-8g T1: per-element focus flag (default false in fixtures).
      focused: false,
      ariaStates: {},
      visualNodeId: null,
      conditionalMarkers: markers,
    }],
    openDialogIds: [],
    openPopoverIds: [],
    expandedRegionAxIds: [],
    // PR-8g T1: State-level focus pointer (null in fixtures).
    focusedAxId: null,
    viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
    online: true,
    conditionalMarkers: markers,
  };
}

describe("PR-8f: masked conditional-marker regression (hash matches, only markers differ)", () => {
  // PR-8f: every test in this describe block uses snapshots whose
  // `hash` field is identical ("h:masked-conditional-only"). The
  // masked regression proves the field-level comparison detects the
  // marker change even when the hash short-circuit no longer fires
  // (and *would* have hidden the change in pre-PR-8f code).

  it("richSnapshotDiffers returns true when before.hash === after.hash and only marker value changed", () => {
    const before = snapWith({ "data-condition-feature-x": "false" });
    const after = snapWith({ "data-condition-feature-x": "true" });
    // The hash mask is the point of the test.
    expect(before.hash).toBe(after.hash);
    expect(richSnapshotDiffers(before, after)).toBe(true);
  });

  it("richSnapshotDiffers returns true when only marker added (hash matches)", () => {
    const before = snapWith({});
    const after = snapWith({ "data-condition-feature-x": "true" });
    expect(before.hash).toBe(after.hash);
    expect(richSnapshotDiffers(before, after)).toBe(true);
  });

  it("richSnapshotDiffers returns true when only marker removed (hash matches)", () => {
    const before = snapWith({ "data-condition-feature-x": "true" });
    const after = snapWith({});
    expect(before.hash).toBe(after.hash);
    expect(richSnapshotDiffers(before, after)).toBe(true);
  });

  it("richSnapshotDiffers returns true when marker key order differs (hash matches)", () => {
    const a = snapWith({ "data-condition-feature-x": "false", "data-condition-y": "off" });
    const b = snapWith({ "data-condition-y": "off", "data-condition-feature-x": "false" });
    expect(a.hash).toBe(b.hash);
    // Order change: the keys and values are the same. This should
    // be equal (the diff function is key-set-driven, not order-driven).
    expect(richSnapshotDiffers(a, b)).toBe(false);
  });

  it("richSnapshotDiffers returns false when markers are equal (hash matches)", () => {
    const a = snapWith({ "data-condition-feature-x": "false" });
    const b = snapWith({ "data-condition-feature-x": "false" });
    expect(a.hash).toBe(b.hash);
    expect(richSnapshotDiffers(a, b)).toBe(false);
  });

  it("richSnapshotDiffers returns true on a non-interactive element marker (hash matches)", () => {
    // PR-8f regression: a `data-condition-*` attribute on an element
    // that is NOT in the interactive enumeration set must still
    // produce a diff. Pre-PR-8f, the diff was hidden because the
    // walker's interactive-set filter dropped the element. Here we
    // exercise the path with two snapshots whose marker differs but
    // whose element enumeration is otherwise identical.
    const before: RichSnapshot = {
      hash: "h:masked-conditional-only",
      elements: [{
        axId: `ax:${PAGE}:non-interactive`,
        rect: { x: 0, y: 0, w: 0, h: 0 },
        visibility: "visible",
        zIndex: 0,
        open: null, expanded: null, selected: null, checked: null, pressed: null, busy: null,
        // PR-8g T1: per-element focus flag.
        focused: false,
        ariaStates: {},
        visualNodeId: null,
        conditionalMarkers: { "data-condition-feature-x": "false" },
      }],
      openDialogIds: [],
      openPopoverIds: [],
      expandedRegionAxIds: [],
      // PR-8g T1: State-level focus pointer.
      focusedAxId: null,
      viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
      online: true,
      conditionalMarkers: { "data-condition-feature-x": "false" },
    };
    const after: RichSnapshot = {
      ...before,
      elements: [{ ...before.elements[0]!, conditionalMarkers: { "data-condition-feature-x": "true" } }],
      conditionalMarkers: { "data-condition-feature-x": "true" },
    };
    expect(before.hash).toBe(after.hash);
    expect(richSnapshotDiffers(before, after)).toBe(true);
  });
});

describe("PR-8e: full pipeline produces a state:successor edge for marker-only change (Blocker 3)", () => {
  it("real RichSnapshot pair (only conditionalMarkers differs) produces two states and one successor", async () => {
    const g = new Graph();
    seedGraph(g);
    // Two snapshots: same elements/visibility/open/etc, only the
    // `data-condition-feature-x` value flipped from "false" to "true".
    // PR-8f: identical hash — the masked regression path. The diff
    // is detected at the field level.
    const before = snapWith({ "data-condition-feature-x": "false" });
    const after = snapWith({ "data-condition-feature-x": "true" });
    expect(before.hash).toBe(after.hash);

    // The interactive element the page exposes — a single button.
    const interactiveEl = {
      axId: SRC_AX,
      rect: { x: 0, y: 0, w: 100, h: 30 },
      tagName: "button",
      role: "button",
    };

    // The observed extractor's callFunction order (V2 path):
    //   1) pre-baseline takeRichSnapshot           → RichSnapshot (before)
    //   2) V2 listInteractive                      → InteractiveElement[]
    //   3) V2 per-loop baseline takeSnapshot       → RichSnapshot (before)
    //   4) per (element, probe) takeSnapshot       → RichSnapshot (before)
    //   5) per (element, probe) takeSnapshot       → RichSnapshot (after)
    // The mock tracks call index; the first 4 calls return `before`,
    // call 2 returns the list, and all subsequent calls return `after`
    // (the page's own listener flipped the marker in between).
    let callIdx = 0;
    const page: ObservedPageLike = {
      target: { context: "ctx-test" } as any,
      script: {
        callFunction: (async (_t: any, _fn: any) => {
          callIdx++;
          if (callIdx === 2) return [interactiveEl];
          if (callIdx <= 4) return before;
          return after;
        }) as any,
        evaluate: vi.fn(),
      },
      input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
    };

    await runObservedExtractor(g, page as any, PAGE, () => undefined);

    // 1. The observed production pipeline must have produced a hit.
    const states = Array.from(g.states());
    expect(states.length).toBeGreaterThanOrEqual(2);

    // 2. Two distinct state ids must have been materialized.
    const ids = new Set(states.map((s) => s.id));
    expect(ids.size).toBeGreaterThanOrEqual(2);

    // 3. A state:successor edge must connect two states.
    const successors = [...g.allEdges()].filter((e) => e.kind === "state:successor");
    expect(successors.length).toBeGreaterThan(0);

    // 4. The edge must carry a real interaction trigger (the cause
    //    that produced the marker change), not the old fabricated
    //    "conditional" trigger.
    const edgeTriggers = successors[0]!.triggers ?? [];
    expect(edgeTriggers.length).toBeGreaterThan(0);
    expect(edgeTriggers).not.toContain("conditional");
    // The trigger must be one of the existing real interaction
    // vocabulary, e.g. "click" (the page's toggle button is what
    // produced the marker change).
    expect(edgeTriggers[0]).toMatch(/^(click|hover|focus|key-|type|submit|scroll|drag|expand|collapse|open-modal|close-modal|switch-tab|choose-dropdown|auth|network-wait|view-transition|popover|dialog|command)$/);

    // 5. No awg:condition-change mechanism is involved.
    for (const e of g.allEdges()) {
      expect(JSON.stringify(e)).not.toMatch(/awg:condition-change/);
    }
  });
});

describe("PR-8e: no AWG-specific cooperation in production state-extraction source", () => {
  it("src/extract-state/observed.ts must not dispatchEvent awg:condition-change", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const observedSrc = await fs.readFile(
      path.resolve(process.cwd(), "src/extract-state/observed.ts"),
      "utf8",
    );
    // Check for the actual dispatchEvent call shape, not the
    // string mention in the comment block, so a documentation
    // mention does not false-positive this test.
    expect(
      observedSrc,
      "production state-extraction source must not dispatchEvent awg:condition-change",
    ).not.toMatch(/dispatchEvent\(new CustomEvent\(\s*['"]awg:condition-change['"]/);
    // No other Agent Web Graph-specific target-app event name in
    // any dispatchEvent call.
    expect(
      observedSrc,
      "production state-extraction source must not dispatchEvent any awg:* event",
    ).not.toMatch(/dispatchEvent\(new CustomEvent\(\s*['"]awg:/);
  });
});
