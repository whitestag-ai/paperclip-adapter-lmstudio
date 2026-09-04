import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolvePrimaryOrFallback } from "../src/server/endpoint-resolver.js";
import { openBreaker, breakerKey } from "../src/server/breaker-state.js";
import * as llmClient from "../src/server/llm-client.js";

const COOLDOWN = 60 * 60 * 1000;
const NOW = 1_000_000;

// Primary and fallback share one URL — that is the real setup: one LM Studio,
// the fallback simply names a model that lives on another device.
const base = {
  primaryUrl: "http://lm:1234",
  primaryModel: "remote-big",
  fallbackUrl: "http://lm:1234",
  fallbackModel: "local-big",
  probeTimeoutMs: 500,
  retryBackoffMs: 0,
};

describe("resolvePrimaryOrFallback with a breaker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("goes straight to the fallback while the primary breaker is open", async () => {
    const probe = vi.spyOn(llmClient, "probeEndpoint").mockResolvedValue({ ok: true });
    const store = openBreaker({}, breakerKey(base.primaryUrl, base.primaryModel), "timeout", NOW);

    const result = await resolvePrimaryOrFallback({
      ...base,
      breaker: { store, now: NOW, cooldownMs: COOLDOWN },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.endpoint).toEqual({ url: base.fallbackUrl, model: "local-big" });
      expect(result.usingFallback).toBe(true);
    }
    // Both endpoints share a URL, so only the probe count can show that the
    // stalled primary was skipped: one probe means fallback only.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("retries the primary once the cooldown has elapsed", async () => {
    vi.spyOn(llmClient, "probeEndpoint").mockResolvedValue({ ok: true });
    const store = openBreaker({}, breakerKey(base.primaryUrl, base.primaryModel), "timeout", NOW);

    const result = await resolvePrimaryOrFallback({
      ...base,
      breaker: { store, now: NOW + COOLDOWN, cooldownMs: COOLDOWN },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.endpoint).toEqual({ url: base.primaryUrl, model: "remote-big" });
      expect(result.usingFallback).toBe(false);
      expect(result.primaryRecovered).toBe(true);
    }
  });

  it("behaves as before when no breaker is passed", async () => {
    vi.spyOn(llmClient, "probeEndpoint").mockResolvedValueOnce({ ok: true });

    const result = await resolvePrimaryOrFallback(base);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usingFallback).toBe(false);
      expect(result.primaryRecovered).toBeFalsy();
    }
  });

  it("still fails cleanly when the breaker is open and no fallback exists", async () => {
    vi.spyOn(llmClient, "probeEndpoint").mockResolvedValue({ ok: true });
    const store = openBreaker({}, breakerKey(base.primaryUrl, base.primaryModel), "timeout", NOW);

    const result = await resolvePrimaryOrFallback({
      ...base,
      fallbackUrl: "",
      breaker: { store, now: NOW, cooldownMs: COOLDOWN },
    });

    expect(result.ok).toBe(false);
  });
});
