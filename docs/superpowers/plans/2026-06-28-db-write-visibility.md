# DB Write-Visibility Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface live DB write activity in the SPA — a `N writes · +R/s` line on each db node badge and `Writes`/`Δ writes/s` columns in the Metrics table — sourced from postgres's cumulative insert counter over the existing metrics WebSocket.

**Architecture:** The agent's metrics WS (~1.5s tick) already pushes `container.stats` cpu/mem. This adds, per db node, a cheap `docker exec <db> psql … sum(n_tup_ins)` read (via the existing `Runner` seam) and attaches the raw count as `writes` on that service's frame. The SPA's `metrics-store` derives `writesPerSec` (with first-tick and stats-reset guards); the badge and Metrics table render it.

**Tech Stack:** Fastify + `@fastify/websocket` + `Runner` seam (agent), React + Zustand + `@xyflow/react` (web), vitest + RTL.

## Global Constraints

- Source query verbatim: `select coalesce(sum(n_tup_ins),0) from pg_stat_user_tables` (cumulative inserts across all user tables; O(1), schema-agnostic; NOT `count(*)`).
- Exec argv verbatim: `['docker','exec',<container>,'psql','-U','postgres','-tAc',<query>]`.
- WS frame entry shape: `{ service: string; cpuPercent: number; memMB: number; writes?: number }` — `writes` present only for db services; the wire carries the raw cumulative count, the SPA derives Δ/s.
- Label is **"writes"** (never "rows"). Node badge keeps the `/s` suffix (`+402/s`); the Metrics table puts the unit in the header (`Δ writes/s`) with bare cells (`+402`).
- Δ/s guards: first tick (no previous) → `writesPerSec` undefined (render `—`/omit); a decrease (stats reset) → clamp to `0` and re-baseline (never negative).
- Field mapping: `writes` undefined → `—`/no line; `writes: 0` → `0 writes`; `writes > 0` → count + delta.
- Failed/empty query → omit `writes` that tick (graceful); never kill the socket.
- Root ESM `.js` import suffixes; `web/` is its own package. NEVER add a `Co-Authored-By` trailer.

---

### Task 1: Agent — `dbWrites` helper

**Files:**
- Create: `src/agent/db-rows.ts`
- Test: `src/agent/db-rows.test.ts`

**Interfaces:**
- Consumes: `Runner` (`run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>`) from `../engine/runner.js`.
- Produces: `dbWrites(runner: Runner, container: string): Promise<number | undefined>`.

- [ ] **Step 1: Write the failing test**

Create `src/agent/db-rows.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { dbWrites } from './db-rows.js';
import type { Runner, RunResult } from '../engine/runner.js';

const runnerReturning = (res: RunResult): Runner => ({ async run() { return res; } });

describe('dbWrites', () => {
  it('parses the count from psql stdout', async () => {
    const n = await dbWrites(runnerReturning({ code: 0, stdout: '208803\n', stderr: '' }), 'sds-saga-orders-db-1');
    expect(n).toBe(208803);
  });

  it('runs psql with sum(n_tup_ins) inside the container', async () => {
    let argv: string[] = [];
    const runner: Runner = { async run(a) { argv = a; return { code: 0, stdout: '0\n', stderr: '' }; } };
    await dbWrites(runner, 'sds-x-db-1');
    expect(argv).toEqual([
      'docker', 'exec', 'sds-x-db-1', 'psql', '-U', 'postgres', '-tAc',
      'select coalesce(sum(n_tup_ins),0) from pg_stat_user_tables',
    ]);
  });

  it('returns undefined on non-zero exit', async () => {
    expect(await dbWrites(runnerReturning({ code: 1, stdout: '', stderr: 'err' }), 'c')).toBeUndefined();
  });

  it('returns undefined on non-numeric output', async () => {
    expect(await dbWrites(runnerReturning({ code: 0, stdout: 'ERROR: relation\n', stderr: '' }), 'c')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/agent/db-rows.test.ts`
Expected: FAIL — `./db-rows.js` does not exist.

- [ ] **Step 3: Create `src/agent/db-rows.ts`**

