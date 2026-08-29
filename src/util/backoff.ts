export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  factor?: number;
  jitter?: number; // 0..1 fraction of the delay
}

/** Exponential backoff with full jitter, capped. `attempt` starts at 0. */
export function backoffDelayMs(attempt: number, opts: BackoffOptions, random: () => number = Math.random): number {
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? 0.3;
  const raw = Math.min(opts.maxMs, opts.baseMs * Math.pow(factor, Math.max(0, attempt)));
  const spread = raw * jitter;
  return Math.round(raw - spread + random() * spread * 2);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) return resolvePromise();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolvePromise();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
