# Edge-Legality Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Graph Compiler fail loud on any edge whose source→target type combo it doesn't wire (silent no-ops like `db → service`), and wire the one combo that needs to become real: `service → service` (upstream cascade).

**Architecture:** A default-deny edge-legality pass runs inside `compile()` after the per-node validation loop, appending to the same `errors` array (so node + edge errors surface together). A 6-entry allowlist keyed `${srcType}>${tgtType}` is the single source of truth. Separately, `service.compile` now emits `UPSTREAM_HTTP=http://<slug>:8080` on a `service → service` edge so that combo is meaningful, not a no-op.

**Tech Stack:** TypeScript (ESM, Node), vitest. Pure compiler logic — no Docker, no network.

## Global Constraints

- Root package is ESM — all relative imports use `.js` suffixes (even for `.ts` files). Root vitest runs `src/**/*.test.ts`.
- The compiler is **fail-loud and deterministic**: refuse to generate, report clear node-attributed errors, never best-effort. Collect ALL errors in a pass (do not stop at the first).
- Allowlist (exact, 6 entries): `service>kafka`, `service>db`, `service>service`, `worker>kafka`, `worker>db`, `lb>service`.
- Error message template (verbatim): `Invalid connection: a ${src.type} ("${src.label}") cannot connect to a ${tgt.type} ("${tgt.label}")`. `nodeId = edge.source` for every edge error.
- `UPSTREAM_HTTP` value (verbatim): `http://${slugify(target.label)}:8080` — must be a full URL (the microservice validates `url.ParseRequestURI`).
- NEVER add a `Co-Authored-By` trailer to commits.

---

### Task 1: Wire the `service → service` upstream cascade

Do this first so `service → service` is meaningful before the allowlist (Task 2) admits it.

**Files:**
- Modify: `src/compiler/handlers/service.ts` (the `compile` out-edge loop)
- Test: `src/compiler/handlers/service.test.ts`

**Interfaces:**
- Consumes: existing `serviceHandler.compile(node, index)`, `slugify` (from `../util.js`).
- Produces: a `service → service` out-edge sets `environment.UPSTREAM_HTTP = http://<slug(target.label)>:8080`. No other behavior changes.

- [ ] **Step 1: Write the failing test**

Append to `src/compiler/handlers/service.test.ts`:

```ts
describe('serviceHandler.compile upstream cascade', () => {
  it('sets UPSTREAM_HTTP on a service->service edge', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'a', type: 'service', label: 'Edge A' },
        { id: 'b', type: 'service', label: 'Edge B' },
      ],
      edges: [{ source: 'a', target: 'b' }],
    };
    const env = serviceHandler.compile(g.nodes[0]!, buildIndex(g)).environment;
    expect(env.UPSTREAM_HTTP).toBe('http://edge-b:8080');
  });

  it('leaves UPSTREAM_HTTP undefined without a service edge', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'a', type: 'service', label: 'Edge A' },
        { id: 'd', type: 'db', label: 'Orders DB' },
      ],
      edges: [{ source: 'a', target: 'd' }],
    };
    const env = serviceHandler.compile(g.nodes[0]!, buildIndex(g)).environment;
    expect(env.UPSTREAM_HTTP).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/compiler/handlers/service.test.ts`
Expected: FAIL — `UPSTREAM_HTTP` is `undefined` in the first new test.

- [ ] **Step 3: Add the cascade branch**

In `src/compiler/handlers/service.ts`, inside `for (const edge of index.outEdges(node.id)) { ... }`, after the existing `if (target.type === 'kafka') { ... }` block, add:

```ts
      if (target.type === 'service') env.UPSTREAM_HTTP = `http://${slugify(target.label)}:8080`;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/compiler/handlers/service.test.ts`
