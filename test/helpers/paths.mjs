import { fileURLToPath } from "node:url";

// Resolve everything from import.meta.url. Tests must never depend on process.cwd():
// the MCP server is launched by hosts from arbitrary working directories, and a test
// that only passes from the repo root hides that entire class of bug.
export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const serverEntry = fileURLToPath(new URL("../../mcp/server.mjs", import.meta.url));

export function repoFile(rel) {
  return fileURLToPath(new URL(`../../${rel}`, import.meta.url));
}
