// Warnings surface on runs that completed, so a job never fails just because
// Real Watch could not pull bytes.

import { describe, it, expect } from 'vitest';
import { collectRunWarnings, completedMessage, WARNING_MARKER } from '../jobs/runWarnings';
import type { EmbywatchLog } from '../types';

const log = (over: Partial<EmbywatchLog> = {}): EmbywatchLog => ({
  itemType: 'Episode',
  title: 'Ep',
  runtimeSeconds: 600,
  startSeconds: 0,
  endSeconds: 60,
  watchedSeconds: 60,
  markedWatched: true,
  ...over,
});

describe('run warnings', () => {
  it('reports nothing for a clean run', () => {
    const warnings = collectRunWarnings('embywatch', [log({ streamedBytes: 4096 })]);
    expect(warnings).toEqual([]);
    expect(completedMessage(warnings)).toBe('Completed');
  });

  it('reports the Real Watch note on a run that streamed nothing', () => {
    const warnings = collectRunWarnings('embywatch', [
      log({ streamedBytes: 0, realWatchNote: 'no-stream-url' }),
    ]);
    expect(warnings).toHaveLength(1);
    const message = completedMessage(warnings);
    expect(message).toContain('Completed');
    expect(message).toContain(WARNING_MARKER);
    expect(message).toContain('no direct-play or transcode stream');
  });

  it('collapses the same note repeated across segments', () => {
    const warnings = collectRunWarnings('embywatch', [
      log({ realWatchNote: 'stream-failed' }),
      log({ realWatchNote: 'stream-failed' }),
    ]);
    expect(warnings).toHaveLength(1);
  });

  it('ignores job types that have no warnings of their own', () => {
    expect(collectRunWarnings('checkin', [{ anything: true }])).toEqual([]);
  });
});