Expected: PASS (all service handler tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/compiler/handlers/service.ts src/compiler/handlers/service.test.ts
git commit -m "feat: wire service->service upstream cascade (UPSTREAM_HTTP)"
```

---

### Task 2: Edge-legality pass in `compile()`

**Files:**
- Modify: `src/compiler/index.ts` (add `ALLOWED_EDGES` + the edge-legality pass)
- Test: `src/compiler/index.test.ts`

**Interfaces:**
- Consumes: `buildIndex` / `index.nodeMap` (existing), `CompilerError` (existing type), `graph.edges`. Task 1's `UPSTREAM_HTTP` wiring (for the cascade-accept test's compose assertion).
- Produces: `compile()` returns `{ ok: false, errors }` for any dangling, self-loop, or non-allowlisted edge; valid graphs unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `src/compiler/index.test.ts`:

```ts
describe('compile — edge legality', () => {
  it('rejects a db→service edge (silent no-op) with a node-attributed message', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 's', type: 'service', label: 'Order Service' },
        { id: 'd', type: 'db', label: 'DB 1' },
        { id: 's2', type: 'service', label: 'Service 2' },
      ],
      edges: [
        { source: 's', target: 'd' },   // service->db: legal (keeps s and d valid)
        { source: 'd', target: 's2' },  // db->service: illegal
      ],
    };
    const result = compile(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/cannot connect to a service/i);
    expect(result.errors[0]!.nodeId).toBe('d');
  });

  it('rejects lb→db', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'lb', type: 'lb', label: 'Gateway' },
        { id: 's1', type: 'service', label: 'Svc One' },
        { id: 's2', type: 'service', label: 'Svc Two' },
        { id: 'd', type: 'db', label: 'DB' },
      ],
      edges: [
        { source: 'lb', target: 's1' },
        { source: 'lb', target: 's2' },
        { source: 'lb', target: 'd' }, // lb->db: illegal
      ],
    };
    const result = compile(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => /cannot connect to a db/i.test(e.message))).toBe(true);
  });

  it('rejects a self-loop', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'a', type: 'service', label: 'Edge A' }],
      edges: [{ source: 'a', target: 'a' }],
    };
    const result = compile(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toMatch(/cannot connect to itself/i);
  });

  it('rejects an edge referencing an unknown node', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'a', type: 'service', label: 'Edge A' }],
      edges: [{ source: 'a', target: 'ghost' }],
    };
    const result = compile(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toMatch(/unknown node "ghost"/i);
  });

  it('accepts service→service and wires the cascade into compose', () => {
    const g: Graph = {
      experimentId: 'pair',
      nodes: [
        { id: 'a', type: 'service', label: 'Edge A' },
        { id: 'b', type: 'service', label: 'Edge B' },
      ],
      edges: [{ source: 'a', target: 'b' }],
    };
    const result = compile(g);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.compose).toContain('UPSTREAM_HTTP: "http://edge-b:8080"');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/compiler/index.test.ts`
Expected: FAIL — the illegal-edge graphs currently compile `ok` (no legality check); the four reject-tests fail. (The cascade-accept test passes already via Task 1.)

- [ ] **Step 3: Add the allowlist constant**

In `src/compiler/index.ts`, after the imports and before `export function compile(...)`, add:

```ts
/** Source→target type combos the compiler actually wires. Everything else is a no-op edge. */
const ALLOWED_EDGES = new Set<string>([
  'service>kafka', 'service>db', 'service>service',
  'worker>kafka', 'worker>db',
  'lb>service',
]);
```

- [ ] **Step 4: Add the edge-legality pass**

In `src/compiler/index.ts`, locate the per-node validation block:

```ts
  // 2. Validation pass — collect ALL errors.
  const errors: CompilerError[] = [];
  for (const node of graph.nodes) {
    errors.push(...handlers[node.type].validate(node, index));
  }
  if (errors.length > 0) return { ok: false, errors };
```

Insert the edge pass **between** the per-node `for` loop and the `if (errors.length > 0) return` line, so node + edge errors collect together:

```ts
  // Edge-legality pass — default-deny. Reject dangling refs, self-loops, and any
  // source→target combo no handler wires (silent no-ops like db→service).
  for (const edge of graph.edges) {
    const src = index.nodeMap.get(edge.source);
    const tgt = index.nodeMap.get(edge.target);
    if (!src || !tgt) {
      const missing = !src ? edge.source : edge.target;
      errors.push({ nodeId: edge.source, message: `Edge references unknown node "${missing}"` });
      continue;
    }
    if (edge.source === edge.target) {
      errors.push({ nodeId: edge.source, message: `A node cannot connect to itself ("${src.label}")` });
      continue;
    }
    if (!ALLOWED_EDGES.has(`${src.type}>${tgt.type}`)) {
      errors.push({
        nodeId: edge.source,
        message: `Invalid connection: a ${src.type} ("${src.label}") cannot connect to a ${tgt.type} ("${tgt.label}")`,
      });
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/compiler/index.test.ts`
Expected: PASS — all edge-legality cases plus the pre-existing compile tests.

- [ ] **Step 6: Regression — all bundled examples still compile**

Run:
```bash
npx tsx -e "import {compile} from './src/compiler/index.js'; import {readFileSync} from 'node:fs'; for (const f of ['saga','saga-db','lb-scaling','service-pair']) { const g = JSON.parse(readFileSync('examples/'+f+'.json','utf8')); const r = compile(g); if (!r.ok) { console.error(f, 'FAILED', r.errors); process.exit(1); } console.log(f, 'ok'); }"
```
Expected: prints `saga ok`, `saga-db ok`, `lb-scaling ok`, `service-pair ok` (exit 0). `service-pair` now also carries `UPSTREAM_HTTP` on Edge A.

- [ ] **Step 7: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all root tests pass (gated Docker smokes skipped); `tsc --noEmit` clean.

- [ ] **Step 8: Commit**

```bash
git add src/compiler/index.ts src/compiler/index.test.ts
git commit -m "feat: fail loud on illegal graph edges (default-deny allowlist)"
```

---

## Self-Review

**Spec coverage:**
- Allowlist (default-deny, 6 combos) → Task 2 Step 3. ✅
- Edge-legality pass placement (after per-node validate, same `errors` array, before the return) → Task 2 Step 4. ✅
- Dangling-edge + self-loop + illegal-combo cases, all collected, `nodeId = edge.source` → Task 2 Step 4 + tests Step 1. ✅
- Templated message verbatim → Global Constraints + Task 2 Step 4. ✅
- `service → service` cascade wiring (`UPSTREAM_HTTP=http://<slug>:8080`) → Task 1. ✅
- `service-pair` becomes a real cascade; all 4 examples compile → Task 2 Step 6. ✅
- Tests: db→service / lb→db / self-loop / dangling rejected; service→service accepted + wired → Task 2 Step 1. ✅
- `npm test` + `npm run typecheck` clean → Task 2 Step 7. ✅
- Out of scope (dedup, depends_on/ordering, other unwired combos) → not present. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the exact command + expected output.

**Type consistency:** `ALLOWED_EDGES: Set<string>` keyed `${src.type}>${tgt.type}`; `errors: CompilerError[]` (existing type) with `{ nodeId, message }` shape used consistently across both passes; `UPSTREAM_HTTP` value identical in Task 1 wiring, the service.test assertion, and the index.test compose assertion (`http://edge-b:8080`). `src`/`tgt` come from `index.nodeMap.get(...)` returning the node (`{ id, type, label }`), so `.type` and `.label` are valid.
