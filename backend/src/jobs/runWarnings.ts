import type { EmbywatchLog, RealWatchNote } from '../types';

/**
 * Marker that turns the tail of a run message into a warning. The logs view keys
 * the amber styling off it, so keep it in step with the frontend.
 */
export const WARNING_MARKER = 'Warning:';

const REAL_WATCH_WARNINGS: Record<RealWatchNote, string> = {
  'no-stream-url': 'Real Watch pulled no bytes (server serves no direct-play or transcode stream)',
  'stream-failed': 'Real Watch pulled no bytes (the server rejected every stream request)',
};

/**
 * Things worth flagging on an otherwise successful run: the job did its work,
 * part of it just didn't land. These never change the run status.
 */
export function collectRunWarnings(jobType: string, detailLogs: unknown[]): string[] {
  if (jobType !== 'embywatch') return [];
  const warnings = new Set<string>();
  for (const entry of detailLogs as EmbywatchLog[]) {
    const note = entry?.realWatchNote;
    if (note && REAL_WATCH_WARNINGS[note]) warnings.add(REAL_WATCH_WARNINGS[note]);
  }
  return [...warnings];
}

/** Compose the message stored against a completed run. */
export function completedMessage(warnings: string[]): string {
  if (!warnings.length) return 'Completed';
  return `Completed · ${WARNING_MARKER} ${warnings.join('; ')}`;
}
