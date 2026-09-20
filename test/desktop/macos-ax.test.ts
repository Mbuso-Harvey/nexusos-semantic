import { describe, it, expect } from "vitest";
import { MacOSAxDaemon } from "../../src/desktop/macos/ax-daemon.js";
import { normalizeMacOSAXNode } from "../../src/substrate/desktop-normalizer.js";

describe("macOS AX Desktop Daemon (Phase D3)", () => {
  it("should list windows using mock JXA runner", async () => {
    const mockWindows = [
      {
        windowId: "Finder:0",
        title: "Downloads",
        processName: "Finder",
        processId: 101,
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      },
      {
        windowId: "Code:0",
        title: "workspace — Visual Studio Code",
        processName: "Code",
        processId: 202,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
      },
    ];

    const daemon = new MacOSAxDaemon({
      commandRunner: async (cmd, args) => {
        expect(cmd).toBe("osascript");
        return {
          stdout: JSON.stringify(mockWindows),
          stderr: "",
          code: 0,
        };
      },
    });

    const windows = await daemon.listWindows();
    expect(windows).toHaveLength(2);
    expect(windows[0]?.title).toBe("Downloads");
    expect(windows[1]?.processName).toBe("Code");
  });

  it("should find window matching pattern", async () => {
    const mockWindows = [
      {
        windowId: "Safari:0",
        title: "GitHub - Dashboard",
        processName: "Safari",
        processId: 303,
        bounds: { x: 50, y: 50, width: 1200, height: 800 },
      },
    ];

    const daemon = new MacOSAxDaemon({
      commandRunner: async () => ({
        stdout: JSON.stringify(mockWindows),
        stderr: "",
        code: 0,
      }),
    });

    const win = await daemon.findWindow("github");
    expect(win).toBeDefined();
    expect(win?.processName).toBe("Safari");

    const winNotFound = await daemon.findWindow("nonexistent");
    expect(winNotFound).toBeUndefined();
  });

  it("should get active window and allow setActiveWindow", async () => {
    let activatedApp = "";
    const daemon = new MacOSAxDaemon({
      commandRunner: async (_cmd, args) => {
        const code = args[args.length - 1] ?? "";
        if (code.includes("activate")) {
          activatedApp = "Safari";
          return { stdout: "", stderr: "", code: 0 };
        }
        return {
          stdout: JSON.stringify({
            windowId: "Safari:0",
            title: "GitHub",
            processName: "Safari",
            processId: 303,
            bounds: { x: 0, y: 0, width: 1440, height: 900 },
          }),
          stderr: "",
          code: 0,
        };
      },
    });

    const active = await daemon.getActiveWindow();
    expect(active.title).toBe("GitHub");
    expect(active.bounds.width).toBe(1440);

    await daemon.setActiveWindow({
      windowId: "Safari:0",
      title: "GitHub",
      processName: "Safari",
      processId: 303,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    });
    expect(activatedApp).toBe("Safari");
  });

  it("should extract accessibility tree and normalize to AxTreeNode", async () => {
    const rawAxTree = {
      role: "AXApplication",
      title: "Settings",
      enabled: true,
      children: [
        {
          role: "AXWindow",
          title: "System Settings",
          enabled: true,
          children: [
            {
              role: "AXButton",
              title: "Wi-Fi",
              description: "Configure Wi-Fi",
              enabled: true,
              value: null,
              children: [],
            },
            {
              role: "AXCheckBox",
              title: "Bluetooth",
              enabled: true,
              value: true,
              children: [],
            },
          ],
        },
      ],
    };

    const daemon = new MacOSAxDaemon({
      commandRunner: async () => ({
        stdout: JSON.stringify(rawAxTree),
        stderr: "",
        code: 0,
      }),
    });

    const tree = await daemon.getAccessibilityTree(3);
    expect(tree.role).toBe("AXApplication");
    expect(tree.children).toHaveLength(1);

    const normalized = normalizeMacOSAXNode(tree);
    expect(normalized.role).toBe("generic");
    expect(normalized.children).toHaveLength(1);

    const winNode = normalized.children[0]!;
    expect(winNode.role).toBe("dialog");
    expect(winNode.children).toHaveLength(2);

    const btnNode = winNode.children[0]!;
    expect(btnNode.role).toBe("button");
    expect(btnNode.name).toBe("Wi-Fi");

    const chkNode = winNode.children[1]!;
    expect(chkNode.role).toBe("checkbox");
    expect(chkNode.name).toBe("Bluetooth");
    expect(chkNode.states.checked).toBe(true);
  });

  it("should dispatch input actions via System Events", async () => {
    const executedScripts: string[] = [];
    const daemon = new MacOSAxDaemon({
      commandRunner: async (_cmd, args) => {
        executedScripts.push(args[args.length - 1] ?? "");
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    await daemon.performInputActions([
      {
        id: "click-wifi",
        type: "pointer",
        actions: [{ type: "pointerDown", x: 250, y: 150 } as any],
      },
      {
        id: "type-password",
        type: "key",
        actions: [{ type: "keyDown", value: "Secret123" }],
      },
    ]);

    expect(executedScripts.some((s) => s.includes("click at {250, 150}"))).toBe(true);
    expect(executedScripts.some((s) => s.includes('keystroke "Secret123"'))).toBe(true);
  });

  it("should create DesktopSubstrateSurface adhering to universal contract", async () => {
    const daemon = new MacOSAxDaemon({
      commandRunner: async () => ({
        stdout: JSON.stringify({
          role: "AXApplication",
          title: "App",
          enabled: true,
          children: [],
        }),
        stderr: "",
        code: 0,
      }),
    });

    const surface = await daemon.createSurface();
    expect(surface.substrateKind).toBe("desktop-macos");

    const axTree = await surface.extractAccessibilityTree();
    expect(axTree).toHaveLength(1);
    expect(axTree[0]?.role).toBe("generic");

    const metrics = await surface.getDisplayMetrics();
    expect(metrics.width).toBeGreaterThan(0);
    expect(metrics.orientation).toBe("landscape");
  });
});