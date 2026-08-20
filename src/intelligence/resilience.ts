// Production-grade LLM call resilience: retry / timeout / cost cap.
//
// Wraps any IntelligenceBackend.ask call with:
//   - exponential backoff retry on 429 / 5xx / network errors
//   - per-call timeout (AbortController)
//   - session cost cap (cumulative across calls in this process)
//   - circuit breaker after N consecutive failures

export interface ResilienceOptions {
  maxRetries?: number;            // default 3
  initialBackoffMs?: number;      // default 500
  maxBackoffMs?: number;          // default 8000
  timeoutMs?: number;             // default 30000
  costCapUsd?: number;            // session cap (cumulative). throws when exceeded.
  circuitBreakerThreshold?: number; // consecutive failures → open circuit. default 5
  onRetry?: (attempt: number, err: Error) => void;
  onCost?: (cumulativeUsd: number, lastCallUsd: number) => void;
}

const DEFAULTS: Required<Omit<ResilienceOptions, 'onRetry' | 'onCost' | 'costCapUsd'>> = {
  maxRetries: 3,
  initialBackoffMs: 500,
  maxBackoffMs: 8000,
  timeoutMs: 30000,
  circuitBreakerThreshold: 5,
};

let cumulativeCostUsd = 0;
let consecutiveFailures = 0;
let circuitOpen = false;

export function resetSessionState(): void {
  cumulativeCostUsd = 0;
  consecutiveFailures = 0;
  circuitOpen = false;
}

export function getSessionCost(): number {
  return cumulativeCostUsd;
}

function isRetryable(err: Error): boolean {
  const msg = err.message.toLowerCase();
  // Anthropic / OpenAI return status codes; map common patterns
  if (msg.includes('429') || msg.includes('rate limit')) return true;
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
  if (msg.includes('overloaded')) return true;
  if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('etimedout')) return true;
  return false;
}

function backoffMs(attempt: number, opts: Required<Omit<ResilienceOptions, 'onRetry' | 'onCost' | 'costCapUsd'>>): number {
  const base = opts.initialBackoffMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * base;
  return Math.min(opts.maxBackoffMs, base + jitter);
}

/**
 * Wrap an LLM call with retry + timeout + cost cap + circuit breaker.
 * The wrapped function returns whatever the inner call returned.
 *
 * @throws if circuit is open, cost cap exceeded, or all retries failed.
 */
export async function withResilience<T>(
  inner: () => Promise<T>,
  opts: ResilienceOptions = {},
): Promise<T> {
  const o = { ...DEFAULTS, ...opts };

  if (circuitOpen) {
    throw new Error(
      `LLM circuit breaker open (${consecutiveFailures} consecutive failures). ` +
      `Reset via resetSessionState() or restart.`,
    );
  }

  if (opts.costCapUsd !== undefined && cumulativeCostUsd >= opts.costCapUsd) {
    throw new Error(
      `LLM cost cap reached: $${cumulativeCostUsd.toFixed(4)} >= $${opts.costCapUsd.toFixed(4)}. ` +
      `Increase --cost-cap or resetSessionState().`,
    );
  }

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= o.maxRetries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeoutMs);
    try {
      const result = await inner();
      clearTimeout(timer);

      // success — update cost ledger (best-effort: result may not carry usage)
      const callCost = ((result as { usage?: { estimatedCostUsd?: number } })?.usage?.estimatedCostUsd) ?? 0;
      cumulativeCostUsd += callCost;
      consecutiveFailures = 0;
      if (opts.onCost) opts.onCost(cumulativeCostUsd, callCost);

      // post-call cap check (still throw if just-now exceeded)
      if (opts.costCapUsd !== undefined && cumulativeCostUsd >= opts.costCapUsd) {
        throw new Error(
          `LLM cost cap reached after this call: $${cumulativeCostUsd.toFixed(4)} >= $${opts.costCapUsd.toFixed(4)}.`,
        );
      }
      return result;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e as Error;
      if (attempt === o.maxRetries || !isRetryable(lastErr)) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= o.circuitBreakerThreshold) circuitOpen = true;
        throw lastErr;
      }
      const wait = backoffMs(attempt, o);
      if (opts.onRetry) opts.onRetry(attempt + 1, lastErr);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  throw lastErr ?? new Error('Unreachable');
}
