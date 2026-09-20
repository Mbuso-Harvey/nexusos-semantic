import { describe, it, expect, vi, beforeEach } from "vitest";
import { WindowsUiaDaemon } from "../../src/desktop/windows/uia-daemon.js";

describe("WindowsUiaDaemon Advanced Kinetic Actions", () => {
  let daemon: WindowsUiaDaemon;
  let runBridgeSpy: any;

  beforeEach(() => {
    daemon = new WindowsUiaDaemon();
    runBridgeSpy = vi.spyOn(daemon as any, "runBridge").mockImplementation(async (...args: any[]) => {
      const argList: string[] = args[0] || [];
      if (argList.includes("Focus")) return { status: "ok", windowId: "12345" };
      if (argList.includes("WindowState")) return { status: "ok", windowId: "12345", state: "Maximize" };
      if (argList.includes("SendHotkey")) return { status: "ok", hotkey: "^c" };
      if (argList.includes("RightClick")) return { status: "ok", x: 100, y: 200, action: "rightClick" };
      return { status: "ok" };
    });
  });

  it("should dispatch focusWindow command to bridge", async () => {
    await daemon.focusWindow("12345");
    expect(runBridgeSpy).toHaveBeenCalledWith(["-Action", "Focus", "-WindowHandle", "12345"]);
  });

  it("should dispatch setWindowState command to bridge", async () => {
    await daemon.setWindowState("12345", "Maximize");
    expect(runBridgeSpy).toHaveBeenCalledWith([
      "-Action",
      "WindowState",
      "-WindowHandle",
      "12345",
      "-WindowState",
      "Maximize",
    ]);
  });

  it("should dispatch sendHotkey command to bridge", async () => {
    await daemon.sendHotkey("^c");
    expect(runBridgeSpy).toHaveBeenCalledWith(["-Action", "SendHotkey", "-Text", "^c"]);
  });

  it("should route rightClick via dispatchKineticAction", async () => {
    await daemon.dispatchKineticAction({ type: "rightClick", x: 100, y: 200 });
    expect(runBridgeSpy).toHaveBeenCalledWith(["-Action", "RightClick", "-X", "100", "-Y", "200"]);
  });

  it("should route hotkey via dispatchKineticAction", async () => {
    await daemon.dispatchKineticAction({ type: "hotkey", text: "^v" });
    expect(runBridgeSpy).toHaveBeenCalledWith(["-Action", "SendHotkey", "-Text", "^v"]);
  });

  it("should route focus via dispatchKineticAction", async () => {
    await daemon.dispatchKineticAction({ type: "focus", windowId: "999" });
    expect(runBridgeSpy).toHaveBeenCalledWith(["-Action", "Focus", "-WindowHandle", "999"]);
  });

  it("should route windowState via dispatchKineticAction", async () => {
    await daemon.dispatchKineticAction({ type: "windowState", windowId: "999", state: "Minimize" });
    expect(runBridgeSpy).toHaveBeenCalledWith([
      "-Action",
      "WindowState",
      "-WindowHandle",
      "999",
      "-WindowState",
      "Minimize",
    ]);
  });
});
