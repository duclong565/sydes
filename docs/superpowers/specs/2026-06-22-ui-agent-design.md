# UI Brick 1 — `sds-agent` + Minimal SPA (Design)

Date: 2026-06-22 · Branch: `feat/ui-agent` · Base: `b556d50`

## Context

The engine is feature-complete (compiler + `ExperimentController` + `K6Runner` +
`MetricsCollector`, all behind injectable seams). This is **brick 1 of 4** of the
UI epic. The chosen architecture is **agent-first, local-only, hybrid-ready**: a
local Node process (`sds-agent`) wraps the engine and exposes it over HTTP+JSON to
a browser SPA. No cloud hosting, WebSocket relay, token pairing, or `npx`
packaging this phase — but the transport boundary is kept clean so those bolt on
later (the user's hybrid/local-agent SaaS vision is the documented north star).

**Epic decomposition (this spec covers brick 1 only):**
1. `sds-agent` + minimal SPA (example dropdown + Run/Stop/status) — **this brick**.
2. React Flow canvas + node palette → graph JSON.
3. Run/teardown UX + warmup state.
4. Live metric badges over WebSocket (consumes the deferred Metrics WS bridge).

## Locked decisions

- **Shell:** local Node agent + browser SPA (not Electron, not Tauri).
- **Framework:** Fastify (`@fastify/static` for the built SPA; `@fastify/websocket`
  deferred to brick 4).
- **/run model:** asynchronous — returns a `runId` immediately, runs in the
  background, SPA polls `GET /api/status/:runId`.
- **Layout:** SPA in `web/` with its own `package.json` (Vite+React+TS+Tailwind);
  agent in `src/agent/` under the existing root package (Node, imports
  `src/engine` + `src/compiler` directly). No workspaces.

## Architecture

```
web/  (Vite + React + TS + Tailwind SPA)
   |  HTTP + JSON  (dev: Vite :5173 proxies /api -> agent :8787)
src/agent/  (Fastify)
   |  in-process calls
engine: compiler.compile + ExperimentController(RealRunner) + K6Runner
   |  dockerode / docker compose / k6 / fs
Docker
```

Dev runs Vite and the agent concurrently (Vite proxies `/api` to the agent). In
built mode the agent serves `web/dist` statically and the API on one port.

## Agent (`src/agent/`)

- **`server.ts`** — `buildServer(deps): FastifyInstance`. Registers routes and (in
  built mode) static serving of `web/dist`. `deps` is injectable:
  `{ runner: Runner; compile: typeof compile; runRoot?: string }`. The agent
  constructs `new ExperimentController(deps.runner, { runRoot })` and
  `new K6Runner(deps.runner)` internally (both already accept the `Runner` seam).
  Tests pass a `FakeRunner`; `main.ts` passes `RealRunner`. A future relay/token
  middleware slots into `buildServer` too.
- **`runs.ts`** — `RunStore`, an in-memory `Map<string, RunRecord>` where
  `RunRecord = { id: string; graph: Graph; runDir: string; state: 'starting' | 'running' | 'error' | 'stopped'; error?: string; services: ServiceStatus[] }`.
  `ServiceStatus` is the engine's existing type (`{ name, state, health? }`).
- **`main.ts`** — entrypoint: `buildServer` with real deps (`RealRunner`), listen
  on `PORT` (default `8787`). Run via `tsx`.

### HTTP API (all under `/api`)

| Method | Path | Body | Success | Failure |
|---|---|---|---|---|
| GET | `/api/examples` | — | `200 [{ id, label, graph }]` | — |
| POST | `/api/compile` | `{ graph, load? }` | `200 { ok: true, output }` | `400 { ok: false, errors }` |
| POST | `/api/run` | `{ graph, load? }` | `202 { runId, state: 'starting' }` | `400 { ok: false, errors }` |
| GET | `/api/status/:runId` | — | `200 { runId, state, services, error? }` | `404` |
| POST | `/api/stop` | `{ runId }` | `200 { runId, state: 'stopped' }` | `404` |

- **`/api/examples`** reads the bundled graphs (`saga`, `saga-db`, `lb-scaling`,
  `service-pair`) from the repo `examples/` dir and returns id+label+parsed graph.
- **`/api/compile`** wraps `compiler.compile(graph, load)` — preview only, no run.
- **`/api/run`**: compile (→400 on errors); `runId = graph.experimentId`;
  `writeArtifacts`; insert `RunRecord` state `starting`; return `202`. A background
  task then runs `preflight → up --wait → (if load) k6 run`, updating the record to
  `running` (and storing `services` from `controller.status`) or `error` (with the
  message). Re-running an existing `runId` first tears the old one down.
- **`/api/status/:runId`** returns the stored record; when `running`, refreshes
  `services` via `controller.status`.
- **`/api/stop`** calls `controller.down` and sets state `stopped`.

Multiple concurrent runs are allowed, keyed by `runId`. **No WebSocket endpoint in
this brick.**

### Optional load

`/api/run` and `/api/compile` accept an optional `load: { rate, durationSec }`. When
present on `/api/run`, the background task fires `K6Runner.run` after `up`. The
minimal SPA may expose a simple "with load" toggle; the API supports it regardless.

## SPA (`web/`)

Vite + React + TypeScript + Tailwind. Minimal screens:

- **Example dropdown** populated from `GET /api/examples`.
- **Compile preview** pane: `POST /api/compile` and show the generated
  `compose` in a `<pre>` (proves the compile path before running).
- **Run button** → `POST /api/run`, stores `runId`.
- **Status panel** → polls `GET /api/status/:runId` every ~2s, renders one row per
  service (name / state / health) and the overall run state
  (`starting` / `running` / `error`).
- **Stop button** → `POST /api/stop`.

State is plain React `useState` (Zustand is deferred to brick 2, which needs it for
the canvas). A small `api.ts` client wraps `fetch`.

## Dev / build wiring

- **`web/package.json`**: `vite`, `react`, `react-dom`, `tailwindcss`,
  `typescript`, `vitest`, `@testing-library/react`. Vite dev-server proxies `/api`
  → `http://localhost:8787`. `vite build` → `web/dist`.
- **Root `package.json`**: add `fastify`, `@fastify/static`, `tsx`. Scripts:
  `agent:dev` (`tsx watch src/agent/main.ts`), `web:dev` (`npm --prefix web run dev`),
  `dev` (both via `concurrently`), `web:build` (`npm --prefix web run build`),
  `agent:start` (`tsx src/agent/main.ts`).
- The agent serves `web/dist` only when it exists (built mode); in dev the SPA is
  served by Vite.

## Testing

- **Agent (no Docker):** `buildServer` with a **FakeRunner** (the controller's
  existing `Runner` seam, already used by `controller.test.ts`) and the real
  compiler. Drive via Fastify `.inject()`:
  - `GET /api/examples` lists the bundled graphs.
  - `POST /api/compile` valid graph → 200 with `output.compose`; invalid → 400 with
    `errors`.
  - `POST /api/run` → 202 `{runId}`; after the (fake) background completes,
    `GET /api/status/:runId` reports `running` with services from the fake `ps`.
  - `POST /api/stop` → `down` invoked, state `stopped`.
  - `GET /api/status/:unknown` → 404.
- **SPA:** Vitest + React Testing Library with mocked `fetch`: dropdown populates
  from `/api/examples`; Run issues `POST /api/run`; status rows render from a polled
  status payload; Stop issues `POST /api/stop`.
- **Gated e2e** (`describe.skipIf(!process.env.RUN_DOCKER)`): start the real agent
  (`RealRunner`), `POST /api/run` with `examples/saga.json`, poll `GET /api/status`
  until `running`, assert services are up, then `POST /api/stop`. Requires the
  `sds/*` images built; mirrors the existing engine gated smokes.

## Hybrid-ready seams (designed, NOT built this brick)

- All agent I/O is HTTP+JSON, so the same handlers later sit behind a cloud
  WebSocket relay without changing the engine calls.
- `buildServer(deps)` is injectable — a future auth/token middleware and the relay
  transport slot in here.
- The compose/k6 artifacts are the compiler's output contract; version it when the
  cloud UI and `npx` agent can drift.

## Out of scope (later bricks / post-epic)

React Flow canvas (brick 2), warmup UX (brick 3), WebSocket metric streaming
(brick 4), cloud hosting + WS relay + token pairing + `npx sds-agent` packaging
(post-epic). No agent production build step beyond `tsx` this brick.

## Likely task breakdown (for writing-plans)

1. Agent skeleton: Fastify `buildServer` + `RunStore` + `GET /api/examples` +
   `POST /api/compile` + `.inject()` tests.
2. `POST /api/run` (async, FakeRunner-injected) + `GET /api/status/:runId` +
   `POST /api/stop` + background runner + tests.
3. `main.ts` (RealRunner) + static `web/dist` serving + root scripts.
4. `web/` Vite+React+Tailwind scaffold + minimal SPA (dropdown, compile preview,
   run/stop, status poll) + RTL tests + Vite proxy.
5. Gated agent + Docker e2e smoke (`saga.json` through the HTTP API).
