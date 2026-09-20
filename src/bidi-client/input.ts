/**
 * Typed wrapper for the BiDi input module.
 *
 * Per the env-report: Firefox 154 supports performActions and releaseActions.
 * Use `pointer` source for mouse/pen, `key` source for keyboard, `wheel` for scroll.
 *
 * **PR-8j T2.** Firefox 154 strictly enforces the BiDi spec's
 * `key` action `value` constraint: it must be a single Unicode
 * code point or grapheme cluster. The previous implementation
 * sent readable names like `"ArrowDown"`, `"Enter"`, `"Escape"`
 * as multi-character strings, which Firefox correctly rejected
 * with
 * `Expected "value" to be a string that represents single code
 * point or grapheme cluster, got "ArrowDown"`. The defect was
 * masked because the BiDi-gated tests skipped themselves when
 * no geckodriver was available; with PR-8j making BiDi
 * mandatory, the bug surfaced.
 *
 * The fix introduces `KeyAction.translate` and the
 * `KEY_NAME_TO_CODE` map. `KeyAction` is now
 * `{ type: "keyDown", value: string }` where `value` is the
 * **already-translated** single code point. `InputApi.sendKey`
 * (and `keyDownUp`) accept a readable name and translate it via
 * the map before issuing the BiDi command.
 *
 * Spec: https://www.w3.org/TR/webdriver-bidi/#module-input
 *   "value" — A string which MUST be a single Unicode code
 *   point or grapheme cluster representing the key.
 *
 * Reference codes (WebDriver classic keyboard codes, the same
 * PUA range BiDi inherits from):
 *   https://w3c.github.io/webdriver/#keyboard-actions
 */
import type { BiDiTransport } from "./transport.js";

export type PointerType = "mouse" | "pen" | "touch";

export type PointerAction =
  | { type: "pointerDown"; button: 0 | 1 | 2 }
  | { type: "pointerUp"; button: 0 | 1 | 2 }
  | { type: "pointerMove"; x: number; y: number; duration?: number }
  | { type: "pause"; duration: number };

export type KeyAction =
  | { type: "keyDown"; value: string }
  | { type: "keyUp"; value: string }
  | { type: "pause"; duration: number };

export type Source =
  | { type: "pointer"; id: string; parameters?: { pointerType?: PointerType }; actions: PointerAction[] }
  | { type: "key"; id: string; actions: KeyAction[] }
  | { type: "wheel"; id: string; actions: Array<{ type: "scroll"; x: number; y: number; deltaX?: number; deltaY?: number; duration?: number }> };

/**
 * Map of human-readable key names to the BiDi-spec single code
 * point Firefox 154 expects. The codes are the WebDriver
 * classic keyboard codes (Unicode private-use area U+E000 –
 * U+EFFF), which BiDi inherits. Arrow keys: U+E013 / U+E015 /
 * U+E012 / U+E014. Editing keys: U+E008 (Backspace), U+E017
 * (Delete), U+E004 (Tab), etc.
 *
 * Single-character printable keys (a, 0, " ", etc.) are passed
 * through unchanged — they are already single code points.
 *
 * **PR-8j J6 (codex review fix).** The Delete code was
 * previously U+E053 (the JSON Pointer escape, unrelated). The
 * WebDriver classic keyboard code for Delete is U+E017. Without
 * this fix, any `InputApi.sendKey(context, "Delete")` call
 * would send an arbitrary private-use code point instead of
 * the delete action.
 */
export const KEY_NAME_TO_CODE: Readonly<Record<string, string>> = Object.freeze({
  // Editing
  Backspace: "",
  Tab:       "",
  Enter:     "",
  Escape:    "",
  Delete:    "",
  Space:     " ",
  // Arrows
  ArrowUp:    "",
  ArrowDown:  "",
  ArrowLeft:  "",
  ArrowRight: "",
  // Navigation
  Home: "",
  End:  "",
  PageUp:   "",
  PageDown: "",
  Insert:   "",
});

