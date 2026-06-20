# sds/worker Image (Saga brick 2b-i) — Design

> **Status:** Approved design, ready for implementation plan.
> **Date:** 2026-06-20
> **Depends on:** Compiler Kafka wiring (brick 2a — emits `KAFKA_BROKER`/`SUBSCRIBE_TOPICS` + a bootable apache/kafka), `sds/microservice` Kafka publish (brick 1 — the producer), k6 Runner + Docker Controller (the smoke uses them).

## Goal

Build the `sds/worker` Go image: a Kafka consumer that subscribes to its topics,
simulates processing work (latency + error injection, like the microservice), and
exposes `/health` + `/metrics`. With it, the full Saga **chain**
(`service → kafka → worker`) runs end-to-end — a gated real-Kafka smoke proves it.

This is **brick 2b-i**. Real postgres persistence (`worker → db`, pgx) is
**brick 2b-ii**, a focused follow-up; this brick has no DB.

## Scope (locked — brainstorm 2026-06-20)

**In:** the `sds/worker` Go image (config, a `Consumer` seam backed by
`segmentio/kafka-go` group reader, a process loop that simulates work, Prometheus
metrics, `/health` + `/metrics`, multi-stage scratch Dockerfile) + Go unit tests
(fake consumer) + a gated real-Kafka Saga-chain smoke.

**Out (deferred to brick 2b-ii):** real postgres writes (pgx Sink, schema,
connection retry), the `DB_URL` handling, and any `worker → db` Saga example. This
brick's worker ignores `DB_URL` (consistent with how the v1 microservice ignores
it).

## Architecture

The worker mirrors the microservice's proven shapes: an injected `RandSource` for
deterministic latency/error, a `Consumer` seam (real `kafka-go` group reader vs a
fake in tests), client_golang metrics, and a scratch static binary. The novel
piece is the consume loop. The worker runs two goroutines — the consumer loop and
an HTTP server for `/health` + `/metrics` — with graceful SIGTERM shutdown.

```
main: FromEnv → metrics → consumer(kafka-go) → Worker.Run(ctx) [goroutine]
                                              → http /health,/metrics [goroutine]
      SIGTERM → cancel ctx (loop exits) → consumer.Close + http.Shutdown
```

## Layout

```
images/worker/
  go.mod / go.sum         module sds/worker; go 1.23; deps: segmentio/kafka-go, prometheus/client_golang
  doc.go
  config.go config_test.go
  consumer.go             Consumer interface + KafkaConsumer (kafka-go group reader)
  worker.go worker_test.go     Worker.Run loop + process(msg)
  metrics.go metrics_test.go
  http.go                 /health + /metrics server + writeJSON
  main.go
  Dockerfile .dockerignore
src/engine/
  saga-chain.smoke.test.ts     gated real-Kafka end-to-end smoke (NEW)
examples/
  saga.json               service → kafka, worker → kafka (no db)   (NEW)
```

## Config

```go
type Config struct {
  Port int
  LatencyMS int
  JitterMS int
  ErrorRate float64
  KafkaBroker string
  SubscribeTopics []string
}
```
`FromEnv` parses + validates (fail loud at boot):
- `PORT` 1–65535 (default 8080); `LATENCY_MS` / `LATENCY_JITTER_MS` ≥ 0; `ERROR_RATE` 0.0–1.0.
- `SUBSCRIBE_TOPICS` comma-split, trimmed, empties dropped. **Must be non-empty** —
  a worker with nothing to consume is invalid → boot error.
- If `SUBSCRIBE_TOPICS` is non-empty, **`KAFKA_BROKER` must be set** → else boot
  error.
- `DB_URL` is read but **ignored** in this brick (handled in 2b-ii).

The compiler (2a) emits `SUBSCRIBE_TOPICS` + `KAFKA_BROKER` together for a
`Worker→Kafka` edge, so the valid path is exercised by real graphs.

## Consumer seam

```go
type Consumer interface {
  Read(ctx context.Context) ([]byte, error)  // returns the next message value; auto-commits within the group
  Close() error
}

type KafkaConsumer struct{ r *kafka.Reader }

func NewKafkaConsumer(broker string, topics []string, groupID string) *KafkaConsumer {
  return &KafkaConsumer{r: kafka.NewReader(kafka.ReaderConfig{
    Brokers:     []string{broker},
    GroupID:     groupID,
    GroupTopics: topics,
    MinBytes:    1,
    MaxBytes:    10e6,
  })}
}
func (c *KafkaConsumer) Read(ctx context.Context) ([]byte, error) {
  m, err := c.r.ReadMessage(ctx)
  if err != nil {
    return nil, err
  }
  return m.Value, nil
}
func (c *KafkaConsumer) Close() error { return c.r.Close() }
```

- **Group id** is derived from the topic set: `"sds-" + strings.Join(topics, "-")`
  — stable, distinct per topic-set, and shared by replicas of the same worker node
  (so scaled workers split the partitions).
- **Commit semantics**: at-least-once via `ReadMessage` (auto-commits on read
  within the consumer group). A simulated processing error still counts the
  message as consumed and commits — no redelivery storm. This is a behaviour
  simulator, not a retrying pipeline.

## Process loop

