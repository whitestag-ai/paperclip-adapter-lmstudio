import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServerAdapter } from "../src/server/index.js";

describe("createServerAdapter().listModels", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("fetches from provided url when opts.url is given", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "my-model" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = createServerAdapter();
    const result = await adapter.listModels!({ url: "http://external:1234" });

    expect(seen).toEqual(["http://external:1234/v1/models"]);
    expect(result).toEqual([{ id: "my-model", label: "my-model" }]);
  });

  it("falls back to http://localhost:1234 when opts.url is missing", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = createServerAdapter();
    await adapter.listModels!();

    expect(seen).toEqual(["http://localhost:1234/v1/models"]);
  });

  it("returns [] when the configured host is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const adapter = createServerAdapter();
    const result = await adapter.listModels!({ url: "http://dead:9999" });

    expect(result).toEqual([]);
  });
});

describe("createServerAdapter().getConfigSchema", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("does not perform any network requests", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const adapter = createServerAdapter();
    await adapter.getConfigSchema!();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("marks defaultModel as combobox driven by the `url` field", async () => {
    const adapter = createServerAdapter();
    const schema = await adapter.getConfigSchema!();
    const field = schema.fields.find((f) => f.key === "defaultModel");

    expect(field?.type).toBe("combobox");
    expect(field?.meta).toMatchObject({ optionsFromUrlField: "url" });
    expect(field?.options).toBeUndefined();
  });

  it("marks fallbackModel as combobox driven by fallbackUrl, disabled when empty", async () => {
    const adapter = createServerAdapter();
    const schema = await adapter.getConfigSchema!();
    const field = schema.fields.find((f) => f.key === "fallbackModel");

    expect(field?.type).toBe("combobox");
    expect(field?.meta).toMatchObject({
      optionsFromUrlField: "fallbackUrl",
      disabledWhenEmpty: "fallbackUrl",
    });
    expect(field?.options).toBeUndefined();
  });
});
