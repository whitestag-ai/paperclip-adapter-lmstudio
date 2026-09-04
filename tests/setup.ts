import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

// Keep the circuit breaker out of the developer's home directory during tests.
const statePath = join(
  mkdtempSync(join(tmpdir(), "lmstudio-adapter-test-")),
  "breaker-state.json",
);
process.env.LMSTUDIO_ADAPTER_BREAKER_STATE = statePath;

// The breaker is deliberately persistent across runs — which means one test
// that trips it would otherwise steer every test after it onto the fallback,
// making results depend on test order. Each test starts from a clean slate;
// tests that want an open breaker write one themselves.
beforeEach(() => {
  rmSync(statePath, { force: true });
});
