# sds/worker Image (Saga brick 2b-i) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `sds/worker` Go image — a kafka-go group consumer that simulates processing work (latency + error injection) and exposes `/health` + `/metrics` — and prove the full Saga chain (`service → kafka → worker`) with a gated real-Kafka smoke.

**Architecture:** Mirrors the `sds/microservice` patterns: injected `RandSource` for deterministic latency/error, a `Consumer` seam (real kafka-go reader vs a fake in tests), client_golang metrics, scratch static binary. The worker runs the consume loop and an HTTP server in goroutines with graceful SIGTERM shutdown. No DB (pgx = brick 2b-ii).

**Tech Stack:** Go 1.23, `segmentio/kafka-go`, `prometheus/client_golang`, Vitest (the smoke).

## Global Constraints

- New module `images/worker/` → module path `sds/worker`, go 1.23, scratch runtime (pure-Go deps, `CGO_ENABLED=0`).
- Config: `PORT` (default 8080, 1–65535), `LATENCY_MS`/`LATENCY_JITTER_MS` (≥0), `ERROR_RATE` (0–1), `KAFKA_BROKER`, `SUBSCRIBE_TOPICS` (comma-split, trimmed). `SUBSCRIBE_TOPICS` must be non-empty; if set, `KAFKA_BROKER` required. `DB_URL` read-but-ignored. Fail-loud at boot.
- Consumer group id: `"sds-" + strings.Join(topics, "-")`. `ReadMessage` auto-commits within the group (at-least-once; a simulated error still commits).
- Metrics (client_golang, private registry): `messages_consumed_total{status="ok"|"error"}`, `processing_duration_seconds` histogram, `in_flight` gauge.
- The worker logs `consumed <N>` per message (the smoke greps `consumed`).
- `/health` → 200 `{"status":"ok"}`; `/metrics` → promhttp. No traffic endpoint.
- Go is NOT on the default PATH — prepend `export PATH="$PATH:/usr/local/go/bin"` in every shell command running `go`. Tests: `cd images/worker && go test ./...`.
- Gated smoke runs only with `RUN_DOCKER=1`. **No `Co-Authored-By` trailer in commits.**

---

### Task 1: Module scaffold + config

**Files:**
- Create: `images/worker/go.mod`
- Create: `images/worker/doc.go`
- Create: `images/worker/config.go`
- Test: `images/worker/config_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config{Port,LatencyMS,JitterMS,ErrorRate,KafkaBroker,SubscribeTopics}`; `FromEnv() (Config, error)`.

- [ ] **Step 1: Write the failing test**

`images/worker/config_test.go`:
```go
package main

import "testing"

func TestFromEnv_Valid(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("SUBSCRIBE_TOPICS", "order-events, payment-events")
	t.Setenv("LATENCY_MS", "20")
	t.Setenv("ERROR_RATE", "0.1")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.KafkaBroker != "kafka:9092" {
		t.Errorf("broker = %q", cfg.KafkaBroker)
	}
	if len(cfg.SubscribeTopics) != 2 || cfg.SubscribeTopics[0] != "order-events" || cfg.SubscribeTopics[1] != "payment-events" {
		t.Errorf("topics = %v", cfg.SubscribeTopics)
	}
	if cfg.LatencyMS != 20 || cfg.ErrorRate != 0.1 {
		t.Errorf("cfg = %+v", cfg)
	}
}

func TestFromEnv_RequiresTopics(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("SUBSCRIBE_TOPICS", "")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error: SUBSCRIBE_TOPICS required")
	}
}

func TestFromEnv_RequiresBroker(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "")
	t.Setenv("SUBSCRIBE_TOPICS", "order-events")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error: KAFKA_BROKER required")
	}
}

func TestFromEnv_InvalidErrorRate(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("SUBSCRIBE_TOPICS", "x")
	t.Setenv("ERROR_RATE", "2.0")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error for ERROR_RATE=2.0")
	}
}

func TestFromEnv_IgnoresDBURL(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("SUBSCRIBE_TOPICS", "x")
	t.Setenv("DB_URL", "postgres://db:5432")
	if _, err := FromEnv(); err != nil {
		t.Fatalf("DB_URL should be ignored: %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: FAIL — `go.mod file not found`.

- [ ] **Step 3: Write minimal implementation**

`images/worker/go.mod`:
```
module sds/worker

