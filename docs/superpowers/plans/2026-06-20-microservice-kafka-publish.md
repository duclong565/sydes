# microservice Kafka Publish (Saga brick 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Kafka producer to `sds/microservice` — when `PUBLISH_TOPIC` is set, publish an event synchronously on each request's success path, and surface a publish failure as a 503.

**Architecture:** A `Publisher` seam (injected like the existing `RandSource`) keeps handler logic unit-testable with a fake; the concrete `KafkaPublisher` wraps `segmentio/kafka-go` (pure Go → the `CGO_ENABLED=0` scratch build is unchanged). A service with no `PUBLISH_TOPIC` behaves exactly as v1.

**Tech Stack:** Go 1.23, `github.com/segmentio/kafka-go`, stdlib `net/http/httptest`.

## Global Constraints

- Kafka client: `github.com/segmentio/kafka-go` (pure Go; no cgo; scratch build unchanged).
- Config: `KAFKA_BROKER` (free string) + `PUBLISH_TOPIC` (free string). If `PUBLISH_TOPIC` is set and `KAFKA_BROKER` is empty → `FromEnv` returns an error (fail loud at boot).
- Publish is **synchronous** on the request success path only — skipped when the request already returned 500 (injected error) or 502 (upstream cascade). Publish failure/timeout → **503** via `respond` (records `http_requests_total{status="503"}`). 2s timeout from the request context.
- Published payload: `{"ts":<unixMillis>}`.
- `NewServer` gains a 4th parameter `publisher Publisher` (nil = no publish). All existing callers pass `nil`.
- Backward compatible: no `PUBLISH_TOPIC` → publisher is nil → behaves exactly as v1.
- Go is NOT on the default PATH — prepend `export PATH="$PATH:/usr/local/go/bin"` in every shell command that runs `go`. Tests: `cd images/microservice && go test ./...`.
- `Dockerfile` needs no structural change. **No `Co-Authored-By` trailer in commits.**

---

### Task 1: Config — `KAFKA_BROKER` + `PUBLISH_TOPIC`

**Files:**
- Modify: `images/microservice/config.go`
- Modify: `images/microservice/config_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config.KafkaBroker` + `Config.PublishTopic` fields; `FromEnv` parses them and errors when `PublishTopic` is set without `KafkaBroker`.

- [ ] **Step 1: Write the failing test**

Append to `images/microservice/config_test.go`:
```go
func TestFromEnv_KafkaValid(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("PUBLISH_TOPIC", "order-events")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.KafkaBroker != "kafka:9092" || cfg.PublishTopic != "order-events" {
		t.Errorf("kafka cfg = %+v", cfg)
	}
}

func TestFromEnv_PublishTopicWithoutBroker(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "")
	t.Setenv("PUBLISH_TOPIC", "order-events")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error: PUBLISH_TOPIC set without KAFKA_BROKER")
	}
}

func TestFromEnv_NoKafka(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "")
	t.Setenv("PUBLISH_TOPIC", "")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.KafkaBroker != "" || cfg.PublishTopic != "" {
		t.Errorf("expected empty kafka cfg, got %+v", cfg)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/microservice && go test ./...`
Expected: FAIL — `cfg.KafkaBroker` / `cfg.PublishTopic` are undefined fields.

- [ ] **Step 3: Write minimal implementation**

In `images/microservice/config.go`, add two fields to `Config` (after `UpstreamHTTP`):
```go
	KafkaBroker  string // e.g. "kafka:9092"
	PublishTopic string // e.g. "order-events"
```

In `FromEnv`, add this block immediately before `return cfg, nil`:
```go
	cfg.KafkaBroker = os.Getenv("KAFKA_BROKER")
	cfg.PublishTopic = os.Getenv("PUBLISH_TOPIC")
	if cfg.PublishTopic != "" && cfg.KafkaBroker == "" {
		return Config{}, fmt.Errorf("PUBLISH_TOPIC set but KAFKA_BROKER is empty")
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/microservice && go test ./...`
Expected: PASS — new kafka config tests green; all prior config/server tests still green.

- [ ] **Step 5: Commit**

```bash
git add images/microservice/config.go images/microservice/config_test.go
git commit -m "feat: parse KAFKA_BROKER and PUBLISH_TOPIC config"
```

---

### Task 2: `Publisher` seam + publish on success path

**Files:**
- Modify: `images/microservice/server.go`
- Modify: `images/microservice/server_test.go`
- Modify: `images/microservice/main.go`

**Interfaces:**
- Consumes: `Config.PublishTopic` (Task 1); existing `Server`/`NewServer`/`handleRoot`/`respond`.
- Produces: `type Publisher interface { Publish(ctx context.Context, value []byte) error }`; `Server.publisher` field; `NewServer(cfg Config, rnd RandSource, metrics *Metrics, publisher Publisher) *Server`; `handleRoot` publishes on success.

