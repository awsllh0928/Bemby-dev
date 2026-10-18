const registry = new Map<number, AbortController>();

export function registerJob(logId: number): AbortSignal {
  const ctrl = new AbortController();
  registry.set(logId, ctrl);
  return ctrl.signal;
}

export function unregisterJob(logId: number): void {
  registry.delete(logId);
}

/** Returns false if no running job was found for this logId. */
export function cancelJob(logId: number): boolean {
  const ctrl = registry.get(logId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

export function isJobRunning(logId: number): boolean {
  return registry.has(logId);
}

/** Log ids of the runs currently in flight, so a memory spike can be attributed. */
export function runningLogIds(): number[] {
  return [...registry.keys()];
}

// Live detail registry — holds a reference to the in-progress detailLogs array
// so the logs API can stream partial results while a job is running.
const liveDetails = new Map<number, any[]>();

export function registerLiveDetail(logId: number, detail: any[]): void {
  liveDetails.set(logId, detail);
}

export function getLiveDetail(logId: number): any[] | undefined {
  return liveDetails.get(logId);
}

export function clearLiveDetail(logId: number): void {
  liveDetails.delete(logId);
}
