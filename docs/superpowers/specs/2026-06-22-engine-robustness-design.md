# Engine Robustness Cleanup (Design)

Date: 2026-06-22 · Branch: `feat/engine-robustness` (off `feat/worker-db`) · Base: `d8e7d05`

## Goal

Clear the deferred §8 robustness follow-ups (from PR #10's review) plus the
carried Minor findings from the Saga 2b-ii (PR #11) review, in one focused PR.
Every change is mechanical and leaves the happy path unchanged — this is a
debt-clearing brick before the Electron/React UI epic.

## Branch dependency

This brick touches `images/worker/*` and `images/microservice/main.go`, which
PR #11 just changed. The branch is cut from `feat/worker-db` so it carries
#11's code. When #11 merges to `main`, this branch's PR should target `main`
(it then shows only the robustness diff); if opened while #11 is still open,
stack the PR base on `feat/worker-db`. Resolve at finish time.

## Items

### 1. `log.Fatalf`-in-goroutine → `stop()`-cascade (both Go mains)

`images/worker/main.go:57` and `images/microservice/main.go:45` call
`log.Fatalf` inside the `ListenAndServe` goroutine. On a rare bind error this
`os.Exit(1)`s immediately, bypassing graceful shutdown (the `defer
kp.Close()` / `defer pgSink.Close()` and `httpSrv.Shutdown`).

**Fix:** replace `log.Fatalf(...)` with `log.Printf(...)` followed by `stop()`
(the cancel returned by `signal.NotifyContext`). Cancelling the context makes
`main` fall through to its existing shutdown block; the worker's
`worker.Run(ctx)` also returns because it watches `ctx`. 2-line change per
main, identical pattern in both.

```go
go func() {
    log.Printf("...listening on :%d", cfg.Port)
    if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
        log.Printf("http server error: %v", err)
        stop() // cancel ctx -> graceful shutdown path runs
    }
}()
<-ctx.Done() // existing shutdown follows unchanged
```

### 2. Worker `Run` read-error backoff

`images/worker/worker.go:37` — on a non-ctx read error the loop `continue`s
with no delay, a theoretical hot-spin if reads fail repeatedly.

**Fix:** add an unexported field `readBackoff time.Duration` to `Worker`,
defaulted in `NewWorker` to `200 * time.Millisecond`. On a non-ctx read error:
`time.Sleep(w.readBackoff)` then `continue`.

**Testability:** `NewWorker`'s signature stays the same (no call-site churn).
The in-package test constructs the worker via `NewWorker`, sets
`w.readBackoff = 0`, and injects a consumer that returns one transient
(non-ctx) error, then a value, then cancels — asserting the post-error message
is still processed (`messages_consumed_total{status="ok"} 1`) so the loop
survived the transient error, with no real delay.

### 3. `NewPgxSink` honors `ctx.Err()` (`images/worker/sink.go`)

The retry loop sleeps to the ~30s deadline even if the context is cancelled at
startup.

**Fix:** immediately after the `pool.Ping(ctx)` error, add
`if ctx.Err() != nil { pool.Close(); return nil, ctx.Err() }` so a startup
cancel returns promptly. No new unit test (needs a real DB; covered by the
gated saga-db smoke and by inspection).

### 4. `PgxSink.Write` drops the `string(payload)` conversion (`sink.go`)

`s.pool.Exec(ctx, "INSERT ...", string(payload))` forces a needless allocation;
pgx encodes a `[]byte` argument into the `text` column directly.

**Fix:** pass `payload` (the `[]byte`) instead of `string(payload)`. No
behavior change; the stored value is identical.

### 5. kafka healthcheck `grep -q` → `grep -qx` (`src/compiler/handlers/kafka.ts`)

Line 35 matches each subscriber consumer-group id with an unanchored
`grep -q '<g>'`, which would also match a group id that contains `<g>` as a
substring (a multi-worker safety hazard).

**Fix:** use `grep -qx '<g>'` to require a whole-line match. Update the
`kafka.test.ts` assertion that pins the healthcheck command string.

### 6. `src/engine/saga-chain.smoke.test.ts` fixed sleep → poll

The smoke uses `await new Promise(r => setTimeout(r, 2000))` to "let the worker
drain" before asserting `consumed`.

**Fix:** replace it with a poll loop (≤15 iterations, 1s apart) that reads the
`payment-worker` logs until `/consumed/` matches, then asserts. Mirrors the
saga-db smoke's poll. Gated (`describe.skipIf(!RUN_DOCKER)`) — re-run real with
`RUN_DOCKER=1`.

### 7. `src/engine/saga-db.smoke.test.ts` diagnostics

Carried Minors: the asserted row count is never surfaced, and the psql poll's
`parseInt(r.stdout) || 0` silently swallows an exec failure.

**Fix:** `console.log` the row count before `expect`; and on each poll, only
parse the count when `r.code === 0` (otherwise treat as not-ready and continue
the loop, so a real psql/exec error is visible rather than masked as `0`).
Gated — re-run real.

## Error handling

These changes *improve* error handling; none introduce new failure modes. The
`stop()`-cascade routes a previously-fatal bind error through the normal
shutdown path. The backoff and `ctx.Err()` checks bound previously-unbounded
loops. The smoke diagnostics surface failures that were previously masked.

## Testing

- `npm test` green (unit suite ~87 pass; gated smokes skip).
- worker `go test ./...` green including the new backoff test; `go vet ./...`
  clean; `go build ./...` clean for both images.
- Rebuild both images, then re-run **both** gated smokes for real
  (`RUN_DOCKER=1`): `saga-chain.smoke` and `saga-db.smoke` must still PASS.

## Out of scope

No new features, no node types, no refactors beyond the seven items above. The
Electron/React UI epic is the next major piece (separate brainstorm).

## Likely task breakdown (for writing-plans)

1. Go mains: `stop()`-cascade in worker + microservice (item 1).
2. Worker `Run` backoff + `readBackoff` field + test (item 2).
3. `PgxSink` `ctx.Err()` check + `[]byte` write (items 3-4).
4. kafka `grep -qx` + `kafka.test.ts` update (item 5).
5. Smoke polls/diagnostics + re-run both gated smokes real (items 6-7).
