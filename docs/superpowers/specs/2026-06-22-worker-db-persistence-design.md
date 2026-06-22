# Saga 2b-ii — Worker → Postgres Persistence (Design)

Date: 2026-06-22 · Branch: `feat/worker-db` · Base: `de8121b`

## Goal

Make `sds/worker` persist consumed messages to Postgres so the full
`service → kafka → worker → db` Saga runs end-to-end. The worker currently
reads but **ignores** `DB_URL` (deferred in 2b-i). Persistence uses real
`pgx` — not simulated.

## Locked decisions

1. **DSN source — compiler emits the full DSN.** `db.ts` is the single source
   of truth for the connection facts; `service.ts`/`worker.ts` build `DB_URL`
   from a shared helper. Worker reads `DB_URL` verbatim.
2. **DB readiness — `pg_isready` healthcheck on db AND worker connect-with-retry.**
   The worker retry is the correctness guarantee (Postgres readiness is racy and a
   worker restart must self-heal); the healthcheck keeps `up --wait` honest. No
   `worker depends_on db` (retry covers ordering; avoids touching load-bearing
   `depends_on` wiring; `pg_isready` is independent of the worker so no deadlock).
3. **Write timing — persist only on the ok path.** A simulated processing error
   (`ERROR_RATE`) drops the message without writing, keeping `ERROR_RATE`
   meaningful (errors = not stored).
4. **Write failure — count metric + continue.** On INSERT error: increment
   `db_writes_total{status="error"}` and move on. No retry, no crash (behavior
   simulator; avoids retry storms; failures stay observable).

## Dependency

`github.com/jackc/pgx/v5` (`pgxpool`) — pure Go, so the scratch
(`CGO_ENABLED=0`) build is unchanged. The DSN carries `?sslmode=disable`
(scratch has no CA certs; avoids a TLS attempt against a non-TLS Postgres).

## Components

### 1. Compiler — DB connection as single source of truth (`src/compiler/handlers/`)

`db.ts` exports the connection facts and a DSN helper:

```ts
export const DB_USER = 'postgres';
export const DB_PASSWORD = 'sds';
export const DB_NAME = 'postgres';
export const dbUrl = (slug: string) =>
  `postgres://${DB_USER}:${DB_PASSWORD}@${slug}:5432/${DB_NAME}?sslmode=disable`;
```

- `db.ts` `compile`: `POSTGRES_PASSWORD` uses `DB_PASSWORD`; add a **healthcheck**
  running `pg_isready -U postgres` (interval/timeout/retries — mirror the shape of
  the kafka handler's healthcheck).
- `service.ts` (currently line 18) and `worker.ts` (currently line 23): import
  `dbUrl`, set `env.DB_URL = dbUrl(slugify(target.label))`. Password is defined
  once, in `db.ts`.

### 2. Worker config (`images/worker/config.go`)

Parse `DB_URL` → `cfg.DBURL string`. Optional: empty `DB_URL` means no DB and a
nil sink. (Today `FromEnv` never reads `DB_URL`.)

### 3. `Sink` seam (`images/worker/sink.go`) — mirrors the `Consumer` seam

```go
type Sink interface {
    Write(ctx context.Context, payload []byte) error
    Close() error
}
```

- `PgxSink` real impl over `*pgxpool.Pool`. Its constructor performs
  **connect-with-retry/backoff** (loop until connected or ~30s cap, then return a
  fatal error) and, on connect, runs the idempotent schema:
  `CREATE TABLE IF NOT EXISTS events (id bigserial primary key, payload text, ts timestamptz default now())`.
- A fake `Sink` for unit tests (records writes / can be told to error).

### 4. Worker wiring (`images/worker/worker.go`)

- Add a `sink Sink` field to `Worker` (nil when no `DB_URL`).
- Change `process(val)` → `process(ctx, val)` so the write has a context; `Run`
  already holds `ctx` and calls `process`.
- Persist only on the ok path (after the error-sim early return):

```go
if w.sink != nil {
    if err := w.sink.Write(ctx, val); err != nil {
        w.metrics.DBWrites.WithLabelValues("error").Inc()
        log.Printf("db write failed: %v", err)
    } else {
        w.metrics.DBWrites.WithLabelValues("ok").Inc()
    }
}
```

### 5. Metrics (`images/worker/metrics.go`)

Add `DBWrites *prometheus.CounterVec` labelled `status` (`ok` | `error`); register
it alongside the existing collectors.

### 6. Main wiring (`images/worker/main.go`)

Build a `PgxSink` when `cfg.DBURL != ""` (else pass nil), inject into
`NewWorker`, and `defer sink.Close()`.

### 7. Example + gated smoke

- `examples/saga-db.json`: `service → kafka`, `worker → kafka`, `worker → db`.
- `src/engine/saga-db.smoke.test.ts` (mirror `saga-chain.smoke.test.ts`):
  `describe.skipIf(!process.env.RUN_DOCKER)`. Up the full stack → run k6 load at
  the service → poll until the worker has `consumed` > 0 → assert rows landed via
  the controller's `Runner`:
  `docker compose -p <proj> exec -T <db-service> psql -U postgres -tAc 'SELECT count(*) FROM events'`
  and check the count > 0. Real run builds both images first, then
  `RUN_DOCKER=1 npm test -- saga-db.smoke`.

## Error handling

- **DB unreachable at boot:** worker retries with backoff up to ~30s, then fails
  loud (constructor returns error → `main` exits non-zero with a clear message).
- **INSERT fails mid-run:** count `db_writes_total{status="error"}`, log, continue.
- **No `DB_URL`:** nil sink; `process` skips the write block (worker behaves
  exactly as 2b-i for non-db graphs).

## Testing

- **Compiler unit tests:** `db.ts` emits healthcheck + `POSTGRES_PASSWORD`;
  `dbUrl` format; `service.ts`/`worker.ts` emit the full `DB_URL`. Non-db graphs
  unchanged.
- **Worker unit tests:** `config.go` parses `DB_URL` (present/empty); `process`
  writes on ok, skips on simulated error, and on write error increments the error
  metric + continues (fake sink); nil sink path is a no-op. `metrics.go` registers
  `DBWrites`.
- **Gated smoke:** the saga-db smoke above (real Docker, `RUN_DOCKER=1`).

## Out of scope (stay deferred — PR #10 §8 follow-ups)

Worker `Run` continue-backoff; `log.Fatalf`-in-goroutine in worker/microservice
main; kafka healthcheck grep anchor; smoke fixed-sleep → poll. Not in this brick.

## Likely task breakdown (for writing-plans)

1. Compiler: `db.ts` helper + healthcheck, `service.ts`/`worker.ts` full DSN,
   unit tests.
2. Worker `config.go` parse `DB_URL` + `metrics.go` `DBWrites` + tests.
3. `Sink` seam + `PgxSink` (retry-connect, schema) + fake + pgx dep; wire into
   `Worker.process` (+ctx) + `main.go`.
4. `examples/saga-db.json` + gated saga-db smoke (build images, `RUN_DOCKER=1`,
   assert rows).