```go
type RandSource interface { Float64() float64; Intn(n int) int }

type Worker struct {
  cfg      Config
  rand     RandSource
  metrics  *Metrics
  consumer Consumer
}

func (w *Worker) Run(ctx context.Context) {
  for {
    val, err := w.consumer.Read(ctx)
    if err != nil {
      if ctx.Err() != nil {
        return // shutdown
      }
      continue // transient read error: skip and retry
    }
    w.process(val)
  }
}

func (w *Worker) process(_ []byte) {
  w.metrics.InFlight.Inc()
  defer w.metrics.InFlight.Dec()
  start := time.Now()
  defer func() { w.metrics.Duration.Observe(time.Since(start).Seconds()) }()

  delay := w.cfg.LatencyMS
  if w.cfg.JitterMS > 0 {
    delay += w.rand.Intn(w.cfg.JitterMS + 1)
  }
  time.Sleep(time.Duration(delay) * time.Millisecond)

  if w.rand.Float64() < w.cfg.ErrorRate {
    w.metrics.Consumed.WithLabelValues("error").Inc()
    return
  }
  w.metrics.Consumed.WithLabelValues("ok").Inc()
}
```

The worker also logs consumption so the smoke can verify without an extra host
port: log a line per consumed message (or a periodic running count) such as
`consumed N` — the exact form is the implementer's choice, but it must contain a
greppable token the smoke can assert on (e.g. the word `consumed`).

## Metrics

client_golang on a private registry (mirrors the microservice):
| Metric | Type | Labels |
|--------|------|--------|
| `messages_consumed_total` | counter | `status` = `ok` \| `error` |
| `processing_duration_seconds` | histogram | default buckets |
| `in_flight` | gauge | — |

## HTTP

`/health` → `200 {"status":"ok"}` (compose/controller readiness); `/metrics` →
promhttp. No traffic endpoint — workers consume, they don't serve requests.

## main wiring + shutdown

`FromEnv` (fail-loud) → `NewMetrics` → seeded `*math/rand.Rand` (satisfies
`RandSource`) → `groupID = "sds-" + strings.Join(cfg.SubscribeTopics, "-")` →
`NewKafkaConsumer` → `Worker`. Run the consumer loop and the HTTP server in
goroutines; on `SIGTERM`/`SIGINT` (`signal.NotifyContext`) cancel the loop ctx,
`consumer.Close()`, and `httpSrv.Shutdown(5s)`.

## Dockerfile

Multi-stage, identical shape to the microservice: `golang:1.23-alpine` build with
`CGO_ENABLED=0 -ldflags="-s -w"` → `FROM scratch`, `EXPOSE 8080`,
`USER 10001:10001`, `ENTRYPOINT ["/worker"]`. kafka-go is pure Go → static scratch
build unchanged. `.dockerignore` excludes `*_test.go` / `doc.go` / `Dockerfile`.

## Testing

**Go unit tests (fast, no Kafka), via a fake `Consumer`:**
- `config_test.go`: valid parse (topics + broker); `SUBSCRIBE_TOPICS` empty →
  error; topics set + `KAFKA_BROKER` empty → error; bad `ERROR_RATE` (2.0) /
  `PORT` (0) → error; `DB_URL` present → ignored (no error).
- `worker_test.go` (fake `Consumer` feeding N canned messages then returning
  `context.Canceled`): `Run` exits cleanly; with a no-error rand stub →
  `messages_consumed_total{status="ok"}` == N; with an always-error rand stub →
  `{status="error"}` == N and `ok` == 0; `in_flight` returns to 0.
- `metrics_test.go`: the three metrics are exposed via the handler (scrape +
  assert).

**Gated real-Kafka Saga-chain smoke (`RUN_DOCKER=1`) — `src/engine/saga-chain.smoke.test.ts`:**
```
compile examples/saga.json   (service → kafka ← worker, no db)
controller.preflight + writeArtifacts + up --wait   (kafka cold start; --wait blocks until healthy)
K6Runner.run(small load)     fire requests at the service → service publishes to kafka
poll: docker compose -p sds-<id> logs <worker-service>  → assert it contains `consumed` (count > 0)
finally: down -v
```
- Verification is via the worker's **logs** (the controller's `Runner` runs
  `docker compose ... logs`), needing no extra host port.
- This is the marquee proof — it exercises 2a's apache/kafka boot, brick-1's
  producer, and this brick's consumer against a live broker end-to-end.
- Requires `sds/microservice` + `sds/worker` images built locally; pulls
  `apache/kafka` on first run. Gated/skipped by default.

## Backward compatibility

New image; no existing behaviour changes. The compiler already references
`sds/worker`; before this brick a worker graph failed preflight ("image not
found"). After it, the image exists and the chain runs.

## Follow-ups

1. **Saga brick 2b-ii** — pgx `Sink` (connect with retry against the unhealth-checked
   postgres, `CREATE TABLE IF NOT EXISTS`, INSERT per message; DSN built from
   `DB_URL` host + the db handler's `postgres:sds` creds) + a `worker → db` Saga
   example + a Saga-with-DB smoke.
2. Worker scaling demo (replicas in one consumer group sharing partitions).
3. Multi-hop Saga (worker publishes a follow-up event).
