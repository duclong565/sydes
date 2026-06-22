# Engine Robustness Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the deferred §8 robustness follow-ups and the carried Saga 2b-ii Minors in one focused PR, with no change to the happy path.

**Architecture:** Five independent mechanical fixes: route a fatal HTTP-server error through graceful shutdown in both Go mains; bound the worker read-error loop with a backoff; make `PgxSink` honor context cancel and write `[]byte` directly; anchor the kafka consumer-group healthcheck grep; and replace fixed-sleep with polling (plus diagnostics) in the two gated smokes.

**Tech Stack:** Go worker + microservice images (scratch, pure-Go), TypeScript compiler (vitest), gated vitest Docker smokes.

## Global Constraints

- Go is NOT on PATH: prefix every Go command with `export PATH="$PATH:/usr/local/go/bin"` and `cd` into the image dir in the SAME command (shell state does not persist across calls).
- Images build on `scratch` with `CGO_ENABLED=0` — pure-Go only. This brick adds NO new dependencies.
- Run a single vitest file with `npx vitest run <path>` (from repo root). Whole TS suite: `npm test` (gated smokes auto-skip).
- Gated smokes use `describe.skipIf(!process.env.RUN_DOCKER)` and must not run under plain `npm test`.
- No behavior change to the happy path; these are robustness/diagnostic fixes only.
- NEVER add a `Co-Authored-By` trailer to commits.

---

### Task 1: Route HTTP-server error through graceful shutdown (both Go mains)

**Files:**
- Modify: `images/worker/main.go` (the http goroutine, ~lines 54-59)
- Modify: `images/microservice/main.go` (the http goroutine, ~lines 42-47)

**Interfaces:**
- Produces: no API change. Both mains stop calling `log.Fatalf` from inside the `ListenAndServe` goroutine; on a non-`ErrServerClosed` error they log and call `stop()` (the `signal.NotifyContext` cancel already in scope), which cancels `ctx` and lets the existing shutdown block run (defers + `httpSrv.Shutdown`).

> No new unit test: this is `main()` wiring and the bind-error path is not unit-testable without integration. Verification is `go vet` + `go build` + the existing test suite for both images.

- [ ] **Step 1: Edit `images/worker/main.go`**

Replace this block:

```go
	go func() {
		log.Printf("worker http on :%d", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http error: %v", err)
		}
	}()
```

with:

```go
	go func() {
		log.Printf("worker http on :%d", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http server error: %v", err)
			stop() // cancel ctx -> graceful shutdown path runs
		}
	}()
```

- [ ] **Step 2: Edit `images/microservice/main.go`**

Replace this block:

```go
	go func() {
		log.Printf("microservice listening on :%d", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()
```

with:

```go
	go func() {
		log.Printf("microservice listening on :%d", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http server error: %v", err)
			stop() // cancel ctx -> graceful shutdown path runs
		}
	}()
```

- [ ] **Step 3: Vet, build, and test both images**

Run:
```bash
export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go vet ./... && go build ./... && go test ./...
```
Expected: PASS, no vet errors.

Run:
```bash
export PATH="$PATH:/usr/local/go/bin" && cd images/microservice && go vet ./... && go build ./... && go test ./...
```
Expected: PASS, no vet errors.

- [ ] **Step 4: Commit**

```bash
git add images/worker/main.go images/microservice/main.go
git commit -m "fix: route http server error through graceful shutdown in both images"
```

---

### Task 2: Backoff on the worker read-error loop

**Files:**
- Modify: `images/worker/worker.go`
- Test: `images/worker/worker_test.go`

**Interfaces:**
- Produces: `Worker` gains an unexported field `readBackoff time.Duration`, defaulted by `NewWorker` to `200 * time.Millisecond`. `NewWorker`'s signature is unchanged. On a non-ctx read error, `Run` sleeps `w.readBackoff` before `continue`. In-package tests may set `w.readBackoff = 0` to avoid real delay.

- [ ] **Step 1: Write the failing test**

Append to `images/worker/worker_test.go`:

```go
// flakyConsumer returns one transient (non-ctx) error, then its queued values, then cancels.
type flakyConsumer struct {
	erroredOnce bool
	values      [][]byte
	i           int
	cancel      context.CancelFunc
}

func (f *flakyConsumer) Read(_ context.Context) ([]byte, error) {
	if !f.erroredOnce {
		f.erroredOnce = true
		return nil, errors.New("transient read error")
	}
	if f.i >= len(f.values) {
		f.cancel()
		return nil, context.Canceled
	}
	v := f.values[f.i]
	f.i++
	return v, nil
}
func (f *flakyConsumer) Close() error { return nil }

func TestWorker_SurvivesTransientReadError(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &flakyConsumer{values: [][]byte{[]byte("a")}, cancel: cancel}
	w := NewWorker(Config{}, stubRand{float: 1.0}, m, fc, nil)
	w.readBackoff = 0 // no real delay in the test
	w.Run(ctx)
	if !strings.Contains(scrape(m), `messages_consumed_total{status="ok"} 1`) {
		t.Errorf("loop should survive a transient read error and process the next message:\n%s", scrape(m))
	}
}
```

