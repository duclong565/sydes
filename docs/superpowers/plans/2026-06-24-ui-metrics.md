# UI Brick 4 — Live Metric Badges over WebSocket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream live per-service CPU/mem from the agent to the SPA over a WebSocket and show it as badges on the canvas nodes + a real Metrics drawer tab.

**Architecture:** The agent adds `@fastify/websocket` and a `GET /api/metrics/:runId` WS that pushes `[{service,cpuPercent,memMB}]` (~1.5s) from the existing `MetricsCollector`/`StatsSource`. The SPA holds metrics in a small Zustand `metrics-store`, opens the WS while the run is `running`, overlays a CPU/mem badge on each `SdsNode` (matched by `slugify(label)`), and shows a per-service table in a new Metrics drawer tab.

**Tech Stack:** Fastify + `@fastify/websocket` (agent), dockerode `container.stats` (engine, existing), React + Zustand + `@xyflow/react` (web), vitest + RTL.

## Global Constraints

- Transport is WebSocket (`@fastify/websocket`); push-only, ~1500ms cadence, plus one immediate frame on connect. No SSE, no HTTP-poll for metrics.
- Scope: live CPU%/mem only. No k6 throughput/latency, no load-config UI (out of scope).
- Engine `StatsSource` seam reused: agent injects `DockerodeStatsSource` (real) or a fake (tests) — no Docker in unit tests.
- Root package is ESM with `.js` import suffixes; root vitest runs `src/**/*.test.ts`. `web/` is its own package (`npm --prefix web run test`/`build`); ESM `.js` suffixes there too.
- jsdom has no `WebSocket` — SPA WS tests stub `global.WebSocket`.
- WS message shape is exactly `{ service: string; cpuPercent: number; memMB: number }[]`, consistent agent → store → Drawer → SdsNode.
- NEVER add a `Co-Authored-By` trailer to commits.

---

### Task 1: Agent — `@fastify/websocket` + `serviceName` + WS `/api/metrics/:runId`

**Files:**
- Modify: `package.json` (add `@fastify/websocket`)
- Create: `src/agent/metrics-stream.ts`
- Modify: `src/agent/server.ts`
- Test: `src/agent/metrics-stream.test.ts`, `src/agent/metrics-ws.test.ts`

**Interfaces:**
- Produces: `serviceName(containerName: string, runId: string): string`. `AgentDeps` gains `statsSource?: StatsSource`. New WS route `GET /api/metrics/:runId` pushing `JSON.stringify([{ service, cpuPercent, memMB }])`.

- [ ] **Step 1: Install the dep**

Run: `npm install @fastify/websocket`
Expected: `@fastify/websocket` in `package.json` dependencies (it bundles `ws`, used by the test).

- [ ] **Step 2: Write the failing `serviceName` test**

Create `src/agent/metrics-stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { serviceName } from './metrics-stream.js';

describe('serviceName', () => {
  it('strips the sds-<runId>- prefix and -<n> replica suffix', () => {
    expect(serviceName('sds-saga-order-service-1', 'saga')).toBe('order-service');
    expect(serviceName('sds-saga-orders-db-1', 'saga')).toBe('orders-db');
    expect(serviceName('sds-saga-order-events-2', 'saga')).toBe('order-events');
  });
  it('tolerates names without the expected shape', () => {
    expect(serviceName('weird', 'saga')).toBe('weird');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/agent/metrics-stream.test.ts`
Expected: FAIL — `./metrics-stream.js` does not exist.

- [ ] **Step 4: Create `src/agent/metrics-stream.ts`**

```ts
/** Maps a compose container name (`sds-<runId>-<service>-<n>`) to its service slug. */
export function serviceName(containerName: string, runId: string): string {
  const prefix = `sds-${runId}-`;
  const stripped = containerName.startsWith(prefix) ? containerName.slice(prefix.length) : containerName;
  return stripped.replace(/-\d+$/, '');
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/agent/metrics-stream.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing WS integration test**

Create `src/agent/metrics-ws.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { buildServer } from './server.js';
import type { Runner, RunResult } from '../engine/runner.js';
import type { StatsSource, ContainerRef, DockerStats } from '../engine/metrics.js';
import type { Graph } from '../compiler/types.js';

