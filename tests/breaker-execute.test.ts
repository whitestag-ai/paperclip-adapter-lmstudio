import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../src/server/execute.js";
import { loadStore, saveStore, openBreaker, breakerKey } from "../src/server/breaker-state.js";

let dir: string;
let statePath: string;

const URL_ = "http://lm:1234";
const PRIMARY = "remote-big";
const FALLBACK = "local-big";

function makeCtx() {
  const logs: string[] = [];
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Agent",
      adapterType: "lmstudio_local",
      adapterConfig: {},
    },
    config: {
      // One LM Studio, two models — the real setup. The fallback model lives
      // on another device, so only the model name differs.
      url: URL_,
      model: PRIMARY,
      fallbackUrl: URL_,
      fallbackModel: FALLBACK,
      probeTimeoutMs: 200,
      probeRetryBackoffMs: 0,
      timeoutMs: 5000,
      maxIterations: 3,
      breakerStatePath: statePath,
    },
    context: { paperclipApiUrl: "http://localhost:3100" },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    onLog: async (_stream: string, chunk: string) => { logs.push(chunk); },
    authToken: "test-auth",
    logs,
  };
}

const okModels = () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) });
const okChat = (content: string) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { role: "assistant", content } }] }),
});
const streamBody = () => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n'));
      c.close();
    },
  });
};
const connRefused = () =>
  Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });

describe("breaker wiring in execute", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    dir = await mkdtemp(join(tmpdir(), "breaker-exec-"));
    statePath = join(dir, "state.json");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("benches the stalled model so the next heartbeat skips it", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(okModels())        // primary probe ok
      .mockRejectedValueOnce(connRefused())     // real call on primary dies
      .mockResolvedValueOnce(okModels())        // fallback probe
      .mockResolvedValueOnce(okChat("Recovered"))
      .mockResolvedValueOnce({ ok: true, body: streamBody() }));

    await execute(makeCtx() as any);

    const store = await loadStore(statePath);
    expect(store).toHaveProperty(breakerKey(URL_, PRIMARY));
  });

  it("starts on the fallback when the breaker is already open", async () => {
    await saveStore(statePath, openBreaker({}, breakerKey(URL_, PRIMARY), "timeout", Date.now()));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okModels())        // fallback probe only
      .mockResolvedValueOnce(okChat("Done"))
      .mockResolvedValueOnce({ ok: true, body: streamBody() });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx() as any);

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}"));
    expect(body.model).toBe(FALLBACK);
  });

  it("clears the breaker once the primary answers again after the cooldown", async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    await saveStore(statePath, openBreaker({}, breakerKey(URL_, PRIMARY), "timeout", twoHoursAgo));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(okModels())        // primary probe — recovered
      .mockResolvedValueOnce(okChat("Done"))
      .mockResolvedValueOnce({ ok: true, body: streamBody() }));

    await execute(makeCtx() as any);

    const store = await loadStore(statePath);
    expect(store).not.toHaveProperty(breakerKey(URL_, PRIMARY));
  });
});
