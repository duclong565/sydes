# Payload Sensitivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make request-body size actually move numbers — a load source sends an N-KB filler body and a receiving service adds latency proportional to bytes received, so a fat payload visibly raises a target's latency/saturation.

**Architecture:** Two orthogonal knobs. `config.msPerKb` on a **service** node → `MS_PER_KB` compose env → the Go microservice folds `bytesReceived/1024 × msPerKb` into its sleep. `config.loadBodyKb` on a **load source** → rides the `/api/load` request as `LoadTarget.bodyKb` → the k6 generator posts a constant ≈N-KB body to that target. Latency-only, sized-body-only.

**Tech Stack:** Go (microservice), TypeScript ESM (compiler + agent), React + Zustand (web SPA), k6, vitest, `go test`.

## Global Constraints

- **Self-contained against current `main`.** Every task edits code that exists on `main` today — none depend on PR #29's contents. But #29 and this brick both touch `generateK6` (`k6.ts`), `index.ts`, and `api.ts`, so to avoid merge conflicts, **land #29 first and rebase** this branch onto it. At implementation time, **derive the real `K6Result.total` shape and `generateK6`'s VU lines from the actual merged code** — do not assume field names like `droppedRps` or a `MAX_VUS` constant (they may or may not be present depending on #29).
- **Latency-only v1.** Body affects the service's sleep, never CPU work.
- **Sized body only.** One constant ≈N-KB string built once at k6 module scope, reused every iteration. No template / per-request randomness.
- **Two knobs, two roles:** `msPerKb` (float ≥ 0) only on `service` nodes; `loadBodyKb` (int 1–1024) only on load sources (service/lb), carried in the load request.
- **Back-compat:** `MS_PER_KB` default `"0"` → byte-identical sleep; `loadBodyKb` unset → k6 posts `JSON.stringify({ ping: true })`.
- **Body size cap = 1024 KB**, `msPerKb ≥ 0` — inline red in the Inspector AND fail-loud compile errors.
- **nginx must set `client_max_body_size 2m;`** (nginx default 1 MB = the cap → would 413 lb-path bodies near the cap).
- **Cascade carries no body** (documented limitation): `service → service` posts `http.NoBody`, so `msPerKb` is inert on cascaded hops — only direct + LB-forwarded traffic exercises it.
- ESM `.js` import extensions. Go module on PATH via `export PATH="$PATH:/usr/local/go/bin"`. NEVER a `Co-Authored-By` trailer.
- Verify per task: root `npm test` + `npm run typecheck`; web tasks also `npm --prefix web run test` + `npm --prefix web run build`; Go task `cd images/microservice && go test ./...`.

---

### Task 1: Microservice — react to body size (`MS_PER_KB`)

**Files:**
- Modify: `images/microservice/config.go` (add `MsPerKb`, `nonNegFloat`)
- Modify: `images/microservice/server.go` (`handleRoot` byte count → `delayMs` helper)
- Test: `images/microservice/config_test.go`, `images/microservice/server_test.go`

**Interfaces:**
- Produces: `Config.MsPerKb float64` (env `MS_PER_KB`, default 0); pure `delayMs(cfg Config, bytes int64, jitter int) float64`.

- [ ] **Step 1: Write the failing config test** — append to `images/microservice/config_test.go`.

```go
func TestMsPerKb(t *testing.T) {
	for _, k := range []string{"PORT", "LATENCY_MS", "LATENCY_JITTER_MS", "ERROR_RATE", "UPSTREAM_HTTP", "MS_PER_KB"} {
		t.Setenv(k, "")
	}
	t.Setenv("MS_PER_KB", "0.5")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	if cfg.MsPerKb != 0.5 {
		t.Errorf("MsPerKb = %v, want 0.5", cfg.MsPerKb)
	}
	t.Setenv("MS_PER_KB", "-1")
	if _, err := FromEnv(); err == nil {
		t.Error("expected error for negative MS_PER_KB")
	}
}
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd images/microservice && export PATH="$PATH:/usr/local/go/bin" && go test -run TestMsPerKb ./...`
Expected: FAIL (`cfg.MsPerKb` undefined).

- [ ] **Step 3: Add the field + helper + parse** in `images/microservice/config.go`.