class FakeRunner implements Runner {
  async run(argv: string[]): Promise<RunResult> {
    if (argv.includes('inspect')) return { code: 0, stdout: '', stderr: '' };
    if (argv.includes('ps')) return { code: 0, stdout: '[]', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }
}

// Canned stats that yield a positive cpuPercent.
function stat(): DockerStats {
  return {
    cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 1 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    memory_stats: { usage: 50 * 1024 * 1024 },
  };
}
class FakeStats implements StatsSource {
  async list(): Promise<ContainerRef[]> { return [{ id: 'c1', name: 'sds-saga-order-service-1' }]; }
  async stats(): Promise<DockerStats> { return stat(); }
}

const sagaGraph: Graph = {
  experimentId: 'saga',
  nodes: [
    { id: 'o', type: 'service', label: 'Order Service' },
    { id: 'k', type: 'kafka', label: 'Order Events' },
    { id: 'p', type: 'worker', label: 'Payment Worker' },
  ],
  edges: [{ source: 'o', target: 'k' }, { source: 'p', target: 'k' }],
};

describe('GET /api/metrics/:runId (websocket)', () => {
  it('pushes a per-service metric frame for a running experiment', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'sds-ws-'));
    const { app, runs } = buildServer({ runner: new FakeRunner(), runRoot, statsSource: new FakeStats() });
    try {
      await app.inject({ method: 'POST', url: '/api/run', payload: { graph: sagaGraph } });
      await runs.get('saga')!.task; // background run -> state 'running'
      const addr = await app.listen({ port: 0, host: '127.0.0.1' });
      const ws = new WebSocket(`${addr.replace('http', 'ws')}/api/metrics/saga`);
      const frame = await new Promise<string>((resolve, reject) => {
        ws.on('message', (d) => resolve(d.toString()));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('no frame')), 5000);
      });
      const parsed = JSON.parse(frame) as Array<{ service: string; cpuPercent: number; memMB: number }>;
      expect(parsed[0]!.service).toBe('order-service');
      expect(parsed[0]!.cpuPercent).toBeGreaterThan(0);
      expect(parsed[0]!.memMB).toBeCloseTo(50, 0);
      ws.close();
    } finally {
      await app.close();
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 15000);

  it('closes the socket for an unknown run', async () => {
    const { app } = buildServer({ runner: new FakeRunner(), statsSource: new FakeStats() });
    try {
      const addr = await app.listen({ port: 0, host: '127.0.0.1' });
      const ws = new WebSocket(`${addr.replace('http', 'ws')}/api/metrics/nope`);
      await new Promise<void>((resolve, reject) => {
        ws.on('close', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket stayed open')), 5000);
      });
    } finally {
      await app.close();
    }
  }, 15000);
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/agent/metrics-ws.test.ts`
Expected: FAIL — no `/api/metrics` route (connection rejected / no frame).

- [ ] **Step 8: Wire the agent in `src/agent/server.ts`**

Add imports (after the existing imports):

```ts
import fastifyWebsocket from '@fastify/websocket';
import { MetricsCollector, DockerodeStatsSource, type StatsSource } from '../engine/metrics.js';
import { serviceName } from './metrics-stream.js';
```

Extend `AgentDeps`:

```ts
export interface AgentDeps {
  runner: Runner;
  compile?: typeof compileFn;
  runRoot?: string;
  examplesDir?: string;
  statsSource?: StatsSource;
}
```

Inside `buildServer`, after `const k6 = new K6Runner(deps.runner);` add:

```ts
  const collector = new MetricsCollector(deps.statsSource ?? new DockerodeStatsSource());
  app.register(fastifyWebsocket);
```

Then add the WS route immediately after the `/api/logs/:runId` handler (before the `const distDir` block):

```ts
  app.get('/api/metrics/:runId', { websocket: true }, (socket, req) => {
    const { runId } = req.params as { runId: string };
    const rec = runs.get(runId);
    if (!rec || rec.state !== 'running') {
      socket.close();
      return;
    }
    const push = async () => {
      try {
        const snaps = await collector.sample(runId);
        socket.send(JSON.stringify(snaps.map((s) => ({ service: serviceName(s.name, runId), cpuPercent: s.cpuPercent, memMB: s.memMB }))));
      } catch {
        /* transient stats error: skip this tick */
      }
    };
    void push(); // immediate first frame
    const timer = setInterval(() => {
      if (rec.state !== 'running') {
        clearInterval(timer);
        socket.close();
        return;
      }
      void push();
    }, 1500);
    socket.on('close', () => clearInterval(timer));
  });
```

> **Version note:** this uses the `@fastify/websocket` v11 handler signature `(socket, req)` where `socket` is the raw `ws` WebSocket (`socket.send/close/on`). If `npm install` resolved an older major whose handler is `(connection, req)` with `connection.socket`, adapt the handler to destructure `connection.socket` — the WS integration test (Step 7) will tell you which is correct.

- [ ] **Step 9: Run the WS tests + full suite to verify they pass**

Run: `npx vitest run src/agent/metrics-ws.test.ts && npm test`
Expected: PASS (both WS cases; whole root suite green, gated smokes skipped).

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/agent/metrics-stream.ts src/agent/metrics-stream.test.ts src/agent/server.ts src/agent/metrics-ws.test.ts
git commit -m "feat: agent /api/metrics websocket streaming per-service cpu/mem"
```

---

### Task 2: SPA `metrics-store` + `slug`

**Files:**
- Create: `web/src/metrics-store.ts`, `web/src/slug.ts`
- Test: `web/src/metrics-store.test.ts`, `web/src/slug.test.ts`

**Interfaces:**
- Produces: `ServiceMetric = { service: string; cpuPercent: number; memMB: number }`; `useMetricsStore` (Zustand) with `byService: Record<string, { cpuPercent: number; memMB: number }>`, `setSnapshot(list: ServiceMetric[])`, `clear()`. `slugify(label: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/slug.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { slugify } from './slug.js';

describe('slugify', () => {
  it('lowercases and dashes spaces', () => {
    expect(slugify('Order Service')).toBe('order-service');
    expect(slugify('Orders DB')).toBe('orders-db');
  });
  it('collapses and trims separators', () => {
    expect(slugify('  Payment   Worker!! ')).toBe('payment-worker');
  });
});
```

Create `web/src/metrics-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useMetricsStore } from './metrics-store.js';

beforeEach(() => useMetricsStore.setState({ byService: {} }));

describe('metrics-store', () => {
  it('setSnapshot keys metrics by service', () => {
    useMetricsStore.getState().setSnapshot([
      { service: 'order-service', cpuPercent: 12, memMB: 48 },
      { service: 'payment-worker', cpuPercent: 5, memMB: 30 },
    ]);
    const { byService } = useMetricsStore.getState();
    expect(byService['order-service']).toEqual({ cpuPercent: 12, memMB: 48 });
    expect(byService['payment-worker']!.memMB).toBe(30);
  });
  it('clear empties the store', () => {
    useMetricsStore.getState().setSnapshot([{ service: 'x', cpuPercent: 1, memMB: 1 }]);
    useMetricsStore.getState().clear();
    expect(useMetricsStore.getState().byService).toEqual({});
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix web run test`
Expected: FAIL — `./slug.js` / `./metrics-store.js` do not exist.

- [ ] **Step 3: Create `web/src/slug.ts`**

```ts
/** Slugify a node label the same way the compiler does (for matching metric service keys). */
export function slugify(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 4: Create `web/src/metrics-store.ts`**

```ts
import { create } from 'zustand';

export interface ServiceMetric {
  service: string;
  cpuPercent: number;
  memMB: number;
}

interface MetricsState {
  byService: Record<string, { cpuPercent: number; memMB: number }>;
  setSnapshot(list: ServiceMetric[]): void;
  clear(): void;
}

export const useMetricsStore = create<MetricsState>((set) => ({
  byService: {},
  setSnapshot: (list) =>
    set({ byService: Object.fromEntries(list.map((m) => [m.service, { cpuPercent: m.cpuPercent, memMB: m.memMB }])) }),
  clear: () => set({ byService: {} }),
}));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix web run test`
Expected: PASS (slug + metrics-store).

- [ ] **Step 6: Commit**

```bash
git add web/src/slug.ts web/src/slug.test.ts web/src/metrics-store.ts web/src/metrics-store.test.ts
git commit -m "feat(web): metrics store + slug util"
```

---

### Task 3: `NodeMetricBadge` + `SdsNode` badge + Drawer Metrics tab

**Files:**
- Create: `web/src/nodes/NodeMetricBadge.tsx`, `web/src/nodes/NodeMetricBadge.test.tsx`
- Modify: `web/src/nodes/SdsNode.tsx`
- Modify: `web/src/Drawer.tsx`, `web/src/Drawer.test.tsx`

**Interfaces:**
- Consumes: `useMetricsStore`, `slugify` (Task 2).
- Produces: `NodeMetricBadge` (props `{ metric: { cpuPercent: number; memMB: number } | undefined }`). `SdsNode` shows the badge for `slugify(data.label)`. `DrawerTab` widened to `'compose' | 'status' | 'logs' | 'metrics'`; `Drawer` gains a required `metrics: ServiceMetric[]` prop + a real Metrics tab.

- [ ] **Step 1: Write the failing tests**

Create `web/src/nodes/NodeMetricBadge.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeMetricBadge } from './NodeMetricBadge.js';