go 1.23
```

`images/worker/doc.go`:
```go
// Package main is the sds/worker image: a Kafka consumer that simulates
// processing work (latency, error injection) for the System Design Sandbox.
package main
```

`images/worker/config.go`:
```go
package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config is the fully-parsed, validated runtime configuration.
type Config struct {
	Port            int
	LatencyMS       int
	JitterMS        int
	ErrorRate       float64
	KafkaBroker     string
	SubscribeTopics []string
}

// FromEnv parses + validates configuration, failing loud on any invalid value.
func FromEnv() (Config, error) {
	cfg := Config{Port: 8080}

	if v := os.Getenv("PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil || p < 1 || p > 65535 {
			return Config{}, fmt.Errorf("PORT must be 1-65535, got %q", v)
		}
		cfg.Port = p
	}

	n, err := nonNegInt("LATENCY_MS")
	if err != nil {
		return Config{}, err
	}
	cfg.LatencyMS = n

	n, err = nonNegInt("LATENCY_JITTER_MS")
	if err != nil {
		return Config{}, err
	}
	cfg.JitterMS = n

	if v := os.Getenv("ERROR_RATE"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f < 0 || f > 1 {
			return Config{}, fmt.Errorf("ERROR_RATE must be 0.0-1.0, got %q", v)
		}
		cfg.ErrorRate = f
	}

	cfg.KafkaBroker = os.Getenv("KAFKA_BROKER")

	for _, t := range strings.Split(os.Getenv("SUBSCRIBE_TOPICS"), ",") {
		if s := strings.TrimSpace(t); s != "" {
			cfg.SubscribeTopics = append(cfg.SubscribeTopics, s)
		}
	}
	if len(cfg.SubscribeTopics) == 0 {
		return Config{}, fmt.Errorf("SUBSCRIBE_TOPICS is required")
	}
	if cfg.KafkaBroker == "" {
		return Config{}, fmt.Errorf("KAFKA_BROKER is required when SUBSCRIBE_TOPICS is set")
	}

	return cfg, nil
}

func nonNegInt(key string) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer, got %q", key, v)
	}
	return n, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: PASS — 5 config tests passing.

- [ ] **Step 5: Commit**

```bash
git add images/worker/go.mod images/worker/doc.go images/worker/config.go images/worker/config_test.go
git commit -m "feat: scaffold sds/worker module with env config"
```

---

### Task 2: Metrics

