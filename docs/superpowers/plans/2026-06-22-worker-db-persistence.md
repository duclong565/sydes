# Worker → Postgres Persistence (Saga 2b-ii) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sds/worker` persist consumed Kafka messages to Postgres so the full `service → kafka → worker → db` Saga runs end-to-end with real `pgx`.

**Architecture:** The compiler becomes the single source of the DB connection string (`db.ts` exports a `dbUrl` helper; `service.ts`/`worker.ts` emit a complete `DB_URL`) and gives Postgres a `pg_isready` healthcheck. The worker gains a `Sink` seam (mirroring its existing `Consumer` seam) with a real `PgxSink` that connects-with-retry and creates an idempotent `events` table; the worker persists only successfully-processed messages and counts write failures via a new metric without retrying or crashing.

**Tech Stack:** TypeScript compiler (vitest), Go worker (`github.com/jackc/pgx/v5`, prometheus client), Docker Compose, vitest gated Docker smoke.

## Global Constraints

- Go modules target `go 1.23`; images build on `scratch` with `CGO_ENABLED=0` — only pure-Go deps allowed (`pgx/v5` qualifies).
- Go is NOT on PATH: prefix every Go command with `export PATH="$PATH:/usr/local/go/bin"` (shell state does not persist across calls).
- Postgres is `postgres:alpine` with `POSTGRES_PASSWORD=sds` → default user `postgres`, default db `postgres`.
- The DSN MUST include `?sslmode=disable` (scratch has no CA certs; Postgres is non-TLS).
- Persist only on the ok path; on INSERT error count a metric and continue (no retry, no crash).
- NEVER add a `Co-Authored-By` trailer to commits.
- Gated Docker smokes use `describe.skipIf(!process.env.RUN_DOCKER)`; the default `npm test` skips them.
- Run a single vitest file with `npx vitest run <path>`. Run worker Go tests with `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`.

---

### Task 1: Compiler emits the full DSN + Postgres healthcheck

**Files:**
- Modify: `src/compiler/handlers/db.ts`
- Modify: `src/compiler/handlers/service.ts` (line 18)
- Modify: `src/compiler/handlers/worker.ts` (line 23)
- Test: `src/compiler/handlers/db.test.ts`, `src/compiler/handlers/service.test.ts`, `src/compiler/handlers/worker.test.ts`

**Interfaces:**
- Produces: `dbUrl(slug: string): string` exported from `src/compiler/handlers/db.ts`, returning `postgres://postgres:sds@<slug>:5432/postgres?sslmode=disable`. Also exports `DB_USER`, `DB_PASSWORD`, `DB_NAME`. The `db` handler now emits a `healthcheck` running `pg_isready -U postgres`.

- [ ] **Step 1: Update the failing tests**

In `src/compiler/handlers/db.test.ts`, add a `dbUrl` import and a new describe block, and extend the compile test to assert the healthcheck. Replace the existing file contents with:

```ts
import { describe, it, expect } from 'vitest';
import { dbHandler, dbUrl } from './db.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

describe('dbHandler.validate', () => {
  it('errors when db has no consumer', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'd', type: 'db', label: 'DB' }], edges: [] };
    const errors = dbHandler.validate(g.nodes[0]!, buildIndex(g));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/consumer/i);
  });
  it('passes when db has a consumer', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 's', type: 'service', label: 'S' }, { id: 'd', type: 'db', label: 'DB' }],
      edges: [{ source: 's', target: 'd' }],
    };
    expect(dbHandler.validate(g.nodes[1]!, buildIndex(g))).toEqual([]);
  });
});

describe('dbHandler.compile', () => {
  it('emits postgres service with port and pg_isready healthcheck', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'd', type: 'db', label: 'Orders DB' }], edges: [] };
    const svc = dbHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.name).toBe('orders-db');
    expect(svc.image).toBe('postgres:alpine');
    expect(svc.ports).toEqual(['5432:5432']);
    expect(svc.environment.POSTGRES_PASSWORD).toBe('sds');
    expect(svc.healthcheck?.test).toEqual(['CMD-SHELL', 'pg_isready -U postgres']);
  });
});

describe('dbUrl', () => {
  it('builds a full postgres DSN with creds, db, and sslmode', () => {
    expect(dbUrl('orders-db')).toBe('postgres://postgres:sds@orders-db:5432/postgres?sslmode=disable');
  });
});
```