/**
 * Translate a readable key name (e.g. "ArrowDown", "Enter") to
 * the BiDi-spec single code point. If the name is not in the
 * map, it is returned as-is. The caller MUST guarantee the
 * returned string is a single code point; otherwise Firefox
 * will reject it. Single-character strings (a, 0, " ", etc.)
 * are already single code points.
 */
export function translateKeyName(name: string): string {
  return KEY_NAME_TO_CODE[name] ?? name;
}

export interface KineticOptions {
  /** If true, interpolates path via cubic Bézier curve with humanized velocity */
  kinetic?: boolean;
  /** Explicit starting X coordinate (defaults to last known cursor X or 0) */
  startX?: number;
  /** Explicit starting Y coordinate (defaults to last known cursor Y or 0) */
  startY?: number;
  /** Number of intermediate trajectory steps (default: 8-15 based on distance) */
  steps?: number;
  /** Maximum micro-jitter amplitude in pixels (default: 1.5) */
  jitter?: number;
}

export interface TypeOptions {
  /** If true, introduces randomized human-like delay variance between keystrokes */
  humanize?: boolean;
  /** Base delay between characters in milliseconds (default: 0) */
  charDelayMs?: number;
  /** Delay variance range in ms when humanize is true (default: [40, 110]) */
  delayRange?: [min: number, max: number];
}

/**
 * Generate intermediate pointer movement steps along a cubic Bézier curve
 * mimicking natural human hand kinematics (acceleration, travel, deceleration).
 */
export function generateKineticTrajectory(
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  opts: KineticOptions = {},
): PointerAction[] {
  const dx = targetX - startX;
  const dy = targetY - startY;
  const distance = Math.hypot(dx, dy);

  // If distance is negligible, single move is truthful
  if (distance < 5) {
    return [{ type: "pointerMove", x: Math.round(targetX), y: Math.round(targetY) }];
  }

  const steps = opts.steps ?? Math.min(24, Math.max(8, Math.round(distance / 25)));
  const jitterAmp = opts.jitter ?? 1.5;

  // Generate two randomized control points biased towards natural curved sweep
  const ctrl1X = startX + dx * 0.25 + (Math.random() - 0.5) * (distance * 0.15);
  const ctrl1Y = startY + dy * 0.25 + (Math.random() - 0.5) * (distance * 0.15);
  const ctrl2X = startX + dx * 0.75 + (Math.random() - 0.5) * (distance * 0.1);
  const ctrl2Y = startY + dy * 0.75 + (Math.random() - 0.5) * (distance * 0.1);

  const actions: PointerAction[] = [];

  for (let i = 1; i <= steps; i++) {
    // S-curve parameter t using sinusoidal ease-in-out
    const linearT = i / steps;
    const t = 0.5 * (1 - Math.cos(Math.PI * linearT));

    // Cubic Bézier formula: B(t) = (1-t)^3*P0 + 3(1-t)^2*t*P1 + 3(1-t)*t^2*P2 + t^3*P3
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;

    let px = uuu * startX + 3 * uu * t * ctrl1X + 3 * u * tt * ctrl2X + ttt * targetX;
    let py = uuu * startY + 3 * uu * t * ctrl1Y + 3 * u * tt * ctrl2Y + ttt * targetY;

    // Apply micro-jitter on intermediate steps (suppressed at the final target)
    if (i < steps && jitterAmp > 0) {
      px += (Math.random() - 0.5) * jitterAmp;
      py += (Math.random() - 0.5) * jitterAmp;
    }

    actions.push({
      type: "pointerMove",
      x: Math.round(px),
      y: Math.round(py),
      duration: Math.round(10 + Math.random() * 8),
    });
  }

  return actions;
}

export class InputApi {
  private currentCursorX = 0;
  private currentCursorY = 0;

