/**
 * Reasoning-Modelle sauber bedienen.
 *
 * A) `reasoningEffort` muss als `reasoning_effort` im Request landen, damit sich
 *    das Denken pro Agent abschalten laesst. Ohne den Schalter verbrennt ein
 *    Modell wie qwen3.8-27b tausende Token, bevor es antwortet — gemessen 8.000
 *    Token in 142 s, ohne fertig zu werden.
 *
 * B) Denkt ein Modell in sein Token-Limit, kommt `content: ""` zurueck und die
 *    Antwort steckt in `reasoning_content`. Wer nur `content` liest, reicht eine
 *    leere Assistant-Nachricht in die Agentenschleife weiter — genau der stille
 *    Ausfall, der den Vault-Tagger 51 Tage totgelegt hat.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { callChatCompletion } from "../src/server/llm-client.js";

const BASE = {
  url: "http://localhost:1234",
  model: "qwen/qwen3.8-27b",
  messages: [{ role: "user" as const, content: "Hallo" }],
  tools: [],
  timeoutMs: 30000,
};

function stubResponse(message: Record<string, unknown>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const bodyOf = (m: ReturnType<typeof vi.fn>) => JSON.parse(m.mock.calls[0][1].body);

describe("A) reasoning_effort wird durchgereicht", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("setzt reasoning_effort, wenn reasoningEffort angegeben ist", async () => {
    const fetchMock = stubResponse({ role: "assistant", content: "Hallo" });

    await callChatCompletion({ ...BASE, reasoningEffort: "none" });

    expect(bodyOf(fetchMock).reasoning_effort).toBe("none");
  });

  it("laesst das Feld weg, wenn nichts angegeben ist", async () => {
    const fetchMock = stubResponse({ role: "assistant", content: "Hallo" });

    await callChatCompletion({ ...BASE });

    expect(bodyOf(fetchMock)).not.toHaveProperty("reasoning_effort");
  });

  it("reicht auch andere Stufen unveraendert weiter", async () => {
    const fetchMock = stubResponse({ role: "assistant", content: "Hallo" });

    await callChatCompletion({ ...BASE, reasoningEffort: "low" });

    expect(bodyOf(fetchMock).reasoning_effort).toBe("low");
  });
});

describe("B) leeres content bei gefuelltem reasoning_content", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("faellt auf reasoning_content zurueck, statt eine leere Nachricht zu liefern", async () => {
    stubResponse({ role: "assistant", content: "", reasoning_content: "Die Hauptstadt ist Potsdam." });

    const result = await callChatCompletion({ ...BASE });

    expect(result.message.content).toBe("Die Hauptstadt ist Potsdam.");
  });

  it("behandelt content: null genauso", async () => {
    stubResponse({ role: "assistant", content: null, reasoning_content: "Antwort aus dem Denkprotokoll." });

    const result = await callChatCompletion({ ...BASE });

    expect(result.message.content).toBe("Antwort aus dem Denkprotokoll.");
  });

  it("laesst ein gefuelltes content unangetastet", async () => {
    stubResponse({ role: "assistant", content: "Echte Antwort", reasoning_content: "nur Gedanken" });

    const result = await callChatCompletion({ ...BASE });

    expect(result.message.content).toBe("Echte Antwort");
  });

  it("greift nicht ein, wenn das Modell Werkzeuge aufruft", async () => {
    stubResponse({
      role: "assistant",
      content: "",
      reasoning_content: "Ich sollte das Werkzeug benutzen.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "fs_read", arguments: "{}" } }],
    });

    const result = await callChatCompletion({ ...BASE });

    // Bei einem Werkzeugaufruf ist leeres content normal und korrekt.
    expect(result.message.content).toBe("");
    expect(result.message.tool_calls).toHaveLength(1);
  });

  it("erfindet nichts, wenn beide Felder leer sind", async () => {
    stubResponse({ role: "assistant", content: "" });

    const result = await callChatCompletion({ ...BASE });

    expect(result.message.content).toBe("");
  });
});