In `src/compiler/handlers/service.test.ts`, change the expectation on line 43 from:

```ts
    expect(svc.environment.DB_URL).toBe('postgres://orders-db:5432');
```

to:

```ts
    expect(svc.environment.DB_URL).toBe('postgres://postgres:sds@orders-db:5432/postgres?sslmode=disable');
```

In `src/compiler/handlers/worker.test.ts`, change the expectation on line 42 from:

```ts
    expect(svc.environment.DB_URL).toBe('postgres://pay-db:5432');
```

to:

```ts
    expect(svc.environment.DB_URL).toBe('postgres://postgres:sds@pay-db:5432/postgres?sslmode=disable');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/compiler/handlers/db.test.ts src/compiler/handlers/service.test.ts src/compiler/handlers/worker.test.ts`
Expected: FAIL — `dbUrl` is not exported; DB_URL expectations mismatch; healthcheck undefined.

- [ ] **Step 3: Implement `db.ts`**

Replace the entire contents of `src/compiler/handlers/db.ts` with:

```ts
import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';

export const DB_USER = 'postgres';
export const DB_PASSWORD = 'sds';
export const DB_NAME = 'postgres';

/** Full Postgres DSN a client can connect with. Single source of the DB connection facts. */
export const dbUrl = (slug: string): string =>
  `postgres://${DB_USER}:${DB_PASSWORD}@${slug}:5432/${DB_NAME}?sslmode=disable`;

export const dbHandler: NodeHandler = {
  validate(node, index) {
    return index.inEdges(node.id).length > 0
      ? []
      : [{ nodeId: node.id, message: 'Database must have at least one consumer' }];
  },
  compile(node) {
    return {
      name: slugify(node.label),
      image: 'postgres:alpine',
      environment: { POSTGRES_PASSWORD: DB_PASSWORD },
      ports: ['5432:5432'],
      healthcheck: {
        test: ['CMD-SHELL', 'pg_isready -U postgres'],
        interval: '5s',
        timeout: '5s',
        retries: 10,
      },
    };
  },
};
```

- [ ] **Step 4: Implement `service.ts` and `worker.ts`**

In `src/compiler/handlers/service.ts`, add the import at the top (after the existing imports):

```ts
import { dbUrl } from './db.js';
```

and change line 18 from:

```ts
      if (target.type === 'db') env.DB_URL = `postgres://${slugify(target.label)}:5432`;
```

to:

```ts
      if (target.type === 'db') env.DB_URL = dbUrl(slugify(target.label));
```

In `src/compiler/handlers/worker.ts`, add the import at the top (after the existing imports):

```ts
import { dbUrl } from './db.js';
```

and change line 23 from:

```ts
      if (target.type === 'db') env.DB_URL = `postgres://${slugify(target.label)}:5432`;
```

to:

```ts
      if (target.type === 'db') env.DB_URL = dbUrl(slugify(target.label));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/compiler/handlers/db.test.ts src/compiler/handlers/service.test.ts src/compiler/handlers/worker.test.ts`
Expected: PASS (all three files green).

- [ ] **Step 6: Run the full TS suite to confirm no regressions**

Run: `npm test`
Expected: PASS (gated Docker smokes skipped).

- [ ] **Step 7: Commit**

```bash
git add src/compiler/handlers/db.ts src/compiler/handlers/service.ts src/compiler/handlers/worker.ts src/compiler/handlers/db.test.ts src/compiler/handlers/service.test.ts src/compiler/handlers/worker.test.ts
git commit -m "feat: compiler emits full postgres DSN and db healthcheck"
```

---

### Task 2: Worker parses `DB_URL` + adds the `db_writes_total` metric

**Files:**
- Modify: `images/worker/config.go`
- Modify: `images/worker/config_test.go`
- Modify: `images/worker/metrics.go`
- Modify: `images/worker/metrics_test.go`

**Interfaces:**
- Produces: `Config.DBURL string` (empty when `DB_URL` unset). `Metrics.DBWrites *prometheus.CounterVec` labelled `status`, exposed as `db_writes_total`.

- [ ] **Step 1: Update the failing config test**

In `images/worker/config_test.go`, replace the `TestFromEnv_IgnoresDBURL` test (lines 50-57) with:

```go
func TestFromEnv_ParsesDBURL(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("SUBSCRIBE_TOPICS", "x")
	t.Setenv("DB_URL", "postgres://postgres:sds@orders-db:5432/postgres?sslmode=disable")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DBURL != "postgres://postgres:sds@orders-db:5432/postgres?sslmode=disable" {
		t.Errorf("DBURL = %q", cfg.DBURL)
	}
}

