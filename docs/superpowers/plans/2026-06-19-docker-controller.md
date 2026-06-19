# Docker Controller v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Docker Controller — orchestration that takes the Graph Compiler's output, runs it as real containers via `docker compose`, waits for health, reports status, and tears down — plus a thin `sim` CLI to run a graph JSON end-to-end.

**Architecture:** Three units behind one seam. `Runner` is the only unit that spawns subprocesses (`RealRunner` in prod, a fake in tests). `ExperimentController` is pure orchestration on top of a `Runner`: write artifacts → `docker compose up -d --wait` → parse `ps` → `down -v`. `cli.ts` is thin glue wiring `compile()` → controller → terminal → signal-driven teardown. The compiler (`src/compiler/`) is untouched.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`), Vitest, Node `child_process`, `docker compose` CLI (v2), `tsx` to run the CLI.

## Global Constraints

- Lifecycle engine is the **`docker compose` CLI**, not dockerode. Run the compiler's YAML as-is.
- Project name: `sds-<experimentId>`. Network `sds-<experimentId>-net` is compiler-owned (inside the YAML) — the controller never manages it directly.
- `up` argv: `docker compose -p sds-<id> -f <dir>/compose.yml up -d --wait`.
- `down` argv: `docker compose -p sds-<id> -f <dir>/compose.yml down -v --remove-orphans`.
- `status` argv: `docker compose -p sds-<id> -f <dir>/compose.yml ps --format json`.
- Run artifacts dir: `.sds-runs/<experimentId>/` (default `runRoot` = `.sds-runs`), gitignored.
- Fail-loud: bad JSON, compile errors, missing image, non-zero compose exit → clear message + non-zero exit. No best-effort.
- `down` is idempotent (no-op success on an already-down project).
- Tests: fast units use a fake `Runner` (no Docker). One real-Docker smoke test is gated behind `RUN_DOCKER=1`.
- TypeScript imports use `.js` specifiers (e.g. `../compiler/index.js`) — matches the existing compiler code.
- Do NOT modify the compiler; LB/service host-reachability fixes are a separate plan.

---

### Task 1: Runner seam

**Files:**
- Create: `src/engine/runner.ts`
- Test: `src/engine/runner.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RunResult { code: number; stdout: string; stderr: string }`
  - `interface Runner { run(argv: string[], opts?: { cwd?: string }): Promise<RunResult> }`
  - `class RealRunner implements Runner`

- [ ] **Step 1: Write the failing test**

`src/engine/runner.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { RealRunner } from './runner.js';

