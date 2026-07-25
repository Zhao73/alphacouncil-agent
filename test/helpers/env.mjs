import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test gets a throwaway ALPHACOUNCIL_AGENT_DATA_DIR. The previous selfcheck wrote
// into the developer's real ~/.alphacouncil-agent/runs on every `npm run check`.
export function makeDataDir() {
  return mkdtempSync(join(tmpdir(), "alphacouncil-test-"));
}

export function removeDataDir(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover temp dir is noise, not a test failure.
  }
}
