import { build } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

async function main() {
  console.log("[build-sea] Step 1: Building standalone CJS bundle...");
  mkdirSync("dist", { recursive: true });
  mkdirSync("dist/bin", { recursive: true });

  await build({
    entryPoints: ["src/cli/awg.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: "dist/bundle.cjs",
    banner: {
      js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;',
    },
    define: {
      "import.meta.url": "__import_meta_url",
    },
    external: [],
  });

  console.log("[build-sea] Step 2: Generating sea-config.json...");
  const seaConfig = {
    main: "dist/bundle.cjs",
    output: "dist/sea-prep.blob",
    disableExperimentalSEAWarning: true,
  };
  writeFileSync("sea-config.json", JSON.stringify(seaConfig, null, 2), "utf8");

  console.log("[build-sea] Step 3: Compiling SEA blob via node...");
  execSync("node --experimental-sea-config sea-config.json", { stdio: "inherit" });

  console.log("[build-sea] Step 4: Copying Node executable...");
  const isWin = process.platform === "win32";
  const exeName = isWin ? "nexus.exe" : "nexus";
  const legacyExeName = isWin ? "awg.exe" : "awg";
  const targetExe = resolve(join("dist", "bin", exeName));
  const legacyTargetExe = resolve(join("dist", "bin", legacyExeName));
  copyFileSync(process.execPath, targetExe);

  console.log(`[build-sea] Step 5: Injecting blob into ${targetExe} via postject...`);
  const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
  let postjectCmd = `npx postject "${targetExe}" NODE_SEA_BLOB "dist/sea-prep.blob" --sentinel-fuse ${fuse}`;
  if (process.platform === "darwin") {
    postjectCmd += " --macho-segment-name NODE_SEA";
  }

  execSync(postjectCmd, { stdio: "inherit" });

  // Provide legacy `awg` binary alias
  copyFileSync(targetExe, legacyTargetExe);

  if (process.platform === "darwin") {
    try {
      execSync(`codesign --sign - "${targetExe}"`, { stdio: "inherit" });
      execSync(`codesign --sign - "${legacyTargetExe}"`, { stdio: "inherit" });
    } catch {
      // Best-effort ad-hoc signing
    }
  }

  // Copy uia-bridge.ps1 for windows UIA desktop automation
  const scriptsDir = resolve("dist/src/desktop/windows/scripts");
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync("src/desktop/windows/scripts/uia-bridge.ps1", join(scriptsDir, "uia-bridge.ps1"));

  // Copy viewer.html for awg view/viewer
  const viewerDir = resolve("dist/src/viewer");
  mkdirSync(viewerDir, { recursive: true });
  copyFileSync("src/viewer/viewer.html", join(viewerDir, "viewer.html"));

  console.log(`[build-sea] Successfully created standalone SEA executable: ${targetExe}`);
}

main().catch((err) => {
  console.error("[build-sea] Failed:", err);
  process.exit(1);
});
