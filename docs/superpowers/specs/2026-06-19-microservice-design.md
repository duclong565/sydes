# `sds/microservice` Go Image v1 — Design

> **Status:** Approved design, ready for implementation plan.
> **Date:** 2026-06-19
> **Depends on:** Graph Compiler (done — emits `image: sds/microservice` + env vars).

## Goal

Build the v1 `sds/microservice` Docker image: a tiny Go HTTP server whose entire
behavior is driven by environment variables. It is the runtime substrate every
`service` node in a compiled graph runs as. Without it, the compiler's
`docker-compose.yml` output references an image that does not exist and nothing
can spin up.

v1 is the first brick of the runtime vertical slice (image → Docker Controller →
k6 runner). It is deliberately scoped to **HTTP only** so it stays small,
cold-starts in <100ms, and proves the LB Scaling template end-to-end. Kafka
publish and the `sds/worker` image are a later iteration.

## Scope

**In v1:**
- HTTP server on a configurable port (default `8080`).
- Simulated processing latency with jitter.
- Probabilistic error injection.
- Synchronous upstream chaining with **cascading** failure propagation.
- `/metrics` Prometheus endpoint via `prometheus/client_golang`.
- `/health` readiness endpoint.
- Fail-loud config validation at boot.

**Out of v1 (deferred):**
- Kafka producer (`PUBLISH_TOPIC`) — needs a consumer (`sds/worker`, Phase 2) to
  be meaningful. Saga template waits on this.
- DB / Redis connections (`DB_URL`, `REDIS_URL`) — env is ignored for now.
- Containerized smoke test harness — unit tests cover behavior; Docker build is a
  manual/CI step.

## Non-goals

- Not a general-purpose web framework or real microservice. It is a behavior
  simulator: latency, errors, and call chains are faked from config.
- No persistence, no auth, no business logic.

## Layout

Single `package main`, files split by concern. Tests in-package so they can reach
internals. Lives outside the TypeScript tree; run with `go test ./...`, not
`npm test`.

```
images/microservice/
  go.mod                 module sds/microservice; go 1.22
                         dep: github.com/prometheus/client_golang
  main.go                wire Config → Server → ListenAndServe; SIGTERM graceful stop
  config.go              FromEnv() (Config, error) + parse/validate
  server.go              Server struct + handleRoot / handleHealth
  metrics.go             prometheus collectors + promhttp handler
  config_test.go         env parsing + validation
  server_test.go         httptest: latency, error roll, cascade, metrics, in-flight
  Dockerfile             multi-stage golang:1.22 (CGO_ENABLED=0) → minimal base, ~5MB
```

CLAUDE.md already documents the build command:
`docker build -t sds/microservice ./images/microservice`.

## Configuration / env API

