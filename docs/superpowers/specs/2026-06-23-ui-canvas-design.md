# UI Brick 2 — React Flow Canvas + Node Palette (Design)

Date: 2026-06-23 · Branch: `feat/ui-canvas` · Base: `97982f1`

## Context

UI brick 1 (PR #13, merged) gave us `sds-agent` (Fastify over the engine) and a
minimal SPA (example dropdown + Preview/Run/Stop + status table). This is **brick
2 of 4** of the UI epic. It replaces the "example *is* the graph" flow with a
**visual canvas**: the user builds an architecture by adding nodes from a palette,
wiring edges, and editing labels/config; the canvas serializes to the exact
`Graph` JSON the agent already accepts.

**Epic position:** 1 = agent + minimal SPA (done). **2 = canvas → graph JSON (this
brick).** 3 = run/teardown UX + warmup state. 4 = live metric badges over
WebSocket.

## Locked decisions

- **Add nodes:** click-to-add (click a palette button → node appears on the
  canvas; drag to reposition). True drag-from-palette is deferred polish.
- **Node editing:** a selection inspector edits the node `label`; for `service`
  nodes also `latencyMs` / `errorRate` (the config the engine consumes).
- **Edge validation:** permissive — any `source → target` connection is allowed;
  the compiler fail-louds and the existing Preview pane surfaces the errors. No
  edge rules duplicated client-side.
- **State:** Zustand store is the graph source of truth; React Flow is controlled
  by it.
- **Library:** `@xyflow/react` (React Flow v12).
- **Examples:** the brick-1 `GET /api/examples` dropdown now *loads into* the
  canvas; Run/Preview serialize the canvas.

## Graph contract (unchanged, from the compiler)

```ts
type NodeType = 'service' | 'kafka' | 'worker' | 'db' | 'lb';
interface GraphNode { id: string; type: NodeType; label: string; config?: { latencyMs?: number; errorRate?: number } }
interface GraphEdge { source: string; target: string } // node ids
interface Graph { experimentId: string; nodes: GraphNode[]; edges: GraphEdge[] }
```

The serializer must emit exactly this shape (it is what `/api/compile` and
`/api/run` consume).

## Layout

```
┌ top bar: [experiment name input] [Load example ▾] [Preview] [Run] [Stop] ┐
├ palette ─┬──────────────── React Flow canvas ──────────────┬ inspector ┤
│ Service  │   (Service) ──▶ (Kafka) ◀── (Worker)             │ label:..  │
│ Kafka    │                              │                  │ latency:. │
│ Worker   │                            (DB)                 │ error:..  │
│ DB / LB  │                                                 │           │
├──────────┴──── errors / compose preview pane ───────────────────────────┤
└ status table (brick 1: run state + per-service rows) ───────────────────┘
```

## State — `web/src/store.ts` (Zustand)

`useGraphStore` holds:

```ts
interface GraphState {
  experimentId: string;
  nodes: Node<SdsNodeData>[];   // React Flow nodes
  edges: Edge[];
  selectedId: string | null;
  setExperimentId(id: string): void;
  addNode(type: NodeType): void;
  updateNode(id: string, patch: Partial<SdsNodeData>): void;
  removeNode(id: string): void;
  onNodesChange(changes: NodeChange[]): void;   // React Flow handler
  onEdgesChange(changes: EdgeChange[]): void;
  onConnect(conn: Connection): void;            // adds an edge
  loadExample(graph: Graph): void;
  toGraph(): Graph;                              // pure serializer
}

interface SdsNodeData { type: NodeType; label: string; config?: { latencyMs?: number; errorRate?: number } }
```

- `addNode(type)` creates a node with a generated id, a default label (e.g.
  `"Service 1"` — type name + running count), default `config` for `service`
  (`{ latencyMs: 0, errorRate: 0 }`), placed at a default position with a small
  cascade offset so successive adds don't overlap.
- `updateNode(id, patch)` shallow-merges into `data` (label and/or config).
- `onConnect` appends `{ id, source, target }` to `edges`.
- `loadExample(graph)` rebuilds `nodes`/`edges`/`experimentId` from a `Graph`,
  assigning deterministic positions (examples carry none — e.g. a simple
  left-to-right or grid layout by index).
- `toGraph()` returns `{ experimentId, nodes: nodes.map(n => ({ id: n.id, type: n.data.type, label: n.data.label, ...(n.data.config ? { config: n.data.config } : {}) })), edges: edges.map(e => ({ source: e.source, target: e.target })) }`.

## Components (`web/src/`)

- **`nodes/SdsNode.tsx`** — one custom React Flow node component, rendering a
  colored box with the type tag + label, a target `Handle` (top/left) and a source
  `Handle` (bottom/right). Registered via `nodeTypes={{ sds: SdsNode }}`; every
  node uses `type: 'sds'` with `data.type` distinguishing the five kinds.
- **`Palette.tsx`** — five buttons (Service / Kafka / Worker / DB / LB) calling
  `addNode(type)`.
- **`Inspector.tsx`** — reads `selectedId`; if a node is selected, edits `label`
  (text) and, for `service`, `latencyMs` (int ≥ 0) and `errorRate` (0–1) via
  `updateNode`; a Delete button calls `removeNode`. Renders a hint when nothing is
  selected.
- **`Canvas.tsx`** — `<ReactFlow>` wired to the store: `nodes`, `edges`,
  `onNodesChange`, `onEdgesChange`, `onConnect`, `nodeTypes`,
  `onNodeClick`→`selectedId`, plus `<Background>`/`<Controls>`.
- **`App.tsx`** — composes top bar + palette + canvas + inspector + preview pane +
  status table. **Preview/Run/Stop call `api.compile`/`api.run` with
  `useGraphStore.getState().toGraph()`** (replacing the brick-1 example-as-graph
  path). `Load example` fetches via `api.examples()` and calls `loadExample`. The
  status table + polling from brick 1 are preserved.

## Dependencies

`@xyflow/react` and `zustand`, added to `web/package.json`. (`@xyflow/react` ships
its own CSS — imported once in the canvas/app.)

## Testing

- **Store / serializer (pure, no DOM — the core coverage):**
  - `addNode('service')` adds one node with `data.type==='service'`, a non-empty
    label, and default `config`.
  - `updateNode` patches label and config independently.
  - `onConnect({source,target})` appends an edge.
  - `removeNode` drops the node.
  - `loadExample(graph)` populates nodes/edges/experimentId from a `Graph`.
  - **`toGraph` round-trip:** `loadExample(saga)` then `toGraph()` deep-equals the
    saga graph's `{experimentId, nodes(id/type/label), edges(source/target)}`.
- **Integration (RTL, mocked fetch):** clicking Run posts `/api/run` with the body
  equal to `toGraph()` of the current store.
- **jsdom:** add a `ResizeObserver` polyfill (and `DOMMatrixReadOnly`/
  `matchMedia` if React Flow needs them) to `web/src/test-setup.ts`; keep the
  canvas-render test light (mounts without throwing; palette buttons present).
- The brick-1 `App.test.tsx` is updated for the restructured `App`.

## Out of scope (later bricks / polish)

Warmup "Warming up…" state (brick 3), live metric badges over WebSocket (brick 4),
true drag-from-palette HTML5 DnD, multi-select/copy/paste, undo/redo, saving or
loading graphs to disk, client-side edge validation.

## Likely task breakdown (for writing-plans)

1. Deps (`@xyflow/react`, `zustand`) + `store.ts` (state, actions, `toGraph`) +
   store unit tests.
2. `nodes/SdsNode.tsx` + `Palette.tsx` + `Canvas.tsx` (React Flow bound to the
   store) + `ResizeObserver` polyfill + a light canvas render test.
3. `Inspector.tsx` (label + service config + delete) + tests.
4. `App.tsx` integration (layout, `Load example`→`loadExample`,
   Preview/Run/Stop→`toGraph`) + updated RTL tests.
