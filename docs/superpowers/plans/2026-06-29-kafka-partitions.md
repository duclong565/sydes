# Kafka Partitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `partitions` field to the Kafka node so the compiler emits `--partitions N` (was hardcoded 1), plus an Inspector consumer-vs-partition hint — letting the canvas demonstrate real consumer scaling (N partitions + N worker nodes).

**Architecture:** A `partitions` number flows from the Kafka node's `config` (SPA `NodeConfig` + compiler `GraphNode.config`) into the topic-create command in `kafka.ts`. The Inspector renders the input with inline `≥1` validation and a non-blocking hint computed from how many worker nodes subscribe to the selected Kafka node. Consumers come from the user adding worker nodes (already supported) — no worker replicas.

**Tech Stack:** TypeScript (ESM, Node) compiler; React + Zustand + `@xyflow/react` SPA; vitest + RTL.

## Global Constraints

- `partitions` default is **1** (back-compat). Compiler line: `--partitions ${node.config?.partitions ?? 1}`.
- Compiler validate message verbatim: `Kafka partitions must be a whole number ≥ 1`. Inspector inline message verbatim: `Partitions must be a whole number ≥ 1`. Invalid = `!Number.isInteger(p) || p < 1`.
- Both `GraphNode.config` (compiler `src/compiler/types.ts`) and `NodeConfig` (SPA `web/src/store.ts`) gain `partitions?: number`.
- Hint is non-blocking and factual. States (subscribers = worker nodes with an edge into this kafka node; partitions = `config.partitions ?? 1`): invalid→paused; `0`→"no consumers yet — wire a worker → this topic"; `subscribers > partitions`→amber "⚠ N workers will sit idle"; `subscribers === partitions`→green "✓ … all active"; `subscribers < partitions`→"N partitions idle".
- Idle workers / idle partitions are NOT compile errors — only non-integer / `< 1` is.
- Root + web are ESM with `.js` import suffixes. NEVER add a `Co-Authored-By` trailer.

---

### Task 1: Compiler — `--partitions N` + validation

**Files:**
- Modify: `src/compiler/types.ts` (`GraphNode.config`)
- Modify: `src/compiler/handlers/kafka.ts` (`compile` topic-create line + `validate`)
- Test: `src/compiler/handlers/kafka.test.ts`

**Interfaces:**
- Produces: `kafkaHandler.compile` emits `--partitions <n>` from `node.config?.partitions ?? 1`; `kafkaHandler.validate` adds an error when `config.partitions` is a non-integer or `< 1`.

- [ ] **Step 1: Write the failing tests**

Append to `src/compiler/handlers/kafka.test.ts`:

```ts
describe('kafkaHandler.compile partitions', () => {
  it('wires --partitions from the node config', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'k', type: 'kafka', label: 'Order Events', config: { partitions: 4 } }], edges: [] };
    const cmd = kafkaHandler.compile(g.nodes[0]!, buildIndex(g)).healthcheck!.test[1]!;
    expect(cmd).toContain('--partitions 4');
  });
  it('defaults to --partitions 1 when the node has no config', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'k', type: 'kafka', label: 'Order Events' }], edges: [] };
    const cmd = kafkaHandler.compile(g.nodes[0]!, buildIndex(g)).healthcheck!.test[1]!;
    expect(cmd).toContain('--partitions 1');
  });
});

describe('kafkaHandler.validate partitions', () => {
  const pubSub = (partitions: number): Graph => ({
    experimentId: 'e',
    nodes: [
      { id: 's', type: 'service', label: 'S' },
      { id: 'k', type: 'kafka', label: 'Bus', config: { partitions } },
      { id: 'w', type: 'worker', label: 'W' },
    ],
    edges: [{ source: 's', target: 'k' }, { source: 'w', target: 'k' }],
  });
  it('errors when partitions is not a whole number ≥ 1', () => {
    for (const bad of [0, -2, 2.5]) {
      const g = pubSub(bad);
      const errors = kafkaHandler.validate(g.nodes[1]!, buildIndex(g));
      expect(errors.some((e) => /whole number/i.test(e.message))).toBe(true);
    }
  });
  it('passes with a valid integer partitions', () => {
    const g = pubSub(3);
    expect(kafkaHandler.validate(g.nodes[1]!, buildIndex(g))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/compiler/handlers/kafka.test.ts`
