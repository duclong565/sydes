# Metrics Collector v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface per-service CPU%/memory while an experiment runs — read container stats from the Docker API via dockerode, and print a live per-service table from the `sim` CLI that composes with `--load` (watch CPU climb while k6 fires).

**Architecture:** A `MetricsCollector` on a `StatsSource` seam (DI like `Runner`) backed by dockerode; pure `cpuPercent`/`memMB` functions computed from raw stats (fixture-testable). The `sim` CLI gains a `--metrics` flow that samples a snapshot during the run, integrated with the existing `--load` k6 run. Compiler and Docker Controller are untouched.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`), Vitest, `dockerode` (Docker API).

## Global Constraints

- Metrics source is **dockerode** `container.stats({ stream: false })`. No cAdvisor, no Prometheus.
- Containers are discovered by the Compose label `com.docker.compose.project=sds-<id>`.
- `MetricsSnapshot` fields: `name` (string), `cpuPercent` (number), `memMB` (number).
- CPU% formula: `(cpuDelta / sysDelta) * online_cpus * 100`, guarded by `sysDelta > 0 && cpuDelta > 0` (else `0` — never `NaN`). `memMB = (memory_stats.usage ?? 0) / (1024*1024)`.
- CLI flags: `--metrics` (enable), `--interval <ms>` (default 1000). `--metrics` prints a baseline sample after up; with `--load`, it polls during the k6 run; per-sample errors in the load loop are caught (warn + continue); the baseline sample is fail-loud.
- Compiler and Docker Controller files are NOT modified. Introduces `dockerode` + `@types/dockerode`.
- Gated real-Docker smoke runs only with `RUN_DOCKER=1`. TypeScript `.js` import specifiers. **No `Co-Authored-By` trailer in commits.**

---

### Task 1: types + pure stat computations

**Files:**
- Create: `src/engine/metrics.ts`
- Test: `src/engine/metrics.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface MetricsSnapshot { name; cpuPercent; memMB }`; `interface DockerStats {...}`; `function cpuPercent(s: DockerStats): number`; `function memMB(s: DockerStats): number`.

- [ ] **Step 1: Write the failing test**

`src/engine/metrics.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { cpuPercent, memMB } from './metrics.js';
import type { DockerStats } from './metrics.js';

// cpuDelta = 2e6-1e6 = 1e6 ; sysDelta = 1e8-9e7 = 1e7 ; cpus=4 -> (1e6/1e7)*4*100 = 40
export const sample: DockerStats = {
  cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 100_000_000, online_cpus: 4 },
  precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 90_000_000 },
  memory_stats: { usage: 18 * 1024 * 1024 },
};

describe('cpuPercent', () => {
  it('computes percent from the cpu/system deltas and core count', () => {
    expect(cpuPercent(sample)).toBe(40);
  });
  it('returns 0 when there is no cpu delta (idle)', () => {
    const idle: DockerStats = {
      cpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 100_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 90_000_000 },
      memory_stats: { usage: 1024 },
    };
    expect(cpuPercent(idle)).toBe(0);
  });
  it('returns 0 (not NaN) when sysDelta is non-positive', () => {
    const flat: DockerStats = {
      cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 90_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 90_000_000 },
      memory_stats: {},
    };
    expect(cpuPercent(flat)).toBe(0);
  });
});