```ts
import type { Runner } from '../engine/runner.js';

const WRITES_SQL = 'select coalesce(sum(n_tup_ins),0) from pg_stat_user_tables';

/**
 * Total rows inserted ("writes") in a db container's postgres, read from the stats
 * collector's cumulative insert counter — cheap (no table scan, no observer effect),
 * monotonic except on a stats reset. Returns undefined if the query fails or the
 * output is not a number (db still starting, no tables yet).
 */
export async function dbWrites(runner: Runner, container: string): Promise<number | undefined> {
  const r = await runner.run(['docker', 'exec', container, 'psql', '-U', 'postgres', '-tAc', WRITES_SQL]);
  if (r.code !== 0) return undefined;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : undefined;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/agent/db-rows.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/db-rows.ts src/agent/db-rows.test.ts
git commit -m "feat: agent dbWrites helper (sum n_tup_ins via docker exec psql)"
```

---

### Task 2: Agent — attach `writes` to db frames in the metrics WS

**Files:**
- Modify: `src/agent/server.ts` (imports + the WS `push` closure)
- Test: `src/agent/metrics-ws.test.ts` (add one case)

**Interfaces:**
- Consumes: `dbWrites` (Task 1), `slugify` from `../compiler/util.js`, the existing `serviceName`, `deps.runner`, `rec.graph`.
- Produces: WS frame entries gain optional `writes` for db services only.

- [ ] **Step 1: Write the failing test**

Add this case inside the `describe('GET /api/metrics/:runId (websocket)', …)` block in `src/agent/metrics-ws.test.ts` (after the first `it`):

```ts
  it('attaches a writes count to db service frames only', async () => {
    const dbGraph: Graph = {
      experimentId: 'wdb',
      nodes: [
        { id: 'o', type: 'service', label: 'Order Service' },
        { id: 'k', type: 'kafka', label: 'Order Events' },
        { id: 'p', type: 'worker', label: 'Payment Worker' },
        { id: 'd', type: 'db', label: 'Orders DB' },
      ],
      edges: [{ source: 'o', target: 'k' }, { source: 'p', target: 'k' }, { source: 'p', target: 'd' }],
    };
    class DbStats implements StatsSource {
      async list(): Promise<ContainerRef[]> {
        return [
          { id: 'c1', name: 'sds-wdb-order-service-1' },
          { id: 'c2', name: 'sds-wdb-orders-db-1' },
        ];
      }
      async stats(): Promise<DockerStats> { return stat(); }
    }
    class CountRunner implements Runner {
      async run(argv: string[]): Promise<RunResult> {
        if (argv.includes('psql')) return { code: 0, stdout: '4242\n', stderr: '' };
        if (argv.includes('inspect')) return { code: 0, stdout: '', stderr: '' };
        if (argv.includes('ps')) return { code: 0, stdout: '[]', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    const runRoot = mkdtempSync(join(tmpdir(), 'sds-ws-'));
    const { app, runs } = buildServer({ runner: new CountRunner(), runRoot, statsSource: new DbStats() });
    try {
      await app.inject({ method: 'POST', url: '/api/run', payload: { graph: dbGraph } });
      await runs.get('wdb')!.task;
      const addr = await app.listen({ port: 0, host: '127.0.0.1' });
      const ws = new WebSocket(`${addr.replace('http', 'ws')}/api/metrics/wdb`);
      const frame = await new Promise<string>((resolve, reject) => {
        ws.on('message', (d) => resolve(d.toString()));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('no frame')), 5000);
      });
      const parsed = JSON.parse(frame) as Array<{ service: string; cpuPercent: number; memMB: number; writes?: number }>;
      expect(parsed.find((p) => p.service === 'orders-db')!.writes).toBe(4242);
      expect(parsed.find((p) => p.service === 'order-service')!.writes).toBeUndefined();
      ws.close();
    } finally {
      await app.close();
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 15000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/agent/metrics-ws.test.ts`
Expected: FAIL — `orders-db` frame entry has no `writes` (currently undefined; expected `4242`).

- [ ] **Step 3: Add imports in `src/agent/server.ts`**

After the existing `import { serviceName } from './metrics-stream.js';` line, add:

```ts
import { slugify } from '../compiler/util.js';
import { dbWrites } from './db-rows.js';
```

- [ ] **Step 4: Attach `writes` in the WS handler**

In `src/agent/server.ts`, replace the WS handler's body (the block starting `const { runId } = …` through the existing `socket.on('close', …)`) so the `push` closure attaches writes for db containers. Replace the existing `push` definition:

```ts
      const push = async () => {
        try {
          const snaps = await collector.sample(runId);
          socket.send(JSON.stringify(snaps.map((s) => ({ service: serviceName(s.name, runId), cpuPercent: s.cpuPercent, memMB: s.memMB }))));
        } catch {
          /* transient stats error: skip this tick */
        }
      };
```

with:

