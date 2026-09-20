import { get } from "node:https";
import { createWriteStream, existsSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "0.36.0";
const ZIP_URL = `https://github.com/mozilla/geckodriver/releases/download/v${VERSION}/geckodriver-v${VERSION}-win64.zip`;
const TMP_ZIP = join(tmpdir(), `geckodriver-v${VERSION}-win64.zip`);
const FINAL_PATH = "C:/Users/Harvey/AppData/Local/Temp/geckodriver.exe";

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      // Follow redirects (GitHub releases redirect to release-assets)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`  redirect -> ${res.headers.location.slice(0, 80)}...`);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(dest); });
    }).on("error", reject);
  });
}

async function main() {
  console.log(`[install-geckodriver] downloading v${VERSION} win64...`);
  console.log(`  from: ${ZIP_URL}`);

  await download(ZIP_URL, TMP_ZIP);
  console.log(`  saved: ${TMP_ZIP}`);

  // Extract the zip (PowerShell Expand-Archive is available on Windows)
  const extractDir = join(tmpdir(), "geckodriver-extract");
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  console.log(`  extracting to ${extractDir}...`);
  execSync(`powershell -Command "Expand-Archive -Path '${TMP_ZIP}' -DestinationPath '${extractDir}' -Force"`, { stdio: "inherit" });

  // Find geckodriver.exe inside the extracted folder
  const extractedExe = join(extractDir, "geckodriver.exe");
  if (!existsSync(extractedExe)) {
    // Some releases nest one folder deep
    const nested = join(extractDir, `geckodriver-v${VERSION}-win64`, "geckodriver.exe");
    if (existsSync(nested)) {
      console.log(`  found nested binary, copying to ${FINAL_PATH}`);
      execSync(`powershell -Command "Copy-Item -Path '${nested}' -Destination '${FINAL_PATH}' -Force"`);
    } else {
      throw new Error(`geckodriver.exe not found in ${extractDir}`);
    }
  } else {
    console.log(`  copying to ${FINAL_PATH}`);
    execSync(`powershell -Command "Copy-Item -Path '${extractedExe}' -Destination '${FINAL_PATH}' -Force"`);
  }

  // Verify
  if (existsSync(FINAL_PATH)) {
    chmodSync(FINAL_PATH, 0o755);
    const versionOut = execSync(`"${FINAL_PATH}" --version`, { encoding: "utf8" }).split("\n")[0];
    console.log(`\n[install-geckodriver] SUCCESS: ${FINAL_PATH}`);
    console.log(`  ${versionOut}`);
  } else {
    throw new Error(`installation failed — ${FINAL_PATH} not present`);
  }

  // Cleanup
  rmSync(TMP_ZIP, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("[install-geckodriver] FAILED:", e.message);
  process.exit(1);
});
