/**
 * Waiting for the store, rather than for the clock.
 *
 * With SQLite a test could drive asynchronous code by draining a fixed number of microtasks:
 * every await resolved in-process, so twenty ticks always sufficed. A round trip to MongoDB
 * does not -- it depends on a separate server, and here it costs tens to low hundreds of
 * milliseconds. Any test that waits a fixed number of turns is therefore a coin flip, and one
 * that waits too little passes for the wrong reason.
 *
 * So tests wait on a condition, with a deadline long enough that a genuine hang fails loudly
 * instead of silently passing.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/** Polls `condition` until it holds. Fails with the label if the deadline passes first. */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await pause(5);
  }
}

/** Hands the loop back for a while. Use it to give something that must *not* happen the
 *  chance to happen -- then assert that it did not. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