```ts
      const dbSlugs = new Set(rec.graph.nodes.filter((n) => n.type === 'db').map((n) => slugify(n.label)));
      const push = async () => {
        try {
          const snaps = await collector.sample(runId);
          const frame = await Promise.all(
            snaps.map(async (s) => {
              const service = serviceName(s.name, runId);
              const entry: { service: string; cpuPercent: number; memMB: number; writes?: number } = {
                service, cpuPercent: s.cpuPercent, memMB: s.memMB,
              };
              if (dbSlugs.has(service)) {
                const w = await dbWrites(deps.runner, s.name);
                if (w !== undefined) entry.writes = w;
              }
              return entry;
            }),
          );
          socket.send(JSON.stringify(frame));
        } catch {
          /* transient stats / exec error: skip this tick */
        }
      };
```

(`rec` and `deps` are already in scope in the handler closure.)

- [ ] **Step 5: Run the WS suite + full root suite**

Run: `npx vitest run src/agent/metrics-ws.test.ts && npm test`
Expected: PASS — the new db-frame case plus the two existing WS cases; whole root suite green (gated smokes skipped).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: `tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add src/agent/server.ts src/agent/metrics-ws.test.ts
git commit -m "feat: stream per-db writes count over the metrics websocket"
```

---

### Task 3: SPA — `metrics-store` writes + derived Δ/s

**Files:**
- Modify: `web/src/metrics-store.ts`
- Test: `web/src/metrics-store.test.ts` (add a describe block)

**Interfaces:**
- Produces: `ServiceMetric` gains `writes?: number` and `writesPerSec?: number`; `byService` entries gain `writes?`/`writesPerSec?`; store state gains `lastT?: number`. `setSnapshot` derives `writesPerSec` with first-tick and decrease guards; `clear()` resets `byService` + `lastT`.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/metrics-store.test.ts`:

```ts
import { vi } from 'vitest';

