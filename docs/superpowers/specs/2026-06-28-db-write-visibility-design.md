# DB Write-Visibility Badge — Design

Date: 2026-06-28 · Branch: `feat/db-write-visibility` · Base: `main`

## Context

The SPA streams live per-service CPU/mem over the `/api/metrics/:runId` WebSocket
(`container.stats` → badges + a Metrics drawer table). But there is **no in-app
signal that a DB is actually being written to** — a db node shows CPU/mem, which is
circumstantial. To confirm writes you must drop to `docker exec <db> psql`. This
brick surfaces DB write activity in the UI: a **writes count + live Δ/s** on each db
node and in the Metrics table.

The worker persists to postgres (pgx, insert-only on the ok path), and exposes a
`db_writes_total` Prometheus counter — but that lives on the worker's in-network
`/metrics` (:8080), which the host-side agent cannot reach (no host port published;
scratch image has no HTTP client). The one reachable path is the existing `Runner`
seam: `docker exec` into the db container and read postgres's own insert counter.

## Locked decisions (brainstorm 2026-06-28, 3 mockup rounds)

- **Metric:** cumulative **writes** (inserts) + a per-tick **Δ/s** (write rate).
  Labeled "writes" (not "rows") — it is the insert count, which matches the feature
  name and is honest about the source (see below).
