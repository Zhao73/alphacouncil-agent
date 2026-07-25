// Compatibility shim. The real suite is `node --test` (see package.json "test").
// Kept for one release so `npm run check`, CLAUDE.md, AGENTS.md and CONTRIBUTING.md keep
// working unchanged. Remove in 0.6.0.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const result = spawnSync(process.execPath, ["--test"], { cwd: repoRoot, stdio: "inherit" });
process.exit(result.status ?? 1);