Expected: FAIL — `config: { partitions }` is a type error (config has no `partitions`) and/or the compile output still says `--partitions 1`, and validate reports no partitions error.

- [ ] **Step 3: Add `partitions` to the compiler config type**

In `src/compiler/types.ts`, extend `GraphNode.config`:

```ts
  config?: {
    latencyMs?: number;
    errorRate?: number;
    partitions?: number;
  };
```

- [ ] **Step 4: Wire `--partitions N` in `kafka.ts` compile**

In `src/compiler/handlers/kafka.ts`, change the topic-create line inside `healthCmd` (currently `--partitions 1 --replication-factor 1`) to:

```ts
      `/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --if-not-exists --topic ${name} --partitions ${node.config?.partitions ?? 1} --replication-factor 1`,
```

- [ ] **Step 5: Add the partitions check in `kafka.ts` validate**

In `kafkaHandler.validate`, before `return errors;`, add:

```ts
    const p = node.config?.partitions;
    if (p !== undefined && (!Number.isInteger(p) || p < 1))
      errors.push({ nodeId: node.id, message: 'Kafka partitions must be a whole number ≥ 1' });
```

- [ ] **Step 6: Run the kafka suite + full suite + typecheck**

Run: `npx vitest run src/compiler/handlers/kafka.test.ts && npm test && npm run typecheck`
Expected: PASS — new partitions tests plus all existing kafka tests; whole root suite green (gated smokes skipped); `tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add src/compiler/types.ts src/compiler/handlers/kafka.ts src/compiler/handlers/kafka.test.ts
git commit -m "feat: kafka node partitions config -> --partitions N + validation"
```

---

### Task 2: SPA store — `NodeConfig.partitions` + kafka default

**Files:**
- Modify: `web/src/store.ts` (`NodeConfig`, `addNode`)
- Test: `web/src/store.test.ts`

**Interfaces:**
- Produces: `NodeConfig` gains `partitions?: number`; `addNode('kafka')` seeds `config: { partitions: 1 }`; `toGraph` round-trips it (existing generic mapping).

- [ ] **Step 1: Update the failing tests**

In `web/src/store.test.ts`, **replace** the existing `it('addNode for kafka has no config', …)` test with:

```ts
  it('addNode for kafka seeds partitions: 1', () => {
    useGraphStore.getState().addNode('kafka');
    expect(useGraphStore.getState().nodes[0]!.data.config).toEqual({ partitions: 1 });
  });

  it('toGraph round-trips a kafka partitions config', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'k', type: 'kafka', label: 'Bus', config: { partitions: 4 } }],
      edges: [],
    };
    useGraphStore.getState().loadExample(g);
    expect(useGraphStore.getState().toGraph()).toEqual(g);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix web run test -- store.test`
Expected: FAIL — kafka `config` is currently `undefined` (was `toBeUndefined`), so `toEqual({ partitions: 1 })` fails; `config.partitions` is also a type error until `NodeConfig` is extended.

- [ ] **Step 3: Add `partitions` to `NodeConfig`**

In `web/src/store.ts`:

```ts
export interface NodeConfig { latencyMs?: number; errorRate?: number; partitions?: number }
```

- [ ] **Step 4: Seed the kafka default in `addNode`**

In `addNode`, change the `data.config` seeding (currently only services get config) to also seed kafka:

```ts
        data: {
          type,
          label: `${TYPE_LABEL[type]} ${count}`,
          ...(type === 'service'
            ? { config: { latencyMs: 0, errorRate: 0 } }
            : type === 'kafka'
            ? { config: { partitions: 1 } }
            : {}),
        },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix web run test -- store.test`
