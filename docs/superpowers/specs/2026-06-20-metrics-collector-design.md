# Metrics Collector v1 — Design

> **Status:** Approved design, ready for implementation plan.
> **Date:** 2026-06-20
> **Depends on:** Docker Controller (brings the stack up; containers carry the `com.docker.compose.project=sds-<id>` label), k6 Runner (the `--load` flow this composes with).

## Goal

Surface per-service runtime metrics (CPU %, memory) while an experiment runs.
Read them straight from the Docker API via dockerode for the experiment's
containers, and print a live, refreshing per-service table from the `sim` CLI —
composing with `--load` so you watch each service's CPU climb while k6 fires.
This is the runtime half of the architecture's Metrics Collector; the
WebSocket→canvas streaming layer waits until the UI exists.

## Scope (locked — brainstorm 2026-06-20)

**In:** a `MetricsCollector` on a `StatsSource` seam backed by dockerode
(`container.stats`); pure CPU%/mem computations; a `sim` CLI `--metrics`
(+ `--interval`) flow that samples a per-service snapshot during the run and
composes with `--load`; a gated real-Docker smoke. Introduces the `dockerode`
dependency.

**Out (deferred):**
- **cAdvisor + Prometheus + PromQL.** Not needed for a live snapshot; dockerode
  reads CPU/mem/net per container directly. Their value (stored history, app
  `/metrics` scrape, PromQL) is unused with no UI yet, and cAdvisor's host mounts
  are finicky on Docker Desktop for Mac. Revisit when the canvas wants history.
- **WebSocket bridge + canvas badges.** No UI consumes a stream yet; the CLI
  table is the consumer until the canvas exists.
- **Network I/O metrics.** Trivial follow-up from the same stats object; CPU% +
  mem are the v1 headline (the planning doc's "per-node CPU badge").

## Why dockerode (not cAdvisor/Prometheus) for v1

The Docker daemon already tracks every container's CPU/mem (it's what
`docker stats` reads). dockerode's `container.stats({ stream: false })` returns
that per container — both `cpu_stats` and `precpu_stats` in one call, enough to
compute CPU%. No extra containers, no host mounts, no scrape config. The
architecture earmarks "dockerode" for exactly this path; the Docker Controller
deferred adding it (it shells out to the compose CLI), and this brick introduces
it.

## Architecture

A new `MetricsCollector` mirrors the project's DI pattern (`Runner` seam): it sits
on a `StatsSource` interface so the dockerode wiring is swappable for a fake in
unit tests. Pure functions compute CPU%/mem from raw stats. The `sim` CLI gains a
`--metrics` flow that polls a snapshot and prints a table, integrated with the
existing `--load` k6 run.

```
sim graph.json --load --metrics --interval 1000
   controller.up --wait                    (stack healthy)
   metrics baseline sample + print
   k6Runner.run(id, runDir)                (start, don't await)
   while k6 not settled:
     MetricsCollector.sample(id)  ── dockerode ── list+stats experiment containers
       -> [{name, cpuPercent, memMB}, …]   -> print table
     sleep(intervalMs)
   k6 aggregate + final sample
   controller.down -v
```

The compiler and Docker Controller are untouched.

## Layout

```
src/engine/
  metrics.ts          types, cpuPercent/memMB, StatsSource, DockerodeStatsSource, MetricsCollector  (NEW)
  metrics.test.ts     fixture tests (pure fns) + fake-StatsSource MetricsCollector test             (NEW)
  metrics.smoke.test.ts  gated real-docker sample                                                   (NEW)
  cli.ts              thread metrics opts + --metrics/--interval flow                                (MODIFY)
  cli.test.ts         --metrics wiring with a stub collector                                         (MODIFY)
```

## Types + pure computations

```ts
export interface MetricsSnapshot {
  name: string;        // service/container name
  cpuPercent: number;  // 0..N*100
  memMB: number;
}

// Minimal shape of dockerode's container.stats() we read.
export interface DockerStats {
  cpu_stats:    { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number };
  memory_stats: { usage?: number };
}

export function cpuPercent(s: DockerStats): number {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
  const cpus = s.cpu_stats.online_cpus ?? 1;
  return sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
}

export function memMB(s: DockerStats): number {
  return (s.memory_stats.usage ?? 0) / (1024 * 1024);
}
```

Standard dockerode CPU% formula (container CPU delta ÷ system CPU delta × cores).
The `sysDelta > 0 && cpuDelta > 0` guard returns `0` on the first/idle read —
never `NaN`. Both functions are pure → fixture-tested without Docker.

## `StatsSource` seam + `MetricsCollector`

