/**
 * Verdrahtung: `reasoningEffort` aus der Agenten-Konfiguration muss bis in den
 * echten Chat-Request durchkommen — auch auf dem Fallback-Pfad. Ein Test nur am
 * llm-client wuerde die Luecke nicht sehen, denn genau das Weitergeben war das
 * Problem: der Adapter las den Schluessel ueberhaupt nicht.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execute } from "../src/server/execute.js";

const okModelsResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ id: "m" }] }),
});

const finalAnswer = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { role: "assistant", content: "Fertig." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }),
});

const connRefused = () => Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } });

function makeCtx(overrides: Record<string, unknown> = {}) {
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
      url: "http://primary:1234",
      defaultModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "small",
      probeTimeoutMs: 200,
      probeRetryBackoffMs: 0,
      timeoutMs: 5000,
      maxIterations: 3,
      ...overrides,
    },
    context: { paperclipApiUrl: "http://localhost:3100" },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    onLog: async (_stream: string, chunk: string) => { logs.push(chunk); },
    authToken: "test-auth",
    logs,
  };
}

/** Bodies aller POSTs auf /v1/chat/completions. */
function chatBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/chat/completions"))
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

describe("execute — reasoningEffort aus der Agenten-Konfiguration", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("reicht reasoningEffort in den Chat-Request durch", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okModelsResponse())
      .mockResolvedValue(finalAnswer());
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({ reasoningEffort: "none" }) as never);

    expect(result.exitCode).toBe(0);
    const bodies = chatBodies(fetchMock);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => b.reasoning_effort === "none")).toBe(true);
  });

  it("laesst das Feld weg, wenn nichts konfiguriert ist", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okModelsResponse())
      .mockResolvedValue(finalAnswer());
    vi.stubGlobal("fetch", fetchMock);

    await execute(makeCtx() as never);

    const bodies = chatBodies(fetchMock);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => !("reasoning_effort" in b))).toBe(true);
  });

  it("gilt auch auf dem Fallback-Pfad", async () => {
    const fetchMock = vi.fn()
      // Primaerer Probe-Versuch scheitert zweimal
      .mockRejectedValueOnce(connRefused())
      .mockRejectedValueOnce(connRefused())
      // Fallback-Probe ok, danach die Antwort
      .mockResolvedValueOnce(okModelsResponse())
      .mockResolvedValue(finalAnswer());
    vi.stubGlobal("fetch", fetchMock);

    await execute(makeCtx({ reasoningEffort: "none" }) as never);

    const fallbackChats = fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith("http://fallback") && String(url).includes("/chat/completions"))
      .map(([, init]) => JSON.parse((init as { body: string }).body));

    expect(fallbackChats.length).toBeGreaterThan(0);
    expect(fallbackChats.every((b) => b.reasoning_effort === "none")).toBe(true);
  });
});
