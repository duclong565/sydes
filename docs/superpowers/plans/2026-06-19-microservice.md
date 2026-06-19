# `sds/microservice` Go Image v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 `sds/microservice` Docker image — a tiny env-driven Go HTTP server that simulates latency, error injection, and cascading upstream call chains, exposing Prometheus metrics.

**Architecture:** stdlib `net/http` only. A `Server` struct holds `Config`, an injectable `RandSource`, a `*Metrics`, and an `*http.Client`; handlers are methods so `httptest` can inject a deterministic rand and a stub upstream. Single `package main`, files split by concern. Behavior is fully unit-tested without Docker; the image is built separately.

**Tech Stack:** Go 1.22, `github.com/prometheus/client_golang`, `net/http/httptest` (stdlib testing), multi-stage Docker build to `scratch`.

## Global Constraints

- Module path: `sds/microservice`. Go version floor: `1.22` (needs method-pattern `ServeMux`, e.g. `"POST /"`).
- Only one external dependency: `github.com/prometheus/client_golang`. No web framework, no Kafka client.
- Lives in `images/microservice/`. Run tests with `go test ./...` — NOT `npm test`.
- Fail loud: invalid config → log a clear message and exit non-zero. Never serve with bad config.
- Error codes: own injected failure → **500**; upstream 5xx/timeout/conn-error → **502**. Both count as errors.
- Defaults: `PORT=8080`, `LATENCY_MS=0`, `LATENCY_JITTER_MS=0`, `ERROR_RATE=0`, `UPSTREAM_HTTP=""`.
- Fixed constants (not env in v1): upstream client timeout `2s`.
- Unknown envs the compiler emits (`DB_URL`, `REDIS_URL`, `KAFKA_BROKER`, `PUBLISH_TOPIC`, `SUBSCRIBE_TOPICS`) are ignored, never errors.
- Container target ~5MB via `scratch` base + static `CGO_ENABLED=0` binary.
- Determinism: rand is injected (`RandSource` interface); tests pass a fixed stub.

---

### Task 1: Module scaffold + Go test toolchain

**Files:**
- Create: `images/microservice/go.mod`
- Create: `images/microservice/doc.go`
- Test: `images/microservice/smoke_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: a `go test ./...` command that runs in `images/microservice/`, `package main`.

- [ ] **Step 1: Write the failing test**

`images/microservice/smoke_test.go`:
```go
package main

import "testing"

func TestToolchain(t *testing.T) {
	if 1+1 != 2 {
		t.Fatal("math broken")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd images/microservice && go test ./...`
Expected: FAIL — `go.mod file not found in current directory or any parent directory`.

- [ ] **Step 3: Write minimal implementation**

`images/microservice/go.mod`:
```
module sds/microservice

go 1.22
```

`images/microservice/doc.go`:
```go
// Package main is the sds/microservice image: an env-driven HTTP server that
// simulates latency, error injection, and upstream call chains for the System
// Design Sandbox.
package main
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd images/microservice && go test ./...`
Expected: PASS — `ok  sds/microservice`.

- [ ] **Step 5: Commit**

```bash
git add images/microservice/go.mod images/microservice/doc.go images/microservice/smoke_test.go
git commit -m "chore: scaffold Go module for sds/microservice"
```

---

### Task 2: Config from env

**Files:**
- Create: `images/microservice/config.go`
- Test: `images/microservice/config_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Config struct { Port int; LatencyMS int; JitterMS int; ErrorRate float64; UpstreamHTTP string }`
  - `func FromEnv() (Config, error)`

- [ ] **Step 1: Write the failing test**

`images/microservice/config_test.go`:
```go
package main

import "testing"

func TestFromEnv_Defaults(t *testing.T) {
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 8080 {
		t.Errorf("Port = %d, want 8080", cfg.Port)
	}
	if cfg.LatencyMS != 0 || cfg.JitterMS != 0 || cfg.ErrorRate != 0 || cfg.UpstreamHTTP != "" {
		t.Errorf("non-zero defaults: %+v", cfg)
	}
}

func TestFromEnv_Valid(t *testing.T) {
	t.Setenv("PORT", "9000")
	t.Setenv("LATENCY_MS", "20")
	t.Setenv("LATENCY_JITTER_MS", "5")
	t.Setenv("ERROR_RATE", "0.1")
	t.Setenv("UPSTREAM_HTTP", "http://payment:8080/")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 9000 || cfg.LatencyMS != 20 || cfg.JitterMS != 5 ||
		cfg.ErrorRate != 0.1 || cfg.UpstreamHTTP != "http://payment:8080/" {
		t.Errorf("bad config: %+v", cfg)
	}
}

func TestFromEnv_InvalidErrorRate(t *testing.T) {
	t.Setenv("ERROR_RATE", "2.0")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error for ERROR_RATE=2.0")
	}
}

func TestFromEnv_InvalidPort(t *testing.T) {
	t.Setenv("PORT", "0")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error for PORT=0")
	}
}

