# UI Brick 4 — Live Metric Badges over WebSocket (Design)

Date: 2026-06-24 · Branch: `feat/ui-metrics` · Base: `eb497ee`

## Context

UI bricks 1–3 are merged to `main`: the `sds-agent` (Fastify) wraps the engine over
HTTP; the `web/` SPA has a React Flow canvas, run/teardown UX, and a collapsible
tabbed Drawer (Compose | Status | Logs) with a **Metrics** stub. This is the
**final UI brick (4 of 4)**: stream live per-service CPU/mem from the agent to the
SPA over a **WebSocket** and show it as badges on the canvas nodes + a real
Metrics drawer tab. This is the project's first WebSocket — the transport seam the
future hybrid cloud-relay will proxy.

The engine already has the collector: `MetricsCollector.sample(id): Promise<MetricsSnapshot[]>`
(`{ name, cpuPercent, memMB }`) over an injectable `StatsSource`
(`DockerodeStatsSource` real; fakeable). `name` is the full container name
(`sds-<id>-<svc>-<n>`).

## Locked decisions

- **Transport:** WebSocket (`@fastify/websocket`) — matches the documented "Metrics
  WS bridge" and the WS-based hybrid future. Server→client push only.
- **Scope:** live CPU%/mem only. k6 throughput/latency aggregate is deferred (the
  SPA doesn't fire k6 yet — no load-config UI; out of scope here).
- **Display:** badges overlaid on canvas nodes **and** a per-service table in the
  Metrics drawer tab.

## Agent (backend)

- Add `@fastify/websocket`; register it in `buildServer`.
- `AgentDeps` gains `statsSource?: StatsSource` (default `new DockerodeStatsSource()`;
  tests inject a fake). Construct `new MetricsCollector(statsSource)` in `buildServer`.
- **Pure helper** `serviceName(containerName: string, runId: string): string` —
  strips the `sds-<runId>-` prefix and the trailing `-<n>` replica suffix, returning
  the service slug (e.g. `sds-saga-order-service-1` → `order-service`). Unit-tested.
- **WS route `GET /api/metrics/:runId`** (`{ websocket: true }`): on connect, if the
  run is unknown or its state is not `running`, close the socket. Otherwise, every
  ~1500ms: `collector.sample(runId)`, map each snapshot's `name` via `serviceName`,
  and send `JSON.stringify([{ service, cpuPercent, memMB }, ...])`. Stop the interval
  on socket `close` and if the run leaves `running`. Wrap `sample` in try/catch so a
  transient stats error doesn't kill the socket.

## SPA (`web/`)

- **`metrics-store.ts`** (Zustand): `{ byService: Record<string, { cpuPercent: number; memMB: number }>; setSnapshot(list: { service: string; cpuPercent: number; memMB: number }[]): void; clear(): void }`. `setSnapshot` replaces `byService` keyed by `service`.
- **`slug.ts`** — `slugify(label: string): string` matching the compiler
  (lowercase, trim, non-alphanumerics → `-`, collapse repeats, strip leading/trailing
  `-`). So a node's `label` maps to the metric `service` key.
- **`SdsNode.tsx`** — read `useMetricsStore((s) => s.byService[slugify(data.label)])`;
  when present, render a compact badge under the label: `cpu N%` · `M MB` + a thin CPU
  bar. Absent → no badge (unchanged look).
- **`Drawer.tsx`** — `DrawerTab` widened to `compose | status | logs | metrics`;
  promote the Metrics stub to a real tab. New prop `metrics: { service; cpuPercent; memMB }[]`
  (derived in App from the store). Renders a per-service table (Service / CPU% / Mem)
  + a "live" indicator; hint when empty.
- **`App.tsx`** — when the run state becomes `running`, open
  `new WebSocket(\`ws://\${location.host}/api/metrics/\${runId}\`)`; on each message,
  `metricsStore.setSnapshot(JSON.parse(ev.data))`; close the socket and
  `metricsStore.clear()` on stop / terminal state / `runId` change / unmount. Show a
  small "● live metrics" indicator while the socket is open. Pass the store's snapshot
  list to the Drawer `metrics` prop.
- **`vite.config.ts`** — change the `/api` proxy to `{ target: 'http://localhost:8787', ws: true }`
  so the dev-server upgrades the WS to the agent.

### Node ↔ metric mapping

Agent sends `service` already reduced to the slug; the SPA matches it to a node via
`slugify(node.data.label)`. Container names that aren't graph nodes (none expected —
every compose service is a node) simply won't match a node and only show in the table.

## Data flow

Run → status poll flips to `running` → SPA opens WS `/api/metrics/:runId` → agent
pushes `[{service,cpuPercent,memMB}]` ~every 1.5s → `metrics-store` → SdsNode badges +
Metrics tab update live → Stop (or terminal/unmount) closes the WS and clears the
store.

## Error handling

- Run not `running` / unknown when the WS connects → agent closes immediately; SPA
  treats a closed socket as "no live metrics" (no badges), no crash.
- Transient `sample()` error → caught; the socket stays open and retries next tick.
- WS unsupported / connection error in the SPA → caught; the app works without badges
  (graceful degradation). No reconnect/backoff this brick.

## Testing

- **Agent:**
  - `serviceName` unit: `sds-saga-order-service-1` → `order-service`; multi-dash slugs
    preserved; bare/edge names tolerated.
  - **WS integration** (no Docker): `buildServer` with a **fake `StatsSource`**
    (canned containers + stats) + a real `app.listen` on an ephemeral port; connect a
    `ws` client to `/api/metrics/<run>` for a started run; assert a frame parses to
    `[{ service, cpuPercent, memMB }]` with the mapped slug. Also assert an unknown run
    closes the socket.
- **SPA:**
  - `metrics-store` set/clear; `slugify` cases.
  - `SdsNode` renders a badge when the store has its slug, none otherwise.
  - `Drawer` Metrics tab renders rows from the `metrics` prop.
  - `App` WS wiring with a **mock `WebSocket`** (jsdom lacks one): stub
    `global.WebSocket`, simulate `onopen` + a message frame, assert badges/tab update;
    Stop closes the socket and clears the store.
- `tsc --noEmit` clean; `npm --prefix web run build` produces `web/dist`.

## Out of scope (deferred / post-epic)

k6 throughput/latency aggregate + a load-config UI (needs the SPA to fire k6 — its own
follow-up); historical charts/sparklines; WS reconnect/backoff; cloud SPA hosting + WS
relay + token pairing + `npx sds-agent` packaging (post-epic; this WS is the seam it
will proxy).

## Likely task breakdown (for writing-plans)

1. Agent: `@fastify/websocket` + `serviceName` helper + WS `/api/metrics/:runId` +
   mapping unit + WS integration test (fake `StatsSource`).
2. SPA: `metrics-store.ts` + `slug.ts` + unit tests.
3. SPA: `SdsNode` badge + `Drawer` Metrics tab + tests.
4. SPA: `App` WS lifecycle + `vite.config.ts` `ws:true` proxy + mock-WebSocket tests +
   build.
