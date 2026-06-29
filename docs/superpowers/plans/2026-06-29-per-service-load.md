# Per-Service Load Targeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user mark any service/lb node as a load source with its own RPS, fire all marked sources at once under one shared duration, and read per-target k6 results (target vs achieved + dropped, saturation highlighted).

**Architecture:** Load source persists as `node.config.loadRate` (UI/canvas). At run time the SPA translates marked nodes → `LoadConfig.targets`; `/api/load/:runId` compiles a multi-scenario k6 script (one tagged `constant-arrival-rate` scenario per target) and runs it one-shot against the already-up stack (existing lifecycle). k6 results are parsed per `scenario` tag into a per-target + total shape.

**Tech Stack:** TypeScript (ESM, Node) compiler + agent; Fastify; dockerode + `docker compose` CLI; grafana/k6 (one-shot container); React + Zustand + React Flow SPA; vitest.

## Global Constraints

- **ESM imports use `.js` extensions** in source (`import … from './x.js'`) — project is `"type":"module"`, NodeNext resolution.
- **Compiler fails loud** — refuses to generate and returns `{ ok: false, errors }` rather than best-effort output. New load errors join the existing collected-errors pass.
- **Eligible load sources: `service` (port 8080) + `lb` (port 80) only.** kafka/worker/db never carry load.
- **Validity rule (single definition, reused verbatim everywhere):** a load rate is valid iff `Number.isInteger(rate) && rate >= 1`.
- **Pin the k6 image.** Use `grafana/k6:0.49.0` (confirmed/adjusted in Task 0) — never `grafana/k6` (= latest). Mirrors the repo's `apache/kafka:3.7.2` discipline.
- **maxVUs is the saturation contract:** per scenario `preAllocatedVUs = rate`, `maxVUs = rate * 10`. Drops mean "arrival rate not sustainable within the VU budget (~10s effective latency)".
- **Gated Docker smokes:** `describe.skipIf(!process.env.RUN_DOCKER)`; default `npm test` skips them.
- **NEVER add a `Co-Authored-By` trailer to commits.**
- Verify per task: root `npm test` + `npm run typecheck`; web tasks also `npm --prefix web run test` + `npm --prefix web run build`.

---

### Task 0: Spike the k6 per-tag mechanism (throwaway, `RUN_DOCKER`) — BEFORE the contract

**Why first:** the entire `K6Result`/`parseSummary`/Drawer shape rides on three unproven k6 assumptions. Prove them on a real run before building 9 components on top. No production code is committed in this task — its deliverable is *confirmed knowledge* (the exact sub-metric key shape, the pinned tag, the `maxVUs` factor) that Tasks 1–3 consume.

**Files:**
- Create (throwaway, git-ignored or deleted after): `/private/tmp/claude-501/.../scratchpad/spike-load.js`, `spike-compose.yml`

- [ ] **Step 1: Write a 2-scenario throwaway k6 script** at `scratchpad/spike-load.js`. One scenario targets a healthy service, one targets a slow/saturated service. Scenario keys = the two hostnames; no-op `{scenario:…}` thresholds on all four metrics; the `maxVUs` policy.

```js
import http from 'k6/http';
export const options = {
  scenarios: {
    'fast': { executor: 'constant-arrival-rate', rate: 50,  timeUnit: '1s', duration: '8s', preAllocatedVUs: 50,  maxVUs: 500,  exec: 'fn0' },
    'slow': { executor: 'constant-arrival-rate', rate: 300, timeUnit: '1s', duration: '8s', preAllocatedVUs: 300, maxVUs: 3000, exec: 'fn1' },
  },
  thresholds: {
    'http_reqs{scenario:fast}': ['count>=0'], 'http_req_duration{scenario:fast}': ['max>=0'],
    'http_req_failed{scenario:fast}': ['rate>=0'], 'dropped_iterations{scenario:fast}': ['count>=0'],
    'http_reqs{scenario:slow}': ['count>=0'], 'http_req_duration{scenario:slow}': ['max>=0'],
    'http_req_failed{scenario:slow}': ['rate>=0'], 'dropped_iterations{scenario:slow}': ['count>=0'],
  },
};
export function fn0() { http.get('http://fast:8080/'); }
export function fn1() { http.get('http://slow:8080/'); }
```

- [ ] **Step 2: Bring up a 2-service stack** with one service forced slow enough to saturate at 300 rps within a 3000-VU ceiling. Reuse the built `sds/microservice` image (`LATENCY_MS` makes it slow).

```bash
docker network create spike-net
docker run -d --name fast --network spike-net -e PORT=8080 -e LATENCY_MS=5 sds/microservice
docker run -d --name slow --network spike-net -e PORT=8080 -e LATENCY_MS=200 sds/microservice
```

- [ ] **Step 3: Run k6 against the network and export the summary**

```bash
docker run --rm --network spike-net -v "$PWD:/sds" grafana/k6:0.49.0 run --summary-export=/sds/spike-summary.json /sds/spike-load.js
```

- [ ] **Step 4: Inspect `spike-summary.json` and confirm all three assumptions.** Verify the `metrics` object contains keys of the exact form `http_reqs{scenario:fast}`, `http_req_duration{scenario:slow}`, `http_req_failed{scenario:fast}`, and **critically** `dropped_iterations{scenario:slow}`. Confirm the slow scenario shows a non-zero `dropped_iterations` count (saturation produced *drops*, not just latency) at `maxVUs = rate*10`.

```bash
cat spike-summary.json | python3 -c "import json,sys; m=json.load(sys.stdin)['metrics']; print('\n'.join(k for k in m if 'scenario:' in k))"
```

Expected: lines including `dropped_iterations{scenario:slow}` with `count > 0`.

