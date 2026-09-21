/**
 * Lazy loading that survives a bad moment (DAT-262).
 *
 * A dynamic `import()` cached in a module-level promise is cached for good —
 * including when it rejects. In the desktop's embedded console one failed
 * chunk request (the webview asking before its sign-in token exists) would
 * poison every mermaid diagram for the life of the page, and that page stays
 * mounted for days. These helpers keep the success cached and let a failure
 * be tried again.
 */

/** A memoised loader that forgets a rejection, so the next call loads again. */
export function retryableLazy<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (cached === null) {
      const attempt = load();
      cached = attempt;
      attempt.catch(() => {
        // Only clear our own attempt: a newer one may already be in flight.
        if (cached === attempt) cached = null;
      });
    }
    return cached;
  };
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  tries?: number;
  /** Wait before each retry; doubles every time. */
  delayMs?: number;
  /** Test seam: how to wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Run `op` until it resolves or the attempts run out; rethrows the last error. */
export async function withRetry<T>(op: () => Promise<T>, { tries = 3, delayMs = 1500, sleep }: RetryOptions = {}): Promise<T> {
  const wait = sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt < Math.max(1, tries); attempt++) {
    if (attempt > 0) await wait(delayMs * 2 ** (attempt - 1));
    try {
      return await op();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