(The test does not assert the sleep duration — wall-clock sleep assertions are flaky; it asserts the loop survives the transient error and keeps consuming, and it references `w.readBackoff`, which does not yet exist.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./... -run TestWorker_SurvivesTransientReadError`
Expected: FAIL — build error, `w.readBackoff` undefined.

- [ ] **Step 3: Add the field and default in `worker.go`**

Add the field to the `Worker` struct (after `sink     Sink // nil when no DB_URL configured`):

```go
	readBackoff time.Duration // delay after a transient read error
```

Set the default in `NewWorker` — change:

```go
func NewWorker(cfg Config, rnd RandSource, metrics *Metrics, consumer Consumer, sink Sink) *Worker {
	return &Worker{cfg: cfg, rand: rnd, metrics: metrics, consumer: consumer, sink: sink}
}
```

to:

```go
func NewWorker(cfg Config, rnd RandSource, metrics *Metrics, consumer Consumer, sink Sink) *Worker {
	return &Worker{cfg: cfg, rand: rnd, metrics: metrics, consumer: consumer, sink: sink, readBackoff: 200 * time.Millisecond}
}
```

- [ ] **Step 4: Add the backoff in `Run`**

In `Run`, change the transient-error branch — replace:

```go
		val, err := w.consumer.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return // shutdown
			}
			continue // transient read error: skip and retry
		}
```

with:

```go
		val, err := w.consumer.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return // shutdown
			}
			time.Sleep(w.readBackoff) // bound the retry rate on transient read errors
			continue
		}
```

(`time` is already imported in `worker.go`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go test ./...`
Expected: PASS (all worker tests, including the new one).

- [ ] **Step 6: Commit**

```bash
git add images/worker/worker.go images/worker/worker_test.go
git commit -m "fix: add backoff to worker read-error loop"
```

---

### Task 3: PgxSink honors context cancel + writes []byte directly

**Files:**
- Modify: `images/worker/sink.go`

**Interfaces:**
- Produces: no API change. `NewPgxSink`'s retry loop returns promptly with `ctx.Err()` when the context is cancelled mid-retry. `PgxSink.Write` passes the `[]byte` payload to pgx directly.

> No new unit test: the connect-retry path needs a real Postgres (covered by the gated `saga-db` smoke), and the `[]byte` write is a behavior-preserving change also covered by that smoke. Verification is `go vet` + `go build` + the existing worker tests.

- [ ] **Step 1: Add the ctx-cancel check in the retry loop**

In `images/worker/sink.go`, change the retry loop — replace:

```go
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
```

with:

```go
	deadline := time.Now().Add(30 * time.Second)
	for {
		if err = pool.Ping(ctx); err == nil {
			break
		}
		if ctx.Err() != nil {
			pool.Close()
			return nil, ctx.Err()
		}
		if time.Now().After(deadline) {
			pool.Close()
			return nil, fmt.Errorf("postgres not ready after 30s: %w", err)
		}
		time.Sleep(time.Second)
	}
```

- [ ] **Step 2: Drop the string() conversion in Write**

Replace:

```go
func (s *PgxSink) Write(ctx context.Context, payload []byte) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO events(payload) VALUES($1)`, string(payload))
	return err
}
```

with:

```go
func (s *PgxSink) Write(ctx context.Context, payload []byte) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO events(payload) VALUES($1)`, payload)
	return err
}
```

- [ ] **Step 3: Vet, build, and test the worker image**

Run: `export PATH="$PATH:/usr/local/go/bin" && cd images/worker && go vet ./... && go build ./... && go test ./...`
Expected: PASS, no vet errors.

- [ ] **Step 4: Commit**

```bash
git add images/worker/sink.go
git commit -m "fix: PgxSink honors context cancel and writes []byte directly"
```

---

### Task 4: Anchor the kafka consumer-group healthcheck grep

**Files:**
- Modify: `src/compiler/handlers/kafka.ts` (line 35)
- Test: `src/compiler/handlers/kafka.test.ts`

**Interfaces:**
- Produces: the kafka handler's healthcheck matches each subscriber consumer-group id with `grep -qx '<g>'` (whole-line match) instead of `grep -q '<g>'`.

- [ ] **Step 1: Add the failing assertion**

In `src/compiler/handlers/kafka.test.ts`, in the test `healthcheck CMD-SHELL creates the topic and checks the worker consumer group` (the one that reads `const cmdShell = svc.healthcheck!.test[1]!;`), add after the existing `expect(cmdShell).toContain('sds-order-events');` line:

```ts
    expect(cmdShell).toContain("grep -qx 'sds-order-events'");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/compiler/handlers/kafka.test.ts`
Expected: FAIL — current command emits `grep -q 'sds-order-events'` (no `-qx`).

- [ ] **Step 3: Anchor the grep in `kafka.ts`**

On line 35, change:

```ts
      .map((g) => `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list 2>/dev/null | grep -q '${g}'`)