- **Source query (forced + perf-hardened):**
  `select coalesce(sum(n_tup_ins),0) from pg_stat_user_tables` — the stats
  collector's cumulative insert count across all user tables. O(1) (no table scan,
  no observer effect, scales to millions), monotonic (smooth Δ/s except on stats
  reset), schema-agnostic (no hardcoded `events`). NOT `count(*)` (full scan that
  competes with the worker's inserts and degrades as the table grows).
- **Transport:** extend the existing metrics WebSocket frame with an optional
  `writes` field; the wire carries the **raw cumulative count**, the SPA derives Δ/s.
- **Cadence:** piggyback the existing ~1.5s metrics tick — one `docker exec` per db
  node per tick.
- **Display:** a third line on db node badges (`N writes · +R/s`) + `Writes` and
  `Δ writes/s` columns in the Metrics drawer table.

## Components

### 1. Agent — `src/agent/db-rows.ts` (new)

```ts
dbWrites(runner: Runner, container: string): Promise<number | undefined>
```
Runs `runner.run(['docker','exec',container,'psql','-U','postgres','-tAc',
'select coalesce(sum(n_tup_ins),0) from pg_stat_user_tables'])`. On exit code 0 with
a numeric trimmed stdout → that integer. On non-zero exit, or non-numeric output
(db not ready, psql error) → `undefined`. Pure over the `Runner` seam → unit-testable
with a `FakeRunner`, no Docker.

### 2. Agent — metrics WS (`src/agent/server.ts`)

The WS handler already has `rec` (so `rec.graph`) and pushes mapped snapshots. Add:
- Derive the db service slugs once per connection:
  `dbSlugs = new Set(rec.graph.nodes.filter(n => n.type === 'db').map(n => slugify(n.label)))`.
- In the per-tick push, for each snapshot whose `serviceName(snapshot.name, runId)`
  is in `dbSlugs`, call `await dbWrites(deps.runner, snapshot.name)` and attach the
  result as `writes` on that frame entry. Non-db entries have no `writes`.
- Frame entry shape: `{ service: string; cpuPercent: number; memMB: number; writes?: number }`.
- `slugify` is imported from the compiler util (`../compiler/util.js`) — the same
  function the compiler uses to turn a node `label` into its service/container slug, so
  `slugify(dbNode.label)` matches what `serviceName(snapshot.name, runId)` returns.
- Wrap the whole tick in the existing try/catch — a failed exec never kills the
  socket; that db simply has no `writes` that tick.

### 3. SPA — `web/src/metrics-store.ts`

- `ServiceMetric` gains optional `writes?: number`.
- Store entry per service: `{ cpuPercent; memMB; writes?: number; writesPerSec?: number }`.
- `setSnapshot(list)` computes `writesPerSec` per service from the previous snapshot,
  using an internal `prev: Record<service, { writes: number; t: number }>` (wall-clock
  `Date.now()`):
  - **No previous** sample for that service (first tick) → `writesPerSec` **undefined**
    (render `—`, no bogus rate).
  - `writes < prev.writes` (stats reset / crash recovery) → clamp `writesPerSec` to
    **0** and re-baseline (`prev = current`).
  - otherwise → `writesPerSec = (writes - prev.writes) / ((now - prev.t) / 1000)`,
    rounded for display.
  - Only services whose snapshot has `writes` defined participate; `prev` is updated
    for them each tick.
- `clear()` resets `byService` **and** `prev`.

### 4. SPA — `web/src/nodes/NodeMetricBadge.tsx` + `SdsNode.tsx`

- `NodeMetricBadge` gains optional `writes?: number` and `writesPerSec?: number`.
- When the node is a **db** and `writes` is defined, render a third line below the
  cpu/mem row: `formatCount(writes) + " writes"` and, when `writesPerSec` is defined,
  `"+" + round(writesPerSec) + "/s"` (green; grey when `writesPerSec === 0`). No
  `writesPerSec` (first tick) → omit the delta segment.
- `SdsNode` passes `writes`/`writesPerSec` from `useMetricsStore` for the node's slug;
  unchanged for non-db nodes (they never carry `writes`).

### 5. SPA — `web/src/Drawer.tsx`

- Metrics table gains `Writes` + `Δ writes/s` header columns.
- Each row: `writes` defined → the formatted count, else `—`; `writesPerSec` defined →
  `+N`, else `—`. (Unit lives in the header; cells are bare — the node badge keeps the
  `/s` suffix since it is standalone.)

## Data flow

```
metrics WS tick (~1.5s):
  collector.sample(runId)            -> [{ name, cpuPercent, memMB }]  [existing]
  for snapshots whose service ∈ dbSlugs:
    dbWrites(runner, name)           -> writes (or undefined)          [new]
  send [{ service, cpuPercent, memMB, writes? }]
SPA:
  metrics-store.setSnapshot          -> byService + derived writesPerSec (guards)
  SdsNode badge (db only)            -> "N writes · +R/s"
  Drawer Metrics table               -> Writes / Δ writes/s columns
Stop / terminal / unmount            -> clear() resets byService + prev
```

## Error handling

- Failed/empty `dbWrites` query (db starting, no tables) → `writes` omitted for that
  tick → badge line absent / table `—`. No crash; socket stays open.
- Stats reset → negative delta guarded (clamp 0 + re-baseline). First tick → no delta.
- Empty DB (`coalesce(...,0)` → `0`) → `0 writes · +0/s` (grey).

## Testing

**Agent (no Docker):**
- `src/agent/db-rows.test.ts` — `dbWrites` with a `FakeRunner`: `{code:0, stdout:'208803\n'}`
  → `208803`; non-zero exit → `undefined`; non-numeric stdout (`'ERROR\n'`) → `undefined`.
- `src/agent/metrics-ws.test.ts` (extend) — a graph with a db node + a `FakeStats`
  listing a db container (`sds-<id>-orders-db-1`) + a `FakeRunner` returning a count
  for the `exec … psql …` argv: assert the db service's frame entry has `writes`, and
  a non-db entry does not.

**SPA:**
- `web/src/metrics-store.test.ts` — `writesPerSec`: first snapshot → undefined; second
  snapshot (later `Date.now`) → positive rate; a decrease → `0` (re-baselined);
  `clear()` resets `prev` (next snapshot is again first-tick).
- `web/src/nodes/NodeMetricBadge.test.tsx` — db badge renders `N writes` + `+R/s`;
  `writesPerSec` undefined → no delta; non-db / no `writes` → no writes line.
- `web/src/Drawer.test.tsx` — Writes / Δ columns render the count + rate for a db row;
  `—` for a non-db row.

`npm test` + `npm run typecheck` clean; `npm --prefix web run test` + web `tsc` +
`build` clean.

**Gated smoke (optional, `RUN_DOCKER=1`):** extend a saga-db smoke to assert the
WS frame's db entry carries a growing `writes` after firing load.

## Out of scope

- Filtering business vs. migration/audit tables — `sum(n_tup_ins)` counts inserts
  across all user tables (for sds/worker that is only `events`); a production filter is
  a future concern.
- Historical write-rate charting / sparklines.
- Reaching the worker's `db_writes_total` counter (unreachable from the host agent).

## Likely task breakdown (for writing-plans)

1. Agent: `db-rows.ts` (`dbWrites`) + unit test (TDD).
2. Agent: metrics-WS wiring (db slugs + attach `writes`) + extend `metrics-ws.test.ts`.
3. SPA: `metrics-store` `writes`/`writesPerSec` + guards + tests (TDD).
4. SPA: `NodeMetricBadge`/`SdsNode` writes line + `Drawer` columns + tests + build.
