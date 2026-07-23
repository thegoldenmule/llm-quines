/**
 * Process-wide graceful-shutdown latch. The loop's signal handler calls
 * `requestShutdown()`; the workflow step passes `controller.signal` into
 * runClaude so an in-flight claude session is killed promptly. The in-flight
 * iteration is intentionally discarded — completed quines are already
 * committed, so a restart resumes from the last commit.
 */
const controller = new AbortController();
let requested = false;

export function requestShutdown(): void {
  requested = true;
  controller.abort();
}

export function shutdownRequested(): boolean {
  return requested;
}

export function shutdownSignal(): AbortSignal {
  return controller.signal;
}