```

to:

```ts
      .map((g) => `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list 2>/dev/null | grep -qx '${g}'`)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/compiler/handlers/kafka.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full TS suite for no regressions**

Run: `npm test`
Expected: PASS (gated smokes skipped).

- [ ] **Step 6: Commit**

```bash
git add src/compiler/handlers/kafka.ts src/compiler/handlers/kafka.test.ts
git commit -m "fix: anchor kafka consumer-group healthcheck grep"
```

---

### Task 5: Poll instead of fixed sleep in the gated smokes + db diagnostics

**Files:**
- Modify: `src/engine/saga-chain.smoke.test.ts`
- Modify: `src/engine/saga-db.smoke.test.ts`

**Interfaces:**
- Consumes: `RealRunner.run(argv)` returns `{ stdout, stderr, code }` (used to check `r.code`).
- Produces: both smokes poll instead of sleeping a fixed interval; the saga-db smoke logs the row count and ignores psql output unless the exec succeeded (`r.code === 0`).

> These are gated tests (`skipIf(!RUN_DOCKER)`). They are skipped by `npm test`; the real verification is a `RUN_DOCKER=1` run after building both images.

- [ ] **Step 1: Replace the fixed sleep in `saga-chain.smoke.test.ts`**

Replace this block:

```ts
      await new K6Runner(runner).run(id, runDir); // fire load at the service -> it publishes
      await new Promise((r) => setTimeout(r, 2000)); // let the worker drain
      const logs = await runner.run([
        'docker', 'compose', '-p', `sds-${id}`, '-f', join(runDir, 'compose.yml'),
        'logs', 'payment-worker',
      ]);
      expect(logs.stdout).toMatch(/consumed/);
```

with:

```ts
      await new K6Runner(runner).run(id, runDir); // fire load at the service -> it publishes
      // Poll the worker logs until it has consumed (instead of a fixed drain sleep).
      let workerLogs = '';
      for (let i = 0; i < 15; i++) {
        workerLogs = (await runner.run([
          'docker', 'compose', '-p', `sds-${id}`, '-f', join(runDir, 'compose.yml'),
          'logs', 'payment-worker',
        ])).stdout;
        if (/consumed/.test(workerLogs)) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      expect(workerLogs).toMatch(/consumed/);
```

- [ ] **Step 2: Add diagnostics + exec-code check in `saga-db.smoke.test.ts`**

Replace this block:

```ts
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
```

with:

```ts
      // Poll Postgres until the worker's writes land (or time out).
      let count = 0;
      for (let i = 0; i < 15; i++) {
        const r = await runner.run([
          ...compose, 'exec', '-T', 'orders-db',
          'psql', '-U', 'postgres', '-tAc', 'SELECT count(*) FROM events',
        ]);
        if (r.code === 0) {
          count = parseInt(r.stdout.trim(), 10) || 0;
          if (count > 0) break;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      console.log(`saga-db smoke: events row count = ${count}`);
      expect(count).toBeGreaterThan(0);
```

- [ ] **Step 3: Confirm both smokes still skip under plain `npm test`**

Run: `npm test`
Expected: PASS; `saga-chain smoke` and `saga-db smoke` both skipped.

- [ ] **Step 4: Build both images and run both gated smokes for real**

```bash
docker build -t sds/microservice ./images/microservice
docker build -t sds/worker ./images/worker
RUN_DOCKER=1 npx vitest run src/engine/saga-chain.smoke.test.ts src/engine/saga-db.smoke.test.ts
```
Expected: both PASS. The saga-db run prints `saga-db smoke: events row count = <N>` with N > 0. Quote the output when reporting done.

- [ ] **Step 5: Commit**

```bash
git add src/engine/saga-chain.smoke.test.ts src/engine/saga-db.smoke.test.ts
git commit -m "test: poll instead of fixed sleep in saga smokes and add db diagnostics"
```

---

## Self-Review

**Spec coverage:**
- Item 1 (`log.Fatalf` → `stop()`-cascade, both mains) → Task 1. ✅
- Item 2 (worker `Run` backoff) → Task 2. ✅
- Item 3 (`NewPgxSink` `ctx.Err()`) → Task 3 Step 1. ✅
- Item 4 (`PgxSink.Write` `[]byte`) → Task 3 Step 2. ✅
- Item 5 (kafka `grep -qx`) → Task 4. ✅
- Item 6 (saga-chain fixed-sleep → poll) → Task 5 Step 1. ✅
- Item 7 (saga-db row-count log + exec-code check) → Task 5 Step 2. ✅
- Re-run both gated smokes real → Task 5 Step 4. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full before/after. Tasks 1 and 3 explicitly justify no new unit test (main wiring / real-DB path), consistent with the spec. ✅

**Type consistency:** `w.readBackoff` (field) used identically in Task 2 Steps 1/3/4. `stop()` is the `signal.NotifyContext` cancel already in scope in both mains. `r.code`/`r.stdout` match `RealRunner.run`'s return shape used elsewhere in the engine. `grep -qx 'sds-order-events'` assertion (Task 4 Step 1) matches the emitted string after the Task 4 Step 3 edit. ✅
