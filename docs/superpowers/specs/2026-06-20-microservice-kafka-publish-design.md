# microservice Kafka Publish (Saga brick 1) — Design

> **Status:** Approved design, ready for implementation plan.
> **Date:** 2026-06-20
> **Depends on:** `sds/microservice` v1 (HTTP-only, on `scratch`), Graph Compiler (already emits `KAFKA_BROKER` + `PUBLISH_TOPIC` for a `Service→Kafka` edge).

## Goal

Add a Kafka producer to `sds/microservice` so a `Service→Kafka` node publishes an
event on each request — the producer half of the Saga template. The service
already honors latency, error injection, and synchronous upstream chaining; this
adds: when `PUBLISH_TOPIC` is set, publish synchronously to Kafka on the success
path, and surface a publish failure as a 503 so a broken/overloaded Kafka is
visible under load.

This is **brick 1 of 2** for Saga. Brick 2 (`sds/worker`, the Kafka consumer +
the real-Kafka end-to-end smoke) is a separate plan.

## Scope (locked — brainstorm 2026-06-20)

**In:** `KAFKA_BROKER` + `PUBLISH_TOPIC` config; a `Publisher` seam backed by
`segmentio/kafka-go`; synchronous publish on the request success path with
failure → 503; unit tests using a fake publisher.

**Out (deferred to brick 2):**
- `sds/worker` (the consumer), the Saga example graph, and the real-Kafka
  end-to-end smoke (service → kafka → worker). The kafka-go producer against a
  live broker is proven there.
- Multi-hop Saga event chains, message keys/partitioning strategy, schema.

## Decisions (brainstorm 2026-06-20)

- **Saga is two bricks**: this brick = microservice publish; brick 2 = worker.
- **Kafka client: `segmentio/kafka-go`** — pure Go, no cgo, so the
  `CGO_ENABLED=0` static build and the `scratch` runtime image are unchanged.
- **Synchronous publish, failure → 503.** Publish on the success path only
  (skipped when the request already 500'd or 502'd). A failed/slow publish makes
  Kafka latency show up in response time and a dead Kafka show up as errors +
  throughput drop — the sandbox's "watch what breaks" purpose. (Fire-and-forget
  was rejected: it hides Kafka failures.)

## Backward compatibility

A service with no `PUBLISH_TOPIC` behaves exactly as v1 (HTTP-only); the
`publisher` is `nil` and never invoked. All existing v1 behavior and tests are
preserved.

## Layout (all under `images/microservice/`)

```
config.go        + KafkaBroker, PublishTopic fields + validation       (MODIFY)
config_test.go   + KAFKA_BROKER/PUBLISH_TOPIC parse + validation tests  (MODIFY)
publisher.go     Publisher interface + KafkaPublisher (kafka-go)        (NEW)
server.go        Server gains a publisher field; handleRoot publishes   (MODIFY)
server_test.go   fake publisher; publish-on-success / 503 / skip tests  (MODIFY)
main.go          build + wire + close the real publisher when configured (MODIFY)
go.mod / go.sum  + github.com/segmentio/kafka-go                        (MODIFY)
Dockerfile       no structural change (pure-Go dep; scratch unchanged)
```

## Config

`Config` gains two fields:
```go
KafkaBroker  string   // e.g. "kafka:9092"
PublishTopic string   // e.g. "order-events"
```
`FromEnv` parsing:
- `KAFKA_BROKER` — optional free string, read as-is.
- `PUBLISH_TOPIC` — optional. **If set, `KAFKA_BROKER` must be non-empty**, else
  `FromEnv` returns an error (`PUBLISH_TOPIC set but KAFKA_BROKER is empty`) and
  the process fails loud at boot.
- The compiler emits both together for a `Service→Kafka` edge, so the valid case
  is exercised by real graphs.

## Publisher seam