func TestFromEnv_EmptyDBURL(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("SUBSCRIBE_TOPICS", "x")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DBURL != "" {
		t.Errorf("expected empty DBURL, got %q", cfg.DBURL)
	}
}
```

- [ ] **Step 2: Add the failing metrics test**

In `images/worker/metrics_test.go`, append:

```go
func TestMetrics_ExposesDBWrites(t *testing.T) {
	m := NewMetrics()
	m.DBWrites.WithLabelValues("ok").Inc()
	m.DBWrites.WithLabelValues("error").Inc()
	m.DBWrites.WithLabelValues("error").Inc()

	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := rec.Body.String()
	if !strings.Contains(body, `db_writes_total{status="ok"} 1`) {
		t.Errorf("missing db_writes ok:\n%s", body)
	}
	if !strings.Contains(body, `db_writes_total{status="error"} 2`) {
		t.Errorf("missing db_writes error:\n%s", body)
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: FAIL — `cfg.DBURL` undefined and `m.DBWrites` undefined (build error).

- [ ] **Step 4: Implement `config.go`**

In `images/worker/config.go`, add the field to the `Config` struct (after `SubscribeTopics []string`):

```go
	DBURL           string
```

and parse it in `FromEnv` (add after the `cfg.KafkaBroker = os.Getenv("KAFKA_BROKER")` line, line 52):

```go
	cfg.DBURL = os.Getenv("DB_URL")
```

- [ ] **Step 5: Implement `metrics.go`**

In `images/worker/metrics.go`, add the field to the `Metrics` struct (after `InFlight prometheus.Gauge`):

```go
	DBWrites *prometheus.CounterVec
```

In `NewMetrics`, add the collector inside the `&Metrics{...}` literal (after the `InFlight` gauge):

```go
		DBWrites: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "db_writes_total",
			Help: "Total Postgres write attempts by status.",
		}, []string{"status"}),
```

and add it to the `MustRegister` call — change:

```go
	reg.MustRegister(m.Consumed, m.Duration, m.InFlight)
```

to:

```go
	reg.MustRegister(m.Consumed, m.Duration, m.InFlight, m.DBWrites)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add images/worker/config.go images/worker/config_test.go images/worker/metrics.go images/worker/metrics_test.go
git commit -m "feat: worker parses DB_URL and adds db_writes_total metric"
```

---

### Task 3: `Sink` seam + `PgxSink` + wire persistence into the worker

**Files:**
- Create: `images/worker/sink.go`
- Modify: `images/worker/worker.go`
- Modify: `images/worker/worker_test.go`
- Modify: `images/worker/main.go`
- Modify: `images/worker/go.mod`, `images/worker/go.sum` (via `go get`/`go mod tidy`)

**Interfaces:**
- Consumes: `Config.DBURL` and `Metrics.DBWrites` (Task 2).
- Produces: `Sink` interface `{ Write(ctx context.Context, payload []byte) error; Close() error }`; `NewPgxSink(ctx context.Context, dsn string) (*PgxSink, error)`. `NewWorker` signature becomes `NewWorker(cfg Config, rnd RandSource, metrics *Metrics, consumer Consumer, sink Sink) *Worker` (sink may be nil).

- [ ] **Step 1: Add the failing worker persistence tests**

In `images/worker/worker_test.go`: first, add a fake sink type after the `fakeConsumer` definition (after line 35):

```go
// fakeSink records writes; if err is set, Write returns it instead of recording.
type fakeSink struct {
	writes [][]byte
	err    error
}

func (f *fakeSink) Write(_ context.Context, p []byte) error {
	if f.err != nil {
		return f.err
	}
	f.writes = append(f.writes, p)
	return nil
}
func (f *fakeSink) Close() error { return nil }
```

Then update the two existing `NewWorker(...)` calls to pass a nil sink:
- Line 47: change `NewWorker(Config{}, stubRand{float: 1.0}, m, fc).Run(ctx)` to `NewWorker(Config{}, stubRand{float: 1.0}, m, fc, nil).Run(ctx)`
- Line 57: change `NewWorker(Config{ErrorRate: 1.0}, stubRand{float: 0.0}, m, fc).Run(ctx)` to `NewWorker(Config{ErrorRate: 1.0}, stubRand{float: 0.0}, m, fc, nil).Run(ctx)`

Then append the new tests:

```go
func TestWorker_WritesOnOkPath(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b"), []byte("c")}, cancel: cancel}
	sink := &fakeSink{}
	NewWorker(Config{}, stubRand{float: 1.0}, m, fc, sink).Run(ctx)
	if len(sink.writes) != 3 {
		t.Errorf("expected 3 writes, got %d", len(sink.writes))
	}
	if !strings.Contains(scrape(m), `db_writes_total{status="ok"} 3`) {
		t.Errorf("expected 3 ok writes:\n%s", scrape(m))
	}
}

func TestWorker_SkipsWriteOnSimulatedError(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b")}, cancel: cancel}
	sink := &fakeSink{}
	NewWorker(Config{ErrorRate: 1.0}, stubRand{float: 0.0}, m, fc, sink).Run(ctx)
	if len(sink.writes) != 0 {
		t.Errorf("expected no writes on error path, got %d", len(sink.writes))
	}
	if strings.Contains(scrape(m), `db_writes_total`) {
		t.Errorf("expected no db_writes series:\n%s", scrape(m))
	}
}

func TestWorker_CountsWriteErrorsAndContinues(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b")}, cancel: cancel}
	sink := &fakeSink{err: errors.New("boom")}
	NewWorker(Config{}, stubRand{float: 1.0}, m, fc, sink).Run(ctx)
	body := scrape(m)
	if !strings.Contains(body, `db_writes_total{status="error"} 2`) {
		t.Errorf("expected 2 error writes:\n%s", body)
	}
	if !strings.Contains(body, `messages_consumed_total{status="ok"} 2`) {
		t.Errorf("worker should keep consuming after write errors:\n%s", body)
	}
}

func TestWorker_NilSinkIsNoOp(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b")}, cancel: cancel}
	NewWorker(Config{}, stubRand{float: 1.0}, m, fc, nil).Run(ctx)
	body := scrape(m)
	if strings.Contains(body, `db_writes_total`) {
		t.Errorf("nil sink should write nothing:\n%s", body)
	}
	if !strings.Contains(body, `messages_consumed_total{status="ok"} 2`) {
		t.Errorf("expected 2 ok consumed:\n%s", body)
	}
}
```

Add `"errors"` to the import block at the top of `worker_test.go` (it currently imports `context`, `net/http`, `net/http/httptest`, `strings`, `testing`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: FAIL — `NewWorker` takes 4 args not 5; `Sink` undefined (build error).

- [ ] **Step 3: Implement `worker.go`**

Replace the entire contents of `images/worker/worker.go` with:

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
	sink     Sink // nil when no DB_URL configured
}

func NewWorker(cfg Config, rnd RandSource, metrics *Metrics, consumer Consumer, sink Sink) *Worker {
	return &Worker{cfg: cfg, rand: rnd, metrics: metrics, consumer: consumer, sink: sink}
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
		w.process(ctx, val)
		count++
		log.Printf("consumed %d", count)
	}
}

func (w *Worker) process(ctx context.Context, val []byte) {
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

	if w.sink != nil {
		if err := w.sink.Write(ctx, val); err != nil {
			w.metrics.DBWrites.WithLabelValues("error").Inc()
			log.Printf("db write failed: %v", err)
		} else {
			w.metrics.DBWrites.WithLabelValues("ok").Inc()
		}
	}

	w.metrics.Consumed.WithLabelValues("ok").Inc()
}
```

- [ ] **Step 4: Add the pgx dependency**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go get github.com/jackc/pgx/v5 && go mod tidy`
Expected: `go.mod` now requires `github.com/jackc/pgx/v5`; `go.sum` updated.

- [ ] **Step 5: Implement `sink.go`**

Create `images/worker/sink.go`:

```go
package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Sink persists a processed message payload. Injected so tests can use a fake.
type Sink interface {
	Write(ctx context.Context, payload []byte) error
	Close() error
}

const createEventsTable = `CREATE TABLE IF NOT EXISTS events (` +
	`id bigserial primary key, payload text, ts timestamptz default now())`

// PgxSink writes payloads to Postgres via a pgx connection pool.
type PgxSink struct {
	pool *pgxpool.Pool
}

// NewPgxSink connects to Postgres (retrying until ready or ~30s), then ensures the events table exists.
func NewPgxSink(ctx context.Context, dsn string) (*PgxSink, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("pgxpool config: %w", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		if err = pool.Ping(ctx); err == nil {
			break
		}
		if time.Now().After(deadline) {
			pool.Close()
			return nil, fmt.Errorf("postgres not ready after 30s: %w", err)
		}
		time.Sleep(time.Second)
	}
	if _, err = pool.Exec(ctx, createEventsTable); err != nil {
		pool.Close()
		return nil, fmt.Errorf("create events table: %w", err)
	}
	return &PgxSink{pool: pool}, nil
}

func (s *PgxSink) Write(ctx context.Context, payload []byte) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO events(payload) VALUES($1)`, string(payload))
	return err
}