`config.go` exposes `FromEnv() (Config, error)`. Parsing and validation happen
once at boot. On any invalid value the process **exits non-zero with a clear
message** (mirrors the compiler's fail-loud ethos) — a misconfigured container
should crash visibly, not serve wrong behavior silently.

| Env | Type | Default | Validation |
|-----|------|---------|------------|
| `PORT` | int | `8080` | 1–65535 |
| `LATENCY_MS` | int | `0` | ≥ 0 |
| `LATENCY_JITTER_MS` | int | `0` | ≥ 0 |
| `ERROR_RATE` | float | `0` | 0.0–1.0 inclusive |
| `UPSTREAM_HTTP` | string | `""` | empty = no upstream; else must parse as a URL |

Fixed constants in v1 (not env-tunable yet):
- `UPSTREAM_TIMEOUT = 2s` — cap on the upstream call so a hung downstream cannot
  hang the caller forever.
- Server `ReadTimeout` / `WriteTimeout` — sane fixed values.

Unknown / not-yet-used envs the compiler emits (`DB_URL`, `REDIS_URL`,
`KAFKA_BROKER`, `PUBLISH_TOPIC`, `SUBSCRIBE_TOPICS`) are **ignored**, not errors.
v1 simply does not act on them.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/` | Traffic endpoint. Runs the request lifecycle. |
| `GET` | `/health` | Readiness — `200 {"status":"ok"}`. For compose healthcheck + controller. |
| `GET` | `/metrics` | Prometheus exposition (promhttp). |

## Request lifecycle (`POST /`)

```
handleRoot:
  inFlight.Inc(); defer inFlight.Dec()
  start = now

  sleep( LATENCY_MS + rand[0, LATENCY_JITTER_MS] )   // milliseconds

  if rand.Float64() < ERROR_RATE:
      record(500); respond 500 {"error":"injected"}   // own failure, skip upstream

  if UPSTREAM_HTTP != "":
      resp, err = client.Post(UPSTREAM_HTTP, body)     // 2s timeout
      if err != nil or resp.StatusCode >= 500:
          record(502); respond 502 {"error":"upstream"} // cascade

  record(200); respond 200 {"ok":true}

  // every path: duration histogram observes (now - start)
```

**Semantics:**
- `rand` is an **injected** source (interface with `Float64()` /
  `Intn(n)`), seeded in `main`, replaced by a deterministic stub in tests.
- Request body is read and discarded (k6 posts `{"ping":true}`).
- **Error coding:** own injected failure → **500**; upstream sick/unreachable →
  **502**. Distinct codes let the dashboard tell self-failure from
  downstream-failure. Both count as errors.
- **Cascade:** upstream `5xx`, timeout, or connection error all become `502`.
  Failures ripple up the chain so a single overloaded/dead node visibly takes
  down everything in front of it — this is what makes the SPOF demo work.
- Total response latency = own simulated latency + upstream round-trip.

## Metrics (`GET /metrics`)

`prometheus/client_golang` with `promhttp.Handler()`. Default registry keeps
`go_*` / `process_*` metrics (useful baseline). App metrics:

| Metric | Type | Labels |
|--------|------|--------|
| `http_requests_total` | counter | `status` = `200` \| `500` \| `502` |
| `http_request_duration_seconds` | histogram | default buckets |
| `http_in_flight_requests` | gauge | — |

Recorded inside `handleRoot` on every return path, including errors. The
histogram observes total handler duration (own latency + upstream RTT).

## Error handling

- **Boot:** invalid config → log a clear message, exit non-zero. No best-effort
  startup.
- **Runtime:** injected error → 500; upstream failure (5xx/timeout/conn) → 502.
  Never panic on a request; recover defensively if needed and return 500.
- **Shutdown:** trap `SIGTERM`/`SIGINT`, `http.Server.Shutdown` with a short grace
  so `docker stop` and teardown are clean.

## Testing (TDD, `go test ./...`)

Behavior is fully unit-testable with `net/http/httptest` — no Docker in the
red-green loop. Determinism comes from injecting the rand source.

`server_test.go`:
- **latency** — `LATENCY_MS=50`, no jitter → elapsed ≥ 50ms and < 50ms + slack.
- **jitter bound** — `LATENCY_MS=10, JITTER=20` → elapsed within `[10, 30]ms` + slack.
- **error roll** — stub `Float64()=0.0`, `ERROR_RATE=1.0` → 500; `ERROR_RATE=0.0` → 200.
- **cascade (5xx)** — stub upstream returns 500 → caller returns **502**.
- **cascade (down)** — `UPSTREAM_HTTP` points at a closed port → **502** within timeout.
- **upstream happy** — stub upstream returns 200 → caller **200**, upstream hit once.
- **metrics** — after N posts, scrape `/metrics`, assert
  `http_requests_total{status="200"}` equals the success count.
- **in-flight** — gauge increments during handler, returns to 0 after.

`config_test.go`:
- valid env → populated `Config`.
- `ERROR_RATE=2.0`, `PORT=0`, non-numeric `LATENCY_MS` → error.
- unknown envs (`DB_URL`, `KAFKA_BROKER`) present → ignored, no error.

Dockerfile build (`docker build -t sds/microservice ./images/microservice`) is
verified manually / in CI, not inside `go test`.

## Out-of-scope follow-ups (future iterations)

1. **v2 — Kafka publish** + `sds/worker` consumer image together → Saga template
   end-to-end.
2. **Docker Controller** (dockerode): write compiler artifacts to disk, compose
   up, Kafka health-check loop, tear down. (Next runtime brick after this image.)
3. **k6 runner**: launch the generated script, capture results.
4. Env-tunable `UPSTREAM_TIMEOUT`, DB/Redis simulated calls.

## Decisions locked (this brainstorm, 2026-06-19)

- HTTP-only v1; no Kafka client.
- Cascading error propagation (own → 500, upstream → 502) with 2s upstream timeout.
- `/metrics` via `prometheus/client_golang`, standard request set.
- Go unit tests with `httptest` + injectable rand; Dockerfile built separately.
- stdlib `net/http` + `Server` struct (DI) — no web framework.
