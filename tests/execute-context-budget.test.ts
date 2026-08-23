import { describe, it, expect, vi, beforeEach } from "vitest";
import { execute } from "../src/server/execute.js";

/**
 * Integrationstest des Kontext-Deckels.
 *
 * Der Unit-Test in context-budget.test.ts prueft die reine Logik. Hier geht es
 * um die Verdrahtung: greift der Deckel im echten Lauf, wird das Fenster nur
 * dann abgefragt, wenn es noetig ist, und geht der Request danach noch durch?
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  const logs: string[] = [];
  return {
    runId: "run-budget",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Agent",
      adapterType: "lmstudio_local",
      adapterConfig: {},
    },
    config: {
      url: "http://localhost:1234",
      defaultModel: "gemma4-31b-it",
      timeoutMs: 30000,
      maxIterations: 4,
      ...overrides,
    },
    context: { paperclipApiUrl: "http://localhost:3100" },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    onLog: async (_stream: string, chunk: string) => { logs.push(chunk); },
    authToken: "test-auth",
    logs,
  };
}

const probeAntwort = { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) };

function streamAntwort(text: string) {
  const body = `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`;
  return {
    ok: true,
    body: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); },
    }),
  };
}

/** Ein Tool-Aufruf, der ein riesiges Ergebnis erzeugt. */
function shellAufruf(id: string, bytes: number) {
  return {
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id,
            type: "function",
            function: {
              name: "shell_exec",
              arguments: JSON.stringify({ command: `head -c ${bytes} /dev/zero | tr '\\0' A` }),
            },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
  };
}

function bodyVon(call: any): any {
  try { return JSON.parse(call?.[1]?.body ?? "{}"); } catch { return {}; }
}

describe("execute — Kontext-Budget", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("fragt das Fenster NICHT ab, solange der Prompt klein ist", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(probeAntwort)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Fertig" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      })
      .mockResolvedValueOnce(streamAntwort("Fertig"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx() as any);

    expect(result.exitCode).toBe(0);
    // Ein normaler kurzer Heartbeat darf keinen zusaetzlichen HTTP-Aufruf kosten.
    const lookups = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/v0/models/"));
    expect(lookups).toHaveLength(0);
  });

  it("kappt ein uebergrosses Tool-Ergebnis, bevor es in die Historie geht", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(probeAntwort)
      .mockResolvedValueOnce(shellAufruf("c1", 200_000))
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Fertig" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await execute(makeCtx({ maxToolResultChars: 5_000, allowedWriteRoots: "" }) as any);

    // Der zweite Chat-Aufruf traegt die Tool-Antwort — sie muss gekappt sein.
    const chats = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/v1/chat/completions"));
    const toolMsg = bodyVon(chats[1]).messages?.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.content.length).toBeLessThan(6_000);
  });

  it("kuerzt die Historie und schickt keine verwaiste tool_call_id", async () => {
    // Fenster klein halten, damit der Deckel sicher greift.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(probeAntwort)
      .mockImplementation(async (url: string) => {
        if (String(url).includes("/api/v0/models/")) {
          return { ok: true, json: async () => ({ loaded_context_length: 50_000 }) };
        }
        if (String(url).includes("/v1/chat/completions")) {
          return shellAufruf(`c${fetchMock.mock.calls.length}`, 500_000);
        }
        return probeAntwort;
      });
    vi.stubGlobal("fetch", fetchMock);

    await execute(makeCtx({ maxToolResultChars: 120_000, maxIterations: 6 }) as any);

    const chats = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/v1/chat/completions"));
    const letzter = bodyVon(chats[chats.length - 1]).messages ?? [];

    // ZUERST: es muss ueberhaupt gekuerzt worden sein. Ohne diese Zusicherung
    // wuerde der Test auch dann gruen, wenn der Deckel gar nicht greift —
    // die Strukturpruefungen unten sind dann trivial erfuellt.
    const alleTexte = letzter.map((m: any) => m.content ?? "").join("\n");
    expect(alleTexte).toContain("Kontext gekürzt");
    expect(fetchMock.mock.calls.some((c) =>
      String(c[0]).includes("/api/v0/models/"))).toBe(true);
    // Und der Prompt muss danach wirklich unter dem Fenster liegen.
    expect(JSON.stringify(letzter).length / 4).toBeLessThan(50_000);

    // Jede tool-Nachricht braucht ihren Aufruf — sonst lehnt LM Studio mit 400 ab.
    const offen = new Set<string>();
    for (const m of letzter) {
      if (m.role === "assistant") for (const tc of m.tool_calls ?? []) offen.add(tc.id);
      if (m.role === "tool") expect(offen.has(m.tool_call_id)).toBe(true);
    }
    // System und Aufgabe ueberleben immer.
    expect(letzter[0]?.role).toBe("system");
    expect(letzter[1]?.role).toBe("user");
  });

  it("laeuft weiter, wenn das Fenster nicht ermittelbar ist", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(probeAntwort)
      .mockImplementation(async (url: string) => {
        if (String(url).includes("/api/v0/models/")) return { ok: false, status: 404 };
        if (String(url).includes("/v1/chat/completions")) {
          return shellAufruf(`c${fetchMock.mock.calls.length}`, 500_000);
        }
        return probeAntwort;
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({ maxIterations: 3 }) as any);
    // Kein Absturz: der Deckel ist eine Schutzmassnahme, kein Muss.
    expect([0, 1]).toContain(result.exitCode);
  });
});
