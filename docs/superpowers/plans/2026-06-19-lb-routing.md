# Compiler LB Routing v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Load-Balancer graphs actually route — mount the compiler's generated nginx config into the `nginx:alpine` LB container so `curl localhost:80` round-robins to the `sds/microservice` backends.

**Architecture:** Three small changes: add a `volumes` field to `ComposeService` and emit it from the compose generator; have the `lb` handler mount the generated `nginx.conf` at `/etc/nginx/conf.d/default.conf`; add a gated real-Docker smoke proving routing. The nginx generator and the Docker Controller are unchanged.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`), Vitest, `docker compose` CLI (via the existing controller), Node `fetch` (v22) for the smoke.

## Global Constraints

- `ComposeService.volumes` is `string[]` using Compose short syntax (mirrors `ports`), e.g. `"./nginx.conf:/etc/nginx/conf.d/default.conf:ro"`.
- The LB mount string is exactly `./nginx.conf:/etc/nginx/conf.d/default.conf:ro`.
- Mount target is `/etc/nginx/conf.d/default.conf` (NOT `/etc/nginx/nginx.conf`) — the generated config is an http-context snippet included via stock nginx's `conf.d/*.conf`.
- `generateNginx` is NOT changed. The Docker Controller is NOT changed.
- Compose generator stays deterministic: array order, no key sorting; services without `volumes` emit no `volumes:` block (existing output byte-identical).
- The gated smoke is skipped unless `RUN_DOCKER=1`. The `sds/microservice` image must be built locally; `nginx:alpine` is pulled by compose on first `up`.
- TypeScript imports use `.js` specifiers. **No `Co-Authored-By` trailer in commits.**

---

### Task 1: `ComposeService.volumes` + compose generator emission

**Files:**
- Modify: `src/compiler/types.ts`
- Modify: `src/compiler/generators/compose.ts`
- Test: `src/compiler/generators/compose.test.ts`

**Interfaces:**
- Consumes: `ComposeService` from `types.ts`.
- Produces: `ComposeService.volumes?: string[]`; `generateCompose` renders a `volumes:` block (each entry `- "<volume>"`) after the `ports:` block when present.

- [ ] **Step 1: Write the failing test**

Append to `src/compiler/generators/compose.test.ts`:
```typescript
describe('generateCompose volumes', () => {
  it('renders a volumes block when present', () => {
    const services: ComposeService[] = [
      {
        name: 'gateway',
        image: 'nginx:alpine',
        environment: {},
        ports: ['80:80'],
        volumes: ['./nginx.conf:/etc/nginx/conf.d/default.conf:ro'],
      },
    ];
    const yaml = generateCompose(services, 'net');
    expect(yaml).toContain('    volumes:');
    expect(yaml).toContain('      - "./nginx.conf:/etc/nginx/conf.d/default.conf:ro"');
  });

  it('omits the volumes block when absent', () => {
    const services: ComposeService[] = [
      { name: 'svc', image: 'sds/microservice', environment: { LATENCY_MS: '0' } },
    ];
    expect(generateCompose(services, 'net')).not.toContain('volumes:');
  });
});
```

> Note: `compose.test.ts` already imports `describe`, `it`, `expect`, `generateCompose`, and the `ComposeService` type. If for some reason `describe` is not imported in this file, add it to the existing `vitest` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/compiler/generators/compose.test.ts`
Expected: FAIL — `volumes` is not a known property of `ComposeService` (type error) and/or the `volumes:` block is not rendered.

- [ ] **Step 3: Write minimal implementation**

In `src/compiler/types.ts`, add the `volumes` field to `ComposeService` (after `ports`):
```typescript
export interface ComposeService {
  name: string;        // container name + DNS hostname
  image: string;
  environment: Record<string, string>;
  ports?: string[];    // e.g. "8080:8080"
  volumes?: string[];  // e.g. "./nginx.conf:/etc/nginx/conf.d/default.conf:ro"
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
  };
}
```

In `src/compiler/generators/compose.ts`, add a `volumes:` block immediately after the existing `ports:` block (before the `healthcheck` block):
```typescript
    if (svc.volumes && svc.volumes.length > 0) {
      lines.push('    volumes:');
      for (const vol of svc.volumes) lines.push(`      - "${vol}"`);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/compiler/generators/compose.test.ts`
Expected: PASS — new volumes tests green, all prior compose tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/types.ts src/compiler/generators/compose.ts src/compiler/generators/compose.test.ts
git commit -m "feat: add volumes support to ComposeService and compose generator"
```

---

### Task 2: LB handler mounts the nginx config

**Files:**
- Modify: `src/compiler/handlers/lb.ts`
- Test: `src/compiler/handlers/lb.test.ts`
- Test: `src/compiler/index.test.ts`

**Interfaces:**
- Consumes: `ComposeService.volumes` (Task 1); `lbHandler` from `lb.ts`; `compile` from `index.ts`.
- Produces: `lbHandler.compile(...)` returns `volumes: ['./nginx.conf:/etc/nginx/conf.d/default.conf:ro']`; an LB graph's `output.compose` contains that mount on the lb service.

- [ ] **Step 1: Write the failing tests**

Append to `src/compiler/handlers/lb.test.ts`:
```typescript
describe('lbHandler.compile volumes', () => {
  it('mounts the generated nginx config into the container', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'lb', type: 'lb', label: 'Gateway LB' }], edges: [] };
    const svc = lbHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.volumes).toEqual(['./nginx.conf:/etc/nginx/conf.d/default.conf:ro']);
  });
});
```

Append to `src/compiler/index.test.ts`:
```typescript
describe('compile — load balancer volumes', () => {
  it('emits the nginx config mount on the lb service', () => {
    const g: Graph = {
      experimentId: 'lbv',
      nodes: [
        { id: 'lb', type: 'lb', label: 'Gateway' },
        { id: 's1', type: 'service', label: 'Svc One' },
        { id: 's2', type: 'service', label: 'Svc Two' },
      ],
      edges: [
        { source: 'lb', target: 's1' },
        { source: 'lb', target: 's2' },
      ],
    };
    const result = compile(g);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.compose).toContain('./nginx.conf:/etc/nginx/conf.d/default.conf:ro');
  });
});
```

> Note: both test files already import `describe`/`it`/`expect`, `buildIndex` (lb.test.ts), `compile` (index.test.ts), and the `Graph` type. Reuse the existing imports; do not duplicate import lines.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/compiler/handlers/lb.test.ts src/compiler/index.test.ts`
Expected: FAIL — `svc.volumes` is `undefined`; `output.compose` does not contain the mount string.

- [ ] **Step 3: Write minimal implementation**

In `src/compiler/handlers/lb.ts`, add `volumes` to the returned object:
```typescript
  compile(node) {
    return {
      name: slugify(node.label),
      image: 'nginx:alpine',
      environment: {},
      ports: ['80:80'],
      volumes: ['./nginx.conf:/etc/nginx/conf.d/default.conf:ro'],
    };
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/compiler/handlers/lb.test.ts src/compiler/index.test.ts`
Expected: PASS — new volumes assertions green, all prior lb/index tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/handlers/lb.ts src/compiler/handlers/lb.test.ts src/compiler/index.test.ts
git commit -m "feat: mount generated nginx config in lb container"
```

---

### Task 3: Gated real-Docker LB routing smoke

**Files:**
- Create: `src/engine/lb-routing.smoke.test.ts`

**Interfaces:**
- Consumes: `compile` (`../compiler/index.js`), `Graph` (`../compiler/types.js`), `ExperimentController` (`./controller.js`), `RealRunner` (`./runner.js`), `examples/lb-scaling.json` (already in the repo: lb → 2 services).
- Produces: a Vitest suite that runs only when `RUN_DOCKER=1`; otherwise skipped. Brings an LB stack up and asserts `localhost:80` returns 200 from a backend.

- [ ] **Step 1: Write the test (it is the deliverable)**

`src/engine/lb-routing.smoke.test.ts`:
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
// Requires host port 80 to be free.
describe.skipIf(!process.env.RUN_DOCKER)('lb routing smoke (real docker)', () => {
  it('routes localhost:80 through nginx to the backends', async () => {
    const graph = JSON.parse(readFileSync('examples/lb-scaling.json', 'utf8')) as Graph;
    const result = compile(graph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runRoot = mkdtempSync(join(tmpdir(), 'sds-lb-'));
    const c = new ExperimentController(new RealRunner(), { runRoot });
    c.writeArtifacts(graph.experimentId, result.output);
    try {
      await c.preflight(result.output);
      await c.up(graph.experimentId);

      // Give the backends a moment to bind after the container reports running.
      await new Promise((r) => setTimeout(r, 1500));

      let ok = 0;
      for (let i = 0; i < 6; i++) {
        const res = await fetch('http://localhost:80/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (res.status === 200) ok++;
      }
      // nginx is configured (not the default welcome page) and routes to a healthy backend.
      expect(ok).toBeGreaterThanOrEqual(5);
    } finally {
      await c.down(graph.experimentId);
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
```

- [ ] **Step 2: Verify it is skipped by default**

Run: `npm test -- src/engine/lb-routing.smoke.test.ts`
Expected: PASS — suite skipped (0 tests run, no Docker touched).

- [ ] **Step 3: Run it for real (manual gate — needs Docker, the image, and free host port 80)**

Run:
```bash
docker build -t sds/microservice ./images/microservice   # if not already built
RUN_DOCKER=1 npm test -- src/engine/lb-routing.smoke.test.ts
```
Expected: PASS — `localhost:80` returns 200 ≥5/6 times (nginx routed to a backend), then the stack is torn down. If host port 80 is busy, free it (or stop the conflicting process) and retry.

- [ ] **Step 4: Run the full default suite**

Run: `npm test`
Expected: PASS — all suites green; both smoke suites (controller + lb-routing) show as skipped.

- [ ] **Step 5: Commit**

```bash
git add src/engine/lb-routing.smoke.test.ts
git commit -m "test: add gated real-docker lb routing smoke"
```

---

## Self-Review

**Spec coverage** (design → task):
- `ComposeService.volumes` field + compose generator emission → Task 1.
- LB handler mounts `./nginx.conf:/etc/nginx/conf.d/default.conf:ro` → Task 2.
- nginx generator unchanged; controller unchanged → no task touches them (Tasks 1–3 file lists exclude `generators/nginx.ts` and `src/engine/controller.ts`/`runner.ts`/`cli.ts`).
- Determinism (volumes only when present; existing output unchanged) → Task 1 "omits the volumes block when absent" test.
- Gated real-Docker routing proof (`curl localhost:80` → 200) → Task 3.
- Round-robin not strictly asserted (no per-instance marker) → Task 3 asserts ≥5/6 200s, documented in the test comment.

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `ComposeService.volumes?: string[]` defined in Task 1, consumed by Task 2's `lbHandler.compile` return and the compose generator. The mount string `./nginx.conf:/etc/nginx/conf.d/default.conf:ro` is byte-identical across Task 1 test, Task 2 handler + tests, and matches the controller's already-written `nginx.conf` filename. `compile`/`ExperimentController`/`RealRunner` signatures match their existing definitions.

**Not in this plan (intentional):** service host ports (port-allocation), round-robin distribution assertion (needs an `INSTANCE_ID` marker on `sds/microservice`), k6 Runner, Metrics — all separate follow-ups per the design.