func (s *PgxSink) Close() error {
	s.pool.Close()
	return nil
}
```

- [ ] **Step 6: Run worker tests to verify they pass**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: PASS (PgxSink itself is exercised by the gated smoke in Task 4, not unit tests).

- [ ] **Step 7: Wire the sink into `main.go`**

Replace the entire contents of `images/worker/main.go` with:

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

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	var sink Sink
	if cfg.DBURL != "" {
		pgSink, err := NewPgxSink(ctx, cfg.DBURL)
		if err != nil {
			log.Fatalf("db sink: %v", err)
		}
		defer pgSink.Close()
		sink = pgSink
		log.Printf("worker persisting to postgres")
	}

	worker := NewWorker(cfg, rnd, metrics, consumer, sink)

	httpSrv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      NewServer(metrics).Routes(),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

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

- [ ] **Step 8: Verify the worker builds and vets cleanly**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go vet ./... && go build ./... && go test ./...`
Expected: no vet errors, build succeeds, tests PASS.

- [ ] **Step 9: Commit**

```bash
git add images/worker/sink.go images/worker/worker.go images/worker/worker_test.go images/worker/main.go images/worker/go.mod images/worker/go.sum
git commit -m "feat: worker persists consumed messages to postgres via pgx sink"
```

---

### Task 4: Saga-with-DB example + gated end-to-end smoke