Add to the `Config` struct (after `ErrorRate float64`):
```go
	MsPerKb      float64
```
Add the parse in `FromEnv` (after the `ERROR_RATE` block, before `KafkaBroker`):
```go
	f, err := nonNegFloat("MS_PER_KB")
	if err != nil {
		return Config{}, err
	}
	cfg.MsPerKb = f
```
Add the helper (next to `nonNegInt`):
```go
func nonNegFloat(key string) (float64, error) {
	v := os.Getenv(key)
	if v == "" {
		return 0, nil
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f < 0 {
		return 0, fmt.Errorf("%s must be a non-negative number, got %q", key, v)
	}
	return f, nil
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `cd images/microservice && export PATH="$PATH:/usr/local/go/bin" && go test -run TestMsPerKb ./...`
Expected: PASS.

- [ ] **Step 5: Write the failing delay test** — append to `images/microservice/server_test.go`.

```go
func TestDelayMs(t *testing.T) {
	cfg := Config{LatencyMS: 10, MsPerKb: 0.5}
	// 64 KB at 0.5 ms/KB = +32 ms, plus base 10 ms, plus jitter 3 ms = 45 ms
	if got := delayMs(cfg, 64*1024, 3); got != 45 {
		t.Errorf("delayMs = %v, want 45", got)
	}
	// MsPerKb = 0 → body size has no effect (back-compat)
	if got := delayMs(Config{LatencyMS: 10}, 64*1024, 0); got != 10 {
		t.Errorf("delayMs(no msPerKb) = %v, want 10", got)
	}
}
```

- [ ] **Step 6: Run it — verify it fails**

Run: `cd images/microservice && export PATH="$PATH:/usr/local/go/bin" && go test -run TestDelayMs ./...`
Expected: FAIL (`delayMs` undefined).

- [ ] **Step 7: Add `delayMs` + wire `handleRoot`** in `images/microservice/server.go`.

Add the pure helper (package-level, near `handleRoot`):
```go
// delayMs is the simulated processing time: base latency + jitter + per-KB body cost.
func delayMs(cfg Config, bytes int64, jitter int) float64 {
	return float64(cfg.LatencyMS) + float64(jitter) + float64(bytes)/1024.0*cfg.MsPerKb
}
```
Replace the body-drain + sleep block (currently lines ~63-69):
```go
	n, _ := io.Copy(io.Discard, r.Body)

	jitter := 0
	if s.cfg.JitterMS > 0 {
		jitter = s.rand.Intn(s.cfg.JitterMS + 1)
	}
	time.Sleep(time.Duration(delayMs(s.cfg, n, jitter) * float64(time.Millisecond)))
```

- [ ] **Step 8: Run the Go suite — verify pass + no regression**

Run: `cd images/microservice && export PATH="$PATH:/usr/local/go/bin" && go test ./...`
Expected: PASS (all existing tests + the two new).

- [ ] **Step 9: Commit**

```bash
git add images/microservice/config.go images/microservice/server.go images/microservice/config_test.go images/microservice/server_test.go
git commit -m "feat(microservice): MS_PER_KB — add per-KB body latency to the sim"
```

---

### Task 2: Compiler — emit `MS_PER_KB`, validate `msPerKb ≥ 0`

**Files:**
- Modify: `src/compiler/types.ts` (add `msPerKb?` to `GraphNode.config`)
- Modify: `src/compiler/handlers/service.ts` (emit env + validate)
- Test: `src/compiler/handlers/service.test.ts`

**Interfaces:**
- Consumes: `node.config.msPerKb` (Task 1's env contract `MS_PER_KB`).
- Produces: service compose env gains `MS_PER_KB`.

- [ ] **Step 1: Add the config field** in `src/compiler/types.ts` — extend `GraphNode.config`:

```ts
    msPerKb?: number;    // service receiver: +ms latency per KB received (float ≥ 0)
```

- [ ] **Step 2: Write the failing tests** — append to `src/compiler/handlers/service.test.ts`.

```ts
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

