/**
 * Nexus build version, sourced from package.json at runtime.
 *
 * Used for substrate provenance (`substrate_info`, manifest binding): an agent
 * must be able to tell WHICH build served it, not just that a server answered.
 * The `../package.json` specifier resolves both from source (src/) and from
 * the compiled output (dist/src/), because tsc emits the imported JSON next to
 * the JS (rootDir "." → dist/package.json).
 */
import packageJson from "../package.json" with { type: "json" };

export const NEXUS_VERSION: string =
  (packageJson as { version?: string }).version ?? "0.0.0";
