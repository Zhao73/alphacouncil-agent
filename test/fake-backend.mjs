// Loaded by the CLI through ALPHA_BACKEND_MODULE in tests.
import { fakeBackend } from "./helpers.mjs";

export function createBackend() {
  return fakeBackend({ fail: (process.env.FAKE_FAIL || "").split("|").filter(Boolean), delayMs: Number(process.env.FAKE_DELAY_MS || 5) });
}
