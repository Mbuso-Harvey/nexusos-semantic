import { describe, it, expect } from "vitest";
import { generateKineticTrajectory, InputApi } from "../../src/bidi-client/input.js";
import type { BiDiTransport } from "../../src/bidi-client/transport.js";

describe("Kinetic Input Trajectory & Anti-Detection", () => {
  it("returns single point when distance is negligible", () => {
    const trajectory = generateKineticTrajectory(100, 100, 102, 101);
    expect(trajectory.length).toBe(1);
    expect(trajectory[0]).toMatchObject({ type: "pointerMove", x: 102, y: 101 });
  });

  it("generates intermediate Bézier steps with human curvature and micro-jitter", () => {
    const trajectory = generateKineticTrajectory(0, 0, 500, 400, {
      steps: 12,
      jitter: 2.0,
    });

    expect(trajectory.length).toBe(12);

    // Trajectory moves progressively towards the target
    const finalStep = trajectory[trajectory.length - 1]!;
    expect(finalStep.type).toBe("pointerMove");
    // The final step reaches the target
    expect(Math.abs((finalStep as any).x - 500)).toBeLessThanOrEqual(2);
    expect(Math.abs((finalStep as any).y - 400)).toBeLessThanOrEqual(2);

    // Steps include human duration variance
    for (const step of trajectory) {
      if (step.type === "pointerMove") {
        expect(step.duration).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it("InputApi.click uses kinetic interpolation when requested", async () => {
    const sent: Array<{ method: string; params: any }> = [];
    const mockTransport = {
      send: async (method: string, params: any) => {
        sent.push({ method, params });
        return {};
      },
    } as unknown as BiDiTransport;

    const input = new InputApi(mockTransport);

    // Non-kinetic click (default, instant)
    await input.click("ctx1", 200, 150);
    expect(sent.length).toBe(1);
    const regularActions = sent[0]!.params.actions[0].actions;
    expect(regularActions.length).toBe(3); // pointerMove, pointerDown, pointerUp
    expect(regularActions[0]).toEqual({ type: "pointerMove", x: 200, y: 150 });

    // Kinetic click from current position (200, 150) to (600, 450)
    await input.click("ctx1", 600, 450, { kinetic: true, steps: 10 });
    expect(sent.length).toBe(2);
    const kineticActions = sent[1]!.params.actions[0].actions;
    expect(kineticActions.length).toBe(12); // 10 pointerMoves + pointerDown + pointerUp
  });

  it("InputApi.type introduces humanized pauses between keystrokes", async () => {
    const sent: Array<{ method: string; params: any }> = [];
    const mockTransport = {
      send: async (method: string, params: any) => {
        sent.push({ method, params });
        return {};
      },
    } as unknown as BiDiTransport;

    const input = new InputApi(mockTransport);

    await input.type("ctx1", "abc", { humanize: true, delayRange: [30, 80] });
    expect(sent.length).toBe(1);
    const actions = sent[0]!.params.actions[0].actions;

    // 'a' (keyDown, keyUp), pause, 'b' (keyDown, keyUp), pause, 'c' (keyDown, keyUp) = 8 actions
    expect(actions.length).toBe(8);
    const pauses = actions.filter((a: any) => a.type === "pause");
    expect(pauses.length).toBe(2);
    for (const p of pauses) {
      expect(p.duration).toBeGreaterThanOrEqual(30);
      expect(p.duration).toBeLessThanOrEqual(80);
    }
  });
});