func TestFromEnv_InvalidUpstream(t *testing.T) {
	t.Setenv("UPSTREAM_HTTP", "not-a-url")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error for malformed UPSTREAM_HTTP")
	}
}

func TestFromEnv_IgnoresUnknown(t *testing.T) {
	t.Setenv("DB_URL", "postgres://x:5432")
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("PUBLISH_TOPIC", "order-events")
	if _, err := FromEnv(); err != nil {
		t.Fatalf("unknown envs must be ignored: %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd images/microservice && go test ./...`
Expected: FAIL — `undefined: FromEnv`.

- [ ] **Step 3: Write minimal implementation**

`images/microservice/config.go`:
```go
package main

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
)

// Config is the fully-parsed, validated runtime configuration.
type Config struct {
	Port         int
	LatencyMS    int
	JitterMS     int
	ErrorRate    float64
	UpstreamHTTP string
}

// FromEnv parses configuration from environment variables, applying defaults
// and validating every value. Any invalid value returns an error so the caller
// can fail loud at boot.
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

	if v := os.Getenv("UPSTREAM_HTTP"); v != "" {
		u, err := url.ParseRequestURI(v)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return Config{}, fmt.Errorf("UPSTREAM_HTTP must be a valid URL, got %q", v)
		}
		cfg.UpstreamHTTP = v
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

Run: `cd images/microservice && go test ./...`
Expected: PASS — all `TestFromEnv_*` green.

- [ ] **Step 5: Commit**

```bash
git add images/microservice/config.go images/microservice/config_test.go
git commit -m "feat: add env config parsing for microservice"
```

---

### Task 3: Prometheus metrics

**Files:**
- Create: `images/microservice/metrics.go`
- Test: `images/microservice/metrics_test.go`
- Modify: `images/microservice/go.mod`, `images/microservice/go.sum` (via `go mod tidy`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type Metrics struct { reg *prometheus.Registry; Requests *prometheus.CounterVec; Duration prometheus.Histogram; InFlight prometheus.Gauge }`
  - `func NewMetrics() *Metrics`
  - `func (m *Metrics) Handler() http.Handler`

- [ ] **Step 1: Write the failing test**

`images/microservice/metrics_test.go`:
```go
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetrics_ExposesCounters(t *testing.T) {
	m := NewMetrics()
	m.Requests.WithLabelValues("200").Inc()
	m.Requests.WithLabelValues("200").Inc()
	m.Requests.WithLabelValues("500").Inc()

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, `http_requests_total{status="200"} 2`) {
		t.Errorf("missing 200 counter:\n%s", body)
	}
	if !strings.Contains(body, `http_requests_total{status="500"} 1`) {
		t.Errorf("missing 500 counter:\n%s", body)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd images/microservice && go test ./...`
Expected: FAIL — `undefined: NewMetrics` (and unresolved prometheus import).

- [ ] **Step 3: Write minimal implementation**

`images/microservice/metrics.go`:
```go
package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics holds the app's Prometheus collectors and a private registry so tests
// stay isolated from the global default registry.
type Metrics struct {
	reg      *prometheus.Registry
	Requests *prometheus.CounterVec
	Duration prometheus.Histogram
	InFlight prometheus.Gauge
}

// NewMetrics builds and registers all collectors, including Go/process baseline
// metrics.
func NewMetrics() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		reg: reg,
		Requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total HTTP requests by response status code.",
		}, []string{"status"}),
		Duration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "HTTP request handler duration in seconds.",
			Buckets: prometheus.DefBuckets,
		}),
		InFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "http_in_flight_requests",
			Help: "Number of in-flight HTTP requests.",
		}),
	}
	reg.MustRegister(m.Requests, m.Duration, m.InFlight)
	reg.MustRegister(collectors.NewGoCollector())
	reg.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return m
}

// Handler serves the Prometheus exposition format for this registry.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
}
```

Then fetch the dependency and write `go.sum`:

Run: `cd images/microservice && go mod tidy`
Expected: `go.mod` gains a `require github.com/prometheus/client_golang ...` line; `go.sum` is created.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd images/microservice && go test ./...`
Expected: PASS — `TestMetrics_ExposesCounters` green.

- [ ] **Step 5: Commit**

```bash
git add images/microservice/metrics.go images/microservice/metrics_test.go images/microservice/go.mod images/microservice/go.sum
git commit -m "feat: add prometheus metrics for microservice"
```

---

### Task 4: Server skeleton + `/health` route

**Files:**
- Create: `images/microservice/server.go`
- Test: `images/microservice/server_test.go`

**Interfaces:**
- Consumes: `Config` (Task 2), `*Metrics` + `Metrics.Handler()` (Task 3).
- Produces:
  - `type RandSource interface { Float64() float64; Intn(n int) int }`
  - `type Server struct { ... }`
  - `func NewServer(cfg Config, rnd RandSource, metrics *Metrics) *Server`
  - `func (s *Server) Routes() http.Handler`
  - `func (s *Server) handleHealth(http.ResponseWriter, *http.Request)`
  - helper `writeJSON(w http.ResponseWriter, status int, body any)`

- [ ] **Step 1: Write the failing test**

`images/microservice/server_test.go`:
```go
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// stubRand is a deterministic RandSource for tests.
type stubRand struct {
	float float64
	intn  int
}

func (s stubRand) Float64() float64 { return s.float }
func (s stubRand) Intn(n int) int   { return s.intn }

func newTestServer(cfg Config, rnd RandSource) *Server {
	return NewServer(cfg, rnd, NewMetrics())
}

func TestHealth(t *testing.T) {
	s := newTestServer(Config{}, stubRand{float: 1})
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("health = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ok") {
		t.Errorf("body = %q", rec.Body.String())
	}
}

func TestMetricsRouteServed(t *testing.T) {
	s := newTestServer(Config{}, stubRand{float: 1})
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics = %d, want 200", rec.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd images/microservice && go test ./...`
Expected: FAIL — `undefined: Server`, `undefined: NewServer`.

- [ ] **Step 3: Write minimal implementation**

`images/microservice/server.go`:
```go
package main

import (
	"encoding/json"
	"net/http"
	"time"
)

// RandSource is the minimal randomness surface the handler needs. Injected so
// tests can make latency and error rolls deterministic.
type RandSource interface {
	Float64() float64
	Intn(n int) int
}

// Server wires config, randomness, metrics, and an upstream HTTP client into the
// request handlers.
type Server struct {
	cfg     Config
	rand    RandSource
	metrics *Metrics
	client  *http.Client
}

// NewServer constructs a Server with a 2s upstream timeout.
func NewServer(cfg Config, rnd RandSource, metrics *Metrics) *Server {
	return &Server{
		cfg:     cfg,
		rand:    rnd,
		metrics: metrics,
		client:  &http.Client{Timeout: 2 * time.Second},
	}
}

// Routes returns the HTTP handler. Uses Go 1.22 method patterns.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.Handle("GET /metrics", s.metrics.Handler())
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd images/microservice && go test ./...`
Expected: PASS — `TestHealth`, `TestMetricsRouteServed` green.

- [ ] **Step 5: Commit**

```bash
git add images/microservice/server.go images/microservice/server_test.go
git commit -m "feat: add microservice server skeleton with health route"
```

---

### Task 5: `POST /` — latency + error injection + metrics

**Files:**
- Modify: `images/microservice/server.go`
- Modify: `images/microservice/server_test.go`

**Interfaces:**
- Consumes: `Server`, `RandSource`, `writeJSON` (Task 4); `Metrics.Requests/Duration/InFlight` (Task 3).
- Produces: `func (s *Server) handleRoot(http.ResponseWriter, *http.Request)`; `POST /` route wired in `Routes()`; helper `func (s *Server) respond(w http.ResponseWriter, status int, body any)`.

- [ ] **Step 1: Write the failing test**

Append to `images/microservice/server_test.go`:
```go
func post(s *Server) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"ping":true}`))
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	return rec
}

func TestRoot_Success(t *testing.T) {
	s := newTestServer(Config{}, stubRand{float: 1.0})
	if rec := post(s); rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
}

func TestRoot_InjectedError(t *testing.T) {
	// Float64()=0.0 < ErrorRate=1.0 → forced error.
	s := newTestServer(Config{ErrorRate: 1.0}, stubRand{float: 0.0})
	if rec := post(s); rec.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500", rec.Code)
	}
}