describe('serviceHandler msPerKb', () => {
  const g = (msPerKb?: number): Graph => ({
    experimentId: 'e',
    nodes: [{ id: 's', type: 'service', label: 'Checkout', ...(msPerKb !== undefined ? { config: { msPerKb } } : {}) },
            { id: 'k', type: 'kafka', label: 'Bus' }],
    edges: [{ source: 's', target: 'k' }],
  });

  it('emits MS_PER_KB from config.msPerKb (default 0)', () => {
    const idx = buildIndex(g(0.5));
    expect(serviceHandler.compile(idx.nodeMap.get('s')!, idx).environment.MS_PER_KB).toBe('0.5');
    const idx0 = buildIndex(g());
    expect(serviceHandler.compile(idx0.nodeMap.get('s')!, idx0).environment.MS_PER_KB).toBe('0');
  });

  it('validate rejects a negative msPerKb', () => {
    const idx = buildIndex(g(-1));
    const errs = serviceHandler.validate(idx.nodeMap.get('s')!, idx);
    expect(errs.some((e) => /msPerKb must be ≥ 0/.test(e.message))).toBe(true);
  });
});
```

(If `service.test.ts` lacks `describe`/`expect`/`serviceHandler` imports, add `import { describe, it, expect } from 'vitest';` and `import { serviceHandler } from './service.js';` at the top.)

- [ ] **Step 3: Run them — verify they fail**

Run: `npx vitest run src/compiler/handlers/service.test.ts`
Expected: FAIL (no `MS_PER_KB`, no msPerKb validation).

- [ ] **Step 4: Emit env + validate** in `src/compiler/handlers/service.ts`.

In `compile`, extend the initial `env`:
```ts
    const env: Record<string, string> = {
      LATENCY_MS: String(node.config?.latencyMs ?? 0),
      ERROR_RATE: String(node.config?.errorRate ?? 0),
      MS_PER_KB: String(node.config?.msPerKb ?? 0),
    };
```
In `validate`, return the edge check **plus** an msPerKb check:
```ts
  validate(node, index) {
    const errors = [];
    const hasEdge = index.inEdges(node.id).length > 0 || index.outEdges(node.id).length > 0;
    if (!hasEdge) errors.push({ nodeId: node.id, message: 'Service must have at least one edge' });
    const ms = node.config?.msPerKb;
    if (ms !== undefined && (typeof ms !== 'number' || ms < 0)) {
      errors.push({ nodeId: node.id, message: 'msPerKb must be ≥ 0' });
    }
    return errors;
  },
```

- [ ] **Step 5: Run them — verify they pass + no regression**

Run: `npx vitest run src/compiler/` then `npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/compiler/types.ts src/compiler/handlers/service.ts src/compiler/handlers/service.test.ts
git commit -m "feat(compiler): emit MS_PER_KB from service config.msPerKb + validate >= 0"
```

---

### Task 3: Compiler — sized body in the k6 generator + `bodyKb` cap

**Files:**
- Modify: `src/compiler/generators/k6.ts` (`K6Target.bodyKb`, sized body)
- Modify: `src/compiler/types.ts` (`LoadTarget.bodyKb`)
- Modify: `src/compiler/index.ts` (resolve `bodyKb` + validate 1–1024)
- Test: `src/compiler/generators/k6.test.ts`, `src/compiler/index.test.ts`

**Interfaces:**
- Consumes: the current multi-scenario `generateK6(targets: K6Target[], durationSec)` and its `fns`/scenario construction. The body edit below is **orthogonal to VU sizing** — don't touch the `preAllocatedVUs`/`maxVUs` lines (whatever they are at implementation time).
- Produces: `K6Target = { slug, port, rate, bodyKb? }`; `LoadTarget = { nodeId, rate, bodyKb? }`; sized body posted per target.

- [ ] **Step 1: Add `bodyKb` to `LoadTarget`** in `src/compiler/types.ts`:

```ts
export interface LoadTarget { nodeId: string; rate: number; bodyKb?: number }
```

- [ ] **Step 2: Write the failing generator test** — append to `src/compiler/generators/k6.test.ts`.

```ts
describe('generateK6 sized body', () => {
  it('posts an N-KB constant body when bodyKb is set; ping otherwise', () => {
    const s = generateK6([
      { slug: 'checkout', port: 8080, rate: 50, bodyKb: 64 },
      { slug: 'search', port: 8080, rate: 50 },
    ], 10);
    // 64 KB = 65536 - 10-byte wrapper = 65526 filler chars
    expect(s).toContain("const body0 = '{\"pad\":\"' + 'x'.repeat(65526) + '\"}';");
    expect(s).toContain('http.post(\'http://checkout:8080/\', body0,');
    // no bodyKb → ping
    expect(s).toContain('const body1 = JSON.stringify({ ping: true });');
    expect(s).toContain('http.post(\'http://search:8080/\', body1,');
  });
});
```

- [ ] **Step 3: Run it — verify it fails**

Run: `npx vitest run src/compiler/generators/k6.test.ts`
Expected: FAIL (no per-target body consts; fns post `JSON.stringify({ ping: true })` inline).

- [ ] **Step 4: Add `bodyKb` + sized body** in `src/compiler/generators/k6.ts`.

Extend the interface:
```ts
export interface K6Target { slug: string; port: number; rate: number; bodyKb?: number }
```
Add a `bodies` block and reference it from the exec fns (replace the existing `fns` construction). The `WRAPPER` is `{"pad":""}` minus the filler = 10 bytes:
```ts
  const bodies = targets
    .map((t, i) =>
      t.bodyKb
        ? `const body${i} = '{"pad":"' + 'x'.repeat(${Math.max(0, t.bodyKb * 1024 - 10)}) + '"}';`
        : `const body${i} = JSON.stringify({ ping: true });`,
    )
    .join('\n');

  const fns = targets
    .map(
      (t, i) =>
        `export function fn${i}() {\n` +
        `  http.post('http://${t.slug}:${t.port}/', body${i}, { headers: { 'Content-Type': 'application/json' } });\n` +
        `}`,
    )
    .join('\n');