```ts
export interface ContainerRef { id: string; name: string }

export interface StatsSource {
  list(experimentId: string): Promise<ContainerRef[]>;
  stats(containerId: string): Promise<DockerStats>;
}

export class MetricsCollector {
  constructor(private source: StatsSource) {}
  async sample(experimentId: string): Promise<MetricsSnapshot[]> {
    const containers = await this.source.list(experimentId);
    return Promise.all(
      containers.map(async (c) => {
        const s = await this.source.stats(c.id);
        return { name: c.name, cpuPercent: cpuPercent(s), memMB: memMB(s) };
      }),
    );
  }
}

export class DockerodeStatsSource implements StatsSource {
  private docker = new Docker(); // dockerode, default socket
  async list(experimentId: string): Promise<ContainerRef[]> {
    const cs = await this.docker.listContainers({
      filters: { label: [`com.docker.compose.project=sds-${experimentId}`] },
    });
    return cs.map((c) => ({ id: c.Id, name: c.Names[0]?.replace(/^\//, '') ?? c.Id }));
  }
  async stats(id: string): Promise<DockerStats> {
    return this.docker.getContainer(id).stats({ stream: false }) as unknown as Promise<DockerStats>;
  }
}
```

- Containers are discovered by Compose's `com.docker.compose.project=sds-<id>`
  label, which every service the controller's `up` created carries — no name
  guessing, robust to the doubled-network-name quirk.
- `MetricsCollector.sample` is fully fake-able: unit tests inject a `StatsSource`
  returning canned containers + stats. dockerode never loads in unit tests.
- `package.json`: add `dockerode` + `@types/dockerode` (devDependency).

## CLI `--metrics` integration

New flags: `--metrics` (enable), `--interval <ms>` (default 1000). `runSim` gains
an optional `metrics?: { collector: MetricsCollector; intervalMs: number }`.

Flow after `up` + status print:
- **`--metrics` on:** take one baseline sample and print a per-service table
  (always ≥1 sample — a deterministic anchor).
- **`--metrics` + `--load`:** start `k6Runner.run(...)` WITHOUT awaiting; while the
  k6 promise is unsettled, `sample` → print a table → `sleep(intervalMs)`; then
  await the k6 promise, print the k6 aggregate and a final sample table.
- **`--metrics` without `--load`:** the baseline sample only (idle containers read
  near 0% — load is what makes it interesting).
- The metrics poll sits inside the existing `up→k6` try-block, so a failure still
  tears down. Per-sample stats errors are caught (warn line + continue) so a
  transient dockerode hiccup never aborts the load run.
- Teardown unchanged: `--load` → one-shot `down`; otherwise interactive
  (SIGINT/SIGTERM). `--keep` still skips teardown.

Table line per service: `  edge-a  cpu 42.1%  mem 18.3MB`.

## Error handling

- dockerode socket unreachable / `list` throws on the baseline sample → surfaces
  as a run error → teardown + exit 1 (fail-loud).
- Per-sample errors during the load poll loop → caught, printed as a warn line,
  loop continues (the k6 aggregate is the primary result).
- `MetricsCollector.sample` itself never throws on incomplete stats — the pure
  fns default missing fields to 0.

## Testing

**Unit (fast, no Docker/dockerode):**
- `cpuPercent` / `memMB` from a `DockerStats` fixture → expected values; the
  `sysDelta <= 0` and idle/zero-delta cases → `0` (no `NaN`).
- `MetricsCollector.sample` with a fake `StatsSource` (two canned containers +
  stats) → asserts the `MetricsSnapshot[]` names + computed numbers.
- `cli.test.ts`: `runSim` with a stub collector and no load → baseline `sample`
  called once and a table line printed; with a stub collector + stub k6 +
  `loadConfig` → `sample` called and k6 ran (the prior 3/4-arg runSim calls still
  valid — the metrics opt is optional).

**Gated real-Docker smoke (`RUN_DOCKER=1`) — `src/engine/metrics.smoke.test.ts`:**
up `examples/service-pair.json`, `new MetricsCollector(new DockerodeStatsSource()).sample('pair')`
→ assert ≥2 snapshots whose names include the service containers and whose
`cpuPercent`/`memMB` are finite and ≥ 0 → `down` in a `finally`. Skipped by
default.

## Known limitations

- CPU% + mem only; net I/O deferred.
- Live snapshot, no stored history (cAdvisor/Prometheus deferred).
- No WebSocket/canvas consumer yet — CLI table only.
- The first baseline CPU% may read low (small precpu delta on a just-started
  container); subsequent samples under load are accurate.

## Follow-ups (separate plans)

1. Network I/O in the snapshot (same stats object).
2. cAdvisor + Prometheus + WebSocket bridge → stored history + canvas badges, when
   the UI exists.
3. Scrape each `sds/microservice` `/metrics` for business metrics alongside
   container stats.
4. Electron/React canvas consuming the metrics + k6 results.