```go
// publisher.go
type Publisher interface {
	Publish(ctx context.Context, value []byte) error
}

type KafkaPublisher struct{ w *kafka.Writer }

func NewKafkaPublisher(broker, topic string) *KafkaPublisher {
	return &KafkaPublisher{w: &kafka.Writer{
		Addr:         kafka.TCP(broker),
		Topic:        topic,
		Balancer:     &kafka.LeastBytes{},
		WriteTimeout: 2 * time.Second,
		RequiredAcks: kafka.RequireOne,
	}}
}
func (p *KafkaPublisher) Publish(ctx context.Context, value []byte) error {
	return p.w.WriteMessages(ctx, kafka.Message{Value: value})
}
func (p *KafkaPublisher) Close() error { return p.w.Close() }
```

The seam keeps handler logic Docker/Kafka-free in tests: a fake `Publisher`
records calls and can return an error to exercise the 503 path.

## Request integration (`handleRoot`)

`Server` gains a `publisher Publisher` field (nil when no `PUBLISH_TOPIC`).
`NewServer(cfg, rnd, metrics, publisher)` — existing tests pass `nil`.

After the upstream block, before the final 200 response:
```go
if s.publisher != nil {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	payload := []byte(fmt.Sprintf(`{"ts":%d}`, time.Now().UnixMilli()))
	if err := s.publisher.Publish(ctx, payload); err != nil {
		s.respond(w, http.StatusServiceUnavailable, map[string]string{"error": "publish"})
		return
	}
}
s.respond(w, http.StatusOK, map[string]bool{"ok": true})
```

- Publish only on the success path: skipped when the request already returned 500
  (injected error) or 502 (upstream cascade).
- Failure → **503** via `respond`, which records
  `http_requests_total{status="503"}` — visible in `/metrics` and to k6
  (`http_req_failed`).
- Synchronous (2s timeout from the request context) → Kafka latency / backpressure
  shows up directly in the service's response time.

## main wiring + deps

```go
var publisher Publisher
if cfg.PublishTopic != "" {
	kp := NewKafkaPublisher(cfg.KafkaBroker, cfg.PublishTopic)
	defer kp.Close()
	publisher = kp
}
srv := NewServer(cfg, rnd, metrics, publisher)
```

- `go.mod`: add `github.com/segmentio/kafka-go`; `go mod tidy`.
- `Dockerfile`: no structural change. kafka-go is pure Go, so `CGO_ENABLED=0`
  static build + `scratch` runtime are unchanged (binary grows modestly).

## Error handling

- Boot: `PUBLISH_TOPIC` without `KAFKA_BROKER` → fail loud, exit non-zero.
- Per request: publish error/timeout → 503 (visible). The request's own injected
  error (500) and upstream cascade (502) still take precedence and skip publish.
- Shutdown: the `KafkaPublisher` is closed on graceful shutdown (flushes/closes
  the writer).

## Testing

**Unit tests (fast, no Kafka), via a fake `Publisher`:**
- `config_test.go`:
  - `PUBLISH_TOPIC=order-events` + `KAFKA_BROKER=kafka:9092` → both parsed.
  - `PUBLISH_TOPIC` set + `KAFKA_BROKER` empty → `FromEnv` error.
  - neither set → HTTP-only config unchanged.
- `server_test.go` (fake publisher records calls / can return an error):
  - success path with a publisher → 200 **and** publisher called once with a
    `{"ts":…}` payload.
  - publisher returns an error → response **503**;
    `http_requests_total{status="503"}` incremented.
  - injected-error (`ERROR_RATE=1`) path → publisher **not** called (500).
  - upstream-cascade path (stub upstream returns 500) → publisher **not** called
    (502).
  - `nil` publisher → behaves exactly as v1 (HTTP-only), never invoked.

**Deferred:** no real-Kafka smoke here. The kafka-go producer against a live
broker is validated end-to-end in brick 2 (worker consumes the events; a Saga
smoke ups kafka + service + worker).

## Follow-ups

1. **Saga brick 2** — `sds/worker` (kafka-go consumer; simulate work; optional DB),
   a Saga example graph, and the real-Kafka end-to-end smoke.
2. Multi-hop Saga chains (worker publishes a follow-up event).
3. App-level publish metric / message key strategy.
