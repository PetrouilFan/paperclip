/** These bounds apply to lifecycle control work, never to healthy provider execution. */
export const EXECUTION_CONTROL_DEADLINE_MS = 60_000;
/**
 * Backstop across the whole post-provider chain.
 *
 * `EXECUTION_CONTROL_DEADLINE_MS` is a per-step budget: every finalization step
 * re-arms it, so the sweep only fires when one bounded sub-step is stuck. That
 * leaves a chain that keeps making progress but never terminates uncovered, so
 * this independent cap still surfaces it. It is deliberately far above the
 * observed worst-case chain, which was still making progress six minutes after
 * the old whole-chain budget had already declared the run failed.
 */
export const EXECUTION_CONTROL_TOTAL_DEADLINE_MS = 900_000;
export const EXECUTION_RECONCILIATION_INTERVAL_MS = 15_000;
export async function boundedExecutionCleanup(
  operation: () => Promise<unknown>,
  timeoutMs = EXECUTION_CONTROL_DEADLINE_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(operation)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
