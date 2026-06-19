# Docker Controller v1 — Design

> **Status:** Approved design, ready for implementation plan.
> **Date:** 2026-06-19
> **Depends on:** Graph Compiler (done — `compile()` emits compose/nginx/k6 strings); `sds/microservice` image (done).

## Goal

Build the Docker Controller: the orchestration-engine layer that takes the Graph
Compiler's output and actually runs it as real Docker containers — bring the
stack up on its isolated network, wait for it to become healthy (Kafka cold
start), report status, and tear it down. Plus a thin `sim` CLI so a graph JSON
can be run end-to-end from the terminal, with no Electron UI yet.

This is the second runtime brick (after `sds/microservice`). It turns the
compiler's `docker-compose.yml` string from an artifact into a running system.

## Decisions locked (brainstorm, 2026-06-19)

- **Lifecycle engine: `docker compose` CLI**, not dockerode. The compiler already
  emits a ready compose YAML; the CLI consumes it as-is, handles ordering /
  networks / naming, and `up --wait` blocks until healthchecks pass (solves the
  Kafka cold-start wait for free). dockerode is deferred to the Metrics brick,
  where live per-container stats are its real strength.
- **Slice scope: controller module + thin `sim` CLI.** Running the generated k6
  load script is deferred to the next brick (k6 Runner).
- **Testing: inject a `Runner` seam.** Fast unit tests use a fake Runner (assert
  argv, artifact writing, `ps` parsing, error/teardown). One opt-in real-Docker
  smoke test (`RUN_DOCKER=1`) actually ups a tiny stack. Mirrors how the compiler
  and microservice were tested.
- **LB/service host-reachability gaps are deferred** to a separate compiler
  follow-up (see Known Limitations). This brick is lifecycle only.

## Non-goals

- No dockerode in this brick (Metrics brick).
- No k6 load execution (k6 Runner brick).
- No Electron/React UI; the entry point is a CLI.
- No compiler changes; the LB nginx-mount and service host-port fixes are a
  separate plan.

## Architecture

Three units, one seam:

```
cli.ts  ──reads graph.json──▶ compile() (src/compiler)
   │                              │ CompilerResult
   │                              ▼
   └──▶ ExperimentController(runner) ──▶ Runner ──▶ child_process ──▶ docker compose
            writeArtifacts / up / status / down
```

- **`Runner`** — the only unit that spawns subprocesses. Swappable: `RealRunner`
  in production, `FakeRunner` in tests. This is the seam that keeps the
  controller fast-testable without Docker.
- **`ExperimentController`** — pure orchestration on top of a `Runner`. Writes the
  compiler's artifacts to disk, builds the `docker compose` argv, parses `ps`
  output. Knows nothing about *how* commands execute.
- **`cli.ts`** — thin glue wiring compiler → controller → terminal output →
  signal-driven teardown.

The compiler (`src/compiler/`) is untouched; the CLI imports `compile`.

## Layout

```
src/engine/
  runner.ts                 Runner interface + RealRunner (child_process.spawn)
  runner.test.ts            RealRunner: runs argv, captures code/stdout/stderr
  controller.ts             ExperimentController: writeArtifacts / up / status / down
  controller.test.ts        unit (FakeRunner): argv, artifacts, ps-parse, errors, preflight
  controller.smoke.test.ts  gated (RUN_DOCKER=1): real up→running→down on 1-service graph
  cli.ts                    `sim` entry: compile → run → print → Ctrl-C teardown
examples/
  single-service.json       1 service node (smallest runnable graph; used by smoke)
  lb-scaling.json           LB → 2 services (template; lifecycle only this brick)
```

- New `src/engine/` home for the orchestration layer.
- `package.json`: add script `"sim": "tsx src/engine/cli.ts"` and `tsx` devDep
  (run TS directly, no build step).
- `.gitignore`: add `.sds-runs/` (per-experiment run artifacts).

## Interfaces

```ts
// runner.ts
export interface RunResult { code: number; stdout: string; stderr: string }
export interface Runner {
  run(argv: string[], opts?: { cwd?: string }): Promise<RunResult>
}
export class RealRunner implements Runner { /* spawn argv[0] argv[1..], capture streams, resolve on close */ }
```

```ts
// controller.ts
import type { CompilerResult } from '../compiler/types.js';
type CompilerOutput = Extract<CompilerResult, { ok: true }>['output']; // { compose: string; nginx?: string; k6?: string }

export interface Publisher { url: string; published: number; target: number }
export interface ServiceStatus {
  name: string;
  state: string;            // e.g. "running"
  health?: string;          // e.g. "healthy" | "starting" (only if the service declares a healthcheck)
  publishers: Publisher[];  // host-reachable ports
}

export class ExperimentController {
  constructor(runner: Runner, opts?: { runRoot?: string }); // runRoot default ".sds-runs"

  writeArtifacts(experimentId: string, output: CompilerOutput): string;   // returns the run dir
  preflight(output: CompilerOutput): Promise<void>;                       // verify sds/* images exist
  up(experimentId: string): Promise<void>;
  status(experimentId: string): Promise<ServiceStatus[]>;
  down(experimentId: string): Promise<void>;
}
```

- `CompilerOutput` is derived from the compiler's own `CompilerResult` type — no
  duplicated shape.
- Project name: `sds-<experimentId>`. Network is `sds-<experimentId>-net`, already
  defined inside the compiler's YAML; the controller never manages it directly.

## Behavior

