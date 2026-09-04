import { probeEndpoint } from "./llm-client.js";
import { isOpen, breakerKey, type BreakerStore } from "./breaker-state.js";

export interface Endpoint {
  url: string;
  model: string;
}

export interface BreakerParams {
  store: BreakerStore;
  now: number;
  cooldownMs: number;
}

export interface ResolveParams {
  primaryUrl: string;
  primaryModel: string;
  fallbackUrl: string;
  fallbackModel: string;
  probeTimeoutMs: number;
  retryBackoffMs?: number;
  /** Optional. Without it the resolver behaves exactly as it did before. */
  breaker?: BreakerParams;
}

export type ResolveResult =
  | {
      ok: true;
      endpoint: Endpoint;
      usingFallback: boolean;
      primaryFailureReason?: string;
      /** True when a previously open breaker was retried and the primary answered. */
      primaryRecovered?: boolean;
    }
  | {
      ok: false;
      errorMessage: string;
    };

export async function resolvePrimaryOrFallback(p: ResolveParams): Promise<ResolveResult> {
  const key = breakerKey(p.primaryUrl, p.primaryModel);
  const breakerWasTripped = p.breaker ? key in p.breaker.store : false;

  // While the breaker is open the primary is not touched at all — neither
  // probed nor called. Probing would be useless anyway: the LM Studio server
  // answers /v1/models even when the model behind it is saturated, which is
  // exactly how a busy device slipped past the probe before. Skipping it also
  // stops us from adding load to a device that is already struggling.
  if (p.breaker && isOpen(p.breaker.store, key, p.breaker.now, p.breaker.cooldownMs)) {
    if (!p.fallbackUrl) {
      return {
        ok: false,
        errorMessage:
          `LM Studio primary ausgesetzt (Breaker offen für ${p.primaryModel}), ` +
          `kein Fallback konfiguriert.`,
      };
    }
    const fallbackProbe = await probeEndpoint(p.fallbackUrl, p.probeTimeoutMs);
    if (!fallbackProbe.ok) {
      return {
        ok: false,
        errorMessage:
          `LM Studio nicht erreichbar:\n` +
          `  primary = ${p.primaryUrl} (Breaker offen für ${p.primaryModel})\n` +
          `  fallback = ${p.fallbackUrl} (${fallbackProbe.reason})`,
      };
    }
    return {
      ok: true,
      endpoint: { url: p.fallbackUrl, model: p.fallbackModel || p.primaryModel },
      usingFallback: true,
      primaryFailureReason: `Breaker offen für ${p.primaryModel}`,
    };
  }

  return resolveByProbe(p, breakerWasTripped);
}

async function resolveByProbe(
  p: ResolveParams,
  breakerWasTripped: boolean,
): Promise<ResolveResult> {
  // Primary probe with one retry. LM Studio frequently returns a transient
  // failure on the first request when the model is cold-loading or the
  // server just woke up — a single retry after a short backoff catches that
  // without giving up to the fallback for the entire heartbeat.
  const backoffMs = p.retryBackoffMs ?? 500;
  let primaryProbe = await probeEndpoint(p.primaryUrl, p.probeTimeoutMs);
  const firstFailureReason = primaryProbe.ok ? undefined : primaryProbe.reason;
  if (!primaryProbe.ok) {
    if (backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs));
    primaryProbe = await probeEndpoint(p.primaryUrl, p.probeTimeoutMs);
  }
  if (primaryProbe.ok) {
    return {
      ok: true,
      endpoint: { url: p.primaryUrl, model: p.primaryModel },
      usingFallback: false,
      // Cooldown elapsed and the primary answered again: the caller clears it.
      primaryRecovered: breakerWasTripped,
    };
  }

  // Both attempts failed. Report the original reason (transient retries
  // often carry less informative errors like "fetch failed").
  const primaryReason =
    firstFailureReason && firstFailureReason !== primaryProbe.reason
      ? `${firstFailureReason}; retry: ${primaryProbe.reason}`
      : primaryProbe.reason;

  if (!p.fallbackUrl) {
    return {
      ok: false,
      errorMessage: `LM Studio primary nicht erreichbar: ${p.primaryUrl} (${primaryReason}). Kein Fallback konfiguriert.`,
    };
  }

  const fallbackProbe = await probeEndpoint(p.fallbackUrl, p.probeTimeoutMs);
  if (!fallbackProbe.ok) {
    return {
      ok: false,
      errorMessage:
        `LM Studio nicht erreichbar:\n` +
        `  primary = ${p.primaryUrl} (${primaryReason})\n` +
        `  fallback = ${p.fallbackUrl} (${fallbackProbe.reason})`,
    };
  }

  return {
    ok: true,
    endpoint: {
      url: p.fallbackUrl,
      model: p.fallbackModel || p.primaryModel,
    },
    usingFallback: true,
    primaryFailureReason: primaryReason,
  };
}
