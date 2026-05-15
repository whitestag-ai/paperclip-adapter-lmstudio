import { probeEndpoint } from "./llm-client.js";

export interface Endpoint {
  url: string;
  model: string;
}

export interface ResolveParams {
  primaryUrl: string;
  primaryModel: string;
  fallbackUrl: string;
  fallbackModel: string;
  probeTimeoutMs: number;
  retryBackoffMs?: number;
}

export type ResolveResult =
  | {
      ok: true;
      endpoint: Endpoint;
      usingFallback: boolean;
      primaryFailureReason?: string;
    }
  | {
      ok: false;
      errorMessage: string;
    };

export async function resolvePrimaryOrFallback(p: ResolveParams): Promise<ResolveResult> {
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