describe('metrics-store writes Δ/s', () => {
  beforeEach(() => useMetricsStore.setState({ byService: {}, lastT: undefined }));

  it('keeps the writes count but no delta on the first snapshot', () => {
    useMetricsStore.getState().setSnapshot([{ service: 'db-1', cpuPercent: 1, memMB: 1, writes: 100 }]);
    const e = useMetricsStore.getState().byService['db-1']!;
    expect(e.writes).toBe(100);
    expect(e.writesPerSec).toBeUndefined();
  });

  it('computes a positive rate on the next snapshot', () => {
    const t0 = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    useMetricsStore.getState().setSnapshot([{ service: 'db-1', cpuPercent: 1, memMB: 1, writes: 100 }]);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 2000); // +2s
    useMetricsStore.getState().setSnapshot([{ service: 'db-1', cpuPercent: 1, memMB: 1, writes: 900 }]);
    expect(useMetricsStore.getState().byService['db-1']!.writesPerSec).toBeCloseTo(400, 0); // (900-100)/2
    vi.restoreAllMocks();
  });

  it('clamps the rate to 0 on a decrease (stats reset)', () => {
    const t0 = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    useMetricsStore.getState().setSnapshot([{ service: 'db-1', cpuPercent: 1, memMB: 1, writes: 900 }]);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 1500);
    useMetricsStore.getState().setSnapshot([{ service: 'db-1', cpuPercent: 1, memMB: 1, writes: 5 }]);
    expect(useMetricsStore.getState().byService['db-1']!.writesPerSec).toBe(0);
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix web run test -- metrics-store`
Expected: FAIL — `writes`/`writesPerSec` are not on the store entries; `setState({ …, lastT })` is not yet a valid field.

- [ ] **Step 3: Replace `web/src/metrics-store.ts`**

```ts
import { create } from 'zustand';

export interface ServiceMetric {
  service: string;
  cpuPercent: number;
  memMB: number;
  writes?: number;        // raw cumulative insert count (db services only)
  writesPerSec?: number;  // derived; absent on the wire
}

interface MetricEntry {
  cpuPercent: number;
  memMB: number;
  writes?: number;
  writesPerSec?: number;
}

interface MetricsState {
  byService: Record<string, MetricEntry>;
  lastT?: number; // wall-clock of the previous snapshot, for Δ/s
  setSnapshot(list: ServiceMetric[]): void;
  clear(): void;
}

export const useMetricsStore = create<MetricsState>((set, get) => ({
  byService: {},
  lastT: undefined,
  setSnapshot: (list) => {
    const now = Date.now();
    const prev = get().byService;
    const prevT = get().lastT;
    const byService: Record<string, MetricEntry> = {};
    for (const m of list) {
      const entry: MetricEntry = { cpuPercent: m.cpuPercent, memMB: m.memMB };
      if (m.writes !== undefined) {
        entry.writes = m.writes;
        const p = prev[m.service];
        if (p?.writes === undefined || prevT === undefined) {
          // first tick for this service — no delta yet
        } else if (m.writes < p.writes) {
          entry.writesPerSec = 0; // stats reset / crash recovery — re-baseline, never negative
        } else {
          const dt = (now - prevT) / 1000;
          entry.writesPerSec = dt > 0 ? (m.writes - p.writes) / dt : 0;
        }
      }
      byService[m.service] = entry;
    }
    set({ byService, lastT: now });
  },
  clear: () => set({ byService: {}, lastT: undefined }),
}));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix web run test -- metrics-store`
Expected: PASS — the new writes cases plus the pre-existing set/clear cases.

- [ ] **Step 5: Commit**

```bash
git add web/src/metrics-store.ts web/src/metrics-store.test.ts
git commit -m "feat(web): metrics-store tracks per-db writes + derived writes/s"
```

---

### Task 4: SPA — writes line on the badge + Metrics columns

**Files:**
- Modify: `web/src/nodes/NodeMetricBadge.tsx`, `web/src/nodes/NodeMetricBadge.test.tsx`
- Modify: `web/src/Drawer.tsx`, `web/src/Drawer.test.tsx`
- Modify: `web/src/App.tsx` (map `writes`/`writesPerSec` into the Drawer `metrics` prop)

**Interfaces:**
- Consumes: `MetricEntry` shape from Task 3 (`{ cpuPercent; memMB; writes?; writesPerSec? }`) via `useMetricsStore`; `ServiceMetric` (now with `writes?`/`writesPerSec?`).
- Produces: db badges render `N writes · +R/s`; Drawer Metrics table gains `Writes`/`Δ writes/s` columns.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/nodes/NodeMetricBadge.test.tsx` (inside the `describe`):

```ts
  it('renders a writes line with delta for a db metric', () => {
    render(<NodeMetricBadge metric={{ cpuPercent: 5, memMB: 50, writes: 1234, writesPerSec: 402 }} />);
    expect(screen.getByText(/1,234 writes/)).toBeInTheDocument();
    expect(screen.getByText(/\+402\/s/)).toBeInTheDocument();
  });
  it('omits the delta on the first tick (writesPerSec undefined)', () => {
    render(<NodeMetricBadge metric={{ cpuPercent: 5, memMB: 50, writes: 1234 }} />);
    expect(screen.getByText(/1,234 writes/)).toBeInTheDocument();
    expect(screen.queryByText(/\/s/)).toBeNull();
  });
  it('renders no writes line for a non-db metric', () => {
    render(<NodeMetricBadge metric={{ cpuPercent: 5, memMB: 50 }} />);
    expect(screen.queryByText(/writes/)).toBeNull();
  });
```

Add to `web/src/Drawer.test.tsx` (inside the `describe`):

```ts
  it('renders Writes and Δ columns for a db row, — for a non-db row', () => {
    const m = [
      { service: 'order-service', cpuPercent: 12, memMB: 48 },
      { service: 'db-1', cpuPercent: 17, memMB: 97, writes: 208803, writesPerSec: 402 },
    ];
    render(<Drawer open tab="metrics" onToggle={() => {}} onSelectTab={() => {}} compose="" status={null} logs="" metrics={m} lastLoad={null} />);
    expect(screen.getByText(/208,803/)).toBeInTheDocument();
    expect(screen.getByText(/\+402/)).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0); // non-db writes/Δ cells
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix web run test -- NodeMetricBadge Drawer`
Expected: FAIL — badge has no writes line; Drawer has no Writes/Δ columns; `208,803` not found.

- [ ] **Step 3: Replace `web/src/nodes/NodeMetricBadge.tsx`**

```tsx
export function NodeMetricBadge({
  metric,
}: {
  metric: { cpuPercent: number; memMB: number; writes?: number; writesPerSec?: number } | undefined;
}) {
  if (!metric) return null;
  return (
    <div className="px-2 pb-1.5">
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span>cpu {metric.cpuPercent.toFixed(0)}%</span>
        <span>{metric.memMB.toFixed(0)}MB</span>
      </div>
      <div className="mt-0.5 h-1 rounded bg-slate-200">
        <div className="h-full rounded bg-blue-500" style={{ width: `${Math.min(100, metric.cpuPercent)}%` }} />
      </div>
      {metric.writes !== undefined && (
        <div className="mt-1 flex items-center justify-between border-t border-slate-100 pt-1 text-[10px]">
          <span className="font-semibold text-slate-700">{metric.writes.toLocaleString()} writes</span>
          {metric.writesPerSec !== undefined && (
            <span className={metric.writesPerSec > 0 ? 'font-semibold text-emerald-600' : 'text-slate-400'}>
              +{metric.writesPerSec.toFixed(0)}/s
            </span>
          )}
        </div>
      )}
    </div>
  );
}
```

(`SdsNode.tsx` needs no change — it already passes the whole `byService[slug]` entry, which now carries `writes`/`writesPerSec`, to `NodeMetricBadge`.)

- [ ] **Step 4: Add the Writes columns in `web/src/Drawer.tsx`**

Replace the metrics-tab `<table>` (the `tab === 'metrics'` branch's non-empty table) so the header and rows include the two new columns:

```tsx
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-slate-400"><tr><th className="py-1">Service</th><th>CPU %</th><th>Mem</th><th>Writes</th><th>Δ writes/s</th></tr></thead>
                  <tbody className="font-mono">
                    {metrics.map((m) => (
                      <tr key={m.service} className="border-t border-slate-100">
                        <td className="py-1">{m.service}</td>
                        <td>{m.cpuPercent.toFixed(1)}</td>
                        <td>{m.memMB.toFixed(0)} MB</td>
                        <td>{m.writes !== undefined ? m.writes.toLocaleString() : '—'}</td>
                        <td>{m.writesPerSec !== undefined ? `+${m.writesPerSec.toFixed(0)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
```

- [ ] **Step 5: Pass `writes`/`writesPerSec` from `web/src/App.tsx`**

Change the Drawer `metrics={…}` mapping (currently maps `service`/`cpuPercent`/`memMB`) to:

```tsx
        metrics={Object.entries(metricsByService).map(([service, m]) => ({ service, cpuPercent: m.cpuPercent, memMB: m.memMB, writes: m.writes, writesPerSec: m.writesPerSec }))}
```

- [ ] **Step 6: Run the web suite to verify it passes**

Run: `npm --prefix web run test`
Expected: PASS — NodeMetricBadge (incl. writes cases), Drawer (incl. Writes columns), and all pre-existing web suites.

- [ ] **Step 7: Typecheck + build**

Run: `(cd web && npx tsc --noEmit) && npm --prefix web run build`
Expected: `tsc` clean; `web/dist/index.html` produced.

- [ ] **Step 8: Commit**

```bash
git add web/src/nodes/NodeMetricBadge.tsx web/src/nodes/NodeMetricBadge.test.tsx web/src/Drawer.tsx web/src/Drawer.test.tsx web/src/App.tsx
git commit -m "feat(web): db write badge line + Metrics table Writes/Δ columns"
```

---

## Self-Review

**Spec coverage:**
- `dbWrites` via `docker exec psql sum(n_tup_ins)`, undefined on failure → Task 1. ✅
- Metrics WS attaches `writes` for db services only (db slugs from `rec.graph`) → Task 2. ✅
- WS frame `{ service, cpuPercent, memMB, writes? }`, raw count on the wire → Task 2. ✅
- `metrics-store` `writes` + derived `writesPerSec` with first-tick (undefined) + decrease (0, re-baseline) guards → Task 3. ✅
- Badge writes line (db only, label "writes", `/s` suffix; no delta on first tick) → Task 4. ✅
- Drawer `Writes` + `Δ writes/s` columns (unit in header, bare cells, `—` for non-db) → Task 4. ✅
- Graceful omit on failed query; socket never killed (existing try/catch retained) → Task 2. ✅
- Out of scope (table filtering, worker-counter reach, charts) → not present. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step has the exact command + expected output.

**Type consistency:** WS frame `{ service, cpuPercent, memMB, writes? }` is identical in the agent send (Task 2), `ServiceMetric` (Task 3), and the Drawer `metrics` prop (Task 4). `MetricEntry` `{ cpuPercent, memMB, writes?, writesPerSec? }` (Task 3) matches `NodeMetricBadge`'s `metric` prop (Task 4) and the App mapping (Task 4). `dbWrites(runner, container): Promise<number | undefined>` (Task 1) is the exact signature called in Task 2. `lastT?: number` added to `MetricsState` (Task 3) is set/cleared consistently. Label is "writes" everywhere; the table header carries `Δ writes/s` while the badge uses `+N/s`.
