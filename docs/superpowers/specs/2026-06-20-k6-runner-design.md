# k6 Runner v1 — Design

> **Status:** Approved design, ready for implementation plan.
> **Date:** 2026-06-20
> **Depends on:** Graph Compiler (emits `output.k6` when `compile(graph, loadConfig)` is called), Docker Controller (brings the stack up healthy + writes `load.js`), `sds/microservice` (the load target).

## Goal

Run load against a compiled stack and report the result. After the Docker
Controller brings an experiment up healthy, launch k6 (the load generator) as a
one-shot container joined to the experiment network, pointed at the
compiler-generated `load.js`, and surface aggregate metrics — throughput,
latency, error rate. Wires into the `sim` CLI behind `--load`, closing the
"set the load, press Run, see if the system keeps up" loop end-to-end from the
terminal.

## Scope (locked — brainstorm 2026-06-20)

**In:** a `K6Runner` module (on the existing `Runner` seam) that runs
`grafana/k6` via one-shot `docker run` and parses k6's `--summary-export` JSON;
CLI wiring (`--load`/`--rate`/`--duration`, one-shot flow); a gated real-Docker
smoke.

**Out (deferred):**
- **Real-time, per-service metrics** (CPU/mem/latency per node, streamed live).
  That is a different mechanism — Prometheus + cAdvisor + each service's
  `/metrics`, streamed via WebSocket — and is the separate **Metrics Collector**
  brick. k6 measures client-side, whole-system load; it is not the per-service
  monitor. `--summary-export` here does not block that future: per-service live
  comes from Prometheus/cAdvisor (dockerode path), and k6 can additionally stream
  (`--out`) when/if its own metrics are wanted live.
- Streaming k6 output, custom thresholds, multiple scenarios.

## Why this fits (and what it is not)

Two complementary metric views the architecture deliberately separates:

| | k6 Runner (this brick) | Metrics Collector (later) |
|--|--|--|
| Source | k6 load generator | Prometheus + cAdvisor + svc `/metrics` |
| View | client-side, whole-system | server-side, per-service |
| Timing | one aggregate at end | real-time stream |
| Transport | read `summary.json` | scrape → WebSocket → canvas |

This brick answers "what throughput/latency/error rate did the whole system
deliver under load." Per-node live badges are the Metrics Collector's job.

## Architecture

A new `K6Runner` unit mirrors `ExperimentController`: pure orchestration on top
of the `Runner` seam, so it is unit-testable without Docker. The `sim` CLI gains
a one-shot `--load` flow that threads a `LoadConfig` through `compile`, brings the
stack up, runs k6, prints the result, and tears down.

```
sim graph.json --load --rate 50 --duration 10
   compile(graph, {rate, durationSec})  -> output.k6 (load.js)
   controller.preflight + writeArtifacts (writes load.js)
   controller.up --wait                 (stack healthy)
   k6Runner.run(id, runDir)             docker run --rm --network sds-<id>-net ... grafana/k6
      -> reads <runDir>/summary.json    -> K6Result
   print result
   controller.down -v                   (one-shot teardown)
```

The compiler is untouched (it already emits `output.k6` for a `LoadConfig`).

## Layout

```
src/engine/
  k6-runner.ts          K6Runner + parseSummary + K6Result   (NEW)
  k6-runner.test.ts     parseSummary fixture + run argv (fake Runner)  (NEW)
  k6.smoke.test.ts      gated real-docker load run                     (NEW)
  cli.ts                thread loadConfig + K6Runner + --load flow  (MODIFY)
  cli.test.ts           --load flow + stub K6Runner                (MODIFY)
```

## `K6Runner` module

```ts
// k6-runner.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner } from './runner.js';

export interface K6Result {
  requests: number;      // total HTTP requests
  rps: number;           // throughput, req/s
  latencyAvgMs: number;
  latencyP95Ms: number;
  errorRate: number;     // 0..1 (http_req_failed)
}

export class K6Runner {
  constructor(private runner: Runner) {}

  // runDir holds load.js (written by controller.writeArtifacts); k6 writes summary.json there.
  async run(experimentId: string, runDir: string): Promise<K6Result> {
    const net = `sds-${experimentId}-net`;
    const r = await this.runner.run([
      'docker', 'run', '--rm', '--network', net,
      '-v', `${runDir}:/sds`,
      'grafana/k6', 'run', '--summary-export=/sds/summary.json', '/sds/load.js',
    ]);
    if (r.code !== 0) throw new Error(`k6 run failed (exit ${r.code}): ${r.stderr.trim()}`);
    return parseSummary(readFileSync(join(runDir, 'summary.json'), 'utf8'));
  }
}

export function parseSummary(json: string): K6Result { /* pure; see below */ }
```

