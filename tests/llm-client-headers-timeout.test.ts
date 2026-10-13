import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { callChatCompletion, llmDispatcher } from "../src/server/llm-client.js";

// Nodes eingebautes fetch bricht nach 300 s ohne Antwort-Header mit
// "fetch failed" ab — unabhaengig von AbortSignal.timeout. Bei langem Denken
// (gemma-4-31b: bis ueber 4 min) riss das Laeufe ab, obwohl timeoutMs 30 min
// erlaubte. Am 12.10.2026 belegt: Anfrage 17:05:10, Abbruch 17:10:11.
describe("Header-Grenze folgt timeoutMs statt Nodes 300-s-Vorgabe", () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
  });

  async function langsamerServer(verzoegerungMs: number): Promise<string> {
    server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
      }, verzoegerungMs);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("der Dispatcher bricht ab, wenn die Header laenger brauchen als die Vorgabe", async () => {
    const url = await langsamerServer(1500);
    await expect(
      fetch(url, { dispatcher: llmDispatcher(500) } as RequestInit),
    ).rejects.toThrow(/fetch failed/);
  });

  it("der Dispatcher wartet, solange die Header innerhalb der Vorgabe kommen", async () => {
    const url = await langsamerServer(800);
    const res = await fetch(url, { dispatcher: llmDispatcher(3000) } as RequestInit);
    expect(res.ok).toBe(true);
  });

  it("callChatCompletion uebergibt den zu timeoutMs passenden Dispatcher", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "Hi" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callChatCompletion({
      url: "http://localhost:1234",
      model: "google/gemma-4-31b",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      timeoutMs: 1_800_000,
    });

    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(llmDispatcher(1_800_000));
  });
});