func TestRoot_NoErrorWhenRateZero(t *testing.T) {
	s := newTestServer(Config{ErrorRate: 0.0}, stubRand{float: 0.0})
	if rec := post(s); rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
}

func TestRoot_Latency(t *testing.T) {
	s := newTestServer(Config{LatencyMS: 50}, stubRand{float: 1.0})
	start := time.Now()
	post(s)
	if elapsed := time.Since(start); elapsed < 50*time.Millisecond {
		t.Errorf("elapsed %v, want >= 50ms", elapsed)
	}
}

func TestRoot_RecordsMetric(t *testing.T) {
	m := NewMetrics()
	s := NewServer(Config{}, stubRand{float: 1.0}, m)
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	s.Routes().ServeHTTP(httptest.NewRecorder(), req)

	mrec := httptest.NewRecorder()
	m.Handler().ServeHTTP(mrec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(mrec.Body.String(), `http_requests_total{status="200"} 1`) {
		t.Errorf("metric not recorded:\n%s", mrec.Body.String())
	}
}
```

Add the `"time"` import to the test file's import block (it already imports `net/http`, `net/http/httptest`, `strings`, `testing`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd images/microservice && go test ./...`
Expected: FAIL — `s.handleRoot undefined` / `POST /` returns 405, `TestRoot_Success` fails.

- [ ] **Step 3: Write minimal implementation**

In `images/microservice/server.go`, add `"io"` and `"strconv"` to the import block, wire the route, and add the handler + helper.

Update `Routes()` to add the root route (first line inside the mux):
```go
	mux.HandleFunc("POST /", s.handleRoot)
```

Add these methods:
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

	s.respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// respond records the status counter then writes the JSON body.
func (s *Server) respond(w http.ResponseWriter, status int, body any) {
	s.metrics.Requests.WithLabelValues(strconv.Itoa(status)).Inc()
	writeJSON(w, status, body)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd images/microservice && go test ./...`
Expected: PASS — all `TestRoot_*` green.

- [ ] **Step 5: Commit**

```bash
git add images/microservice/server.go images/microservice/server_test.go
git commit -m "feat: add request lifecycle with latency and error injection"
```

---

### Task 6: `POST /` — upstream cascade

**Files:**
- Modify: `images/microservice/server.go`
- Modify: `images/microservice/server_test.go`

**Interfaces:**
- Consumes: `Server.client`, `Server.cfg.UpstreamHTTP`, `handleRoot`, `respond` (Task 5).
- Produces: upstream call inside `handleRoot` — own failure → 500, upstream 5xx/timeout/conn-error → 502, upstream 2xx → continue to 200.

- [ ] **Step 1: Write the failing test**

Append to `images/microservice/server_test.go`:
```go
func TestRoot_UpstreamHappy(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	s := newTestServer(Config{UpstreamHTTP: upstream.URL}, stubRand{float: 1.0})
	if rec := post(s); rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
}

func TestRoot_UpstreamCascade(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()

	s := newTestServer(Config{UpstreamHTTP: upstream.URL}, stubRand{float: 1.0})
	if rec := post(s); rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d, want 502", rec.Code)
	}
}

func TestRoot_UpstreamDown(t *testing.T) {
	// 127.0.0.1:1 refuses immediately — well under the 2s timeout.
	s := newTestServer(Config{UpstreamHTTP: "http://127.0.0.1:1"}, stubRand{float: 1.0})
	if rec := post(s); rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d, want 502", rec.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd images/microservice && go test ./...`
Expected: FAIL — `TestRoot_UpstreamCascade` / `TestRoot_UpstreamDown` get 200, want 502.

- [ ] **Step 3: Write minimal implementation**

In `images/microservice/server.go`, replace the whole `handleRoot` method with the version below (adds the upstream block between the error roll and the 200 response):
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
		resp, err := s.client.Post(s.cfg.UpstreamHTTP, "application/json", nil)
		if err != nil || resp.StatusCode >= 500 {
			if resp != nil {
				resp.Body.Close()
			}
			s.respond(w, http.StatusBadGateway, map[string]string{"error": "upstream"})
			return
		}
		resp.Body.Close()
	}

	s.respond(w, http.StatusOK, map[string]bool{"ok": true})
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd images/microservice && go test ./...`
Expected: PASS — all upstream tests green, full suite green.

- [ ] **Step 5: Commit**

```bash
git add images/microservice/server.go images/microservice/server_test.go
git commit -m "feat: cascade upstream failures as 502"
```

---

### Task 7: `main.go` — wiring + graceful shutdown

**Files:**
- Create: `images/microservice/main.go`

**Interfaces:**
- Consumes: `FromEnv` (Task 2), `NewMetrics` (Task 3), `NewServer` + `Routes` (Task 4).
- Produces: `func main()` — boot, listen, graceful shutdown on SIGTERM/SIGINT. `*math/rand.Rand` satisfies `RandSource`.

- [ ] **Step 1: Write the failing test**

No unit test — `main` is integration glue. The gate is that the package builds and vets cleanly (it previously had no `func main`, so `go build`/`go vet` flagged the missing entry point).

Run: `cd images/microservice && go vet ./...`
Expected: FAIL — `function main is undeclared in the main package`.

- [ ] **Step 2: (covered by Step 1)**

The failing `go vet` above is the red state.

- [ ] **Step 3: Write minimal implementation**

`images/microservice/main.go`:
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
	srv := NewServer(cfg, rnd, metrics)

	httpSrv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      srv.Routes(),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go func() {
		log.Printf("microservice listening on :%d", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Print("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
```

- [ ] **Step 4: Verify build, vet, and full test suite pass**

Run: `cd images/microservice && go vet ./... && go build ./... && go test ./...`
Expected: PASS — vet clean, build produces a binary, all tests green.

- [ ] **Step 5: Commit**

```bash
git add images/microservice/main.go
git commit -m "feat: wire microservice entrypoint with graceful shutdown"
```

---

### Task 8: Dockerfile + build verification

**Files:**
- Create: `images/microservice/Dockerfile`
- Create: `images/microservice/.dockerignore`

**Interfaces:**
- Consumes: the full Go module (Tasks 1–7).
- Produces: a buildable `sds/microservice` image, static binary on `scratch`.

- [ ] **Step 1: Write the Dockerfile**

`images/microservice/Dockerfile`:
```dockerfile
# --- build stage ---
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /microservice .

# --- runtime stage ---
FROM scratch
COPY --from=build /microservice /microservice
EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["/microservice"]
```

`images/microservice/.dockerignore`:
```
*_test.go
doc.go
Dockerfile
.dockerignore
```

> Note: `.dockerignore` excludes `*_test.go` from the build context so test files
> don't bloat the image layer; tests run via `go test`, not in the image.

- [ ] **Step 2: Build the image (manual / CI — needs Docker)**

Run: `docker build -t sds/microservice ./images/microservice`
Expected: build succeeds; final image is `scratch`-based (~5MB).

- [ ] **Step 3: Smoke-run the container manually**

Run:
```bash
docker run --rm -d -p 8080:8080 -e LATENCY_MS=20 --name sds-ms sds/microservice
sleep 1
curl -s -X POST http://localhost:8080/         # expect {"ok":true}
curl -s http://localhost:8080/health            # expect {"status":"ok"}
curl -s http://localhost:8080/metrics | head    # expect http_requests_total ...
docker rm -f sds-ms
```
Expected: POST returns `{"ok":true}` after ~20ms, `/health` returns ok, `/metrics` lists counters.

- [ ] **Step 4: Verify image size**

Run: `docker images sds/microservice --format '{{.Size}}'`
Expected: roughly 5–8MB.

- [ ] **Step 5: Commit**

```bash
git add images/microservice/Dockerfile images/microservice/.dockerignore
git commit -m "feat: add Dockerfile for sds/microservice image"
```

---

## Self-Review

**Spec coverage** (design → task):
- HTTP-only scope, no Kafka → entire plan; no Kafka client anywhere.
- Config/env API + fail-loud validation (§Configuration) → Task 2.
- Endpoints `POST /`, `GET /health`, `GET /metrics` (§Endpoints) → Tasks 4 (health, metrics route), 5 (root).
- Request lifecycle: latency+jitter, error roll, body discard (§Request lifecycle) → Task 5.
- Cascade: own→500, upstream→502, 2s timeout (§Request lifecycle) → Task 6 + `NewServer` client timeout in Task 4.
- Metrics: `http_requests_total{status}`, duration histogram, in-flight gauge via client_golang (§Metrics) → Task 3, recorded in Tasks 5/6.
- Injectable rand for determinism (§Testing) → `RandSource` Task 4, `stubRand` Tasks 4–6.
- Graceful shutdown on SIGTERM (§Error handling) → Task 7.
- Layout `images/microservice/*` (§Layout) → Tasks 1–8 file paths.
- Dockerfile multi-stage scratch ~5MB (§Layout) → Task 8.
- Unknown envs ignored (§Configuration) → Task 2 `TestFromEnv_IgnoresUnknown`.
- Test list (§Testing) → Tasks 2, 3, 5, 6 cover latency, jitter-by-construction, error roll, cascade ×2, upstream happy, metrics, in-flight (gauge exercised via handler; counter asserted in `TestRoot_RecordsMetric`).

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `Config` fields (`Port`, `LatencyMS`, `JitterMS`, `ErrorRate`, `UpstreamHTTP`) identical across Tasks 2/4/5/6/7. `RandSource{Float64, Intn}` defined Task 4, satisfied by `stubRand` (tests) and `*rand.Rand` (Task 7). `NewServer(cfg, rnd, metrics)`, `Routes()`, `handleRoot`, `respond`, `writeJSON`, `NewMetrics()`, `Metrics.Handler()`, `FromEnv()` signatures consistent everywhere referenced.

**Not in this plan (intentional):** Kafka publish + `sds/worker` (future v2), Docker Controller, k6 runner — separate plans per the design's follow-ups.