- [ ] **Step 5: Record findings + tear down.** Write the confirmed facts into the plan as a short note (or commit message body when Task 1 lands): the exact sub-metric key template `<metric>{scenario:<slug>}`, the working `grafana/k6` tag, and whether `rate*10` produced drops (tune the factor if it didn't). **If `dropped_iterations` does NOT carry the `scenario` tag**, STOP and revise the spec/contract (e.g. expose `dropped` only at the `total` level, or derive saturation from `achieved < target` alone) before proceeding.

```bash
docker rm -f fast slow && docker network rm spike-net && rm -f spike-summary.json
```

- [ ] **Step 6: No production commit.** This task commits nothing to `src/` — proceed to Task 1 with the confirmed key shape, tag, and `maxVUs` factor.

---

### Task 1: Contract types + multi-scenario k6 generator + compiler resolve/validate

**Files:**
- Modify: `src/compiler/types.ts` (LoadConfig, NodeConfig, CompilerResult.output)
- Rewrite: `src/compiler/generators/k6.ts`
- Modify: `src/compiler/index.ts:16-116` (load validation pass + k6 generation block)
- Test: `src/compiler/generators/k6.test.ts`, `src/compiler/index.test.ts`

**Interfaces:**
- Produces: `LoadConfig = { durationSec: number; targets: { nodeId: string; rate: number }[] }`; `generateK6(targets: { slug: string; port: number; rate: number }[], durationSec: number): string`; `compile(...).output.loadTargets?: { slug: string; targetRps: number }[]`; `GraphNode.config.loadRate?: number`.
- Consumes: existing `slugify`, `buildIndex`, `index.nodeMap`.

- [ ] **Step 1: Update `src/compiler/types.ts`.** Replace the `LoadConfig` interface and extend `GraphNode.config` + the success `output`.

```ts
export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  config?: {
    latencyMs?: number;
    errorRate?: number;
    partitions?: number;
    loadRate?: number;   // present + integer ≥1 = this node is a load source at N rps
  };
}

export interface LoadTarget { nodeId: string; rate: number }
export interface LoadConfig { durationSec: number; targets: LoadTarget[] }

export interface LoadTargetResolved { slug: string; targetRps: number }

export type CompilerResult =
  | { ok: true; output: { compose: string; nginx?: string; k6?: string; loadTargets?: LoadTargetResolved[] } }
  | { ok: false; errors: CompilerError[] };
```

- [ ] **Step 2: Write the failing generator test** in `src/compiler/generators/k6.test.ts` (replace existing single-target test).

```ts
import { describe, it, expect } from 'vitest';
import { generateK6 } from './k6.js';

describe('generateK6 multi-scenario', () => {
  it('emits one tagged scenario + exec fn per target, with no-op threshold sub-metrics', () => {
    const s = generateK6(
      [ { slug: 'checkout', port: 8080, rate: 50 }, { slug: 'gateway', port: 80, rate: 200 } ],
      10,
    );
    // scenario keyed by slug, with maxVUs = rate*10 and preAllocatedVUs = rate
    expect(s).toContain("'checkout': { executor: 'constant-arrival-rate', rate: 50");
    expect(s).toContain('preAllocatedVUs: 50, maxVUs: 500');
    expect(s).toContain("'gateway': { executor: 'constant-arrival-rate', rate: 200");
    expect(s).toContain('preAllocatedVUs: 200, maxVUs: 2000');
    // exec fns hit the right host:port
    expect(s).toContain("http.post('http://checkout:8080/'");
    expect(s).toContain("http.post('http://gateway:80/'");
    // forced sub-metric thresholds for the dropped metric (the saturation signal)
    expect(s).toContain("'dropped_iterations{scenario:checkout}': ['count>=0']");
    expect(s).toContain("'dropped_iterations{scenario:gateway}': ['count>=0']");
    expect(s).toContain("'http_req_duration{scenario:checkout}': ['max>=0']");
  });
});
```

- [ ] **Step 3: Run it — verify it fails**

Run: `npx vitest run src/compiler/generators/k6.test.ts`
Expected: FAIL (old `generateK6(targetHost, port, load)` signature / assertions mismatch).

- [ ] **Step 4: Rewrite `src/compiler/generators/k6.ts`**

```ts
export interface K6Target { slug: string; port: number; rate: number }

const SUB_METRICS: Record<string, string> = {
  http_reqs: 'count>=0',
  http_req_duration: 'max>=0',
  http_req_failed: 'rate>=0',
  dropped_iterations: 'count>=0',
};

export function generateK6(targets: K6Target[], durationSec: number): string {
  const scenarios = targets
    .map(
      (t, i) =>
        `    '${t.slug}': { executor: 'constant-arrival-rate', rate: ${t.rate}, timeUnit: '1s', ` +
        `duration: '${durationSec}s', preAllocatedVUs: ${t.rate}, maxVUs: ${t.rate * 10}, exec: 'fn${i}' },`,
    )
    .join('\n');

  const thresholds = targets
    .flatMap((t) =>
      Object.entries(SUB_METRICS).map(([metric, agg]) => `    '${metric}{scenario:${t.slug}}': ['${agg}'],`),
    )
    .join('\n');

  const fns = targets
    .map(
      (t, i) =>
        `export function fn${i}() {\n` +
        `  http.post('http://${t.slug}:${t.port}/', JSON.stringify({ ping: true }), { headers: { 'Content-Type': 'application/json' } });\n` +
        `}`,
    )
    .join('\n');

  return `import http from 'k6/http';

export const options = {
  scenarios: {
${scenarios}
  },
  thresholds: {
${thresholds}
  },
};

${fns}
`;
}
```

- [ ] **Step 5: Run the generator test — verify it passes**

Run: `npx vitest run src/compiler/generators/k6.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing compiler test** — append to `src/compiler/index.test.ts`.

```ts
describe('compile — load targeting', () => {
  const base = (extra: Partial<Graph> = {}): Graph => ({
    experimentId: 'e',
    nodes: [
      { id: 's', type: 'service', label: 'Checkout' },
      { id: 'k', type: 'kafka', label: 'Bus' },
    ],
    edges: [],
    ...extra,
  });

  it('resolves targets → one k6 scenario + loadTargets (no auto-pick)', () => {
    const r = compile(base(), { durationSec: 10, targets: [{ nodeId: 's', rate: 50 }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output.k6).toContain("'checkout': { executor: 'constant-arrival-rate', rate: 50");
    expect(r.output.loadTargets).toEqual([{ slug: 'checkout', targetRps: 50 }]);
  });

  it('fails loud on zero targets', () => {
    const r = compile(base(), { durationSec: 10, targets: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /at least one target/i.test(e.message))).toBe(true);
  });

  it('fails loud on an ineligible target type', () => {
    const r = compile(base(), { durationSec: 10, targets: [{ nodeId: 'k', rate: 50 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /must be a service or lb/i.test(e.message))).toBe(true);
  });

  it('fails loud on a non-integer / <1 rate', () => {
    const r = compile(base(), { durationSec: 10, targets: [{ nodeId: 's', rate: 2.5 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /whole number ≥ 1/.test(e.message))).toBe(true);
  });

  it('omits k6 when no load config is supplied', () => {
    const r = compile(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output.k6).toBeUndefined();
    expect(r.output.loadTargets).toBeUndefined();
  });
});
```

- [ ] **Step 7: Run it — verify it fails**

Run: `npx vitest run src/compiler/index.test.ts`
Expected: FAIL (validation + resolve not implemented; old auto-pick produces different output).

- [ ] **Step 8: Add the load-validation pass** in `src/compiler/index.ts` — insert immediately after the edge-legality `for (const edge …)` loop (before `if (errors.length > 0) return { ok: false, errors };` at line 61).

```ts
  // Load-targeting pass — only when a load config is supplied (Preview/Run pass none).
  if (loadConfig) {
    if (loadConfig.targets.length === 0) {
      errors.push({ nodeId: '', message: 'Load requires at least one target' });
    }
    for (const t of loadConfig.targets) {
      const node = index.nodeMap.get(t.nodeId);
      if (!node) {
        errors.push({ nodeId: t.nodeId, message: `Load target "${t.nodeId}" is not in the graph` });
        continue;
      }
      if (node.type !== 'service' && node.type !== 'lb') {
        errors.push({ nodeId: t.nodeId, message: `Load target "${node.label}" must be a service or lb (got ${node.type})` });
      }
      if (!Number.isInteger(t.rate) || t.rate < 1) {
        errors.push({ nodeId: t.nodeId, message: `Load rate for "${node.label}" must be a whole number ≥ 1` });
      }
    }
  }
```

- [ ] **Step 9: Replace the k6 generation block** in `src/compiler/index.ts` (the `// 6. k6 (entry = first LB else first service).` block, lines ~106-113) with explicit-target resolution. Also widen the `output` type declaration (line 93) to include `loadTargets`.

```ts
  // line ~93: widen output type
  const output: { compose: string; nginx?: string; k6?: string; loadTargets?: { slug: string; targetRps: number }[] } = { compose };

  // line ~106: replace the auto-pick block
  // 6. k6 — one tagged scenario per explicit load target (validated above; no auto-pick).
  if (loadConfig) {
    const resolved = loadConfig.targets.map((t) => {
      const node = index.nodeMap.get(t.nodeId)!;
      return { slug: slugify(node.label), port: node.type === 'lb' ? 80 : 8080, rate: t.rate };
    });
    output.k6 = generateK6(resolved, loadConfig.durationSec);
    output.loadTargets = resolved.map((r) => ({ slug: r.slug, targetRps: r.rate }));
  }
```

- [ ] **Step 10: Run compiler tests — verify they pass**

Run: `npx vitest run src/compiler/`
Expected: PASS. Then `npm run typecheck` — clean.

- [ ] **Step 11: Commit**

```bash
git add src/compiler/
git commit -m "feat(compiler): per-target load config + multi-scenario k6 generator"
```

---

### Task 2: Engine — per-target `parseSummary` + `K6Result` shape + pinned image + smoke

**Files:**
- Modify: `src/engine/k6-runner.ts`
- Test: `src/engine/k6-runner.test.ts`
- Test (gated): `src/engine/k6-runner.smoke.test.ts` (the hardened Task-0 spike)

**Interfaces:**
- Consumes: `LoadTargetResolved` shape `{ slug, targetRps }` (Task 1).
- Produces: `K6Result = { perTarget: TargetResult[]; total: {...} }`; `parseSummary(json: string, targets: { slug: string; targetRps: number }[]): K6Result`; `K6Runner.run(experimentId, runDir, targets): Promise<K6Result>`.

- [ ] **Step 1: Write the failing parse test** — replace `src/engine/k6-runner.test.ts`'s parse test.

```ts
import { describe, it, expect } from 'vitest';
import { parseSummary } from './k6-runner.js';

const summary = JSON.stringify({
  metrics: {
    http_reqs: { count: 2500, rate: 250 },
    http_req_failed: { value: 0.01 },
    dropped_iterations: { count: 120 },
    'http_reqs{scenario:checkout}': { count: 500, rate: 50 },
    'http_req_duration{scenario:checkout}': { avg: 22.1, 'p(95)': 40, max: 96 },
    'http_req_failed{scenario:checkout}': { value: 0.014 },
    'dropped_iterations{scenario:checkout}': { count: 120 },
    'http_reqs{scenario:gateway}': { count: 2000, rate: 200 },
    'http_req_duration{scenario:gateway}': { avg: 9.4, 'p(95)': 18, max: 61 },
    'http_req_failed{scenario:gateway}': { value: 0.002 },
    // NOTE: no dropped_iterations{scenario:gateway} — zero-drop scenario emits no samples
  },
});

describe('parseSummary per-target', () => {
  it('splits metrics by scenario tag and sums the total', () => {
    const r = parseSummary(summary, [
      { slug: 'gateway', targetRps: 200 },
      { slug: 'checkout', targetRps: 50 },
    ]);
    const checkout = r.perTarget.find((t) => t.slug === 'checkout')!;
    expect(checkout).toMatchObject({ targetRps: 50, achievedRps: 50, requests: 500, dropped: 120, latencyP95Ms: 40 });
    const gateway = r.perTarget.find((t) => t.slug === 'gateway')!;
    expect(gateway.dropped).toBe(0); // missing sub-metric defaults to 0
    expect(r.total).toMatchObject({ requests: 2500, achievedRps: 250, targetRps: 250, dropped: 120 });
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run src/engine/k6-runner.test.ts`
Expected: FAIL (old flat `K6Result`).

- [ ] **Step 3: Rewrite the types + `parseSummary` + `run` + pin the image** in `src/engine/k6-runner.ts`.

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner } from './runner.js';

const K6_IMAGE = 'grafana/k6:0.49.0'; // pinned (Task 0); --summary-export + tagged sub-metrics depend on it

export interface TargetResult {
  slug: string;
  targetRps: number;
  achievedRps: number;
  requests: number;
  dropped: number;
  errorRate: number;
  latencyAvgMs: number;
  latencyP95Ms: number;
  latencyMaxMs: number;
}

export interface K6Result {
  perTarget: TargetResult[];
  total: { requests: number; targetRps: number; achievedRps: number; dropped: number; errorRate: number };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function parseSummary(json: string, targets: { slug: string; targetRps: number }[]): K6Result {
  const data = JSON.parse(json) as { metrics?: Record<string, Record<string, unknown>> };
  const m = data.metrics ?? {};
  const sub = (metric: string, slug: string) => m[`${metric}{scenario:${slug}}`] ?? {};
  const top = (metric: string) => m[metric] ?? {};

  const perTarget: TargetResult[] = targets.map((t) => {
    const reqs = sub('http_reqs', t.slug);
    const dur = sub('http_req_duration', t.slug);
    const failed = sub('http_req_failed', t.slug);
    const dropped = sub('dropped_iterations', t.slug);
    return {
      slug: t.slug,
      targetRps: t.targetRps,
      achievedRps: num(reqs.rate),
      requests: num(reqs.count),
      dropped: num(dropped.count),
      errorRate: num(failed.value),
      latencyAvgMs: num(dur.avg),
      latencyP95Ms: num(dur['p(95)']),
      latencyMaxMs: num(dur.max),
    };
  });

  return {
    perTarget,
    total: {
      requests: num(top('http_reqs').count),
      targetRps: targets.reduce((s, t) => s + t.targetRps, 0),
      achievedRps: num(top('http_reqs').rate),
      dropped: num(top('dropped_iterations').count),
      errorRate: num(top('http_req_failed').value),
    },
  };
}

/** Runs grafana/k6 as a one-shot container against an experiment's network. */
export class K6Runner {
  constructor(private readonly runner: Runner) {}

  async run(experimentId: string, runDir: string, targets: { slug: string; targetRps: number }[]): Promise<K6Result> {
    const net = `sds-${experimentId}_sds-${experimentId}-net`;
    const r = await this.runner.run([
      'docker', 'run', '--rm', '--network', net,
      '-v', `${runDir}:/sds`,
      K6_IMAGE, 'run', '--summary-export=/sds/summary.json', '/sds/load.js',
    ]);
    if (r.code !== 0) {
      throw new Error(`k6 run failed (exit ${r.code}): ${r.stderr.trim()}`);
    }
    return parseSummary(readFileSync(join(runDir, 'summary.json'), 'utf8'), targets);
  }
}
```

- [ ] **Step 4: Run the parse test — verify it passes**

Run: `npx vitest run src/engine/k6-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the gated smoke** at `src/engine/k6-runner.smoke.test.ts` (hardens the Task-0 spike into a regression).

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSummary } from './k6-runner.js';
import { generateK6 } from '../compiler/generators/k6.js';

describe.skipIf(!process.env.RUN_DOCKER)('k6 per-tag mechanism (real run)', () => {
  it('produces per-scenario sub-metrics incl. dropped on a saturated target', () => {
    const net = 'sds-spike_smoke-net';
    execFileSync('docker', ['network', 'create', net]);
    try {
      execFileSync('docker', ['run', '-d', '--name', 'fast', '--network', net, '-e', 'PORT=8080', '-e', 'LATENCY_MS=5', 'sds/microservice']);
      execFileSync('docker', ['run', '-d', '--name', 'slow', '--network', net, '-e', 'PORT=8080', '-e', 'LATENCY_MS=200', 'sds/microservice']);
      const dir = mkdtempSync(join(tmpdir(), 'k6smoke-'));
      // scenario keys must be the hostnames the script targets:
      writeFileSync(join(dir, 'load.js'), generateK6(
        [ { slug: 'fast', port: 8080, rate: 50 }, { slug: 'slow', port: 8080, rate: 300 } ], 8));
      execFileSync('docker', ['run', '--rm', '--network', net, '-v', `${dir}:/sds`,
        'grafana/k6:0.49.0', 'run', '--summary-export=/sds/summary.json', '/sds/load.js'], { stdio: 'inherit' });
      const r = parseSummary(readFileSync(join(dir, 'summary.json'), 'utf8'),
        [ { slug: 'fast', targetRps: 50 }, { slug: 'slow', targetRps: 300 } ]);
      expect(r.perTarget).toHaveLength(2);
      const slow = r.perTarget.find((t) => t.slug === 'slow')!;
      expect(slow.dropped).toBeGreaterThan(0); // the saturation signal — assumption (3)
    } finally {
      execFileSync('docker', ['rm', '-f', 'fast', 'slow'], { stdio: 'ignore' });
      execFileSync('docker', ['network', 'rm', net], { stdio: 'ignore' });
    }
  }, 60_000);
});
```

- [ ] **Step 6: Run the gated smoke (requires Docker + built `sds/microservice`)**

Run: `RUN_DOCKER=1 npx vitest run src/engine/k6-runner.smoke.test.ts`
Expected: PASS (slow target shows `dropped > 0`). If it fails on the tag/key shape, reconcile with Task-0 findings before continuing.

- [ ] **Step 7: Run unit tests + typecheck**

Run: `npm test` then `npm run typecheck`
Expected: PASS / clean (note: this leaves agent + CLI broken on the K6Result shape — Task 3 fixes them; if `npm test` surfaces those compile errors, that's expected and resolved next task. Commit this task's engine change regardless once k6-runner.test passes.)

- [ ] **Step 8: Commit**

```bash
git add src/engine/k6-runner.ts src/engine/k6-runner.test.ts src/engine/k6-runner.smoke.test.ts
git commit -m "feat(engine): per-target k6 result parsing + pinned k6 image + smoke"
```

---

### Task 3: Agent `/api/load` body + run-experiment + sim CLI migration

**Files:**
- Modify: `src/agent/server.ts:95-115` (load endpoint)
- Modify: `src/agent/run-experiment.ts`
- Modify: `src/engine/controller.ts` (add `loadTargets?` to `CompilerOutput` if it's a distinct type)
- Modify: `src/engine/cli.ts:57-85,111-136` (build targets, print per-target)
- Test: `src/agent/load.test.ts`

**Interfaces:**
- Consumes: `compile(graph, { durationSec, targets })` → `output.k6` + `output.loadTargets` (Task 1); `K6Runner.run(id, dir, targets)` → `K6Result` (Task 2).
- Produces: `POST /api/load/:runId` body `{ durationSec: number; targets: { nodeId: string; rate: number }[] }` → `K6Result`.

- [ ] **Step 1: Add `loadTargets` to `CompilerOutput`.** Open `src/engine/controller.ts`; if `CompilerOutput` is its own interface (not a re-export of the compiler result's `output`), add `loadTargets?: { slug: string; targetRps: number }[];`. If it already aliases the compiler output type, no change.

- [ ] **Step 2: Write the failing agent test** at `src/agent/load.test.ts`.

```ts
import { describe, it, expect } from 'vitest';
import { buildServer } from './server.js';
import { FakeRunner } from '../engine/runner.js'; // adjust import to the repo's fake

// A FakeRunner that writes a canned per-scenario summary.json when it sees a `k6 ... run` argv.
// (Mirror the existing load.test.ts harness if one exists; otherwise inline as below.)
```

Use the existing agent test harness pattern (the old `load.test.ts` already drives a `FakeRunner` that writes a `summary.json` on the k6 argv — reuse it). Assert:

```ts
it('runs load against marked targets and returns per-target results', async () => {
  // server with a run already 'running' whose graph has a service node 'svc' labelled 'Checkout'
  const res = await app.inject({
    method: 'POST', url: `/api/load/${runId}`,
    payload: { durationSec: 10, targets: [{ nodeId: 'svc', rate: 50 }] },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.perTarget[0]).toMatchObject({ slug: 'checkout', targetRps: 50 });
});

it('rejects an empty targets list with 400', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/load/${runId}`, payload: { durationSec: 10, targets: [] } });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 3: Run it — verify it fails**

Run: `npx vitest run src/agent/load.test.ts`
Expected: FAIL.

- [ ] **Step 4: Update the `/api/load/:runId` handler** in `src/agent/server.ts`.

```ts
  app.post('/api/load/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const { durationSec, targets } = req.body as { durationSec: number; targets: { nodeId: string; rate: number }[] };
    const rec = runs.get(runId);
    if (!rec) return reply.code(404).send({ error: 'unknown runId' });
    if (rec.state !== 'running') return reply.code(409).send({ error: 'run is not running' });
    if (rec.loadInFlight) return reply.code(409).send({ error: 'a load is already running' });
    const result = compile(rec.graph, { durationSec, targets });
    if (!result.ok) return reply.code(400).send(result);
    if (!result.output.k6) return reply.code(400).send({ error: 'no load entry (needs a service or lb target)' });
    writeFileSync(join(rec.runDir, 'load.js'), result.output.k6);
    rec.loadInFlight = true;
    try {
      rec.lastLoad = await k6.run(runId, rec.runDir, result.output.loadTargets!);
      return rec.lastLoad;
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      rec.loadInFlight = false;
    }
  });
```

- [ ] **Step 5: Update `runExperiment`** in `src/agent/run-experiment.ts` to use `output.loadTargets` (the K6Runner signature now needs targets).

```ts
    if (load) {
      await deps.k6.run(rec.id, rec.runDir, output.loadTargets ?? []);
    }
```

- [ ] **Step 6: Migrate the sim CLI** in `src/engine/cli.ts`. (a) Add a `buildLoad` helper; (b) build `opts.loadConfig` in `main` from the graph; (c) fix the k6 `run` call + the load log lines.

```ts
// near the top of cli.ts, after imports:
function buildLoad(graph: Graph, rate: number, durationSec: number): LoadConfig {
  const eligible = graph.nodes.filter((n) => n.type === 'service' || n.type === 'lb');
  const marked = eligible.filter((n) => Number.isInteger(n.config?.loadRate) && (n.config!.loadRate as number) >= 1);
  if (marked.length > 0) {
    return { durationSec, targets: marked.map((n) => ({ nodeId: n.id, rate: n.config!.loadRate as number })) };
  }
  const entry = eligible.find((n) => n.type === 'lb') ?? eligible[0];
  return { durationSec, targets: entry ? [{ nodeId: entry.id, rate }] : [] };
}
```

```ts
// in runSim, replace the load block (lines ~57-85):
    if (opts.loadConfig && opts.k6Runner) {
      const totalRps = opts.loadConfig.targets.reduce((s, t) => s + t.rate, 0);
      out.log(`🔥 running load: ${opts.loadConfig.targets.length} target(s), ${totalRps} rps total for ${opts.loadConfig.durationSec}s…`);
      const k6p = opts.k6Runner.run(id, runDir, result.output.loadTargets ?? []);
      if (opts.metrics) {
        const m = opts.metrics;
        let settled = false;
        void k6p.finally(() => { settled = true; }).catch(() => {});
        while (!settled) {
          await new Promise((r) => setTimeout(r, m.intervalMs));
          if (settled) break;
          try { out.log('metrics:'); printSnaps(await m.collector.sample(id)); }
          catch (e) { out.error(`metrics sample failed: ${(e as Error).message}`); }
        }
      }
      const k = await k6p;
      out.log(`load total: requests=${k.total.requests} rps=${k.total.achievedRps.toFixed(1)} dropped=${k.total.dropped} errors=${(k.total.errorRate * 100).toFixed(1)}%`);
      for (const t of k.perTarget) {
        out.log(`  ${t.slug}: target=${t.targetRps} achieved=${t.achievedRps.toFixed(1)} dropped=${t.dropped} p95=${t.latencyP95Ms.toFixed(1)}ms`);
      }
      if (opts.metrics) { out.log('metrics (final):'); printSnaps(await opts.metrics.collector.sample(id)); }
    }
```

```ts
// in main, replace the `if (load) { opts.loadConfig = { rate, durationSec }; ... }` block:
  if (load) {
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as Graph;
    opts.loadConfig = buildLoad(graph, rate, durationSec);
    opts.k6Runner = new K6Runner(new RealRunner());
  }
```

- [ ] **Step 7: Run agent tests + typecheck**

Run: `npx vitest run src/agent/load.test.ts` then `npm test` then `npm run typecheck`
Expected: PASS / clean (engine, agent, CLI all consistent now).

- [ ] **Step 8: Commit**

```bash
git add src/agent/ src/engine/cli.ts src/engine/controller.ts
git commit -m "feat(agent): /api/load takes {durationSec,targets}; migrate run-experiment + sim CLI"
```

---

### Task 4: SPA store — `NodeConfig.loadRate`

**Files:**
- Modify: `web/src/store.ts:14`
- Test: `web/src/store.test.ts`

**Interfaces:**
- Produces: `NodeConfig.loadRate?: number`; round-trips through `toGraph`/`loadExample`.

- [ ] **Step 1: Write the failing test** — append to `web/src/store.test.ts`.

```ts
it('round-trips config.loadRate through toGraph', () => {
  const s = useGraphStore.getState();
  s.loadExample({ experimentId: 'e', nodes: [{ id: 's', type: 'service', label: 'Checkout', config: { loadRate: 50 } }], edges: [] });
  expect(useGraphStore.getState().toGraph().nodes[0].config).toEqual({ loadRate: 50 });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm --prefix web run test -- store.test.ts`
Expected: FAIL (TS error: `loadRate` not on `NodeConfig`).

- [ ] **Step 3: Add the field** in `web/src/store.ts`.

```ts
export interface NodeConfig { latencyMs?: number; errorRate?: number; partitions?: number; loadRate?: number }
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm --prefix web run test -- store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/store.ts web/src/store.test.ts
git commit -m "feat(web): NodeConfig.loadRate on the graph store"
```

---

### Task 5: SPA Inspector — load toggle + rate for service & lb

**Files:**
- Modify: `web/src/Inspector.tsx`
- Test: `web/src/Inspector.test.tsx`

**Interfaces:**
- Consumes: `NodeConfig.loadRate` (Task 4), `slugify` from `./slug.js`.
- Produces: a load section rendered for `type === 'service' || type === 'lb'`.

- [ ] **Step 1: Write the failing tests** — append to `web/src/Inspector.test.tsx`.

```tsx
it('shows the load toggle on a service and adds loadRate when turned on', async () => {
  // select a service node, then click the "Load source" toggle
  // expect updateNode called with config.loadRate >= 1, and a rate input to appear
});

it('shows the load toggle on an lb node too', () => { /* select lb → toggle present */ });

it('flags a non-integer rate inline', () => {
  // service with config.loadRate = 2.5 → red "Rate must be a whole number ≥ 1"
});

it('does not show a load toggle on a kafka node', () => { /* select kafka → no ⚡ toggle */ });
```

Fill these with the repo's existing Inspector test pattern (render `<Inspector/>`, drive the store via `useGraphStore.setState`/`addNode`+`setSelected`, query by `aria-label`/text). Use `aria-label="load source"` for the toggle and `aria-label="rate"` for the input.

- [ ] **Step 2: Run them — verify they fail**

Run: `npm --prefix web run test -- Inspector.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the shared load section** in `web/src/Inspector.tsx`. Import `slugify`. After the existing `service` block (and so it also renders for `lb`), insert:

```tsx
{(node.data.type === 'service' || node.data.type === 'lb') && (() => {
  const on = cfg.loadRate !== undefined;
  const rate = cfg.loadRate ?? 0;
  const invalid = on && (!Number.isInteger(rate) || rate < 1);
  const port = node.data.type === 'lb' ? 80 : 8080;
  const toggle = () =>
    updateNode(node.id, { config: { ...cfg, loadRate: on ? undefined : 20 } });
  return (
    <div className="mb-3 mt-2 border-t border-dashed border-slate-200 pt-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-700">⚡ Load source</span>
        <button
          aria-label="load source"
          aria-pressed={on}
          onClick={toggle}
          className={`relative h-5 w-9 rounded-full transition ${on ? 'bg-orange-500' : 'bg-slate-300'}`}
        >
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${on ? 'left-[18px]' : 'left-0.5'}`} />
        </button>
      </div>
      {on ? (
        <>
          <label htmlFor="insp-rate" className="mt-2 block text-xs text-slate-500">rate (req/s)</label>
          <input
            id="insp-rate"
            aria-label="rate"
            type="number"
            min={1}
            value={rate}
            onChange={(e) => updateNode(node.id, { config: { ...cfg, loadRate: Number(e.target.value) } })}
            className={`w-full rounded border px-2 py-1 text-sm ${invalid ? 'border-red-500 bg-red-50' : 'border-slate-300'}`}
          />
          {invalid && <div className="mt-1 text-xs font-semibold text-red-600">Rate must be a whole number ≥ 1</div>}
          <div className="mt-1 text-[10px] text-slate-400">k6 hits {slugify(node.data.label)}:{port}{node.data.type === 'lb' ? ' → nginx round-robins' : ''} at {rate} rps</div>
        </>
      ) : (
        <div className="mt-1 text-[10px] text-slate-400">off — no traffic generated here</div>
      )}
    </div>
  );
})()}
```

- [ ] **Step 4: Run the tests — verify they pass**

Run: `npm --prefix web run test -- Inspector.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/Inspector.tsx web/src/Inspector.test.tsx
git commit -m "feat(web): Inspector load-source toggle + rate for service/lb"
```

---

### Task 6: SPA canvas — `⚡N/s` chip in the node header

**Files:**
- Modify: `web/src/nodes/SdsNode.tsx:19-21`
- Test: `web/src/nodes/SdsNode.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `data.config.loadRate` (Task 4).

- [ ] **Step 1: Write the failing test** at `web/src/nodes/SdsNode.test.tsx`.

```tsx
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, it, expect } from 'vitest';
import { SdsNode } from './SdsNode.js';

const renderNode = (data: any) =>
  render(<ReactFlowProvider><SdsNode id="n1" data={data} type="sds" selected={false} zIndex={0} isConnectable dragging={false} xPos={0} yPos={0} /></ReactFlowProvider> as any);

describe('SdsNode ⚡ chip', () => {
  it('shows ⚡N/s when a service is a load source', () => {
    renderNode({ type: 'service', label: 'Checkout', config: { loadRate: 50 } });
    expect(screen.getByText(/⚡ 50\/s/)).toBeInTheDocument();
  });
  it('shows no chip when loadRate is unset', () => {
    renderNode({ type: 'service', label: 'Search' });
    expect(screen.queryByText(/\/s/)).not.toBeInTheDocument();
  });
});
```

(If `SdsNode`'s `NodeProps` makes the inline props awkward, mirror the existing `NodeMetricBadge.test.tsx` render harness in the repo instead.)

- [ ] **Step 2: Run it — verify it fails**

Run: `npm --prefix web run test -- SdsNode.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the chip** in `web/src/nodes/SdsNode.tsx` — make the header bar a flex row carrying the chip when eligible.

```tsx
const loadRate = data.config?.loadRate;
const isSource = (data.type === 'service' || data.type === 'lb') && loadRate !== undefined && loadRate >= 1;
return (
  <div className={`w-40 rounded-md border bg-white shadow-sm ${BORDER[data.type]}`}>
    <Handle type="target" position={Position.Left} />
    <div className={`flex items-center justify-between rounded-t-md px-2 py-0.5 text-[10px] font-semibold uppercase text-white ${HEADER[data.type]}`}>
      <span>{data.type}</span>
      {isSource && <span className="rounded-full bg-white/25 px-1.5 normal-case">⚡ {loadRate}/s</span>}
    </div>
    <div className="px-2 py-2 text-sm">{data.label}</div>
    <NodeMetricBadge metric={metric} />
    <Handle type="source" position={Position.Right} />
  </div>
);
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm --prefix web run test -- SdsNode.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/nodes/SdsNode.tsx web/src/nodes/SdsNode.test.tsx
git commit -m "feat(web): ⚡N/s load-source chip in the node header"
```

---

### Task 7: SPA App — targets assembly, Run-load, drop global rate/presets

**Files:**
- Modify: `web/src/App.tsx` (state, `onGenerateLoad`→`onRunLoad`, toolbar block 146-165)
- Modify: `web/src/api.ts:26-34,68-69` (K6Result + load signature)
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `isLoadSource` predicate; `api.load(runId, durationSec, targets)`.
- Produces: `api.load: (runId, durationSec, targets: { nodeId: string; rate: number }[]) => …`.

- [ ] **Step 1: Update `web/src/api.ts`** — mirror the engine `K6Result` and change `load`.

```ts
export interface TargetResult {
  slug: string; targetRps: number; achievedRps: number; requests: number;
  dropped: number; errorRate: number; latencyAvgMs: number; latencyP95Ms: number; latencyMaxMs: number;
}
export interface K6Result {
  perTarget: TargetResult[];
  total: { requests: number; targetRps: number; achievedRps: number; dropped: number; errorRate: number };
}
export type LoadResult = K6Result | { error?: string; ok?: false; errors?: unknown[] };
// …
  load: (runId: string, durationSec: number, targets: { nodeId: string; rate: number }[]) =>
    jsonFetch<LoadResult>(`/api/load/${runId}`, { method: 'POST', body: JSON.stringify({ durationSec, targets }) }),
```

- [ ] **Step 2: Write the failing App test** — append to `web/src/App.test.tsx`. Mock `api.load`; mark a service as a source; click Run load; assert payload.

```tsx
it('Run load posts targets built from marked nodes', async () => {
  const spy = vi.spyOn(api, 'load').mockResolvedValue({ perTarget: [], total: { requests: 0, targetRps: 0, achievedRps: 0, dropped: 0, errorRate: 0 } });
  // arrange: store has a running experiment + a service node with config.loadRate = 50
  // act: click the "Run load" button
  // assert:
  expect(spy).toHaveBeenCalledWith(expect.any(String), expect.any(Number), [{ nodeId: expect.any(String), rate: 50 }]);
});

it('disables Run load when no node is a load source', () => {
  // running experiment, zero marked sources → button disabled
});
```

Use the repo's existing `App.test.tsx` harness for standing up a "running" state (it already mocks `api.status`/`api.run`).

- [ ] **Step 3: Run it — verify it fails**

Run: `npm --prefix web run test -- App.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Rewrite the App load wiring.** (a) drop `rate` state + the preset row; (b) add the `isLoadSource` predicate + a `sources` selector; (c) rewrite `onRunLoad`; (d) replace the toolbar load control.

```tsx
// state: remove `const [rate, setRate] = useState(20)`. Keep durationSec.
// add a selector for marked sources (reactive to store changes):
const sources = useGraphStore((s) =>
  s.nodes
    .filter((n) => {
      const t = n.data.type, r = n.data.config?.loadRate;
      return (t === 'service' || t === 'lb') && Number.isInteger(r) && (r as number) >= 1;
    })
    .map((n) => ({ nodeId: n.id, rate: n.data.config!.loadRate as number })),
);
const totalRps = sources.reduce((acc, t) => acc + t.rate, 0);
```

```tsx
async function onRunLoad() {
  if (!runId || sources.length === 0) return;
  setLoading(true);
  try {
    const r = await api.load(runId, durationSec, sources);
    if ('perTarget' in r) { setLastLoad(r); setError(null); setDrawerTab('metrics'); setDrawerOpen(true); }
    else setError(`Load failed: ${r.error ?? errorText(r.errors ?? [])}`);
  } catch (e) { setError(String(e)); }
  finally { setLoading(false); }
}
```

```tsx
{state === 'running' && (
  <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-2 py-1">
    <label className="text-[11px] text-slate-500">dur
      <input aria-label="duration" type="number" min={1} max={120} value={durationSec}
        onChange={(e) => setDurationSec(Number(e.target.value))}
        className="ml-1 w-12 rounded border border-slate-300 px-1 py-0.5 text-sm text-right" /></label>
    <span className={`text-[11px] font-semibold ${sources.length ? 'text-orange-600' : 'text-slate-400'}`}>
      {sources.length ? `⚡ ${sources.length} sources · ${totalRps} rps` : 'select a service → toggle ⚡ Load source'}
    </span>
    <button onClick={onRunLoad} disabled={loading || sources.length === 0}
      className="rounded bg-orange-600 px-2.5 py-1 text-sm font-medium text-white disabled:opacity-50">
      {loading ? 'Running load…' : 'Run load'}
    </button>
  </div>
)}
```

Also update the `K6Result` import and `lastLoad` state type to the new `K6Result` from `./api.js`.

- [ ] **Step 5: Run it — verify it passes**

Run: `npm --prefix web run test -- App.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/App.tsx web/src/api.ts web/src/App.test.tsx
git commit -m "feat(web): per-service Run load (targets from marked nodes); drop global rate/presets"
```

---

### Task 8: SPA Drawer — per-target results table + saturation highlight

**Files:**
- Modify: `web/src/Drawer.tsx:1-16,55-69` (props type + Metrics tab "Last load" block)
- Test: `web/src/Drawer.test.tsx`

**Interfaces:**
- Consumes: `K6Result` (Task 7's `api.ts` shape).

- [ ] **Step 1: Write the failing test** — append to `web/src/Drawer.test.tsx`.

```tsx
it('renders a per-target results table with a total and highlights saturated rows', () => {
  const lastLoad = {
    perTarget: [
      { slug: 'gateway', targetRps: 200, achievedRps: 200, requests: 2000, dropped: 0, errorRate: 0.002, latencyAvgMs: 9, latencyP95Ms: 18, latencyMaxMs: 61 },
      { slug: 'checkout', targetRps: 50, achievedRps: 38, requests: 380, dropped: 120, errorRate: 0.014, latencyAvgMs: 22, latencyP95Ms: 40, latencyMaxMs: 96 },
    ],
    total: { requests: 2380, targetRps: 250, achievedRps: 238, dropped: 120, errorRate: 0.005 },
  };
  render(<Drawer open tab="metrics" onToggle={() => {}} onSelectTab={() => {}} compose="" status={null} logs="" metrics={[]} lastLoad={lastLoad as any} />);
  expect(screen.getByText('checkout')).toBeInTheDocument();
  expect(screen.getByText(/120/)).toBeInTheDocument();       // dropped
  expect(screen.getByText('total')).toBeInTheDocument();
  const row = screen.getByText('checkout').closest('tr')!;
  expect(row.className).toMatch(/orange|amber|bg-/);          // saturated highlight
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm --prefix web run test -- Drawer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Replace the "Last load" block** in `web/src/Drawer.tsx` (the `{lastLoad && (…)}` div, lines ~57-69) with a per-target table. The `lastLoad` prop type becomes the new `K6Result` (already imported from `./api.js`).

```tsx
{lastLoad && (
  <div className="mb-3 overflow-hidden rounded-lg border border-slate-200">
    <div className="bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">Load results</div>
    <table className="w-full text-right text-xs">
      <thead className="text-[10px] uppercase text-slate-400">
        <tr><th className="px-2 py-1 text-left">target</th><th>target/s</th><th>achieved/s</th><th>dropped</th><th>err %</th><th>avg</th><th>p95</th><th>peak</th></tr>
      </thead>
      <tbody className="font-mono">
        {lastLoad.perTarget.map((t) => {
          const saturated = t.achievedRps < t.targetRps;
          return (
            <tr key={t.slug} className={`border-t border-slate-100 ${saturated ? 'bg-orange-50' : ''}`}>
              <td className="px-2 py-1 text-left">{t.slug}</td>
              <td>{t.targetRps}</td>
              <td className={saturated ? 'font-bold text-orange-600' : ''}>{t.achievedRps.toFixed(0)}</td>
              <td className={saturated ? 'font-bold text-orange-600' : ''}>{t.dropped}{saturated ? ' ⚠' : ''}</td>
              <td>{(t.errorRate * 100).toFixed(1)}</td>
              <td>{t.latencyAvgMs.toFixed(1)}</td>
              <td>{t.latencyP95Ms.toFixed(0)}</td>
              <td>{t.latencyMaxMs.toFixed(0)}</td>
            </tr>
          );
        })}
        <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
          <td className="px-2 py-1 text-left">total</td>
          <td>{lastLoad.total.targetRps}</td>
          <td>{lastLoad.total.achievedRps.toFixed(0)}</td>
          <td>{lastLoad.total.dropped}</td>
          <td>{(lastLoad.total.errorRate * 100).toFixed(1)}</td>
          <td>—</td><td>—</td><td>—</td>
        </tr>
      </tbody>
    </table>
  </div>
)}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm --prefix web run test -- Drawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full web verify**

Run: `npm --prefix web run test` then `npm --prefix web run build`
Expected: all pass; build clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/Drawer.tsx web/src/Drawer.test.tsx
git commit -m "feat(web): per-target load results table with saturation highlight"
```

---

### Task 9: Docs + example seed

**Files:**
- Modify: `CLAUDE.md` (metrics/load notes), `README.md` (load bullet)
- Modify: `examples/lb-scaling.json` (seed `config.loadRate` on the lb for a one-click demo)

- [ ] **Step 1: Seed an example.** In `examples/lb-scaling.json`, add `"config": { "loadRate": 100 }` to the lb node (or whichever node fronts the topology) so "Load example → Run → Run load" demonstrates the feature with zero clicks. Verify the file still parses and compiles: `npm run sim examples/lb-scaling.json` (no `--load`) starts clean.

- [ ] **Step 2: Update `CLAUDE.md`.** In the Graph Compiler / k6 line and the metrics-mapping note, document: load targets are explicit (per-node `config.loadRate`, service/lb only), k6 emits one tagged scenario per target, results are per-target (target vs achieved + dropped). Note the pinned `grafana/k6:0.49.0`.

- [ ] **Step 3: Update `README.md`.** Adjust the "Live metrics" / load sentence to mention per-service load sources + per-target results.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md examples/lb-scaling.json
git commit -m "docs: per-service load targeting; seed lb-scaling example loadRate"
```

---

## Self-Review

**Spec coverage:**
- multi-source/per-service rate, global duration → Tasks 1,5,7 ✓
- service+lb eligibility (8080/80) → Tasks 1,5,6 ✓
- per-target tagged scenarios + threshold sub-metrics → Task 1 ✓
- maxVUs saturation contract → Tasks 0,1 ✓
- per-target parse + total → Task 2 ✓
- pinned k6 image → Task 2 ✓; smoke (top risk) → Tasks 0,2 ✓
- `/api/load` body + run-experiment + CLI migration → Task 3 ✓
- `NodeConfig.loadRate` persistence → Task 4 ✓
- Inspector toggle/rate + inline validation → Task 5 ✓
- ⚡ header chip → Task 6 ✓
- App targets assembly + isLoadSource gate (= validity rule) + drop presets → Task 7 ✓
- Drawer per-target table + saturation highlight + blank total latency → Task 8 ✓
- docs + example → Task 9 ✓
- Task-0 spike before the contract (review finding B) → Task 0 ✓

**Placeholder scan:** k6 tag is a concrete real tag (`0.49.0`), confirmed in Task 0; test bodies that defer to "the repo's existing harness" (agent `load.test.ts`, App/Inspector store setup) name the exact harness, assertions, and `aria-label`s to use — no blank TODOs.

**Type consistency:** `LoadConfig{durationSec,targets}`, `LoadTarget{nodeId,rate}`, `K6Result{perTarget,total}`, `TargetResult{slug,targetRps,achievedRps,requests,dropped,errorRate,latencyAvgMs,latencyP95Ms,latencyMaxMs}`, `output.loadTargets:{slug,targetRps}[]`, `generateK6(targets,durationSec)`, `K6Runner.run(id,dir,targets)`, `api.load(runId,durationSec,targets)`, `isLoadSource` rule `Number.isInteger(r)&&r>=1` — used identically across Tasks 1–8.