```
In the returned template literal, emit `bodies` above the functions (between `options` and the fns):
```ts
  return `import http from 'k6/http';

export const options = {
  scenarios: {
${scenarios}
  },
  thresholds: {
${thresholds}
  },
};

${bodies}

${fns}
`;
```

- [ ] **Step 5: Run the generator test — verify it passes**

Run: `npx vitest run src/compiler/generators/k6.test.ts`
Expected: PASS (the new sized-body test + all existing generator tests).

- [ ] **Step 6: Write the failing compiler resolve/validate test** — append to `src/compiler/index.test.ts` (inside the existing load-targeting describe or a new one):

```ts
describe('compile — load body size', () => {
  const g = (): Graph => ({
    experimentId: 'e',
    nodes: [{ id: 's', type: 'service', label: 'Checkout' }, { id: 'd', type: 'db', label: 'DB' }],
    edges: [{ source: 's', target: 'd' }],
  });

  it('threads bodyKb into the generated k6', () => {
    const r = compile(g(), { durationSec: 10, targets: [{ nodeId: 's', rate: 50, bodyKb: 64 }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output.k6).toContain("'x'.repeat(65526)");
  });

  it('fails loud on bodyKb out of 1–1024', () => {
    for (const bodyKb of [0, 2.5, 2048]) {
      const r = compile(g(), { durationSec: 10, targets: [{ nodeId: 's', rate: 50, bodyKb }] });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.errors.some((e) => /1–1024 KB/.test(e.message))).toBe(true);
    }
  });
});
```

- [ ] **Step 7: Run it — verify it fails**

Run: `npx vitest run src/compiler/index.test.ts`
Expected: FAIL (bodyKb not validated/resolved).

- [ ] **Step 8: Resolve + validate `bodyKb`** in `src/compiler/index.ts`.

In the load-targeting validation pass (the `if (loadConfig)` block that checks rate), add per target:
```ts
      if (t.bodyKb !== undefined && (!Number.isInteger(t.bodyKb) || t.bodyKb < 1 || t.bodyKb > 1024)) {
        errors.push({ nodeId: t.nodeId, message: `Body size for "${node?.label ?? t.nodeId}" must be a whole number 1–1024 KB` });
      }
```
In the k6 resolve block, pass `bodyKb` into the `K6Target`:
```ts
    const resolved = loadConfig.targets.map((t) => {
      const node = index.nodeMap.get(t.nodeId)!;
      return { slug: slugify(node.label), port: node.type === 'lb' ? 80 : 8080, rate: t.rate, bodyKb: t.bodyKb };
    });
    output.k6 = generateK6(resolved, loadConfig.durationSec);
```

- [ ] **Step 9: Run compiler tests + typecheck — verify pass**

Run: `npx vitest run src/compiler/` then `npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 10: Commit**

```bash
git add src/compiler/generators/k6.ts src/compiler/types.ts src/compiler/index.ts src/compiler/generators/k6.test.ts src/compiler/index.test.ts
git commit -m "feat(compiler): sized request body per load target (bodyKb, 1-1024 KB cap)"
```

---

### Task 4: nginx — raise `client_max_body_size` (the 413 fix)

**Files:**
- Modify: `src/compiler/generators/nginx.ts`
- Test: `src/compiler/generators/nginx.test.ts`

**Interfaces:**
- Produces: generated nginx.conf with `client_max_body_size 2m;` in the server block.

- [ ] **Step 1: Write the failing test** — append to `src/compiler/generators/nginx.test.ts`.

```ts
it('sets client_max_body_size above the 1024 KB body cap', () => {
  expect(generateNginx(['a', 'b'])).toContain('client_max_body_size 2m;');
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run src/compiler/generators/nginx.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the directive** in `src/compiler/generators/nginx.ts` — inside the `server {` block, above `location /`:

```ts
    'server {',
    '    listen 80;',
    '    client_max_body_size 2m;',
    '    location / {',
    '        proxy_pass http://backend;',
    '    }',
    '}',
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run src/compiler/generators/nginx.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/generators/nginx.ts src/compiler/generators/nginx.test.ts
git commit -m "fix(compiler): nginx client_max_body_size 2m so big lb-path bodies don't 413"
```

---

### Task 5: SPA store — `msPerKb` + `loadBodyKb` on `NodeConfig`

**Files:**
- Modify: `web/src/store.ts:14`
- Test: `web/src/store.test.ts`

**Interfaces:**
- Produces: `NodeConfig.msPerKb?: number`, `NodeConfig.loadBodyKb?: number`; round-trip through `toGraph`/`loadExample`.

- [ ] **Step 1: Write the failing test** — append to `web/src/store.test.ts`.

```ts
it('round-trips msPerKb + loadBodyKb through toGraph', () => {
  const s = useGraphStore.getState();
  s.loadExample({ experimentId: 'e', nodes: [{ id: 's', type: 'service', label: 'Checkout', config: { msPerKb: 0.5, loadBodyKb: 64 } }], edges: [] });
  expect(useGraphStore.getState().toGraph().nodes[0].config).toEqual({ msPerKb: 0.5, loadBodyKb: 64 });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm --prefix web run test -- store.test.ts`
Expected: FAIL (TS error: fields not on `NodeConfig`).

- [ ] **Step 3: Add the fields** in `web/src/store.ts`:

```ts
export interface NodeConfig { latencyMs?: number; errorRate?: number; partitions?: number; loadRate?: number; msPerKb?: number; loadBodyKb?: number }
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm --prefix web run test -- store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/store.ts web/src/store.test.ts
git commit -m "feat(web): NodeConfig.msPerKb + loadBodyKb on the graph store"
```

---

### Task 6: SPA Inspector — `ms/KB` (service) + `body size (KB)` (source)

**Files:**
- Modify: `web/src/Inspector.tsx`
- Test: `web/src/Inspector.test.tsx`

**Interfaces:**
- Consumes: `NodeConfig.msPerKb`, `NodeConfig.loadBodyKb` (Task 5).

- [ ] **Step 1: Write the failing tests** — append to `web/src/Inspector.test.tsx`.

```tsx
it('shows payload sensitivity on a service and flags a negative value', () => {
  const id = addAndSelect('service');
  useGraphStore.getState().updateNode(id, { config: { msPerKb: -1 } });
  render(<Inspector />);
  expect(screen.getByLabelText('msPerKb')).toBeInTheDocument();
  expect(screen.getByText(/Must be ≥ 0/i)).toBeInTheDocument();
});

it('shows body size on a load source and flags > 1024', () => {
  const id = addAndSelect('service');
  useGraphStore.getState().updateNode(id, { config: { loadRate: 50, loadBodyKb: 5000 } });
  render(<Inspector />);
  expect(screen.getByLabelText('body size')).toBeInTheDocument();
  expect(screen.getByText(/Max body size is 1024 KB/i)).toBeInTheDocument();
});

it('shows no payload-sensitivity field on a kafka node', () => {
  addAndSelect('kafka');
  render(<Inspector />);
  expect(screen.queryByLabelText('msPerKb')).toBeNull();
});
```

- [ ] **Step 2: Run them — verify they fail**

Run: `npm --prefix web run test -- Inspector.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the `ms/KB` field to the service block** in `web/src/Inspector.tsx` — after the `errorRate` input, inside `node.data.type === 'service'`:

```tsx
          <label htmlFor="insp-mspkb" className="block text-xs text-slate-500">payload sensitivity (ms/KB)</label>
          {(() => {
            const ms = cfg.msPerKb ?? 0;
            const bad = typeof ms !== 'number' || ms < 0;
            return (<>
              <input
                id="insp-mspkb" aria-label="msPerKb" type="number" step="0.1" min={0}
                value={cfg.msPerKb ?? 0}
                onChange={(e) => updateNode(node.id, { config: { ...cfg, msPerKb: Number(e.target.value) } })}
                className={`mb-1 w-full rounded border px-2 py-1 text-sm ${bad ? 'border-red-500 bg-red-50' : 'border-slate-300'}`}
              />
              {bad && <div className="mb-2 text-xs font-semibold text-red-600">Must be ≥ 0</div>}
            </>);
          })()}
```

- [ ] **Step 4: Add the `body size (KB)` field to the load section** — in the `(service||lb)` load block, when the toggle is on (after the rate input), add:

```tsx
          <label htmlFor="insp-bodykb" className="mt-2 block text-xs text-slate-500">body size (KB)</label>
          {(() => {
            const kb = cfg.loadBodyKb;
            const bad = kb !== undefined && (!Number.isInteger(kb) || kb < 1 || kb > 1024);
            return (<>
              <input
                id="insp-bodykb" aria-label="body size" type="number" min={1}
                value={kb ?? ''} placeholder="(unset → {ping:true})"
                onChange={(e) => updateNode(node.id, { config: { ...cfg, loadBodyKb: e.target.value === '' ? undefined : Number(e.target.value) } })}
                className={`w-full rounded border px-2 py-1 text-sm ${bad ? 'border-red-500 bg-red-50' : 'border-slate-300'}`}
              />
              {bad
                ? <div className="mt-1 text-xs font-semibold text-red-600">Max body size is 1024 KB</div>
                : <div className="mt-1 text-[10px] text-slate-400">only bites a service with ms/KB &gt; 0</div>}
            </>);
          })()}
```

- [ ] **Step 5: Run the tests — verify they pass**

Run: `npm --prefix web run test -- Inspector.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/Inspector.tsx web/src/Inspector.test.tsx
git commit -m "feat(web): Inspector payload sensitivity (ms/KB) + body size (KB) fields"
```

---

### Task 7: SPA App — carry `bodyKb` in the load request

**Files:**
- Modify: `web/src/App.tsx` (sources/targets builder)
- Modify: `web/src/api.ts` (load targets type)
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `config.loadBodyKb` (Task 5); `api.load(runId, durationSec, targets)`.
- Produces: `targets` entries gain optional `bodyKb`.

- [ ] **Step 1: Widen the `api.load` targets type** in `web/src/api.ts`:

```ts
  load: (runId: string, durationSec: number, targets: { nodeId: string; rate: number; bodyKb?: number }[]) =>
    jsonFetch<LoadResult>(`/api/load/${runId}`, { method: 'POST', body: JSON.stringify({ durationSec, targets }) }),
```

- [ ] **Step 2: Write the failing test** — append to `web/src/App.test.tsx` (mirror the existing "Run load posts targets" test; mark a source with `loadBodyKb`).

```tsx
it('includes bodyKb in the load targets when set', async () => {
  // the resolved value is never asserted (we check the CALL args), so cast a minimal
  // stub rather than coupling to the current K6Result.total shape:
  const spy = vi.spyOn(api, 'load').mockResolvedValue({ perTarget: [], total: {} } as unknown as Awaited<ReturnType<typeof api.load>>);
  // arrange a running experiment with a service node config { loadRate: 50, loadBodyKb: 64 } (reuse the suite's running-state setup)
  // act: click "Run load"
  expect(spy).toHaveBeenCalledWith(expect.any(String), expect.any(Number),
    [expect.objectContaining({ rate: 50, bodyKb: 64 })]);
});
```

(Use the existing `App.test.tsx` harness that stands up the `running` state + marks a load source; add `loadBodyKb: 64` to that node's config. The `as unknown as …` cast keeps the mock valid whatever `K6Result.total`'s exact fields are.)

- [ ] **Step 3: Run it — verify it fails**

Run: `npm --prefix web run test -- App.test.tsx`
Expected: FAIL (targets carry no `bodyKb`).

- [ ] **Step 4: Thread `bodyKb` into the targets** in `web/src/App.tsx` — where `sources` is built from marked nodes:

```tsx
const sources = useGraphStore((s) =>
  s.nodes
    .filter((n) => {
      const t = n.data.type, r = n.data.config?.loadRate;
      return (t === 'service' || t === 'lb') && Number.isInteger(r) && (r as number) >= 1;
    })
    .map((n) => ({
      nodeId: n.id,
      rate: n.data.config!.loadRate as number,
      ...(n.data.config?.loadBodyKb ? { bodyKb: n.data.config.loadBodyKb } : {}),
    })),
);
```
(`onRunLoad` already passes `sources` to `api.load` — no further change.)

- [ ] **Step 5: Run it — verify it passes + full web suite + build**

Run: `npm --prefix web run test -- App.test.tsx` then `npm --prefix web run test` then `npm --prefix web run build`
Expected: PASS / build clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/App.tsx web/src/api.ts web/src/App.test.tsx
git commit -m "feat(web): send per-source bodyKb in the load request"
```

---

### Task 8: Docs

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Update `CLAUDE.md`.** In the `sds/microservice` env-var list add `MS_PER_KB` (per-KB body latency). In the Graph Compiler / Load generator notes, document the sized body (`config.loadBodyKb`, 1–1024 KB), `client_max_body_size 2m`, and the **cascade-carries-no-body** limitation (`msPerKb` fires on direct + LB-forwarded traffic, not `service → service`).

- [ ] **Step 2: Update `README.md`.** Add a line under load: a service's `payload sensitivity (ms/KB)` + a source's `body size (KB)` let a fat payload saturate a service; note the 16–128 KB sweet spot and that transport cost dominates at ~1 MB.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: payload sensitivity (MS_PER_KB, body size, cascade limitation)"
```

---

## Self-Review

**Spec coverage:**
- Microservice `MS_PER_KB` + byte-count sleep → Task 1 ✓ (pure `delayMs` for deterministic tests)
- `nonNegFloat`, back-compat at 0 → Task 1 ✓
- Compiler emits `MS_PER_KB` + `msPerKb ≥ 0` validate → Task 2 ✓
- Sized body per target + `K6Target.bodyKb` + `LoadTarget.bodyKb` → Task 3 ✓
- `bodyKb` 1–1024 fail-loud → Task 3 ✓
- nginx `client_max_body_size 2m` → Task 4 ✓
- web `NodeConfig.msPerKb`/`loadBodyKb` → Task 5 ✓
- Inspector two fields + validation + no-op hint → Task 6 ✓
- App threads `bodyKb` → Task 7 ✓
- No new results column → (no task; intentional) ✓
- Cascade limitation + transport caveat documented → Task 8 ✓
- Stacks on #29 → Global Constraints ✓

**Placeholder scan:** every code step has concrete code; the App/Inspector tests name the exact harness + `aria-label`s + assertions; the wrapper math is `bodyKb*1024 - 10` (= 65526 at 64 KB) consistently in Task 3 generator + test + compiler test.

**Type consistency:** `Config.MsPerKb float64`; `delayMs(cfg, bytes int64, jitter int) float64`; `K6Target = { slug, port, rate, bodyKb? }`; `LoadTarget = { nodeId, rate, bodyKb? }`; `NodeConfig` gains `msPerKb?`/`loadBodyKb?`; `api.load(runId, durationSec, targets:{nodeId,rate,bodyKb?}[])`; env `MS_PER_KB`. Used identically across Tasks 1–8.
