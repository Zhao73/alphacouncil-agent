/** Build a local timeout signal linked to an optional upstream cancellation signal. */
export function linkedAbort(timeoutMs, upstream) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) onAbort();
  else upstream?.addEventListener?.("abort", onAbort, { once: true });
  const timer = Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? setTimeout(() => controller.abort(new Error(`operation timed out after ${timeoutMs}ms`)), timeoutMs)
    : null;
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      upstream?.removeEventListener?.("abort", onAbort);
    },
  };
}
