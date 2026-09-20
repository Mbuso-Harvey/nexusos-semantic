/**
 * Smoke test for the synthetic SaaS demo server. Boots the static server on
 * a free port, fetches every page, and asserts the structural primitives
 * the extractors are expected to find.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const SERVER = path.join(REPO, "demo/saas/server.cjs");
const PORT = 7311;

async function waitForReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/index.html`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(50);
  }
  child.kill("SIGTERM");
  throw new Error(`server did not become ready within ${timeoutMs}ms`);
}

let server: ChildProcess | null = null;
let baseUrl: string;

beforeAll(async () => {
  server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForReady(server, 5000);
  baseUrl = `http://127.0.0.1:${PORT}`;
}, 10_000);

afterAll(async () => {
  if (server) {
    server.kill("SIGTERM");
    await sleep(50);
  }
});

describe("synthetic SaaS demo", () => {
  it("serves the homepage with full a11y primitives", async () => {
    const r = await fetch(`${baseUrl}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('popovertarget="user-menu"');
    expect(html).toContain('popover');
    expect(html).toContain('command="--toggle-theme"');
    expect(html).toContain('command="show-modal"');
    expect(html).toContain('commandfor="confirm-signout"');
  });

  it("serves the design-tokens sidecar as JSON", async () => {
    const r = await fetch(`${baseUrl}/design-tokens.json`);
    expect(r.status).toBe(200);
    const json = await r.json() as any;
    expect(json.color.bg.$value).toBe("#ffffff");
    expect(json.color.accent.$value).toBe("#3b82f6");
    expect(json.font.size.lg.$value).toBe("20px");
  });

  it("serves the webmcp capability sidecar as JSON with three tools across tiers", async () => {
    const r = await fetch(`${baseUrl}/webmcp.json`);
    expect(r.status).toBe(200);
    const json = await r.json() as any;
    expect(json.tools).toHaveLength(3);
    const tiers = json.tools.map((t: any) => t.security);
    expect(tiers).toContain("EXECUTE");
    expect(tiers).toContain("PROPOSE");
    expect(tiers).toContain("CONFIRM");
  });

  it("every page resolves with 200 OK and a navigation landmark", async () => {
    const pages = ["/", "/projects.html", "/tickets.html", "/settings.html", "/docs.html", "/about.html"];
    for (const p of pages) {
      const r = await fetch(`${baseUrl}${p}`);
      expect(r.status, `page ${p} should be 200`).toBe(200);
      const html = await r.text();
      expect(html, `page ${p} should have a nav`).toMatch(/<nav[^>]*aria-label="Sections"/);
    }
  });

  it("resolves bare path to .html fallback (e.g. /projects -> /projects.html)", async () => {
    const r = await fetch(`${baseUrl}/projects`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Projects");
  });

  it("returns 404 for unknown paths", async () => {
    const r = await fetch(`${baseUrl}/this-does-not-exist`);
    expect(r.status).toBe(404);
  });
});