**Files:**
- Create: `images/worker/metrics.go`
- Test: `images/worker/metrics_test.go`
- Modify: `images/worker/go.mod`, `images/worker/go.sum` (via `go mod tidy`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type Metrics{reg,Consumed *CounterVec,Duration Histogram,InFlight Gauge}`; `NewMetrics() *Metrics`; `(*Metrics).Handler() http.Handler`.

- [ ] **Step 1: Write the failing test**

`images/worker/metrics_test.go`:
```go
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetrics_ExposesConsumed(t *testing.T) {
	m := NewMetrics()
	m.Consumed.WithLabelValues("ok").Inc()
	m.Consumed.WithLabelValues("ok").Inc()
	m.Consumed.WithLabelValues("error").Inc()

	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := rec.Body.String()
	if !strings.Contains(body, `messages_consumed_total{status="ok"} 2`) {
		t.Errorf("missing ok counter:\n%s", body)
	}
	if !strings.Contains(body, `messages_consumed_total{status="error"} 1`) {
		t.Errorf("missing error counter:\n%s", body)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: FAIL — `undefined: NewMetrics` (and unresolved prometheus import).

- [ ] **Step 3: Write minimal implementation**

`images/worker/metrics.go`:
```go
package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics holds the worker's Prometheus collectors on a private registry.
type Metrics struct {
	reg      *prometheus.Registry
	Consumed *prometheus.CounterVec
	Duration prometheus.Histogram
	InFlight prometheus.Gauge
}

func NewMetrics() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		reg: reg,
		Consumed: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "messages_consumed_total",
			Help: "Total messages consumed by processing status.",
		}, []string{"status"}),
		Duration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "processing_duration_seconds",
			Help:    "Message processing duration in seconds.",
			Buckets: prometheus.DefBuckets,
		}),
		InFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "in_flight",
			Help: "Number of in-flight message processings.",
		}),
	}
	reg.MustRegister(m.Consumed, m.Duration, m.InFlight)
	reg.MustRegister(collectors.NewGoCollector())
	reg.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return m
}

func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
}
```

Then fetch the dependency:

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go mod tidy`
Expected: `go.mod` gains `require github.com/prometheus/client_golang ...`; `go.sum` created.

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: PASS — metrics test green, config tests still green.

- [ ] **Step 5: Commit**

```bash
git add images/worker/metrics.go images/worker/metrics_test.go images/worker/go.mod images/worker/go.sum
git commit -m "feat: add prometheus metrics for the worker"
```

---

### Task 3: Consumer seam + kafka-go

**Files:**
- Create: `images/worker/consumer.go`
- Modify: `images/worker/go.mod`, `images/worker/go.sum` (via `go mod tidy`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type Consumer interface { Read(ctx context.Context) ([]byte, error); Close() error }`; `type KafkaConsumer`; `NewKafkaConsumer(broker string, topics []string, groupID string) *KafkaConsumer`.

- [ ] **Step 1: Write the file (the failing state)**

`images/worker/consumer.go`:
```go
package main

import (
	"context"

	"github.com/segmentio/kafka-go"
)

// Consumer reads the next message value from a topic set. Injected so tests can use a fake.
type Consumer interface {
	Read(ctx context.Context) ([]byte, error)
	Close() error
}

// KafkaConsumer is a kafka-go consumer-group reader.
type KafkaConsumer struct {
	r *kafka.Reader
}

func NewKafkaConsumer(broker string, topics []string, groupID string) *KafkaConsumer {
	return &KafkaConsumer{r: kafka.NewReader(kafka.ReaderConfig{
		Brokers:     []string{broker},
		GroupID:     groupID,
		GroupTopics: topics,
		MinBytes:    1,
		MaxBytes:    10e6,
	})}
}

// Read returns the next message value, auto-committing within the consumer group.
func (c *KafkaConsumer) Read(ctx context.Context) ([]byte, error) {
	m, err := c.r.ReadMessage(ctx)
	if err != nil {
		return nil, err
	}
	return m.Value, nil
}

func (c *KafkaConsumer) Close() error { return c.r.Close() }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: FAIL — `no required module provides package github.com/segmentio/kafka-go` (kafka-go not yet in go.mod).

- [ ] **Step 3: Fetch the dependency**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go mod tidy`
Expected: `go.mod` gains `require github.com/segmentio/kafka-go ...`; `go.sum` updated with kafka-go + its pure-Go transitive deps.

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: PASS — the package compiles with `consumer.go`; all prior tests still green. (`KafkaConsumer` is not unit-tested — it is exercised against a live broker by the Saga smoke in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add images/worker/consumer.go images/worker/go.mod images/worker/go.sum
git commit -m "feat: add kafka-go consumer seam"
```

---

### Task 4: Worker consume loop

**Files:**
- Create: `images/worker/worker.go`
- Test: `images/worker/worker_test.go`

**Interfaces:**
- Consumes: `Config` (Task 1), `Metrics` (Task 2), `Consumer` (Task 3).
- Produces: `type RandSource interface { Float64() float64; Intn(n int) int }`; `type Worker`; `NewWorker(cfg Config, rnd RandSource, metrics *Metrics, consumer Consumer) *Worker`; `(*Worker).Run(ctx context.Context)`.

- [ ] **Step 1: Write the failing test**

`images/worker/worker_test.go`:
```go
package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type stubRand struct {
	float float64
	intn  int
}

func (s stubRand) Float64() float64 { return s.float }
func (s stubRand) Intn(n int) int   { return s.intn }

// fakeConsumer returns queued values, then cancels the run context and signals done.
type fakeConsumer struct {
	values [][]byte
	i      int
	cancel context.CancelFunc
}

func (f *fakeConsumer) Read(_ context.Context) ([]byte, error) {
	if f.i >= len(f.values) {
		f.cancel()
		return nil, context.Canceled
	}
	v := f.values[f.i]
	f.i++
	return v, nil
}
func (f *fakeConsumer) Close() error { return nil }

func scrape(m *Metrics) string {
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	return rec.Body.String()
}

func TestWorker_ConsumesAllMessages(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b"), []byte("c")}, cancel: cancel}
	NewWorker(Config{}, stubRand{float: 1.0}, m, fc).Run(ctx)
	if !strings.Contains(scrape(m), `messages_consumed_total{status="ok"} 3`) {
		t.Errorf("expected 3 ok:\n%s", scrape(m))
	}
}

func TestWorker_CountsErrors(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b")}, cancel: cancel}
	NewWorker(Config{ErrorRate: 1.0}, stubRand{float: 0.0}, m, fc).Run(ctx)
	body := scrape(m)
	if !strings.Contains(body, `messages_consumed_total{status="error"} 2`) {
		t.Errorf("expected 2 error:\n%s", body)
	}
	if strings.Contains(body, `status="ok"`) {
		t.Errorf("should be no ok series:\n%s", body)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: FAIL — `undefined: NewWorker` / `RandSource`.

- [ ] **Step 3: Write minimal implementation**

`images/worker/worker.go`:
```go
package main

import (
	"context"
	"log"
	"time"
)

// RandSource is the minimal randomness surface. Injected for deterministic tests.
type RandSource interface {
	Float64() float64
	Intn(n int) int
}

// Worker consumes messages and simulates processing work.
type Worker struct {
	cfg      Config
	rand     RandSource
	metrics  *Metrics
	consumer Consumer
}

func NewWorker(cfg Config, rnd RandSource, metrics *Metrics, consumer Consumer) *Worker {
	return &Worker{cfg: cfg, rand: rnd, metrics: metrics, consumer: consumer}
}

// Run consumes until the context is cancelled.
func (w *Worker) Run(ctx context.Context) {
	var count int
	for {
		val, err := w.consumer.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return // shutdown
			}
			continue // transient read error: skip and retry
		}
		w.process(val)
		count++
		log.Printf("consumed %d", count)
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

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: PASS — both worker tests green, all prior tests green.

- [ ] **Step 5: Commit**

```bash
git add images/worker/worker.go images/worker/worker_test.go
git commit -m "feat: add worker consume loop with simulated processing"
```

---

### Task 5: HTTP server + main wiring + Dockerfile

**Files:**
- Create: `images/worker/http.go`
- Test: `images/worker/http_test.go`
- Create: `images/worker/main.go`
- Create: `images/worker/Dockerfile`
- Create: `images/worker/.dockerignore`

**Interfaces:**
- Consumes: `Metrics` (Task 2), `Config`/`FromEnv` (Task 1), `NewKafkaConsumer` (Task 3), `NewWorker`/`Worker.Run` (Task 4).
- Produces: `type Server{metrics}`; `NewServer(metrics *Metrics) *Server`; `(*Server).Routes() http.Handler`; `writeJSON`; `func main()`.

- [ ] **Step 1: Write the failing test**

`images/worker/http_test.go`:
```go
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealth(t *testing.T) {
	s := NewServer(NewMetrics())
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ok") {
		t.Errorf("body = %q", rec.Body.String())
	}
}

func TestMetricsRouteServed(t *testing.T) {
	s := NewServer(NewMetrics())
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics = %d, want 200", rec.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: FAIL — `undefined: NewServer`.

- [ ] **Step 3: Write minimal implementation**

`images/worker/http.go`:
```go
package main

import (
	"encoding/json"
	"net/http"
)

// Server serves the worker's /health and /metrics endpoints.
type Server struct {
	metrics *Metrics
}

func NewServer(metrics *Metrics) *Server {
	return &Server{metrics: metrics}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("GET /metrics", s.metrics.Handler())
	return mux
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
```

`images/worker/main.go`:
```go
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	cfg, err := FromEnv()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	metrics := NewMetrics()
	rnd := rand.New(rand.NewSource(time.Now().UnixNano()))
	groupID := "sds-" + strings.Join(cfg.SubscribeTopics, "-")
	consumer := NewKafkaConsumer(cfg.KafkaBroker, cfg.SubscribeTopics, groupID)
	worker := NewWorker(cfg, rnd, metrics, consumer)

	httpSrv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      NewServer(metrics).Routes(),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go func() {
		log.Printf("worker consuming %v via %s (group %s)", cfg.SubscribeTopics, cfg.KafkaBroker, groupID)
		worker.Run(ctx)
	}()
	go func() {
		log.Printf("worker http on :%d", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Print("shutting down")
	_ = consumer.Close()
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
```

`images/worker/Dockerfile`:
```dockerfile
# --- build stage ---
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /worker .

# --- runtime stage ---
FROM scratch
COPY --from=build /worker /worker
EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["/worker"]
```

`images/worker/.dockerignore`:
```
*_test.go
doc.go
Dockerfile
.dockerignore
```

- [ ] **Step 4: Verify build, vet, tests, and the image**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go vet ./... && go build ./... && go test ./...`
Expected: PASS — vet clean, build produces a binary (delete the stray `worker` binary if `go build .` left one; do not commit it), all tests green.

Run: `docker build -t sds/worker ./images/worker`
Expected: build succeeds; `scratch`-based static image.

- [ ] **Step 5: Commit**

```bash
git add images/worker/http.go images/worker/http_test.go images/worker/main.go images/worker/Dockerfile images/worker/.dockerignore
git commit -m "feat: add worker http server, main wiring, and Dockerfile"
```

---

### Task 6: Saga example + gated real-Kafka chain smoke

**Files:**
- Create: `examples/saga.json`
- Create: `src/engine/saga-chain.smoke.test.ts`

**Interfaces:**
- Consumes: `compile` (`../compiler/index.js`), `Graph` (`../compiler/types.js`), `ExperimentController` + `RealRunner` + `K6Runner` (existing engine).
- Produces: a Saga example graph + a gated suite that proves `service → kafka → worker` end-to-end.

- [ ] **Step 1: Write the example graph + the test**

`examples/saga.json`:
```json
{
  "experimentId": "saga",
  "nodes": [
    { "id": "o", "type": "service", "label": "Order Service" },
    { "id": "k", "type": "kafka", "label": "Order Events" },
    { "id": "p", "type": "worker", "label": "Payment Worker" }
  ],
  "edges": [
    { "source": "o", "target": "k" },
    { "source": "p", "target": "k" }
  ]
}
```

`src/engine/saga-chain.smoke.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';
import { K6Runner } from './k6-runner.js';

// Gated: needs RUN_DOCKER=1, the sds/microservice + sds/worker images built; pulls apache/kafka.
describe.skipIf(!process.env.RUN_DOCKER)('saga chain smoke (real docker)', () => {
  it('service publishes -> kafka -> worker consumes', async () => {
    const graph = JSON.parse(readFileSync('examples/saga.json', 'utf8')) as Graph;
    const result = compile(graph, { rate: 20, durationSec: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runRoot = mkdtempSync(join(tmpdir(), 'sds-saga-'));
    const runner = new RealRunner();
    const c = new ExperimentController(runner, { runRoot });
    const runDir = c.writeArtifacts(graph.experimentId, result.output);
    const id = graph.experimentId;
    try {
      await c.preflight(result.output);
      await c.up(id); // kafka cold start; --wait blocks until healthy
      await new K6Runner(runner).run(id, runDir); // fire load at the service -> it publishes
      await new Promise((r) => setTimeout(r, 2000)); // let the worker drain
      const logs = await runner.run([
        'docker', 'compose', '-p', `sds-${id}`, '-f', join(runDir, 'compose.yml'),
        'logs', 'payment-worker',
      ]);
      expect(logs.stdout).toMatch(/consumed/);
    } finally {
      await c.down(id);
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
```

- [ ] **Step 2: Verify the example compiles + the suite skips by default**

Run: `npm test -- src/engine/saga-chain.smoke.test.ts`
Expected: PASS — suite skipped (no Docker). (The `compile` of `examples/saga.json` only runs under `RUN_DOCKER=1`.)

- [ ] **Step 3: Run it for real (manual gate — needs Docker + both images)**

Run:
```bash
docker build -t sds/microservice ./images/microservice
docker build -t sds/worker ./images/worker
RUN_DOCKER=1 npm test -- src/engine/saga-chain.smoke.test.ts
```
Expected: PASS — apache/kafka boots (KRaft, `up --wait`), the order-service takes ~3s of k6 load and publishes to `order-events`, the payment-worker consumes and logs `consumed N`, the assertion matches, then the stack is torn down. (First run pulls `apache/kafka`; allow generous time — the test sets a 180s timeout.) If a leftover `sds-saga` project interferes, run `docker compose -p sds-saga down -v` first.

- [ ] **Step 4: Run the full default suite**

Run: `npm test`
Expected: PASS — all suites green; the new smoke (and the other gated smokes) show as skipped.

- [ ] **Step 5: Commit**

```bash
git add examples/saga.json src/engine/saga-chain.smoke.test.ts
git commit -m "test: add Saga example and gated real-kafka chain smoke"
```

---

## Self-Review

**Spec coverage** (design → task):
- Config (mirror microservice + `SUBSCRIBE_TOPICS`/`KAFKA_BROKER` validation, `DB_URL` ignored) → Task 1.
- Metrics (`messages_consumed_total{status}`, duration, in-flight) → Task 2.
- `Consumer` seam + `KafkaConsumer` (group reader, `GroupTopics`, `ReadMessage` auto-commit) → Task 3.
- Worker loop + `process` simulate (latency/error, `RandSource`), at-least-once commit, `consumed N` log → Task 4.
- `/health` + `/metrics`, group id `sds-<topics>`, main wiring + graceful shutdown, scratch Dockerfile → Task 5.
- Saga example + gated real-Kafka chain smoke (verified via worker logs) → Task 6.
- Backward compat (new image; before it, worker graphs failed preflight) → Task 5 (image builds) + Task 6 (preflight finds both images).

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `Config` fields used in `worker.go` (Task 4) + `main.go` (Task 5) match Task 1. `Metrics{Consumed,Duration,InFlight}` defined Task 2, used in Task 4/5 and the worker tests. `Consumer.Read(ctx)([]byte,error)`/`Close()` identical in the interface (Task 3), `KafkaConsumer` (Task 3), and `fakeConsumer` (Task 4 test). `NewWorker(cfg,rnd,metrics,consumer)`/`Worker.Run(ctx)` consistent Task 4 ↔ Task 5. `NewServer(metrics)`/`Routes()`/`writeJSON` defined Task 5. Group id `"sds-"+join(topics,"-")` matches between `main.go` and the spec. The worker service name in the smoke (`payment-worker`) = `slugify("Payment Worker")`.

**Not in this plan (intentional, = brick 2b-ii):** real postgres writes (pgx Sink, schema, connection retry, `DB_URL` handling), a `worker → db` Saga example, multi-hop Saga.