  constructor(private transport: BiDiTransport) {}

  /** Perform a batch of input actions. Sources are interleaved per the BiDi spec. */
  async performActions(context: string, actions: Source[]): Promise<void> {
    await this.transport.send("input.performActions", { context, actions });
  }

  async releaseActions(context: string): Promise<void> {
    await this.transport.send("input.releaseActions", { context });
  }

  // ---- Convenience helpers for common probes ----

  /** Click at viewport coordinates. Supports optional human-kinetic trajectory interpolation. */
  async click(context: string, x: number, y: number, opts?: KineticOptions): Promise<void> {
    const pointerActions: PointerAction[] = [];

    if (opts?.kinetic) {
      const sx = opts.startX ?? this.currentCursorX;
      const sy = opts.startY ?? this.currentCursorY;
      pointerActions.push(...generateKineticTrajectory(sx, sy, x, y, opts));
    } else {
      pointerActions.push({ type: "pointerMove", x, y });
    }

    pointerActions.push(
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    );

    this.currentCursorX = x;
    this.currentCursorY = y;

    await this.performActions(context, [{
      type: "pointer", id: "mouse1", parameters: { pointerType: "mouse" },
      actions: pointerActions,
    }]);
  }

  /** Hover at viewport coordinates. Supports optional kinetic interpolation. */
  async hover(context: string, x: number, y: number, opts?: KineticOptions): Promise<void> {
    const pointerActions: PointerAction[] = [];

    if (opts?.kinetic) {
      const sx = opts.startX ?? this.currentCursorX;
      const sy = opts.startY ?? this.currentCursorY;
      pointerActions.push(...generateKineticTrajectory(sx, sy, x, y, opts));
    } else {
      pointerActions.push({ type: "pointerMove", x, y });
    }

    this.currentCursorX = x;
    this.currentCursorY = y;

    await this.performActions(context, [{
      type: "pointer", id: "mouse1", parameters: { pointerType: "mouse" },
      actions: pointerActions,
    }]);
  }

  /**
   * PR-8j T2: send a single keypress by readable name. Translates
   * the name to its BiDi-spec single code point before issuing
   * keyDown + keyUp. Use this for non-character keys
   * (ArrowDown, Enter, Escape, Tab, ...). For typing strings
   * use `type()`.
   */
  async sendKey(context: string, name: string, id: string = "kbd"): Promise<void> {
    const value = translateKeyName(name);
    await this.performActions(context, [{
      type: "key", id,
      actions: [
        { type: "keyDown", value },
        { type: "keyUp", value },
      ],
    }]);
  }

  /** Type a string of keys. Supports fixed charDelayMs or humanized randomized delays. */
  async type(context: string, text: string, charDelayOrOpts: number | TypeOptions = 0): Promise<void> {
    const chars = Array.from(text);
    const actions: KeyAction[] = [];
    const opts: TypeOptions = typeof charDelayOrOpts === "number"
      ? { charDelayMs: charDelayOrOpts }
      : charDelayOrOpts;

    const [minD, maxD] = opts.delayRange ?? [40, 110];

    for (let i = 0; i < chars.length; i++) {
      if (i > 0) {
        let pause = opts.charDelayMs ?? 0;
        if (opts.humanize) {
          pause = Math.round(minD + Math.random() * (maxD - minD));
        }
        if (pause > 0) actions.push({ type: "pause", duration: pause });
      }
      actions.push({ type: "keyDown", value: chars[i]! });
      actions.push({ type: "keyUp", value: chars[i]! });
    }
    await this.performActions(context, [{ type: "key", id: "kbd", actions }]);
  }

  /** Scroll the page (or an element if you offset from its rect). */
  async scroll(context: string, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.performActions(context, [{
      type: "wheel", id: "wheel1",
      actions: [{ type: "scroll", x, y, deltaX, deltaY }],
    }]);
  }
}