Expected: PASS — kafka seeds `{ partitions: 1 }`, round-trip holds, and the pre-existing store tests still pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/store.ts web/src/store.test.ts
git commit -m "feat(web): kafka node seeds partitions config (default 1)"
```

---

### Task 3: SPA Inspector — partitions input + validation + consumer hint

**Files:**
- Modify: `web/src/Inspector.tsx`
- Test: `web/src/Inspector.test.tsx`

**Interfaces:**
- Consumes: `NodeConfig.partitions` (Task 2), the store's `nodes`/`edges`.
- Produces: for a selected kafka node, a `partitions` number input (`aria-label="partitions"`), an inline error for invalid values, and a consumer-vs-partition hint.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/Inspector.test.tsx` (inside the `describe('Inspector', …)` block):

```ts
  it('shows a partitions input for kafka nodes (not service fields)', () => {
    addAndSelect('kafka');
    render(<Inspector />);
    expect(screen.getByLabelText('partitions')).toBeInTheDocument();
    expect(screen.queryByLabelText('latencyMs')).toBeNull();
  });

  it('edits the partitions of a kafka node', async () => {
    const id = addAndSelect('kafka');
    render(<Inspector />);
    const input = screen.getByLabelText('partitions');
    await userEvent.clear(input);
    await userEvent.type(input, '4');
    expect(useGraphStore.getState().nodes.find((n) => n.id === id)!.data.config!.partitions).toBe(4);
  });

  it('warns when more workers subscribe than there are partitions', () => {
    const store = useGraphStore.getState();
    store.addNode('kafka');
    store.addNode('worker');
    store.addNode('worker');
    store.addNode('worker');
    const [k, w1, w2, w3] = useGraphStore.getState().nodes.map((n) => n.id);
    const conn = (source: string) => ({ source, target: k!, sourceHandle: null, targetHandle: null });
    store.onConnect(conn(w1!));
    store.onConnect(conn(w2!));
    store.onConnect(conn(w3!));
    store.setSelected(k!);
    render(<Inspector />);
    expect(screen.getByText(/2 workers will sit idle/i)).toBeInTheDocument(); // 3 subscribers, 1 partition
  });

  it('shows an inline error and pauses the hint for partitions < 1', () => {
    const id = addAndSelect('kafka');
    useGraphStore.getState().updateNode(id, { config: { partitions: 0 } });
    render(<Inspector />);
    expect(screen.getByText(/whole number ≥ 1/i)).toBeInTheDocument();
    expect(screen.getByText(/fix the value/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix web run test -- Inspector`
Expected: FAIL — no `partitions` input / hint / error text exists yet.

- [ ] **Step 3: Add the subscriber count selector in `web/src/Inspector.tsx`**

After the existing `removeNode` selector, add:

```ts
  const subscribers = useGraphStore((s) => {
    const id = s.selectedId;
    if (!id) return 0;
    return s.edges.filter(
      (e) => e.target === id && s.nodes.find((n) => n.id === e.source)?.data.type === 'worker',
    ).length;
  });
```

- [ ] **Step 4: Render the kafka branch**

In `web/src/Inspector.tsx`, after the `node.data.type === 'service'` block (and before the Delete button), add:

