import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadBuildProfile(repoRoot) {
  const file = resolve(repoRoot, "data/build-profile.v1.json");
  const profile = JSON.parse(readFileSync(file, "utf8"));
  if (profile?.schema_version !== 1) throw new Error(`unsupported build profile at ${file}`);
  return Object.freeze(profile);
}

/**
 * Runtime releases and PersonaPack revisions are independent version axes.
 *
 * Falling back to package_version keeps older packaged trees readable, while current trees
 * pin persona_pack_version so a routing-only release cannot invalidate pack review evidence.
 */
export function resolvePersonaPackVersion(repoRoot) {
  const profile = loadBuildProfile(repoRoot);
  const version = profile.persona_pack_version || profile.package_version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("build profile must declare persona_pack_version or package_version");
  }
  return version;
}
