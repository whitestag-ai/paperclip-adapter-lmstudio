import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isOpen,
  openBreaker,
  closeBreaker,
  loadStore,
  saveStore,
  defaultBreakerStatePath,
} from "../src/server/breaker-state.js";

const COOLDOWN = 60 * 60 * 1000; // 1 h

describe("breaker state", () => {
  it("reports a freshly opened breaker as open", () => {
    const now = 1_000_000;
    const store = openBreaker({}, "http://x:1234|big", "timeout", now);

    expect(isOpen(store, "http://x:1234|big", now, COOLDOWN)).toBe(true);
  });

  it("stops reporting open once the cooldown has elapsed", () => {
    const opened = 1_000_000;
    const store = openBreaker({}, "http://x:1234|big", "timeout", opened);

    expect(isOpen(store, "http://x:1234|big", opened + COOLDOWN, COOLDOWN)).toBe(false);
  });

  it("closing a breaker clears it so the primary is used again", () => {
    const now = 1_000_000;
    const opened = openBreaker({}, "http://x:1234|big", "timeout", now);

    const closed = closeBreaker(opened, "http://x:1234|big");

    expect(isOpen(closed, "http://x:1234|big", now, COOLDOWN)).toBe(false);
  });

  it("keeps breakers for other models untouched", () => {
    const now = 1_000_000;
    let store = openBreaker({}, "http://x:1234|big", "timeout", now);
    store = openBreaker(store, "http://x:1234|other", "timeout", now);

    store = closeBreaker(store, "http://x:1234|big");

    expect(isOpen(store, "http://x:1234|other", now, COOLDOWN)).toBe(true);
  });
});

describe("breaker persistence", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "breaker-"));
    file = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("survives a process boundary: saved state loads back", async () => {
    const now = 1_000_000;
    await saveStore(file, openBreaker({}, "http://x:1234|big", "timeout", now));

    const loaded = await loadStore(file);

    expect(isOpen(loaded, "http://x:1234|big", now, COOLDOWN)).toBe(true);
  });

  it("treats a missing file as no open breakers", async () => {
    const loaded = await loadStore(join(dir, "does-not-exist.json"));

    expect(loaded).toEqual({});
  });

  it("treats an unreadable file as no open breakers instead of throwing", async () => {
    await writeFile(file, "{ this is not json", "utf8");

    const loaded = await loadStore(file);

    expect(loaded).toEqual({});
  });

  it("creates missing parent directories when saving", async () => {
    const nested = join(dir, "deep", "state.json");

    await saveStore(nested, openBreaker({}, "k", "timeout", 1));

    expect(await loadStore(nested)).toHaveProperty("k");
  });

  it("lets the environment override the default location", () => {
    const previous = process.env.LMSTUDIO_ADAPTER_BREAKER_STATE;
    process.env.LMSTUDIO_ADAPTER_BREAKER_STATE = join(dir, "from-env.json");
    try {
      expect(defaultBreakerStatePath()).toBe(join(dir, "from-env.json"));
    } finally {
      if (previous === undefined) delete process.env.LMSTUDIO_ADAPTER_BREAKER_STATE;
      else process.env.LMSTUDIO_ADAPTER_BREAKER_STATE = previous;
    }
  });
});