```tsx
      {node.data.type === 'kafka' && (() => {
        const partitions = cfg.partitions ?? 1;
        const invalid = !Number.isInteger(partitions) || partitions < 1;
        let text: string;
        let tone: string;
        if (invalid) {
          text = 'fix the value to see the consumer balance';
          tone = 'border-slate-200 bg-slate-50 text-slate-500';
        } else if (subscribers === 0) {
          text = 'no consumers yet — wire a worker → this topic';
          tone = 'border-slate-200 bg-slate-50 text-slate-600';
        } else if (subscribers > partitions) {
          const idle = subscribers - partitions;
          text = `⚠ ${idle} worker${idle === 1 ? '' : 's'} will sit idle — a partition feeds only one consumer in a group`;
          tone = 'border-l-4 border-amber-500 bg-amber-50 text-amber-900';
        } else if (subscribers === partitions) {
          text = `✓ ${subscribers} workers · ${partitions} partitions — all active`;
          tone = 'border-emerald-300 bg-emerald-50 text-emerald-800';
        } else {
          const idle = partitions - subscribers;
          text = `${idle} partition${idle === 1 ? '' : 's'} idle`;
          tone = 'border-slate-200 bg-slate-50 text-slate-600';
        }
        return (
          <>
            <label htmlFor="insp-partitions" className="block text-xs text-slate-500">partitions</label>
            <input
              id="insp-partitions"
              aria-label="partitions"
              type="number"
              min={1}
              value={cfg.partitions ?? 1}
              onChange={(e) => updateNode(node.id, { config: { ...cfg, partitions: Number(e.target.value) } })}
              className={`mb-1 w-full rounded border px-2 py-1 text-sm ${invalid ? 'border-red-500 bg-red-50' : 'border-slate-300'}`}
            />
            {invalid && <div className="mb-2 text-xs font-semibold text-red-600">Partitions must be a whole number ≥ 1</div>}
            <div className={`mb-3 rounded border px-2 py-1.5 text-xs ${tone}`}>{text}</div>
          </>
        );
      })()}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix web run test -- Inspector`
Expected: PASS — partitions input shown, edit updates `config.partitions`, the over-subscribed graph shows "2 workers will sit idle", and the invalid value shows both the inline error and the paused hint.

- [ ] **Step 6: Full web suite + typecheck + build**

Run: `npm --prefix web run test && (cd web && npx tsc --noEmit) && npm --prefix web run build`
Expected: all web suites pass; `tsc` clean; `web/dist/index.html` produced.

- [ ] **Step 7: Commit**

```bash
git add web/src/Inspector.tsx web/src/Inspector.test.tsx
git commit -m "feat(web): kafka partitions inspector field + consumer-balance hint"
```

---

## Self-Review

**Spec coverage:**
- `partitions` on both config types (`GraphNode.config` + `NodeConfig`) → Task 1 Step 3 + Task 2 Step 3. ✅
- Compiler `--partitions ${config.partitions ?? 1}` (default 1, back-compat) → Task 1 Step 4. ✅
- Compiler fail-loud validate (non-integer / `< 1`) → Task 1 Step 5. ✅
- `addNode('kafka')` seeds `{ partitions: 1 }`; round-trips → Task 2. ✅
- Inspector partitions input + inline validation ("Partitions must be a whole number ≥ 1") → Task 3 Step 4. ✅
- Consumer hint, 4 states + paused-when-invalid, amber for over-subscribed, factual over-partition → Task 3 Step 4. ✅
- Subscribers counted as worker nodes with an edge into the kafka node → Task 3 Step 3. ✅
- Tests: compile `--partitions 4`/default 1, validate 0/2.5/-2; store seed + round-trip; Inspector input/edit/hint/invalid → all tasks. ✅
- Out of scope (worker replicas, auto-partition, per-partition metrics, badge cost text) → not present. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step has the exact command + expected output. The one existing test that changes behavior (kafka `has no config`) is explicitly replaced (Task 2 Step 1), not silently broken.

**Type consistency:** `partitions?: number` is identical on `GraphNode.config` (Task 1) and `NodeConfig` (Task 2). The compiler reads `node.config?.partitions ?? 1` (Task 1) matching the SPA seed `{ partitions: 1 }` (Task 2). The Inspector's `invalid = !Number.isInteger(partitions) || partitions < 1` matches the compiler validate predicate exactly. Hint inputs (`subscribers`, `partitions`) are both numbers; `subscribers` is derived from `edges`/`nodes` (Task 3 Step 3) and consumed in the branch (Step 4). Messages are verbatim per Global Constraints (compiler `Kafka partitions must be a whole number ≥ 1`; inline `Partitions must be a whole number ≥ 1`).