describe('NodeMetricBadge', () => {
  it('renders nothing without a metric', () => {
    const { container } = render(<NodeMetricBadge metric={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('renders cpu and mem', () => {
    render(<NodeMetricBadge metric={{ cpuPercent: 12.4, memMB: 48.9 }} />);
    expect(screen.getByText(/cpu 12%/i)).toBeInTheDocument();
    expect(screen.getByText(/49MB/)).toBeInTheDocument();
  });
});
```

Replace `web/src/Drawer.test.tsx` with (adds `metrics` prop + a Metrics-tab test):

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Drawer } from './Drawer.js';

const status = {
  runId: 'saga', state: 'running' as const,
  services: [{ name: 'order-service', state: 'running', health: undefined }],
};
const metrics = [{ service: 'order-service', cpuPercent: 12, memMB: 48 }];

describe('Drawer', () => {
  it('shows compose content when open on the compose tab', () => {
    render(<Drawer open tab="compose" onToggle={() => {}} onSelectTab={() => {}} compose="services: {}" status={null} logs="" metrics={[]} />);
    expect(screen.getByText(/services:/)).toBeInTheDocument();
  });

  it('hides pane content when collapsed', () => {
    render(<Drawer open={false} tab="compose" onToggle={() => {}} onSelectTab={() => {}} compose="services: {}" status={null} logs="" metrics={[]} />);
    expect(screen.queryByText(/services:/)).toBeNull();
  });

  it('calls onSelectTab when the Status tab is clicked', async () => {
    const onSelectTab = vi.fn();
    render(<Drawer open tab="compose" onToggle={() => {}} onSelectTab={onSelectTab} compose="" status={status} logs="" metrics={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(onSelectTab).toHaveBeenCalledWith('status');
  });

  it('renders the service rows on the status tab', () => {
    render(<Drawer open tab="status" onToggle={() => {}} onSelectTab={() => {}} compose="" status={status} logs="" metrics={[]} />);
    expect(screen.getByText('order-service')).toBeInTheDocument();
  });

  it('renders log lines on the logs tab', () => {
    render(<Drawer open tab="logs" onToggle={() => {}} onSelectTab={() => {}} compose="" status={null} logs="worker | consumed 1" metrics={[]} />);
    expect(screen.getByText(/consumed 1/)).toBeInTheDocument();
  });

  it('renders metric rows on the metrics tab and lets you select it', async () => {
    const onSelectTab = vi.fn();
    render(<Drawer open tab="metrics" onToggle={() => {}} onSelectTab={onSelectTab} compose="" status={null} logs="" metrics={metrics} />);
    expect(screen.getByText('order-service')).toBeInTheDocument();
    expect(screen.getByText(/48/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Metrics' }));
    expect(onSelectTab).toHaveBeenCalledWith('metrics');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix web run test`
Expected: FAIL — `./nodes/NodeMetricBadge.js` missing; `Drawer` has no Metrics tab / rejects the `metrics` prop.

- [ ] **Step 3: Create `web/src/nodes/NodeMetricBadge.tsx`**

```tsx
export function NodeMetricBadge({ metric }: { metric: { cpuPercent: number; memMB: number } | undefined }) {
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
    </div>
  );
}
```

- [ ] **Step 4: Wire the badge into `web/src/nodes/SdsNode.tsx`**

Replace the file with:

```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AppNode, NodeType } from '../store.js';
import { useMetricsStore } from '../metrics-store.js';
import { slugify } from '../slug.js';
import { NodeMetricBadge } from './NodeMetricBadge.js';

const HEADER: Record<NodeType, string> = {
  service: 'bg-blue-500', kafka: 'bg-amber-500', worker: 'bg-violet-500', db: 'bg-emerald-500', lb: 'bg-slate-500',
};
const BORDER: Record<NodeType, string> = {
  service: 'border-blue-300', kafka: 'border-amber-300', worker: 'border-violet-300', db: 'border-emerald-300', lb: 'border-slate-300',
};

export function SdsNode({ data }: NodeProps<AppNode>) {
  const metric = useMetricsStore((s) => s.byService[slugify(data.label)]);
  return (
    <div className={`w-40 rounded-md border bg-white shadow-sm ${BORDER[data.type]}`}>
      <Handle type="target" position={Position.Left} />
      <div className={`rounded-t-md px-2 py-0.5 text-[10px] font-semibold uppercase text-white ${HEADER[data.type]}`}>
        {data.type}
      </div>
      <div className="px-2 py-2 text-sm">{data.label}</div>
      <NodeMetricBadge metric={metric} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
```

- [ ] **Step 5: Add the Metrics tab to `web/src/Drawer.tsx`**

Replace the file with:

```tsx
import type { RunStatus } from './api.js';
import type { ServiceMetric } from './metrics-store.js';

export type DrawerTab = 'compose' | 'status' | 'logs' | 'metrics';

interface DrawerProps {
  open: boolean;
  tab: DrawerTab;
  onToggle(): void;
  onSelectTab(tab: DrawerTab): void;
  compose: string;
  status: RunStatus | null;
  logs: string;
  metrics: ServiceMetric[];
}

function TabButton({ tab, active, onSelect, children }: { tab: DrawerTab; active: boolean; onSelect(t: DrawerTab): void; children: string }) {
  return (
    <button
      onClick={() => onSelect(tab)}
      className={`px-3 py-1.5 text-sm ${active ? 'border-b-2 border-blue-500 font-semibold' : 'text-slate-500'}`}
    >
      {children}
    </button>
  );
}

export function Drawer({ open, tab, onToggle, onSelectTab, compose, status, logs, metrics }: DrawerProps) {
  return (
    <div className="shrink-0 border-t border-slate-200 bg-white">
      <div className="flex items-center px-2">
        <TabButton tab="compose" active={tab === 'compose'} onSelect={onSelectTab}>Compose</TabButton>
        <TabButton tab="status" active={tab === 'status'} onSelect={onSelectTab}>Status</TabButton>
        <TabButton tab="logs" active={tab === 'logs'} onSelect={onSelectTab}>Logs</TabButton>
        <TabButton tab="metrics" active={tab === 'metrics'} onSelect={onSelectTab}>Metrics</TabButton>
        <div className="flex-1" />
        <button onClick={onToggle} className="px-2 py-1 text-sm text-slate-500">
          {open ? '▾ collapse' : '▴ expand'}
        </button>
      </div>

      {open && (
        <div className="max-h-[34vh] overflow-auto p-3">
          {tab === 'compose' && (
            <pre className="max-h-[28vh] overflow-auto rounded bg-slate-900 p-3 text-[11px] leading-snug text-slate-100">
              {compose || '(press Preview to compile the canvas)'}
            </pre>
          )}
          {tab === 'logs' && (
            <pre className="max-h-[28vh] overflow-auto rounded bg-slate-900 p-3 text-[11px] leading-snug text-slate-100">
              {logs || '(no logs yet — run an experiment)'}
            </pre>
          )}
          {tab === 'metrics' && (
            metrics.length === 0 ? (
              <div className="text-sm text-slate-400">(no live metrics — run an experiment)</div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-slate-400"><tr><th className="py-1">Service</th><th>CPU %</th><th>Mem</th></tr></thead>
                <tbody className="font-mono">
                  {metrics.map((m) => (
                    <tr key={m.service} className="border-t border-slate-100"><td className="py-1">{m.service}</td><td>{m.cpuPercent.toFixed(1)}</td><td>{m.memMB.toFixed(0)} MB</td></tr>
                  ))}
                </tbody>
              </table>
            )
          )}
          {tab === 'status' && (!status ? (
            <div className="text-sm text-slate-400">(press Run to start the experiment)</div>
          ) : (
            <div>
              <div className="mb-2 text-sm">State: <span className="font-mono">{status.state}</span>{status.error ? ` — ${status.error}` : ''}</div>
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-slate-400"><tr><th className="py-1">Service</th><th>State</th><th>Health</th></tr></thead>
                <tbody className="font-mono">
                  {status.services.map((s) => (
                    <tr key={s.name} className="border-t border-slate-100"><td className="py-1">{s.name}</td><td>{s.state}</td><td>{s.health ?? '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix web run test`
Expected: PASS (NodeMetricBadge + Drawer + earlier suites). Note: the existing `App.test.tsx` renders `<Drawer>` without `metrics` — at runtime `metrics` is `undefined` and `metrics.length` would throw ONLY if the metrics tab renders; the brick-3 App never selects the metrics tab and the prop is read only inside `tab === 'metrics'`, so App.test stays green until Task 4 passes the prop. If any App test does fail here, it is resolved in Task 4.

- [ ] **Step 7: Commit**

```bash
git add web/src/nodes/NodeMetricBadge.tsx web/src/nodes/NodeMetricBadge.test.tsx web/src/nodes/SdsNode.tsx web/src/Drawer.tsx web/src/Drawer.test.tsx
git commit -m "feat(web): node metric badge + Drawer Metrics tab"
```

---

### Task 4: `App` WebSocket lifecycle + vite ws proxy + tests

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/vite.config.ts`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `useMetricsStore`, `Drawer` (now requires `metrics`), the agent WS `/api/metrics/:runId`.
- Produces: the assembled brick-4 SPA — opens the metrics WS while `running`, feeds the store, passes `metrics` to the Drawer, shows a "live" indicator.

- [ ] **Step 1: Update the failing test**

Replace `web/src/App.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.js';
import { useGraphStore } from './store.js';
import { useMetricsStore } from './metrics-store.js';

const exampleList = [
  { id: 'saga', label: 'saga', graph: { experimentId: 'saga', nodes: [], edges: [] } },
];

// Minimal controllable WebSocket mock (jsdom has none).
class MockWS {
  static last: MockWS | null = null;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) { this.url = url; MockWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send() {}
  close() { this.closed = true; this.onclose?.(); }
}

beforeEach(() => {
  vi.restoreAllMocks();
  useGraphStore.setState({ experimentId: 'untitled', nodes: [], edges: [], selectedId: null });
  useMetricsStore.setState({ byService: {} });
  MockWS.last = null;
});

function runningFetch() {
  return vi.fn(async (url: string) => {
    if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
    if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
    if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
    return new Response(JSON.stringify({}));
  });
}

describe('App brick 4 (metrics WS)', () => {
  it('opens a metrics WS once running and shows live metrics in the Metrics tab', async () => {
    vi.stubGlobal('fetch', runningFetch());
    vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByText(/Running/)).toBeInTheDocument()); // status flipped to running
    await waitFor(() => expect(MockWS.last).not.toBeNull()); // WS opened
    expect(MockWS.last!.url).toContain('/api/metrics/saga');

    MockWS.last!.onmessage?.({ data: JSON.stringify([{ service: 'order-service', cpuPercent: 12, memMB: 48 }]) });
    await userEvent.click(screen.getByRole('button', { name: 'Metrics' }));
    await waitFor(() => expect(screen.getByText('order-service')).toBeInTheDocument());
  });

  it('closes the WS and clears metrics on Stop', async () => {
    const fetchMock = runningFetch();
    (fetchMock as unknown as { mockImplementation: (f: unknown) => void }); // keep type loose
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      if (url === '/api/stop') return new Response(JSON.stringify({ runId: 'saga', state: 'stopped' }));
      if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
      return new Response(JSON.stringify({}));
    }));
    vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(MockWS.last).not.toBeNull());
    const sock = MockWS.last!;
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(sock.closed).toBe(true));
    expect(useMetricsStore.getState().byService).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix web run test`
Expected: FAIL — App doesn't open a WS / Drawer call lacks `metrics`.

- [ ] **Step 3: Update `web/src/App.tsx`**

Add imports (after the `RunBadge` import):

```tsx
import { useMetricsStore } from './metrics-store.js';
```

Add state + selectors (after the existing `useGraphStore` selectors, around line 26):

```tsx
  const metricsByService = useMetricsStore((s) => s.byService);
  const setSnapshot = useMetricsStore((s) => s.setSnapshot);
  const clearMetrics = useMetricsStore((s) => s.clear);
  const [wsLive, setWsLive] = useState(false);
```

Add the WS effect immediately AFTER the existing `const state = status?.state ?? null;` line (so `state` is in scope), before the `onPreview` function:

```tsx
  // Metrics WebSocket: open while running, close + clear on stop/terminal/unmount.
  useEffect(() => {
    if (!runId || state !== 'running') return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/metrics/${runId}`);
    ws.onopen = () => setWsLive(true);
    ws.onmessage = (ev) => {
      try { setSnapshot(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
    };
    ws.onclose = () => setWsLive(false);
    ws.onerror = () => setWsLive(false);
    return () => { ws.close(); setWsLive(false); clearMetrics(); };
  }, [runId, state, setSnapshot, clearMetrics]);
```

Derive the metrics list and pass it to the Drawer; add the live indicator. Change the `<RunBadge .../>` line region to also render the indicator:

```tsx
        <RunBadge state={state} error={status?.error} />
        {wsLive && <span className="text-xs text-emerald-600">● live metrics</span>}
```

Change the `<Drawer ... />` props to include `metrics`:

```tsx
      <Drawer
        open={drawerOpen}
        tab={drawerTab}
        onToggle={() => setDrawerOpen((o) => !o)}
        onSelectTab={setDrawerTab}
        compose={compose}
        status={status}
        logs={logs}
        metrics={Object.entries(metricsByService).map(([service, m]) => ({ service, cpuPercent: m.cpuPercent, memMB: m.memMB }))}
      />
```

- [ ] **Step 4: Update `web/vite.config.ts` proxy for WS**

Change the `server.proxy` block to:

```ts
  server: { proxy: { '/api': { target: 'http://localhost:8787', ws: true } } },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix web run test`
Expected: PASS — all web suites (store, slug, metrics-store, Palette, Canvas, Inspector, RunBadge, NodeMetricBadge, Drawer, api, App).

- [ ] **Step 6: Typecheck + build**

Run: `(cd web && npx tsc --noEmit) && npm --prefix web run build`
Expected: `tsc` clean; `web/dist/index.html` produced.

- [ ] **Step 7: Manual smoke (optional, not gated)**

```bash
npm run agent:dev   # terminal 1
npm run web:dev     # terminal 2
```
Build/Load a graph, Run; once "Running", CPU/mem badges animate on the nodes and the Metrics tab fills; Stop clears them. (Needs the sds/* images built.)

- [ ] **Step 8: Commit**

```bash
git add web/src/App.tsx web/src/App.test.tsx web/vite.config.ts
git commit -m "feat(web): live metrics WebSocket — node badges + Metrics tab"
```

---

## Self-Review

**Spec coverage:**
- `@fastify/websocket` + `serviceName` + WS `/api/metrics/:runId` (immediate frame + ~1.5s; closes when not running) → Task 1. ✅
- `statsSource` injectable on `AgentDeps`; `MetricsCollector` wired → Task 1. ✅
- `metrics-store` + `slugify` → Task 2. ✅
- `NodeMetricBadge` + `SdsNode` badge (matched by `slugify(label)`) → Task 3. ✅
- Drawer Metrics tab (`compose|status|logs|metrics`) + `metrics` prop → Task 3. ✅
- `App` opens WS while running, feeds store, clears on stop/terminal/unmount; "live" indicator; passes `metrics` → Task 4. ✅
- vite `/api` proxy `ws: true` → Task 4. ✅
- Tests: serviceName unit, WS integration w/ fake StatsSource, store/slug units, badge/Drawer/App (mock WebSocket) → all tasks. ✅
- Out-of-scope (k6 aggregate, load-config UI, reconnect, cloud relay) → not present. ✅

**Placeholder scan:** No TBD/TODO; every step has complete code. Task 1 flags the one version-sensitive bit (`@fastify/websocket` handler arg shape) with a concrete fallback. Task 3 Step 6 explains why App.test stays green until Task 4. No vacuous tests.

**Type consistency:** WS frame `{ service, cpuPercent, memMB }` identical in agent send (Task 1), `ServiceMetric`/`setSnapshot` (Task 2), Drawer `metrics` prop + Metrics rows (Task 3), and App's derived list (Task 4). `byService[slug]` shape `{ cpuPercent, memMB }` matches `NodeMetricBadge`'s `metric` prop (Task 3) and the store (Task 2). `DrawerTab` widened consistently (Task 3 Drawer + Task 4 App `setDrawerTab('metrics')` via the tab button). `slugify` used identically in `SdsNode` (Task 3) and is the inverse of the agent's `serviceName` mapping (both yield e.g. `order-service`).
