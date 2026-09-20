import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * ED-09 §2/§4: the Evidence Ledger target set is contract, not convenience.
 * Every manifest must (a) parse, (b) name an authorization basis, and
 * (c) carry gating semantics consistent with its class. A target that
 * cannot show its authorization basis must never be crawlable by the
 * runner — this test keeps the manifest format honest.
 */
const targetsDir = resolve(process.cwd(), "verification", "targets");
const CLASSES = ["owned", "self-hosted-oss", "permissioned-public", "design-partner"];

function loadAll(): Array<{ file: string; manifest: Record<string, any> }> {
  return readdirSync(targetsDir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      manifest: JSON.parse(readFileSync(join(targetsDir, file), "utf8")) as Record<string, any>,
    }));
}

describe("Evidence Ledger target manifests (ED-09)", () => {
  it("contains the five ratified targets and nothing unparsed", () => {
    const slugs = loadAll().map((x) => x.manifest.slug).sort();
    expect(slugs).toEqual(["aria-apg", "demo-saas", "example-com", "httpbin", "juice-shop"]);
  });

  it("every manifest is structurally valid", () => {
    for (const { file, manifest } of loadAll()) {
      expect(manifest.slug, `${file}: slug must equal filename`).toBe(file.replace(/\.json$/, ""));
      expect(CLASSES, `${file}: class must be ratified`).toContain(manifest.class);
      expect(manifest.target?.url, `${file}: target.url required`).toBeTruthy();
      expect(manifest.target?.host, `${file}: target.host required`).toBeTruthy();
      expect(manifest.crawl?.maxPages, `${file}: crawl.maxPages >= 1`).toBeGreaterThanOrEqual(1);
      expect(manifest.expect, `${file}: expect block required`).toBeTruthy();
    }
  });

  it("every manifest records an authorization basis (ED-09 §2)", () => {
    for (const { file, manifest } of loadAll()) {
      expect(
        typeof manifest.authorizationBasis === "string" && manifest.authorizationBasis.length >= 20,
        `${file}: authorizationBasis is mandatory and must be substantive`,
      ).toBe(true);
    }
  });

  it("gating semantics match the class (ED-09 §4)", () => {
    for (const { file, manifest } of loadAll()) {
      if (manifest.class === "permissioned-public") {
        expect(manifest.authoritative, `${file}: permissioned-public is evidence-only`).toBe(false);
        expect(manifest.robots?.check, `${file}: must snapshot robots.txt`).toBe(true);
      } else {
        expect(manifest.authoritative, `${file}: ${manifest.class} gates the build`).toBe(true);
      }
    }
  });

  it("permissioned-public targets are hard-capped (ED-09 §5)", () => {
    for (const { file, manifest } of loadAll()) {
      if (manifest.class === "permissioned-public") {
        expect(manifest.crawl.maxPages, `${file}: evidence-only budget cap`).toBeLessThanOrEqual(2);
      }
    }
  });
});