### writeArtifacts
Writes to `<runRoot>/<experimentId>/`:
- `compose.yml` — always (`output.compose`).
- `nginx.conf` — only if `output.nginx` present.
- `load.js` — only if `output.k6` present.
Creates the dir (recursive), overwrites on rerun, returns the absolute dir path.

### preflight (fail-loud)
Scan `output.compose` for `image:` values beginning `sds/`. For each unique
image, run `docker image inspect <image>` via the runner. If any exits non-zero:
throw with a build hint, e.g.
`✗ image sds/worker not found — build it: docker build -t sds/worker ./images/worker`
This catches the most common confusing failure (worker graphs — `sds/worker`
does not exist yet) before `up`, instead of a cryptic compose pull error.

### up
Runner argv:
`["docker","compose","-p","sds-<id>","-f","<dir>/compose.yml","up","-d","--wait"]`
`--wait` resolves only when healthchecked services (Kafka) report healthy;
services without a healthcheck need only be running. Non-zero exit → throw with
captured stderr.

### status
Runner argv:
`["docker","compose","-p","sds-<id>","-f","<dir>/compose.yml","ps","--format","json"]`
Compose v2 emits **NDJSON** (one JSON object per line). Parse each non-empty line
→ map to `ServiceStatus` (`Name`/`State`/`Health`/`Publishers[].URL,PublishedPort,TargetPort`).
Tolerate an empty result (no containers) → `[]`.

### down
Runner argv:
`["docker","compose","-p","sds-<id>","-f","<dir>/compose.yml","down","-v","--remove-orphans"]`
`-v` removes the experiment's volumes so reruns start clean. Idempotent: down on
an already-down project is a no-op success.

## CLI flow (`npm run sim <graph.json> [--keep] [--run-root <dir>]`)

```
1. read graph.json → JSON.parse → Graph        (parse error → message, exit 1)
2. result = compile(graph)                      (!ok → print errors[], exit 1)
3. await controller.preflight(result.output)    (missing image → build hint, exit 1)
4. dir = controller.writeArtifacts(id, result.output)
5. print "⏳ warming up <id> (kafka cold start ~5-10s)…"
6. await controller.up(id)                       (blocks on --wait)
7. statuses = await controller.status(id)
   print table: NAME  STATE  HEALTH  + reachable host ports (from publishers)
   print "network: sds-<id>-net   |   Ctrl-C to tear down"
8. on SIGINT/SIGTERM → await controller.down(id) → exit 0
   on any error in 4–7 → attempt controller.down(id) → exit 1
   --keep → skip teardown, leave stack up and exit 0 after printing status
```

## Error handling & teardown

- **Fail-loud:** bad JSON, compile errors, missing image, non-zero compose exit →
  clear message + non-zero exit. No partial best-effort.
- **Always tear down:** CLI wraps up→status→wait in try/finally; any throw →
  `down(id)` then exit 1. `--keep` opts out.
- **Signals:** SIGINT/SIGTERM → `down(id)` → exit 0. `down` is idempotent.

## Testing

- **`runner.test.ts`** — `RealRunner` runs a harmless real argv (e.g.
  `node -e "process.stdout.write('hi')"`) → `{code:0, stdout:"hi"}`; a failing
  argv → non-zero code + captured stderr. Tests subprocess plumbing, not Docker.
- **`controller.test.ts`** (FakeRunner, fast, no Docker):
  - `writeArtifacts` writes `compose.yml` (+ `nginx.conf`/`load.js` when present)
    to `<runRoot>/<id>/`, returns the dir.
  - `up`/`down`/`status` build the exact argv listed in Behavior.
  - `status` parses fake NDJSON `ps` output → `ServiceStatus[]`.
  - `up` non-zero exit → throws with stderr text.
  - `preflight` with a fake missing `image inspect` → throws build-hint error
    before any `up` argv is issued.
- **`controller.smoke.test.ts`** — gated: `if (!process.env.RUN_DOCKER) it.skip`.
  Real `up` of `single-service.json`, poll `status` until `running`, assert, then
  `down` in a finally block.

## Known limitations (deferred to a compiler follow-up)

The controller runs any graph's lifecycle, but two pre-existing **compiler** gaps
limit host-side manual verification after `up`:

1. **Service nodes publish no host port.** The `service` handler emits no
   `ports:`, so `sds/microservice` containers are reachable only inside the
   network (by DNS), not from the host. Fine for in-network k6; means a
   pure-service graph isn't `curl`-able from the host.
2. **LB nginx config isn't mounted.** The `lb` handler emits `nginx:alpine` with
   `ports: ['80:80']` but no volume mounting the generated `nginx.conf`, and
   `ComposeService` has no `volumes` field. An LB stack comes up at `localhost:80`
   but serves nginx's default page — it does not route to the backends.

Consequence: this brick proves the controller spins real containers up to
*healthy* and tears them down (verified via `compose ps` + the gated smoke).
Full host-`curl`-able LB routing needs a separate compiler plan: add `volumes` to
`ComposeService` + compose-generator emission + mount `nginx.conf` in the `lb`
handler, and publish a service/LB host port.

## Follow-ups (separate plans)

1. **Compiler: volumes + LB nginx mount + host ports** → LB graphs route and are
   `curl`-able host-side.
2. **k6 Runner** → run the generated `load.js` against the stack, capture
   throughput/latency.
3. **Metrics Collector** (dockerode) → stream container stats / Prometheus scrape
   → WebSocket → UI.
4. **`sds/worker` image** → Kafka consumer → Saga template end-to-end.