**Files:**
- Create: `examples/saga-db.json`
- Create: `src/engine/saga-db.smoke.test.ts`

**Interfaces:**
- Consumes: `compile` (compiler), `ExperimentController`, `RealRunner`, `K6Runner` (engine); the `events` table written by `PgxSink` (Task 3); the `orders-db` service name from the db node label `Orders DB`.

- [ ] **Step 1: Create the example graph**

Create `examples/saga-db.json`:

```json
{
  "experimentId": "saga-db",
  "nodes": [
    { "id": "o", "type": "service", "label": "Order Service" },
    { "id": "k", "type": "kafka", "label": "Order Events" },
    { "id": "p", "type": "worker", "label": "Payment Worker" },
    { "id": "d", "type": "db", "label": "Orders DB" }
  ],
  "edges": [
    { "source": "o", "target": "k" },
    { "source": "p", "target": "k" },
    { "source": "p", "target": "d" }
  ]
}
```

- [ ] **Step 2: Verify the example compiles (non-gated sanity)**

Run: `node --input-type=module -e "import('./src/compiler/index.js').catch(()=>{}); console.log('compiler present')"` is NOT required. Instead confirm the example is valid JSON:

Run: `node -e "JSON.parse(require('fs').readFileSync('examples/saga-db.json','utf8')); console.log('valid json')"`
Expected: prints `valid json`.