`parseSummary` reads k6's `--summary-export` shape (flat under `metrics`):
```
metrics.http_reqs.count            -> requests
metrics.http_reqs.rate             -> rps
metrics.http_req_duration.avg      -> latencyAvgMs
metrics.http_req_duration["p(95)"] -> latencyP95Ms
metrics.http_req_failed.value      -> errorRate
```
Every field is read defensively: a missing metric or sub-field yields `0` rather
than throwing or `NaN`. `parseSummary` is pure → unit-tested from a fixture.

## docker run argv (exact)

```
docker run --rm --network sds-<id>-net -v <runDir>:/sds grafana/k6 run --summary-export=/sds/summary.json /sds/load.js
```
- `--rm` — throwaway container.
- `--network sds-<id>-net` — joins the experiment's bridge network (created by
  compose); reaches the entry host (`gateway:80` / `edge-a:8080`) by DNS.
- `-v <runDir>:/sds` — mounts the controller's run dir (holds `load.js`; k6
  writes `summary.json` back into it).
- `grafana/k6` is pulled by Docker on first run (non-`sds/` image; the
  controller's preflight does not check it).

## CLI wiring & flow

`runSim` gains an optional `loadConfig` and an optional `K6Runner`. The CLI parses
`--load`, `--rate <N>` (default 50), `--duration <N>` seconds (default 10).

- **`--load` (one-shot):** `compile(graph, {rate, durationSec})` → preflight →
  `writeArtifacts` (now also writes `load.js`) → `up --wait` → print
  `🔥 running load: <rate> rps for <dur>s…` → `k6Runner.run(id, runDir)` → print
  the `K6Result` (requests / rps / avg / p95 / error %) → `down -v` → exit 0.
- **No `--load` (interactive, unchanged):** up → status → wait SIGINT/SIGTERM →
  down.
- `--keep` still skips teardown in either flow.
- `runDir` is the value returned by `controller.writeArtifacts(...)`.
- Fail-loud + always-teardown: if `up` or `k6Runner.run` throws, tear down the
  stack, then exit 1.

Result print format (one line):
```
load: requests=30000  rps=498.3  avg=12.4ms  p95=41.0ms  errors=1.8%
```

## Error handling

- k6 non-zero exit → `K6Runner.run` throws with captured stderr; the CLI tears
  down and exits 1.
- Missing/garbled `summary.json` → `parseSummary` returns zeros for absent fields
  (it never throws on a well-formed-but-incomplete JSON); a non-JSON file throws
  from `JSON.parse`, surfaced as a clear error and triggers teardown.
- All teardown still routes through `controller.down` (idempotent).

## Testing

**Unit (fast, no Docker):**
- `parseSummary` — feed a representative k6 `summary.json` fixture; assert
  `requests`/`rps`/`latencyAvgMs`/`latencyP95Ms`/`errorRate`. A second fixture
  with missing `http_req_failed` asserts `errorRate === 0` (defensive defaults).
- `K6Runner.run` (fake Runner) — assert the exact `docker run` argv (incl.
  `--network sds-<id>-net`, the `-v <runDir>:/sds` mount, and the
  `--summary-export=/sds/summary.json /sds/load.js` tail); a non-zero fake exit →
  throws with stderr. (Provide the fake `summary.json` on disk in a temp `runDir`
  so the happy path can parse.)
- `cli.test.ts` — `runSim` with a `loadConfig` + a stub `K6Runner` returning a
  canned `K6Result`: assert k6 was invoked and the result line was printed; assert
  the `--load` path returns (does not register signal handlers / wait).

**Gated real-Docker smoke (`RUN_DOCKER=1`) — `src/engine/k6.smoke.test.ts`:**
compile `examples/service-pair.json` with a small load (`rate: 20, durationSec: 3`)
→ `writeArtifacts` → `up --wait` → real `K6Runner.run` → assert `requests > 0` and
`rps > 0` → `down` in a `finally`. service-pair means k6 hits `edge-a:8080`
in-network — no LB, no host port needed. Skipped by default.

## Known limitations

- Aggregate only — no per-service breakdown, no real-time (Metrics Collector
  brick).
- `http_req_failed` marks responses with status ≥ 400 as failed, so the
  microservice's injected `ERROR_RATE` (500s) and upstream cascades (502s) show
  up in `errorRate` — intended.
- `--summary-export` is deprecated in newer k6 (prints a warning) but still
  produces the JSON; migration to `handleSummary` is a future cleanup if the flag
  is ever removed.
- One experiment at a time (shared host networking / port 80 for LB graphs).

## Follow-ups (separate plans)

1. **Metrics Collector** — Prometheus + cAdvisor + WebSocket → real-time
   per-service badges; optionally k6 `--out` streaming for live throughput.
2. `sds/microservice` `INSTANCE_ID` → per-backend distribution.
3. `sds/worker` + Kafka publish → Saga end-to-end.
4. Electron/React canvas consuming the metrics stream.
