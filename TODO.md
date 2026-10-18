# TODO

## Deferred bug fixes

Both items from the 2026-07-19 system bug scan are now closed. See GitHub issue #21
for the original crash that triggered the scan.

- [x] **`getLiveClient` concurrent double-connect leak** -- fixed in
  `backend/src/tg/liveClient.ts`. The connection promise is cached per account
  (`connecting`), so concurrent callers for the same idle account await the same client
  rather than each building one and the second overwriting the first. The cache entry is
  cleared whether the connect resolves or throws, so a failed attempt does not wedge the
  account. Covered by `liveClient.test.ts`.

- [x] **embywatch ignores cancellation** -- already resolved before this pass, so the
  entry above was stale. `runEmbywatch` takes an `AbortSignal`, `runner.ts` passes the
  job's signal, and the progress loop waits through `sleep(..., ctx.signal)` and checks
  `ctx.signal?.aborted`. The Stopped report is deliberately still sent on cancellation, so
  the Emby session does not linger.