- [ ] **Step 1: Write the failing test**

Append to `images/microservice/server_test.go` (it already imports `net/http`, `net/http/httptest`, `strings`, `testing`, `time`; add `context` and `errors` to its import block):
```go
type fakePublisher struct {
	calls     int
	lastValue []byte
	err       error
}

func (f *fakePublisher) Publish(_ context.Context, value []byte) error {
	f.calls++
	f.lastValue = append([]byte(nil), value...)
	return f.err
}

func TestRoot_PublishesOnSuccess(t *testing.T) {
	pub := &fakePublisher{}
	s := NewServer(Config{}, stubRand{float: 1.0}, NewMetrics(), pub)
	rec := post(s)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
	if pub.calls != 1 {
		t.Fatalf("publisher calls = %d, want 1", pub.calls)
	}
	if !strings.Contains(string(pub.lastValue), `"ts"`) {
		t.Errorf("payload missing ts: %s", pub.lastValue)
	}
}

func TestRoot_PublishFailureReturns503(t *testing.T) {
	pub := &fakePublisher{err: errors.New("broker down")}
	s := NewServer(Config{}, stubRand{float: 1.0}, NewMetrics(), pub)
	if rec := post(s); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503", rec.Code)
	}
}

func TestRoot_NoPublishOnInjectedError(t *testing.T) {
	pub := &fakePublisher{}
	s := NewServer(Config{ErrorRate: 1.0}, stubRand{float: 0.0}, NewMetrics(), pub)
	if rec := post(s); rec.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500", rec.Code)
	}
	if pub.calls != 0 {
		t.Errorf("publisher should not be called on injected error, got %d", pub.calls)
	}
}

func TestRoot_NoPublishOnUpstreamCascade(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()
	pub := &fakePublisher{}
	s := NewServer(Config{UpstreamHTTP: upstream.URL}, stubRand{float: 1.0}, NewMetrics(), pub)
	if rec := post(s); rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d, want 502", rec.Code)
	}
	if pub.calls != 0 {
		t.Errorf("publisher should not be called on upstream cascade, got %d", pub.calls)
	}
}
```