describe('memMB', () => {
  it('converts bytes to MB', () => {
    expect(memMB(sample)).toBe(18);
  });
  it('defaults missing usage to 0', () => {
    expect(memMB({ ...sample, memory_stats: {} })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/engine/metrics.test.ts`
Expected: FAIL — cannot find module `./metrics.js`.

- [ ] **Step 3: Write minimal implementation**

`src/engine/metrics.ts`:
```typescript
export interface MetricsSnapshot {
  name: string;        // service/container name
  cpuPercent: number;  // 0..N*100
  memMB: number;
}

// Minimal shape of dockerode's container.stats() output we read.
export interface DockerStats {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus?: number };
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/engine/metrics.test.ts`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/engine/metrics.ts src/engine/metrics.test.ts
git commit -m "feat: add per-container cpu/mem stat computations"
```

---

### Task 2: `StatsSource` seam + `MetricsCollector` + dockerode source

**Files:**
- Modify: `src/engine/metrics.ts`
- Modify: `src/engine/metrics.test.ts`
- Modify: `package.json` (+ `package-lock.json` via npm)

**Interfaces:**
- Consumes: `cpuPercent`/`memMB`/`DockerStats`/`MetricsSnapshot` (Task 1).
- Produces: `interface ContainerRef { id; name }`; `interface StatsSource { list(id): Promise<ContainerRef[]>; stats(containerId): Promise<DockerStats> }`; `class MetricsCollector { constructor(source: StatsSource); sample(experimentId): Promise<MetricsSnapshot[]> }`; `class DockerodeStatsSource implements StatsSource`.

- [ ] **Step 1: Write the failing test**

Append to `src/engine/metrics.test.ts`:
```typescript
import { MetricsCollector } from './metrics.js';
import type { StatsSource, ContainerRef } from './metrics.js';

class FakeStatsSource implements StatsSource {
  constructor(
    private containers: ContainerRef[],
    private statsById: Record<string, DockerStats>,
  ) {}
  async list(): Promise<ContainerRef[]> {
    return this.containers;
  }
  async stats(id: string): Promise<DockerStats> {
    return this.statsById[id]!;
  }
}

describe('MetricsCollector.sample', () => {
  it('returns one snapshot per container with computed cpu/mem', async () => {
    // c2: cpuDelta=5e5 / sysDelta=1e7 *4*100 = 20 ; mem 9MB
    const c2: DockerStats = {
      cpu_stats: { cpu_usage: { total_usage: 1_500_000 }, system_cpu_usage: 100_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 90_000_000 },
      memory_stats: { usage: 9 * 1024 * 1024 },
    };
    const src = new FakeStatsSource(
      [{ id: 'c1', name: 'edge-a' }, { id: 'c2', name: 'edge-b' }],
      { c1: sample, c2 },
    );
    const snaps = await new MetricsCollector(src).sample('pair');
    expect(snaps).toHaveLength(2);
    expect(snaps[0]).toEqual({ name: 'edge-a', cpuPercent: 40, memMB: 18 });
    expect(snaps[1]).toEqual({ name: 'edge-b', cpuPercent: 20, memMB: 9 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/engine/metrics.test.ts`
Expected: FAIL — `MetricsCollector` is not exported (and dockerode import unresolved until installed).

- [ ] **Step 3: Write minimal implementation**

Install the dependency:
```bash
npm install dockerode
npm install -D @types/dockerode
```

In `src/engine/metrics.ts`, add the dockerode import at the top and the seam + classes at the bottom:
```typescript
import Docker from 'dockerode';
```
```typescript
export interface ContainerRef {
  id: string;
  name: string;
}

export interface StatsSource {
  list(experimentId: string): Promise<ContainerRef[]>;
  stats(containerId: string): Promise<DockerStats>;
}

/** Collects per-service CPU/mem snapshots from a StatsSource. */
export class MetricsCollector {
  constructor(private readonly source: StatsSource) {}

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

/** Real StatsSource: reads container stats from the Docker API via dockerode. */
export class DockerodeStatsSource implements StatsSource {
  private readonly docker = new Docker();

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/engine/metrics.test.ts`
Expected: PASS — the new `MetricsCollector.sample` test green, all Task 1 tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/metrics.ts src/engine/metrics.test.ts package.json package-lock.json
git commit -m "feat: add MetricsCollector with dockerode stats source"
```

---

### Task 3: CLI `--metrics` flow

**Files:**
- Modify: `src/engine/cli.ts`
- Modify: `src/engine/cli.test.ts`

**Interfaces:**
- Consumes: `MetricsCollector`/`DockerodeStatsSource`/`MetricsSnapshot` (Tasks 1–2); existing `runSim`/`main`/`SimOptions`/`K6Runner`/`ExperimentController`/`RealRunner`.
- Produces: `SimOptions.metrics?: { collector: Pick<MetricsCollector, 'sample'>; intervalMs: number }`; `runSim` prints a baseline metrics table when `metrics` is set and polls during a `--load` run; `main` parses `--metrics`/`--interval`.

- [ ] **Step 1: Write the failing test**

Append to `src/engine/cli.test.ts` (the file already imports `runSim`, `ExperimentController`, `mkdtempSync`/`join`/`tmpdir`, and defines `StubRunner`, `CapturingLogger`, `tmpGraph`, `pairGraph`, `StubK6`):
```typescript
import type { MetricsSnapshot } from './metrics.js';

class StubCollector {
  calls = 0;
  async sample(_experimentId: string): Promise<MetricsSnapshot[]> {
    this.calls++;
    return [{ name: 'edge-a', cpuPercent: 12.5, memMB: 8 }];
  }
}

describe('runSim with metrics', () => {
  it('prints a baseline metrics sample when metrics is set (no load)', async () => {
    const out = new CapturingLogger();
    const c = new ExperimentController(new StubRunner(), { runRoot: mkdtempSync(join(tmpdir(), 'sds-run-')) });
    const col = new StubCollector();
    await runSim(tmpGraph(pairGraph), c, out, { metrics: { collector: col, intervalMs: 10 } });
    expect(col.calls).toBeGreaterThanOrEqual(1);
    expect(out.lines.some((l) => l.includes('cpu 12.5%'))).toBe(true);
  });

  it('samples metrics during a load run', async () => {
    const out = new CapturingLogger();
    const c = new ExperimentController(new StubRunner(), { runRoot: mkdtempSync(join(tmpdir(), 'sds-run-')) });
    const col = new StubCollector();
    const k6 = new StubK6();
    await runSim(tmpGraph(pairGraph), c, out, {
      loadConfig: { rate: 20, durationSec: 3 },
      k6Runner: k6,
      metrics: { collector: col, intervalMs: 10 },
    });
    expect(k6.ran).toBe(true);
    expect(col.calls).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/engine/cli.test.ts`
Expected: FAIL — `runSim` ignores `opts.metrics`; `cpu 12.5%` not printed.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/cli.ts`, add to the imports:
```typescript
import { MetricsCollector, DockerodeStatsSource } from './metrics.js';
import type { MetricsSnapshot } from './metrics.js';
```

Replace the whole `SimOptions` interface and the whole `runSim` function with:
```typescript
export interface SimOptions {
  loadConfig?: LoadConfig;
  k6Runner?: Pick<K6Runner, 'run'>;
  metrics?: { collector: Pick<MetricsCollector, 'sample'>; intervalMs: number };
}

export async function runSim(
  graphPath: string,
  controller: ExperimentController,
  out: Logger,
  opts: SimOptions = {},
): Promise<string> {
  const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as Graph;
  const result = compile(graph, opts.loadConfig);
  if (!result.ok) {
    for (const e of result.errors) out.error(`✗ ${e.nodeId}: ${e.message}`);
    throw new Error('compile failed');
  }
  await controller.preflight(result.output);
  const runDir = controller.writeArtifacts(graph.experimentId, result.output);
  const id = graph.experimentId;
  out.log(`⏳ warming up ${id} (kafka cold start ~5-10s if present)…`);

  const printSnaps = (snaps: MetricsSnapshot[]) => {
    for (const s of snaps) {
      out.log(`  ${s.name}  cpu ${s.cpuPercent.toFixed(1)}%  mem ${s.memMB.toFixed(1)}MB`);
    }
  };

  try {
    await controller.up(id);
    for (const s of await controller.status(id)) {
      const ports = s.publishers.map((p) => `${p.published}->${p.target}`).join(', ') || '-';
      out.log(`  ${s.name}  ${s.state}${s.health ? '/' + s.health : ''}  ports:${ports}`);
    }

    if (opts.metrics) {
      out.log('metrics (baseline):');
      printSnaps(await opts.metrics.collector.sample(id));
    }

    if (opts.loadConfig && opts.k6Runner) {
      out.log(`🔥 running load: ${opts.loadConfig.rate} rps for ${opts.loadConfig.durationSec}s…`);
      const k6p = opts.k6Runner.run(id, runDir);
      if (opts.metrics) {
        const m = opts.metrics;
        let settled = false;
        void k6p.then(() => {}, () => {}).finally(() => { settled = true; });
        while (!settled) {
          await new Promise((r) => setTimeout(r, m.intervalMs));
          if (settled) break;
          try {
            out.log('metrics:');
            printSnaps(await m.collector.sample(id));
          } catch (e) {
            out.error(`metrics sample failed: ${(e as Error).message}`);
          }
        }
      }
      const k = await k6p;
      out.log(
        `load: requests=${k.requests}  rps=${k.rps.toFixed(1)}  ` +
          `avg=${k.latencyAvgMs.toFixed(1)}ms  p95=${k.latencyP95Ms.toFixed(1)}ms  ` +
          `errors=${(k.errorRate * 100).toFixed(1)}%`,
      );
      if (opts.metrics) {
        out.log('metrics (final):');
        printSnaps(await opts.metrics.collector.sample(id));
      }
    }
  } catch (e) {
    await controller.down(id);
    throw e;
  }

  // Real Docker network name = <project>_<key> (Compose prefixes the YAML key with the project name).
  const hint = opts.loadConfig ? '' : '   |   Ctrl-C to tear down';
  out.log(`network: sds-${id}_sds-${id}-net${hint}`);
  return id;
}
```

Replace the whole `main` function with:
```typescript
export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const keep = args.includes('--keep');
  const load = args.includes('--load');
  const metricsOn = args.includes('--metrics');
  const runRootIdx = args.indexOf('--run-root');
  const runRoot = runRootIdx >= 0 ? args[runRootIdx + 1] : undefined;

  const numFlag = (name: string, def: number): number => {
    const i = args.indexOf(name);
    if (i < 0) return def;
    const v = Number(args[i + 1]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  const rate = numFlag('--rate', 50);
  const durationSec = numFlag('--duration', 10);
  const intervalMs = numFlag('--interval', 1000);

  const consumed = new Set<number>();
  for (const f of ['--run-root', '--rate', '--duration', '--interval']) {
    const i = args.indexOf(f);
    if (i >= 0) consumed.add(i + 1);
  }
  const graphPath = args.find((a, i) => !a.startsWith('--') && !consumed.has(i));
  if (!graphPath) {
    console.error(
      'usage: npm run sim <graph.json> [--load [--rate N] [--duration N]] [--metrics [--interval MS]] [--keep] [--run-root <dir>]',
    );
    process.exit(1);
    return;
  }

  const controller = new ExperimentController(new RealRunner(), { runRoot });
  const out: Logger = { log: (s) => console.log(s), error: (s) => console.error(s) };

  const opts: SimOptions = {};
  if (load) {
    opts.loadConfig = { rate, durationSec };
    opts.k6Runner = new K6Runner(new RealRunner());
  }
  if (metricsOn) {
    opts.metrics = { collector: new MetricsCollector(new DockerodeStatsSource()), intervalMs };
  }

  let id: string;
  try {
    id = await runSim(graphPath, controller, out, opts);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
    return;
  }

  if (keep) {
    console.log('--keep: leaving stack up. Tear down with: docker compose -p sds-' + id + ' down -v');
    return;
  }
  if (load) {
    console.log('tearing down…');
    await controller.down(id);
    return;
  }
  const teardown = async () => {
    console.log('\ntearing down…');
    await controller.down(id);
    process.exit(0);
  };
  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);
}
```

Keep the run-if-main guard at the bottom of `cli.ts` unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/engine/cli.test.ts`
Expected: PASS — new metrics tests green; prior runSim/load tests still green. Then `npm test` → full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/cli.ts src/engine/cli.test.ts
git commit -m "feat: add --metrics flow sampling per-service stats in the sim CLI"
```

---

### Task 4: Gated real-Docker metrics smoke

**Files:**
- Create: `src/engine/metrics.smoke.test.ts`

**Interfaces:**
- Consumes: `compile` (`../compiler/index.js`), `Graph` (`../compiler/types.js`), `ExperimentController`+`RealRunner`, `MetricsCollector`+`DockerodeStatsSource` (Tasks 1–2), `examples/service-pair.json`.
- Produces: a Vitest suite gated behind `RUN_DOCKER=1` that samples real container stats.

- [ ] **Step 1: Write the test (it is the deliverable)**

`src/engine/metrics.smoke.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';
import { MetricsCollector, DockerodeStatsSource } from './metrics.js';

// Gated: runs only with RUN_DOCKER=1. Needs the sds/microservice image.
describe.skipIf(!process.env.RUN_DOCKER)('metrics smoke (real docker)', () => {
  it('samples per-service cpu/mem for a running service-pair', async () => {
    const graph = JSON.parse(readFileSync('examples/service-pair.json', 'utf8')) as Graph;
    const result = compile(graph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runRoot = mkdtempSync(join(tmpdir(), 'sds-metrics-'));
    const c = new ExperimentController(new RealRunner(), { runRoot });
    c.writeArtifacts(graph.experimentId, result.output);
    try {
      await c.preflight(result.output);
      await c.up(graph.experimentId);
      const snaps = await new MetricsCollector(new DockerodeStatsSource()).sample(graph.experimentId);
      expect(snaps.length).toBeGreaterThanOrEqual(2);
      for (const s of snaps) {
        expect(Number.isFinite(s.cpuPercent)).toBe(true);
        expect(s.cpuPercent).toBeGreaterThanOrEqual(0);
        expect(s.memMB).toBeGreaterThan(0);
      }
    } finally {
      await c.down(graph.experimentId);
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
```

- [ ] **Step 2: Verify it is skipped by default**

Run: `npm test -- src/engine/metrics.smoke.test.ts`
Expected: PASS — suite skipped (0 tests run, no Docker touched).

- [ ] **Step 3: Run it for real (manual gate — needs Docker + the image)**

Run:
```bash
docker build -t sds/microservice ./images/microservice   # if not already built
RUN_DOCKER=1 npm test -- src/engine/metrics.smoke.test.ts
```
Expected: PASS — two `sds/microservice` containers come up, `sample('pair')` returns ≥2 snapshots with finite `cpuPercent` ≥ 0 and `memMB` > 0, then the stack is torn down. If a leftover `sds-pair` project interferes, run `docker compose -p sds-pair down -v` first.

- [ ] **Step 4: Run the full default suite**

Run: `npm test`
Expected: PASS — all suites green; the metrics smoke (and the other smokes) show as skipped.

- [ ] **Step 5: Commit**

```bash
git add src/engine/metrics.smoke.test.ts
git commit -m "test: add gated real-docker metrics smoke"
```

---

## Self-Review

**Spec coverage** (design → task):
- dockerode source, `MetricsSnapshot`, pure `cpuPercent`/`memMB` with guards → Tasks 1 + 2.
- `StatsSource` seam (fake-able) + `MetricsCollector.sample` + `DockerodeStatsSource` (label filter) → Task 2.
- CLI `--metrics`/`--interval`, baseline sample + poll-during-`--load`, per-sample errors tolerated in the loop, baseline fail-loud → Task 3.
- Teardown-on-failure preserved (metrics inside the up→k6 try) → Task 3.
- Compiler + controller untouched → no task edits `src/compiler/**` or `controller.ts`.
- dockerode + @types/dockerode dependency → Task 2.
- Gated real-Docker smoke (≥2 snapshots, finite cpu ≥0, mem >0) → Task 4.

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `MetricsSnapshot{name,cpuPercent,memMB}` and `DockerStats` defined in Task 1, consumed by Task 2 (`MetricsCollector`, `cpuPercent`/`memMB`), Task 3 (`printSnaps`, `SimOptions.metrics`), Task 4 (smoke assertions). `StatsSource{list,stats}` + `ContainerRef{id,name}` defined Task 2, satisfied by `FakeStatsSource` (test) and `DockerodeStatsSource`. `MetricsCollector.sample(experimentId)` signature identical across Tasks 2–4. `SimOptions.metrics.collector` typed `Pick<MetricsCollector,'sample'>` so `StubCollector` fits. The k6 result-line + network-name strings match the current `cli.ts` (carried verbatim into the replacement).

**Not in this plan (intentional):** net I/O metrics, cAdvisor/Prometheus, WebSocket bridge, canvas UI, app `/metrics` scrape — all separate follow-ups per the design.