- [ ] **Step 3: Write the gated smoke test**

Create `src/engine/saga-db.smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';
import { K6Runner } from './k6-runner.js';

// Gated: needs RUN_DOCKER=1, the sds/microservice + sds/worker images built; pulls apache/kafka + postgres.
describe.skipIf(!process.env.RUN_DOCKER)('saga-db smoke (real docker)', () => {
  it('service -> kafka -> worker -> postgres rows land', async () => {
    const graph = JSON.parse(readFileSync('examples/saga-db.json', 'utf8')) as Graph;
    const result = compile(graph, { rate: 20, durationSec: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runRoot = mkdtempSync(join(tmpdir(), 'sds-sagadb-'));
    const runner = new RealRunner();
    const c = new ExperimentController(runner, { runRoot });
    const runDir = c.writeArtifacts(graph.experimentId, result.output);
    const id = graph.experimentId;
    const compose = ['docker', 'compose', '-p', `sds-${id}`, '-f', join(runDir, 'compose.yml')];
    try {
      await c.preflight(result.output);
      await c.up(id); // blocks until kafka healthy (worker group registered) + postgres healthy
      await new K6Runner(runner).run(id, runDir); // fire load at the service -> publishes -> worker consumes -> writes

      // Poll Postgres until the worker's writes land (or time out).
      let count = 0;
      for (let i = 0; i < 15; i++) {
        const r = await runner.run([
          ...compose, 'exec', '-T', 'orders-db',
          'psql', '-U', 'postgres', '-tAc', 'SELECT count(*) FROM events',
        ]);
        count = parseInt(r.stdout.trim(), 10) || 0;
        if (count > 0) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      expect(count).toBeGreaterThan(0);
    } finally {
      await c.down(id);
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
```

- [ ] **Step 4: Confirm the smoke is skipped by default**

Run: `npm test`
Expected: PASS; the `saga-db smoke (real docker)` suite is skipped (no `RUN_DOCKER`).

- [ ] **Step 5: Build the images and run the smoke for real**

```bash
docker build -t sds/microservice ./images/microservice
docker build -t sds/worker ./images/worker
RUN_DOCKER=1 npx vitest run src/engine/saga-db.smoke.test.ts
```
Expected: PASS — `count` > 0 (rows persisted to the `events` table). Quote the output when reporting done.

- [ ] **Step 6: Commit**

```bash
git add examples/saga-db.json src/engine/saga-db.smoke.test.ts
git commit -m "test: add saga-db example and gated worker->postgres smoke"
```

---

## Self-Review

**Spec coverage:**
- Dependency `pgx/v5` + `?sslmode=disable` → Task 3 Step 4/5, Global Constraints. ✅
- Compiler single-source `dbUrl` + healthcheck + service/worker full DSN → Task 1. ✅
- Worker `config.go` parses `DB_URL` → Task 2. ✅
- `Sink` seam + `PgxSink` (retry-connect, idempotent schema) + fake → Task 3. ✅
- Wire into `Worker.process` (+ctx), persist only on ok, write-fail metric+continue, nil-sink no-op → Task 3 Steps 1/3. ✅
- `DBWrites` metric registered → Task 2. ✅
- Main wiring builds sink when `DBURL != ""`, defer Close → Task 3 Step 7. ✅
- Example `saga-db.json` + gated smoke asserting rows → Task 4. ✅
- Out-of-scope items (Run backoff, log.Fatalf-in-goroutine, grep anchor, smoke fixed-sleep) — intentionally NOT touched. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✅

**Type consistency:** `dbUrl(slug)` used identically in db.test.ts/service.ts/worker.ts. `NewWorker(cfg, rnd, metrics, consumer, sink)` — 5 args consistent across main.go and all worker_test.go calls. `Sink.Write(ctx, payload)`/`Close()` consistent between interface, `PgxSink`, and `fakeSink`. `Metrics.DBWrites` / `db_writes_total{status}` consistent across metrics.go, metrics_test.go, worker_test.go. ✅
