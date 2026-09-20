import { describe, it, expect, vi, beforeEach } from "vitest";
import { AndroidClient } from "../../src/mobile/android/uia2-client.js";
import { WdaClient } from "../../src/mobile/ios/wda-client.js";
import { MobileSubstrateSurface } from "../../src/substrate/mobile-surface.js";

describe("Mobile Substrate Clients", () => {
  describe("AndroidClient", () => {
    let client: AndroidClient;

    beforeEach(() => {
      client = new AndroidClient({ deviceId: "emulator-5554" });
    });

    it("should parse XML hierarchy from UIAutomator dump correctly", () => {
      const sampleXml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Submit" resource-id="com.example.app:id/submit_btn" class="android.widget.Button" package="com.example.app" content-desc="Submit Form" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,500][400,600]" />
  </node>
</hierarchy>`;

      const parsed = client.parseXmlHierarchy(sampleXml);
      expect(parsed).toBeDefined();
      expect(parsed?.className).toBe("android.widget.FrameLayout");
      expect(parsed?.bounds).toEqual({ left: 0, top: 0, right: 1080, bottom: 2400 });
      expect(parsed?.children).toHaveLength(1);
      
      const child = parsed?.children?.[0];
      expect(child?.className).toBe("android.widget.Button");
      expect(child?.text).toBe("Submit");
      expect(child?.contentDescription).toBe("Submit Form");
      expect(child?.resourceId).toBe("com.example.app:id/submit_btn");
      expect(child?.clickable).toBe(true);
      expect(child?.bounds).toEqual({ left: 100, top: 500, right: 400, bottom: 600 });
    });
    it("should accurately parse deeply nested sibling XML subtrees without truncation", () => {
      const complexXml = `<hierarchy rotation="0">
        <node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
          <node class="android.widget.LinearLayout" bounds="[0,0][1080,1200]">
            <node class="android.widget.TextView" text="Item 1" bounds="[0,0][500,200]" />
            <node class="android.widget.LinearLayout" bounds="[0,200][500,400]">
              <node class="android.widget.Button" text="SubAction 1" bounds="[0,200][200,300]" />
            </node>
          </node>
          <node class="android.widget.LinearLayout" bounds="[0,1200][1080,2400]">
            <node class="android.widget.TextView" text="Item 2" bounds="[0,1200][500,1400]" />
          </node>
        </node>
      </hierarchy>`;

      const parsed = client.parseXmlHierarchy(complexXml);
      expect(parsed).toBeDefined();
      expect(parsed?.children).toHaveLength(2);
      expect(parsed?.children?.[0]?.children).toHaveLength(2);
      expect(parsed?.children?.[0]?.children?.[0]?.text).toBe("Item 1");
      expect(parsed?.children?.[0]?.children?.[1]?.children?.[0]?.text).toBe("SubAction 1");
      expect(parsed?.children?.[1]?.children?.[0]?.text).toBe("Item 2");
    });


    it("should parse `adb devices -l` output into structured list", async () => {
      vi.spyOn(client, "runAdb").mockResolvedValueOnce({
        stdout: `List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a
RFCW102V98D            device usb:1-1 product:starqltezc model:SM_G9600 device:starqltechn
`,
        stderr: "",
      });

      const devices = await client.listDevices();
      expect(devices).toHaveLength(2);
      expect(devices[0]).toEqual({
        id: "emulator-5554",
        state: "device",
        model: "sdk_gphone64_arm64",
        device: "emu64a",
      });
      expect(devices[1]?.id).toBe("RFCW102V98D");
    });

    it("should normalize Android tree through MobileSubstrateSurface into canonical AxTreeNode", async () => {
      const sampleXml = `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
        <node class="android.widget.Button" text="Search" content-desc="Search Button" clickable="true" bounds="[50,50][200,100]" />
      </node>`;

      vi.spyOn(client, "runAdb").mockImplementation(async (args: string[]) => {
        if (args.includes("dump")) return { stdout: "UI hierchary dumped to: /data/local/tmp/awg_dump.xml", stderr: "" };
        if (args.includes("cat")) return { stdout: sampleXml, stderr: "" };
        return { stdout: "", stderr: "" };
      });

      const surface = new MobileSubstrateSurface("mobile-android", "android-surface-1", client);
      const axTree = await surface.extractAccessibilityTree();
      expect(axTree).toHaveLength(1);

      const root = axTree[0]!;
      expect(root.role).toBe("generic");
      expect(root.children).toHaveLength(1);

      const button = root.children[0]!;
      expect(button.role).toBe("button");
      expect(button.name).toBe("Search Button");
      expect(button.tag).toBe("button");
      expect(button.visibility).toBe("visible");
    });
  });

  describe("WdaClient", () => {
    it("should fetch and normalize iOS hierarchy through MobileSubstrateSurface", async () => {
      const rawIosTree = {
        value: {
          type: "Window",
          label: "Main App Window",
          enabled: true,
          frame: { x: 0, y: 0, width: 390, height: 844 },
          children: [
            {
              type: "Button",
              label: "Continue",
              enabled: true,
              frame: { x: 40, y: 700, width: 310, height: 50 },
            },
          ],
        },
      };

      const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => rawIosTree,
      } as any);

      const client = new WdaClient();
      const surface = new MobileSubstrateSurface("mobile-ios", "ios-surface-1", client);
      const axTree = await surface.extractAccessibilityTree();

      expect(globalFetch).toHaveBeenCalled();
      expect(axTree).toHaveLength(1);

      const root = axTree[0]!;
      expect(root.role).toBe("window");
      expect(root.children).toHaveLength(1);

      const btn = root.children[0]!;
      expect(btn.role).toBe("button");
      expect(btn.name).toBe("Continue");
      expect(btn.visibility).toBe("visible");
    });
    it("should support iOS session lifecycle, gestures, and app management", async () => {
      const fetchCalls: Array<{ url: string; options?: any }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, opts: any) => {
        fetchCalls.push({ url: String(url), options: opts });
        if (String(url).endsWith("/session") && opts?.method === "POST") {
          return { ok: true, json: async () => ({ sessionId: "ios-test-session-123" }) } as any;
        }
        if (String(url).endsWith("/alert/text")) {
          return { ok: true, json: async () => ({ value: "Allow Notifications?" }) } as any;
        }
        if (String(url).endsWith("/apps/terminate")) {
          return { ok: true, json: async () => ({ value: true }) } as any;
        }
        return { ok: true, json: async () => ({}) } as any;
      });

      const client = new WdaClient({ host: "localhost", port: 8100 });
      const sessionId = await client.createSession("com.apple.Preferences");
      expect(sessionId).toBe("ios-test-session-123");

      await client.swipe(100, 500, 100, 100, 0.3);
      await client.longPress(200, 300, 1.5);
      await client.pressHome();

      const alertText = await client.getAlertText();
      expect(alertText).toBe("Allow Notifications?");

      await client.acceptAlert();
      await client.launchApp("com.apple.mobilesafari");
      const terminated = await client.terminateApp("com.apple.mobilesafari");
      expect(terminated).toBe(true);

      await client.closeSession();

      expect(fetchCalls.some((c) => c.url.endsWith("/session"))).toBe(true);
      expect(fetchCalls.some((c) => c.url.endsWith("/wda/dragfromtoforduration"))).toBe(true);
      expect(fetchCalls.some((c) => c.url.endsWith("/wda/touchAndHold"))).toBe(true);
      expect(fetchCalls.some((c) => c.url.endsWith("/wda/homescreen"))).toBe(true);
      expect(fetchCalls.some((c) => c.url.endsWith("/alert/accept"))).toBe(true);
      expect(fetchCalls.some((c) => c.url.endsWith("/wda/apps/launch"))).toBe(true);
      expect(fetchCalls.some((c) => c.url.endsWith("/session/ios-test-session-123"))).toBe(true);
    });
  });
});