Then update EVERY existing `NewServer(` call site to pass a 4th argument `nil`. Find them with:
`export PATH="$PATH:/usr/local/go/bin" && grep -rn "NewServer(" images/microservice/`
Existing callers (in `server_test.go`'s `newTestServer` helper, the `TestRoot_RecordsMetric` direct call, and `main.go`) each take `(cfg, rnd, metrics)` — append `, nil` so they become `(cfg, rnd, metrics, nil)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/microservice && go test ./...`
Expected: FAIL — `NewServer` takes 3 args (the new tests pass 4); `Publisher` undefined.

- [ ] **Step 3: Write minimal implementation**

In `images/microservice/server.go`:

Add `context` and `fmt` to the import block.

Add the `Publisher` interface (just below the `RandSource` interface):
```go
// Publisher publishes one event per successful request when configured.
// Injected so tests can use a fake.
type Publisher interface {
	Publish(ctx context.Context, value []byte) error
}
```

Add a `publisher` field to `Server`:
```go
type Server struct {
	cfg       Config
	rand      RandSource
	metrics   *Metrics
	client    *http.Client
	publisher Publisher
}
```

Change `NewServer` to take and store the publisher:
```go
func NewServer(cfg Config, rnd RandSource, metrics *Metrics, publisher Publisher) *Server {
	return &Server{
		cfg:       cfg,
		rand:      rnd,
		metrics:   metrics,
		client:    &http.Client{Timeout: 2 * time.Second},
		publisher: publisher,
	}
}
```

Replace the whole `handleRoot` method with the version below (adds the publish block between the upstream block and the final 200):
```go
func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	s.metrics.InFlight.Inc()
	defer s.metrics.InFlight.Dec()

	start := time.Now()
	defer func() { s.metrics.Duration.Observe(time.Since(start).Seconds()) }()

	_, _ = io.Copy(io.Discard, r.Body)

	delay := s.cfg.LatencyMS
	if s.cfg.JitterMS > 0 {
		delay += s.rand.Intn(s.cfg.JitterMS + 1)
	}
	time.Sleep(time.Duration(delay) * time.Millisecond)

	if s.rand.Float64() < s.cfg.ErrorRate {
		s.respond(w, http.StatusInternalServerError, map[string]string{"error": "injected"})
		return
	}

	if s.cfg.UpstreamHTTP != "" {
		// Body intentionally dropped — this is a traffic simulator, not a proxy.
		resp, err := s.client.Post(s.cfg.UpstreamHTTP, "application/json", http.NoBody)
		if err != nil || resp.StatusCode >= 500 {
			if resp != nil {
				resp.Body.Close()
			}
			s.respond(w, http.StatusBadGateway, map[string]string{"error": "upstream"})
			return
		}
		resp.Body.Close()
	}

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
}
```

(The `main.go` `NewServer` call was already updated to `(cfg, rnd, metrics, nil)` in Step 1 so the package compiles. Task 3 wires the real publisher.)

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/microservice && go test ./...`
Expected: PASS — publish-on-success, 503-on-failure, no-publish-on-500, no-publish-on-502, and all prior tests green.

- [ ] **Step 5: Commit**

```bash
git add images/microservice/server.go images/microservice/server_test.go images/microservice/main.go
git commit -m "feat: publish to Kafka on the request success path"
```

---

### Task 3: `KafkaPublisher` + kafka-go dep + main wiring

**Files:**
- Create: `images/microservice/publisher.go`
- Modify: `images/microservice/main.go`
- Modify: `images/microservice/go.mod`, `images/microservice/go.sum` (via `go mod tidy`)

**Interfaces:**
- Consumes: `Publisher` interface + `NewServer` (Task 2); `Config.PublishTopic`/`KafkaBroker` (Task 1).
- Produces: `KafkaPublisher` implementing `Publisher`; `NewKafkaPublisher(broker, topic string) *KafkaPublisher`; `(*KafkaPublisher).Close()`; `main` builds + wires the real publisher when `PublishTopic != ""`.

- [ ] **Step 1: Wire main to the real publisher (the failing state)**

In `images/microservice/main.go`, replace the line that builds the server (currently `srv := NewServer(cfg, rnd, metrics, nil)`) with:
```go
	var publisher Publisher
	if cfg.PublishTopic != "" {
		kp := NewKafkaPublisher(cfg.KafkaBroker, cfg.PublishTopic)
		defer kp.Close()
		publisher = kp
	}
	srv := NewServer(cfg, rnd, metrics, publisher)
```

- [ ] **Step 2: Run build to verify it fails**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/microservice && go build ./...`
Expected: FAIL — `undefined: NewKafkaPublisher`.

- [ ] **Step 3: Write minimal implementation**

`images/microservice/publisher.go`:
```go
package main

import (
	"context"
	"time"

	"github.com/segmentio/kafka-go"
)

// KafkaPublisher publishes messages to a topic via segmentio/kafka-go.
type KafkaPublisher struct {
	w *kafka.Writer
}

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

func (p *KafkaPublisher) Close() error {
	return p.w.Close()
}
```

Then fetch the dependency:

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/microservice && go mod tidy`
Expected: `go.mod` gains `require github.com/segmentio/kafka-go ...`; `go.sum` updated with kafka-go + its pure-Go transitive deps.

- [ ] **Step 4: Verify build, vet, and the full suite pass**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/microservice && go vet ./... && go build ./... && go test ./...`
Expected: PASS — vet clean, build succeeds, all unit tests green. (`KafkaPublisher` itself is not unit-tested; it is proven against a live broker in Saga brick 2.)

- [ ] **Step 5: Verify the Docker image still builds (manual gate — needs Docker)**

Run: `docker build -t sds/microservice ./images/microservice`
Expected: build succeeds; still a `scratch`-based static binary (kafka-go is pure Go, `CGO_ENABLED=0` unchanged). Image is modestly larger than v1.

- [ ] **Step 6: Commit**

```bash
git add images/microservice/publisher.go images/microservice/main.go images/microservice/go.mod images/microservice/go.sum
git commit -m "feat: add kafka-go publisher and wire it in main"
```

---

## Self-Review

**Spec coverage** (design → task):
- `KAFKA_BROKER` + `PUBLISH_TOPIC` config + fail-loud when topic-without-broker → Task 1.
- `Publisher` seam (injected like `RandSource`) + `NewServer` 4th param + existing callers pass nil → Task 2.
- Synchronous publish on success path, failure → 503, skipped on 500/502, `{"ts":…}` payload → Task 2 (`handleRoot`).
- `KafkaPublisher` (kafka-go) + `main` wiring + close on shutdown → Task 3.
- Pure-Go dep, scratch build unchanged (Dockerfile untouched) → Task 3 Step 5.
- Backward compatible (nil publisher = v1) → Task 2 (existing tests pass nil and still green).
- Unit tests via fake publisher; real-Kafka deferred to brick 2 → Tasks 1–2 tests + Task 3 note.

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `Publisher.Publish(ctx context.Context, value []byte) error` is identical in the interface (Task 2), the `fakePublisher` (Task 2 test), and `KafkaPublisher` (Task 3). `NewServer(cfg Config, rnd RandSource, metrics *Metrics, publisher Publisher)` is consistent across Task 2's definition, all updated callers, and Task 3's `main` wiring. `Config.PublishTopic`/`KafkaBroker` (Task 1) consumed by Task 3's `main`. Payload `{"ts":<unixMillis>}` matches the test's `"ts"` assertion.

**Not in this plan (intentional, = Saga brick 2):** `sds/worker`, the Saga example graph, the real-Kafka end-to-end smoke, multi-hop event chains.
