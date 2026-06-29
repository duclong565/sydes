# Kafka Partitions — Design

Date: 2026-06-29 · Branch: `feat/kafka-partitions` · Base: `main`

## Context

The worker is the throughput bottleneck, and it's a **design** limit: a Kafka topic
with **1 partition** can be consumed by only **one** worker in a consumer group, so
adding worker nodes does nothing (all distinct-labeled workers share group
`sds-<topic>`; only one gets the single partition, the rest idle). Verified live: 5
worker nodes + 1 partition → 1 active (cpu 32%), 4 idle (cpu 0%), throughput flat.

The compiler **hardcodes `--partitions 1`** (`src/compiler/handlers/kafka.ts:39`).
This brick adds a **`partitions` field on the Kafka node** → compiler `--partitions N`,
so `N partitions + N worker nodes` becomes a real parallel-drain demo on the canvas.
Today the sandbox can only show the trap; this lets it show the fix.

## Locked decisions (brainstorm 2026-06-29, mockup v3)

- **Scope: partitions field only.** Consumers come from the user dropping worker nodes
  (already supported). No worker `replicas` / compose scaling (separate future brick).
- **Inspector:** a `partitions` number input (min 1, default 1) + **inline validation**
  + a **non-blocking consumer-vs-partition hint**. The hint is computed from the graph
  and is purely factual (esp. over-partition → "N partitions idle", no risk judgment).
- **Compiler:** `--partitions ${node.config?.partitions ?? 1}`; `kafka.validate` fails
  loud if `partitions` is set and not an integer ≥ 1 (defense in depth with the inline
  check).
- Worker image is unchanged — `sds/worker` (kafka-go) handles multi-partition group
  assignment automatically.

## Components

### 1. `web/src/store.ts` — `NodeConfig.partitions`

- `NodeConfig` gains `partitions?: number`.
- `addNode('kafka')` seeds `config: { partitions: 1 }` (mirrors how `service` seeds
  `{ latencyMs: 0, errorRate: 0 }`), so the Inspector shows `1` and `toGraph`
  round-trips it. `toGraph` already maps `n.data.config` generically — no change.

### 2. `web/src/Inspector.tsx` — partitions field + validation + hint

When `node.data.type === 'kafka'`:
- A `partitions` number input (`min={1}`, value `cfg.partitions ?? 1`), editing
  `updateNode(node.id, { config: { ...cfg, partitions: Number(e.target.value) } })`.
- **Inline validation:** the value is invalid when it is not an integer ≥ 1 (covers
  `0`, negatives, `2.5`, `NaN`/empty). Invalid → red border on the input + a message
  **"Partitions must be a whole number ≥ 1"**.
- **Consumer hint** (read from the store): `subscribers` = number of `worker` nodes
  that have an edge whose `target` is this kafka node. `partitions = cfg.partitions ?? 1`.
  - invalid partitions → hint **paused** ("fix the value to see the consumer balance").
  - `subscribers === 0` → grey "no consumers yet — wire a worker → this topic".
  - `subscribers > partitions` → **amber** "⚠ {subscribers − partitions} workers will
    sit idle — a partition feeds only one consumer in a group".
  - `subscribers === partitions` → green "✓ {n} workers · {n} partitions — all active".
  - `subscribers < partitions` → grey "{partitions − subscribers} partitions idle".

The Inspector reads `nodes`/`edges` from the store to count subscribers
(`useGraphStore((s) => …)`), in addition to the existing `selectedId`/`updateNode`/
`removeNode` selectors.

### 3. `src/compiler/handlers/kafka.ts` — wire `--partitions N` + validate

- **First add `partitions?: number` to `GraphNode.config`** in `src/compiler/types.ts`
  (currently `{ latencyMs?; errorRate? }`) — otherwise `node.config?.partitions` does
  not typecheck. This mirrors the SPA `NodeConfig` change (component 1).
- In `compile`, change the topic-create line (currently `--partitions 1`) to
  `--partitions ${node.config?.partitions ?? 1}`. (`node` is the compiler graph node,
  which already carries `config?` — `service.ts` reads `node.config?.latencyMs` the
  same way.)
- In `validate`, append: if `node.config?.partitions` is defined and
  `(!Number.isInteger(p) || p < 1)` → push
  `{ nodeId, message: 'Kafka partitions must be a whole number ≥ 1' }`. This sits
  alongside the existing publisher/subscriber checks (collect all).

## Data flow

```
Inspector partitions input → node.data.config.partitions
  → toGraph → compile(graph)
  → kafka topic created with --partitions N
  → Kafka spreads N partitions across the worker nodes' shared group sds-<topic>
  → up to N workers consume in parallel → ~N× drain (until the DB becomes the limit)
```

## Error handling / edge cases

- **Default 1** → existing graphs, the 4 bundled examples, and the gated smokes are
  byte-unchanged (no `config` on their kafka nodes → `?? 1`).
- **Invalid partitions** → inline red in the Inspector **and** a fail-loud compile
  error (the run never starts with a broken topic spec).
- **Repartitioning:** a topic's partition count is set at `--create`. The sandbox
  always starts fresh (`Stop` = `compose down -v` wipes the volume), so a changed
  `partitions` simply takes effect on the next Run. You cannot repartition a live
  topic — out of scope, and a non-issue given the one-experiment-at-a-time model.
- **Over-partitioning is valid, not free** (documented, not surfaced in the badge):
  more partitions = more broker file handles + memory, slower rebalance, and ordering
  is guaranteed only *within* a partition. The hint stays factual ("N partitions idle").

## Testing

**Compiler (`src/compiler/handlers/kafka.test.ts`, no Docker):**
- `compile` a kafka node with `config.partitions: 4` → the healthcheck `--create`
  command contains `--partitions 4`.
- a kafka node with no `config` → contains `--partitions 1` (default, back-compat).
- `validate`: a valid pub/sub graph whose kafka node has `config.partitions: 0`
  (and `2.5`, and `-2`) → errors include `/whole number ≥ 1/`; `config.partitions: 3`
  → no partitions error.

**SPA store (`web/src/store.test.ts`):**
- `addNode('kafka')` → `nodes[0].data.config.partitions === 1`.
- `loadExample`/`toGraph` round-trips a kafka node's `config.partitions`.

**SPA Inspector (`web/src/Inspector.test.tsx`):**
- selecting a kafka node shows the `partitions` input; editing calls `updateNode` with
  the new `config.partitions`.
- hint text reflects the graph: a store with 3 workers → this kafka + `partitions: 1`
  shows the amber "2 workers will sit idle"; `partitions: 3` shows the green "all
  active"; `partitions: 5` shows "2 partitions idle"; 0 workers shows "no consumers yet".
- `partitions: 0` → the inline "Partitions must be a whole number ≥ 1" message and the
  hint is paused.

`npm test` + `npm run typecheck` clean; `npm --prefix web run test` + web `tsc` +
`build` clean.

## Out of scope

- Worker `replicas` / compose scaling (a node → N containers) — separate brick.
- Auto-setting partitions from the subscriber count; repartitioning a running topic.
- Per-partition metrics / lag-per-partition (consumer lag is already visible via the
  #23 writes badge).
- Surfacing the over-partition cost in the runtime badge (documented here only).

## Likely task breakdown (for writing-plans)

1. Compiler: `kafka.ts` `--partitions N` + `validate` integer-≥-1 + `kafka.test.ts` (TDD).
2. SPA store: `NodeConfig.partitions` + `addNode('kafka')` default + `store.test.ts` (TDD).
3. SPA Inspector: partitions input + inline validation + consumer hint + `Inspector.test.tsx` (TDD) + web build.
