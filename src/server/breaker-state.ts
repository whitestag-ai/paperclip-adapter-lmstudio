/**
 * Circuit breaker for LLM endpoints.
 *
 * A probe against `/v1/models` only tells us the LM Studio server answers — not
 * that the model behind it can still serve. A model on a busy remote device can
 * time out for minutes while the server keeps replying 200. This breaker
 * therefore learns from real call failures, not from probes.
 *
 * State is keyed by `${url}|${model}` so one stalled model does not disable
 * others on the same server.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Where the breaker state lives when the agent config does not say.
 *
 * `LMSTUDIO_ADAPTER_BREAKER_STATE` overrides it. That is what the test suite
 * uses: without an override every test sharing this process would also share
 * one state file in the user's home directory, and a breaker opened by one
 * test would silently steer another.
 */
export function defaultBreakerStatePath(): string {
  const fromEnv = process.env.LMSTUDIO_ADAPTER_BREAKER_STATE;
  if (fromEnv) return fromEnv;
  return join(homedir(), ".paperclip-adapter-lmstudio", "breaker-state.json");
}

export interface BreakerEntry {
  openedAt: number;
  reason: string;
}

export type BreakerStore = Record<string, BreakerEntry>;

export function breakerKey(url: string, model: string): string {
  return `${url}|${model}`;
}

export function openBreaker(
  store: BreakerStore,
  key: string,
  reason: string,
  now: number,
): BreakerStore {
  return { ...store, [key]: { openedAt: now, reason } };
}

export function closeBreaker(store: BreakerStore, key: string): BreakerStore {
  if (!(key in store)) return store;
  const next = { ...store };
  delete next[key];
  return next;
}

export function isOpen(
  store: BreakerStore,
  key: string,
  now: number,
  cooldownMs: number,
): boolean {
  const entry = store[key];
  if (!entry) return false;
  return now - entry.openedAt < cooldownMs;
}

/**
 * Reads the store. Any problem — missing file, unreadable JSON, wrong shape —
 * yields an empty store rather than an exception: a damaged breaker file must
 * never keep an agent from running. The worst case is one wasted call against
 * the primary, which re-opens the breaker anyway.
 */
export async function loadStore(path: string): Promise<BreakerStore> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: BreakerStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<BreakerEntry>;
      if (typeof entry.openedAt !== "number") continue;
      store[key] = {
        openedAt: entry.openedAt,
        reason: typeof entry.reason === "string" ? entry.reason : "",
      };
    }
    return store;
  } catch {
    return {};
  }
}

export async function saveStore(path: string, store: BreakerStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), "utf8");
}