describe('RealRunner', () => {
  it('runs an argv and captures stdout + zero exit code', async () => {
    const r = await new RealRunner().run(['node', '-e', 'process.stdout.write("hi")']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi');
  });

  it('captures a non-zero exit code', async () => {
    const r = await new RealRunner().run(['node', '-e', 'process.exit(3)']);
    expect(r.code).toBe(3);
  });

  it('captures stderr', async () => {
    const r = await new RealRunner().run(['node', '-e', 'process.stderr.write("boom")']);
    expect(r.stderr).toBe('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/engine/runner.test.ts`
Expected: FAIL — cannot find module `./runner.js`.

- [ ] **Step 3: Write minimal implementation**

`src/engine/runner.ts`:
```typescript
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(argv: string[], opts?: { cwd?: string }): Promise<RunResult>;
}

/** Runs commands as real child processes. The single side-effecting unit. */
export class RealRunner implements Runner {
  run(argv: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error('Runner.run called with empty argv');
    return new Promise<RunResult>((resolve) => {
      const child = spawn(cmd, args, { cwd: opts.cwd });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/engine/runner.test.ts`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/engine/runner.ts src/engine/runner.test.ts
git commit -m "feat: add Runner seam for the orchestration engine"
```

---

### Task 2: Controller scaffold + writeArtifacts

**Files:**
- Create: `src/engine/controller.ts`
- Test: `src/engine/controller.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `Runner` from `runner.js` (Task 1); `CompilerResult` from `../compiler/types.js`.
- Produces:
  - `type CompilerOutput = Extract<CompilerResult, { ok: true }>['output']`
  - `interface Publisher { url: string; published: number; target: number }`
  - `interface ServiceStatus { name: string; state: string; health?: string; publishers: Publisher[] }`
  - `class ExperimentController` with `constructor(runner: Runner, opts?: { runRoot?: string })` and `writeArtifacts(id: string, output: CompilerOutput): string`.

- [ ] **Step 1: Write the failing test**

`src/engine/controller.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperimentController } from './controller.js';
import type { Runner, RunResult } from './runner.js';

/** Records argv and returns queued (or default) results. No Docker. */
class FakeRunner implements Runner {
  calls: string[][] = [];
  responses: RunResult[] = [];
  default: RunResult = { code: 0, stdout: '', stderr: '' };
  async run(argv: string[]): Promise<RunResult> {
    this.calls.push(argv);
    return this.responses.shift() ?? this.default;
  }
}

const tmpDirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'sds-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ExperimentController.writeArtifacts', () => {
  it('writes compose.yml always and returns the run dir', () => {
    const root = freshRoot();
    const c = new ExperimentController(new FakeRunner(), { runRoot: root });
    const dir = c.writeArtifacts('exp1', { compose: 'services: {}\n' });
    expect(dir).toBe(join(root, 'exp1'));
    expect(readFileSync(join(dir, 'compose.yml'), 'utf8')).toBe('services: {}\n');
    expect(existsSync(join(dir, 'nginx.conf'))).toBe(false);
    expect(existsSync(join(dir, 'load.js'))).toBe(false);
  });

  it('writes nginx.conf and load.js only when present', () => {
    const root = freshRoot();
    const c = new ExperimentController(new FakeRunner(), { runRoot: root });
    const dir = c.writeArtifacts('exp2', { compose: 'x', nginx: 'upstream {}', k6: 'export default(){}' });
    expect(readFileSync(join(dir, 'nginx.conf'), 'utf8')).toBe('upstream {}');
    expect(readFileSync(join(dir, 'load.js'), 'utf8')).toBe('export default(){}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/engine/controller.test.ts`
Expected: FAIL — cannot find module `./controller.js`.

- [ ] **Step 3: Write minimal implementation**

`src/engine/controller.ts`:
```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { CompilerResult } from '../compiler/types.js';
import type { Runner } from './runner.js';

export type CompilerOutput = Extract<CompilerResult, { ok: true }>['output'];

export interface Publisher {
  url: string;
  published: number;
  target: number;
}

export interface ServiceStatus {
  name: string;
  state: string;
  health?: string;
  publishers: Publisher[];
}

/** Drives one experiment's container lifecycle via the `docker compose` CLI. */
export class ExperimentController {
  private readonly runRoot: string;

  constructor(private readonly runner: Runner, opts: { runRoot?: string } = {}) {
    this.runRoot = opts.runRoot ?? '.sds-runs';
  }

  private dir(id: string): string {
    return resolvePath(this.runRoot, id);
  }

  /** Writes the compiler artifacts to <runRoot>/<id>/ and returns the dir. */
  writeArtifacts(id: string, output: CompilerOutput): string {
    const d = this.dir(id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'compose.yml'), output.compose);
    if (output.nginx) writeFileSync(join(d, 'nginx.conf'), output.nginx);
    if (output.k6) writeFileSync(join(d, 'load.js'), output.k6);
    return d;
  }
}
```

Append to `.gitignore`:
```
.sds-runs/
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/engine/controller.test.ts`
Expected: PASS — 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/engine/controller.ts src/engine/controller.test.ts .gitignore
git commit -m "feat: add ExperimentController with artifact writing"
```

---

### Task 3: up + down

**Files:**
- Modify: `src/engine/controller.ts`
- Modify: `src/engine/controller.test.ts`

**Interfaces:**
- Consumes: `ExperimentController` (Task 2), `Runner` (Task 1).
- Produces: `up(id: string): Promise<void>` and `down(id: string): Promise<void>` on `ExperimentController`. `up` throws on non-zero exit; `down` ignores exit code.

- [ ] **Step 1: Write the failing test**

Append to `src/engine/controller.test.ts`:
```typescript
import { resolve as resolvePath } from 'node:path';

describe('ExperimentController.up / down', () => {
  it('up builds the compose up --wait argv', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    await c.up('exp1');
    expect(runner.calls.at(-1)).toEqual([
      'docker', 'compose', '-p', 'sds-exp1',
      '-f', resolvePath(root, 'exp1', 'compose.yml'),
      'up', '-d', '--wait',
    ]);
  });

  it('up throws with stderr on non-zero exit', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    runner.responses = [{ code: 1, stdout: '', stderr: 'kafka unhealthy' }];
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    await expect(c.up('exp1')).rejects.toThrow(/kafka unhealthy/);
  });

  it('down builds the compose down -v argv', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    await c.down('exp1');
    expect(runner.calls.at(-1)).toEqual([
      'docker', 'compose', '-p', 'sds-exp1',
      '-f', resolvePath(root, 'exp1', 'compose.yml'),
      'down', '-v', '--remove-orphans',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/engine/controller.test.ts`
Expected: FAIL — `c.up is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/controller.ts`, add two private helpers and the `up`/`down` methods to the class (after `writeArtifacts`):
```typescript
  private composePath(id: string): string {
    return join(this.dir(id), 'compose.yml');
  }

  private baseArgs(id: string): string[] {
    return ['docker', 'compose', '-p', `sds-${id}`, '-f', this.composePath(id)];
  }

  /** Brings the stack up and blocks until healthchecked services are healthy. */
  async up(id: string): Promise<void> {
    const r = await this.runner.run([...this.baseArgs(id), 'up', '-d', '--wait']);
    if (r.code !== 0) {
      throw new Error(`docker compose up failed (exit ${r.code}): ${r.stderr.trim()}`);
    }
  }

  /** Tears down the stack and its volumes. Idempotent. */
  async down(id: string): Promise<void> {
    await this.runner.run([...this.baseArgs(id), 'down', '-v', '--remove-orphans']);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/engine/controller.test.ts`
Expected: PASS — up/down tests green, full file green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/controller.ts src/engine/controller.test.ts
git commit -m "feat: add compose up/down lifecycle to controller"
```

---

### Task 4: status (ps parsing)

**Files:**
- Modify: `src/engine/controller.ts`
- Modify: `src/engine/controller.test.ts`

**Interfaces:**
- Consumes: `ExperimentController` (Task 3), `ServiceStatus` (Task 2).
- Produces: `status(id: string): Promise<ServiceStatus[]>`. Tolerates a JSON array, a single object, NDJSON, or empty output.

- [ ] **Step 1: Write the failing test**

Append to `src/engine/controller.test.ts`:
```typescript
describe('ExperimentController.status', () => {
  it('parses NDJSON ps output into ServiceStatus[]', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    runner.responses = [{
      code: 0,
      stdout:
        '{"Name":"sds-exp1-edge-1","State":"running","Health":"","Publishers":[]}\n' +
        '{"Name":"sds-exp1-db-1","State":"running","Health":"healthy","Publishers":[{"URL":"0.0.0.0","PublishedPort":5432,"TargetPort":5432}]}\n',
      stderr: '',
    }];
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    const st = await c.status('exp1');
    expect(st).toHaveLength(2);
    expect(st[0]).toEqual({ name: 'sds-exp1-edge-1', state: 'running', health: undefined, publishers: [] });
    expect(st[1]!.health).toBe('healthy');
    expect(st[1]!.publishers).toEqual([{ url: '0.0.0.0', published: 5432, target: 5432 }]);
  });

  it('parses a JSON array form of ps output', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    runner.responses = [{
      code: 0,
      stdout: '[{"Name":"a","State":"running","Publishers":null}]',
      stderr: '',
    }];
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    const st = await c.status('exp1');
    expect(st).toEqual([{ name: 'a', state: 'running', health: undefined, publishers: [] }]);
  });

  it('returns [] for empty output', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    runner.responses = [{ code: 0, stdout: '\n', stderr: '' }];
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    expect(await c.status('exp1')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/engine/controller.test.ts`
Expected: FAIL — `c.status is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/controller.ts`, add the `status` method to the class:
```typescript
  /** Returns current container status. Tolerates array / single-object / NDJSON ps output. */
  async status(id: string): Promise<ServiceStatus[]> {
    const r = await this.runner.run([...this.baseArgs(id), 'ps', '--format', 'json']);
    const out = r.stdout.trim();
    if (!out) return [];
    let rows: Array<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(out);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      rows = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    }
    return rows.map((row) => {
      const pubs = Array.isArray(row.Publishers) ? row.Publishers : [];
      return {
        name: String(row.Name),
        state: String(row.State),
        health: row.Health ? String(row.Health) : undefined,
        publishers: pubs
          .filter((p: Record<string, unknown>) => p.PublishedPort)
          .map((p: Record<string, unknown>) => ({
            url: p.URL ? String(p.URL) : '0.0.0.0',
            published: Number(p.PublishedPort),
            target: Number(p.TargetPort),
          })),
      };
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/engine/controller.test.ts`
Expected: PASS — status tests green, full file green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/controller.ts src/engine/controller.test.ts
git commit -m "feat: add compose ps status parsing to controller"
```

---

### Task 5: preflight (image check)

**Files:**
- Modify: `src/engine/controller.ts`
- Modify: `src/engine/controller.test.ts`

**Interfaces:**
- Consumes: `ExperimentController` (Task 4), `CompilerOutput` (Task 2).
- Produces: `preflight(output: CompilerOutput): Promise<void>`. Scans the compose string for `sds/*` images, runs `docker image inspect` per unique image, throws a build-hint error on the first missing one.

- [ ] **Step 1: Write the failing test**

Append to `src/engine/controller.test.ts`:
```typescript
describe('ExperimentController.preflight', () => {
  it('passes when every sds/* image inspects ok', async () => {
    const runner = new FakeRunner(); // default code 0 = image present
    const c = new ExperimentController(runner, { runRoot: freshRoot() });
    await expect(
      c.preflight({ compose: 'services:\n  a:\n    image: sds/microservice\n' }),
    ).resolves.toBeUndefined();
    expect(runner.calls).toContainEqual(['docker', 'image', 'inspect', 'sds/microservice']);
  });

  it('throws a build hint when an sds/* image is missing', async () => {
    const runner = new FakeRunner();
    runner.responses = [{ code: 1, stdout: '', stderr: 'No such image' }];
    const c = new ExperimentController(runner, { runRoot: freshRoot() });
    await expect(
      c.preflight({ compose: 'services:\n  w:\n    image: sds/worker\n' }),
    ).rejects.toThrow(/sds\/worker not found.*docker build -t sds\/worker \.\/images\/worker/);
  });

  it('ignores non-sds images', async () => {
    const runner = new FakeRunner();
    const c = new ExperimentController(runner, { runRoot: freshRoot() });
    await c.preflight({ compose: 'services:\n  k:\n    image: bitnami/kafka:latest\n' });
    expect(runner.calls).toEqual([]); // no inspects issued
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/engine/controller.test.ts`
Expected: FAIL — `c.preflight is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/controller.ts`, add the `preflight` method to the class:
```typescript
  /** Fail-loud: verify every sds/* image referenced by the compose exists locally. */
  async preflight(output: CompilerOutput): Promise<void> {
    const images = [
      ...new Set(
        [...output.compose.matchAll(/image:\s*(sds\/\S+)/g)].map((m) => m[1]!),
      ),
    ];
    for (const img of images) {
      const r = await this.runner.run(['docker', 'image', 'inspect', img]);
      if (r.code !== 0) {
        const name = img.split('/')[1]!;
        throw new Error(
          `✗ image ${img} not found — build it: docker build -t ${img} ./images/${name}`,
        );
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/engine/controller.test.ts`
Expected: PASS — preflight tests green, full file green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/controller.ts src/engine/controller.test.ts
git commit -m "feat: add image preflight check to controller"
```

---

### Task 6: CLI + example graphs + sim script

**Files:**
- Create: `src/engine/cli.ts`
- Test: `src/engine/cli.test.ts`
- Create: `examples/service-pair.json`
- Create: `examples/lb-scaling.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `compile` from `../compiler/index.js`; `Graph` from `../compiler/types.js`; `ExperimentController` (Task 5); `RealRunner` (Task 1).
- Produces:
  - `interface Logger { log(s: string): void; error(s: string): void }`
  - `async function runSim(graphPath: string, controller: ExperimentController, out: Logger): Promise<string>` — reads+compiles the graph, preflights, writes artifacts, ups the stack, prints status; returns the experimentId. Throws on any failure. Does NOT wait or tear down.
  - `async function main(argv: string[]): Promise<void>` — wires `RealRunner` + controller, calls `runSim`, then registers SIGINT/SIGTERM teardown (unless `--keep`).

> Note: the spec mentioned `single-service.json`, but a lone service node fails compiler validation (a service needs ≥1 edge). The smallest *valid* runnable graph is two service nodes with one edge — `service-pair.json` below. The smoke test (Task 7) uses it.

- [ ] **Step 1: Write the failing test**

`src/engine/cli.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSim } from './cli.js';
import { ExperimentController } from './controller.js';
import type { Runner, RunResult } from './runner.js';

/** Returns canned ps output for `ps`, success for everything else. */
class StubRunner implements Runner {
  async run(argv: string[]): Promise<RunResult> {
    if (argv.includes('ps')) {
      return { code: 0, stdout: '{"Name":"sds-pair-edge-a-1","State":"running","Publishers":[]}', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
}

class CapturingLogger {
  lines: string[] = [];
  errors: string[] = [];
  log(s: string) { this.lines.push(s); }
  error(s: string) { this.errors.push(s); }
}

const tmpDirs: string[] = [];
function tmpGraph(obj: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'sds-cli-'));
  tmpDirs.push(d);
  const p = join(d, 'graph.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const pairGraph = {
  experimentId: 'pair',
  nodes: [
    { id: 'a', type: 'service', label: 'Edge A' },
    { id: 'b', type: 'service', label: 'Edge B' },
  ],
  edges: [{ source: 'a', target: 'b' }],
};

describe('runSim', () => {
  it('compiles, ups, and prints status; returns experimentId', async () => {
    const out = new CapturingLogger();
    const c = new ExperimentController(new StubRunner(), { runRoot: mkdtempSync(join(tmpdir(), 'sds-run-')) });
    const id = await runSim(tmpGraph(pairGraph), c, out);
    expect(id).toBe('pair');
    expect(out.lines.some((l) => l.includes('sds-pair-edge-a-1'))).toBe(true);
    expect(out.lines.some((l) => l.includes('sds-pair-net'))).toBe(true);
  });

  it('throws and reports compile errors for an invalid graph', async () => {
    const out = new CapturingLogger();
    const c = new ExperimentController(new StubRunner(), { runRoot: mkdtempSync(join(tmpdir(), 'sds-run-')) });
    const orphan = { experimentId: 'bad', nodes: [{ id: 's', type: 'service', label: 'Orphan' }], edges: [] };
    await expect(runSim(tmpGraph(orphan), c, out)).rejects.toThrow(/compile failed/);
    expect(out.errors.some((e) => /Orphan|edge/i.test(e))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/engine/cli.test.ts`
Expected: FAIL — cannot find module `./cli.js`.

- [ ] **Step 3: Write minimal implementation**

`src/engine/cli.ts`:
```typescript
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';

export interface Logger {
  log(s: string): void;
  error(s: string): void;
}

/** Compile a graph file, bring its stack up, print status. Returns the experimentId. Throws on failure. */
export async function runSim(graphPath: string, controller: ExperimentController, out: Logger): Promise<string> {
  const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as Graph;
  const result = compile(graph);
  if (!result.ok) {
    for (const e of result.errors) out.error(`✗ ${e.nodeId}: ${e.message}`);
    throw new Error('compile failed');
  }
  await controller.preflight(result.output);
  controller.writeArtifacts(graph.experimentId, result.output);
  out.log(`⏳ warming up ${graph.experimentId} (kafka cold start ~5-10s if present)…`);
  await controller.up(graph.experimentId);
  for (const s of await controller.status(graph.experimentId)) {
    const ports = s.publishers.map((p) => `${p.published}->${p.target}`).join(', ') || '-';
    out.log(`  ${s.name}  ${s.state}${s.health ? '/' + s.health : ''}  ports:${ports}`);
  }
  out.log(`network: sds-${graph.experimentId}-net   |   Ctrl-C to tear down`);
  return graph.experimentId;
}

export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const keep = args.includes('--keep');
  const runRootIdx = args.indexOf('--run-root');
  const runRoot = runRootIdx >= 0 ? args[runRootIdx + 1] : undefined;
  const graphPath = args.find((a) => !a.startsWith('--') && a !== runRoot);
  if (!graphPath) {
    console.error('usage: npm run sim <graph.json> [--keep] [--run-root <dir>]');
    process.exit(1);
    return;
  }
  const controller = new ExperimentController(new RealRunner(), { runRoot });
  const out: Logger = { log: (s) => console.log(s), error: (s) => console.error(s) };
  let id: string;
  try {
    id = await runSim(graphPath, controller, out);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
    return;
  }
  if (keep) {
    console.log('--keep: leaving stack up. Tear down with: docker compose -p sds-' + id + ' down -v');
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

// Auto-run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv);
}
```

`examples/service-pair.json`:
```json
{
  "experimentId": "pair",
  "nodes": [
    { "id": "a", "type": "service", "label": "Edge A" },
    { "id": "b", "type": "service", "label": "Edge B" }
  ],
  "edges": [{ "source": "a", "target": "b" }]
}
```

`examples/lb-scaling.json`:
```json
{
  "experimentId": "lbdemo",
  "nodes": [
    { "id": "lb", "type": "lb", "label": "Gateway" },
    { "id": "s1", "type": "service", "label": "Svc One" },
    { "id": "s2", "type": "service", "label": "Svc Two" }
  ],
  "edges": [
    { "source": "lb", "target": "s1" },
    { "source": "lb", "target": "s2" }
  ]
}
```

In `package.json`, add a `sim` script and the `tsx` devDependency:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "sim": "tsx src/engine/cli.ts"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```
Then run: `npm install` (writes `tsx` into `package-lock.json` and `node_modules`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/engine/cli.test.ts`
Expected: PASS — 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/engine/cli.ts src/engine/cli.test.ts examples/service-pair.json examples/lb-scaling.json package.json package-lock.json
git commit -m "feat: add sim CLI and example graphs"
```

---

### Task 7: Gated real-Docker smoke test

**Files:**
- Create: `src/engine/controller.smoke.test.ts`

**Interfaces:**
- Consumes: `compile` (`../compiler/index.js`), `ExperimentController` (Task 5), `RealRunner` (Task 1), `examples/service-pair.json` (Task 6).
- Produces: a Vitest suite that runs ONLY when `RUN_DOCKER=1`; otherwise skipped. Requires the `sds/microservice` image to be built locally.

- [ ] **Step 1: Write the test (it is the deliverable)**

`src/engine/controller.smoke.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';

// Gated: runs only with RUN_DOCKER=1 and a built sds/microservice image.
describe.skipIf(!process.env.RUN_DOCKER)('controller smoke (real docker)', () => {
  it('ups a service-pair graph to running, then tears down', async () => {
    const graph = JSON.parse(readFileSync('examples/service-pair.json', 'utf8')) as Graph;
    const result = compile(graph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runRoot = mkdtempSync(join(tmpdir(), 'sds-smoke-'));
    const c = new ExperimentController(new RealRunner(), { runRoot });
    c.writeArtifacts(graph.experimentId, result.output);
    try {
      await c.preflight(result.output);
      await c.up(graph.experimentId);
      const st = await c.status(graph.experimentId);
      expect(st.length).toBeGreaterThanOrEqual(2);
      expect(st.every((s) => s.state === 'running')).toBe(true);
    } finally {
      await c.down(graph.experimentId);
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
```

- [ ] **Step 2: Verify it is skipped by default**

Run: `npm test -- src/engine/controller.smoke.test.ts`
Expected: PASS — suite skipped (0 tests run, no Docker touched). Vitest reports the file with a skipped suite.

- [ ] **Step 3: Run it for real (manual gate — needs Docker + the image)**

Run:
```bash
docker build -t sds/microservice ./images/microservice   # if not already built
RUN_DOCKER=1 npm test -- src/engine/controller.smoke.test.ts
```
Expected: PASS — two `sds/microservice` containers reach `running`, then are torn down. (Networks/volumes removed by `down -v`.)

- [ ] **Step 4: Run the full default suite**

Run: `npm test`
Expected: PASS — all engine + compiler suites green; the smoke suite shows as skipped.

- [ ] **Step 5: Commit**

```bash
git add src/engine/controller.smoke.test.ts
git commit -m "test: add gated real-docker smoke test for controller"
```

---

## Self-Review

**Spec coverage** (design → task):
- compose-CLI lifecycle, exact argv (up --wait / down -v / ps --format json) → Tasks 3, 4 + Global Constraints.
- `Runner` seam (RealRunner + fake) → Task 1; fakes used in Tasks 2–6.
- `ExperimentController` API (writeArtifacts/preflight/up/status/down) → Tasks 2–5.
- `CompilerOutput` derived from compiler types (no duplication) → Task 2.
- Artifact writing (compose always; nginx/load conditional) to `.sds-runs/<id>/` + gitignore → Task 2.
- Preflight sds/* image check, fail-loud build hint → Task 5.
- `status` NDJSON/array/empty tolerance + publishers → Task 4.
- `sim` CLI flow (read→compile→preflight→write→up→status→print→signal teardown) + `--keep`/`--run-root` → Task 6.
- Example graphs + `sim` script + tsx dep → Task 6.
- Fast fake-Runner units → Tasks 1–6; gated real smoke (`RUN_DOCKER=1`) → Task 7.
- Fail-loud + always-teardown + idempotent down → Tasks 3 (up throw), 6 (try/catch teardown), 6 (down idempotent via Task 3).

**Spec deviation (corrected):** spec's `single-service.json` would fail compiler validation (a service needs ≥1 edge); the plan uses `service-pair.json` (two services, one edge) as the smallest valid runnable graph. Noted in Task 6.

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `Runner.run(argv, opts?)`/`RunResult{code,stdout,stderr}` identical across Tasks 1–7. `ExperimentController` ctor `(runner, {runRoot?})`, methods `writeArtifacts/preflight/up/status/down`, and types `CompilerOutput`/`ServiceStatus`/`Publisher` consistent across Tasks 2–7. `runSim(graphPath, controller, out)` + `Logger` used consistently in Task 6. Project name `sds-<id>` and network `sds-<id>-net` consistent.

**Not in this plan (intentional):** dockerode, k6 execution, compiler volume/nginx-mount/host-port fixes, Electron UI — all separate follow-up plans per the design.
