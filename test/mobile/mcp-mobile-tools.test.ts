import { describe, it, expect, vi } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { buildMcpServer } from "../../src/server/mcp-server.js";
import { AndroidClient } from "../../src/mobile/android/uia2-client.js";
import {
  EnforcementGateway,
  SecurityPosture,
  configureEnforcement,
} from "../../src/security/index.js";

/**
 * Kinetic dispatch is a side-effecting technique (mobile_act), so §10–§12
 * requires an explicit authorization before the handler may run. These tests
 * inject a gateway that models an operator authorization for the mobile
 * substrate; the process-wide default stays fail-closed (AUDIT).
 */
async function authorizedMobileGateway(): Promise<EnforcementGateway> {
  const gateway = new EnforcementGateway();
  await configureEnforcement(
    {
      posture: SecurityPosture.AUTOPILOT,
      targets: ["*"],
      operations: ["*"],
      substrates: ["mobile"],
      maxImpact: "modify",
      requireDurableAudit: false,
      actor: { id: "test-operator", name: "Test Operator", type: "operator" },
    },
    gateway,
  );
  return gateway;
}

describe("MCP Mobile Substrate Tools (Phase M3)", () => {
  it("registers mobile tools when mobile option is enabled", async () => {
    const graph = new Graph();
    const server = buildMcpServer(graph, { mobile: true });
    expect(server).toBeDefined();

    const tools = (server as any)._registeredTools;
    expect(tools).toBeDefined();
    expect(tools.mobile_list_devices).toBeDefined();
    expect(tools.mobile_scrape_device).toBeDefined();
    expect(tools.mobile_touch_action).toBeDefined();
  });

  it("executes mobile_list_devices tool handler successfully", async () => {
    const mockClient = new AndroidClient();
    vi.spyOn(mockClient, "listDevices").mockResolvedValueOnce([
      { id: "device-123", state: "device", model: "Pixel_7", device: "panther" },
    ]);

    const graph = new Graph();
    const server = buildMcpServer(graph, { mobile: mockClient });
    const tool = (server as any)._registeredTools.mobile_list_devices;
    expect(tool).toBeDefined();

    const res = await tool.handler({});
    expect(res.isError).toBeFalsy();
    expect(res.content).toBeDefined();
    const devices = JSON.parse(res.content[0].text);
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe("device-123");
  });

  it("executes mobile_touch_action tap handler successfully", async () => {
    const mockClient = new AndroidClient();
    const tapSpy = vi.spyOn(mockClient, "tap").mockResolvedValueOnce();

    const graph = new Graph();
    const gateway = await authorizedMobileGateway();
    const server = buildMcpServer(graph, {
      mobile: mockClient,
      enforcement: { gateway },
    });
    const tool = (server as any)._registeredTools.mobile_touch_action;
    expect(tool).toBeDefined();

    const res = await tool.handler({ type: "tap", x: 150, y: 350 });
    expect(res.isError).toBeFalsy();
    expect(tapSpy).toHaveBeenCalledWith(150, 350);
  });

  it("denies mobile_touch_action without an authorization (fail closed)", async () => {
    const mockClient = new AndroidClient();
    const tapSpy = vi.spyOn(mockClient, "tap").mockResolvedValueOnce();

    const graph = new Graph();
    // Default gateway = AUDIT posture: kinetic dispatch is denied and the
    // handler never runs.
    const server = buildMcpServer(graph, { mobile: mockClient });
    const tool = (server as any)._registeredTools.mobile_touch_action;

    const res = await tool.handler({ type: "tap", x: 1, y: 1 });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.denied).toBe(true);
    expect(payload.denialKind).toBe("posture_denied");
    expect(tapSpy).not.toHaveBeenCalled();
  });
});
