# UI Brick 5 — "Generate load" (k6 from the canvas) (Design)

Date: 2026-06-24 · Branch: `feat/ui-load` (off `main`, which has bricks 1–4) · Base: `9b2d17d`

## Context

The UI epic (bricks 1–4) is on `main`: canvas → graph JSON → agent → real Docker,
with live status, logs, and per-service CPU/mem badges over WebSocket. But there's
no way to drive traffic from the UI — the microservice only publishes to Kafka per
HTTP request it receives, and nothing in the SPA generates those requests (the
load-config UI was deferred). This brick adds an on-demand **Generate load** action:
fire k6 at the running stack from the canvas, watch the badges/logs move, and see the
k6 aggregate.

The engine already has the pieces: `compile(graph, { rate, durationSec })` emits a k6
script targeting the entry (first LB else first service); `K6Runner.run(id, runDir)`
runs one-shot `grafana/k6` in the experiment network and parses the summary into
`K6Result`. The agent's `runExperiment` can fire k6 at startup but the SPA never
passes a load config and the result is discarded.

## Locked decisions

- **Trigger:** a separate, repeatable action — `POST /api/load/:runId` against an
  already-running experiment (Run just brings the stack up).
- **Response:** synchronous — the endpoint blocks for ~`durationSec` and returns the
  `K6Result`; the button shows "Generating load…"; live feedback comes from the
  existing metrics WS + Logs.
- **Result display:** a "Last load" card atop the Metrics drawer tab.
- **Control:** preset buttons (Light/Normal/Spike/Stress) + unit-labelled number
  inputs (rate `req/s`, duration `s`).
- **Visual feedback:** edges animate (React Flow `animated`) while a load is in flight.
- **Deferred:** per-service "most-stressed" attribution (k6 is HTTP-aggregate; the
  live CPU/mem table already shows per-service load; a true peak-per-service over the
  burst needs extra tracking — follow-up). Continuous/indefinite load (k6 bursts are
  finite; repeat the button). Load history/charts.

## Engine

- **`K6Result` gains `latencyMaxMs: number`** (peak latency) and `parseSummary`
  reads `metrics.http_req_duration.max` (`num(dur.max)`), alongside the existing
  `requests`, `rps`, `latencyAvgMs`, `latencyP95Ms`, `errorRate`. (`src/engine/k6-runner.ts`.)

## Agent

- **`POST /api/load/:runId`** body `{ rate: number; durationSec: number }`
  (`src/agent/server.ts`):
  - `404` if the run is unknown; `409` if its state is not `running`, or a load is
    already in flight (`rec.loadInFlight`).
  - `compile(rec.graph, { rate, durationSec })`: if `!ok` or `output.k6` is absent
    (graph has no service/LB entry) → `400 { error }`.
  - Write the k6 script: `writeFileSync(join(rec.runDir, 'load.js'), output.k6)`
    (only that file — does not touch the running compose).
  - `rec.loadInFlight = true`; `try { const result = await k6.run(runId, rec.runDir); rec.lastLoad = result; return result } finally { rec.loadInFlight = false }`.
  - k6 failure (non-zero) → the thrown error becomes a `500 { error }`.
- **`RunRecord`** gains `lastLoad?: K6Result` and `loadInFlight?: boolean`
  (`src/agent/types.ts`).

## SPA (`web/`)

- **`api.ts`**: `load(runId, rate, durationSec): Promise<K6Result | { ok: false; errors?: unknown[]; error?: string }>` → `POST /api/load/:runId`. Mirror the `K6Result` type (incl. `latencyMaxMs`).
- **`App.tsx`**:
  - Load-config state `rate` (default 20), `durationSec` (default 10), `lastLoad: K6Result | null`, `loading: boolean`.
  - Top-bar **load control**: preset buttons — `Light` (5/10), `Normal` (20/10),
    `Spike` (100/5), `Stress` (200/20) set rate+dur — plus number inputs (`req/s`, `s`)
    and a **Generate load** button. Button enabled only when `state === 'running'`
    && `!loading`; click → `loading=true`, `await api.load`; on a `K6Result` set
    `lastLoad`; on an error shape → error banner; `finally loading=false`. Button text
    "Generating load…" while loading.
  - **Animated edges:** pass `loading` down so edges render `animated` during the burst.
  - Pass `lastLoad` to the Drawer.
- **`Canvas.tsx`**: accept a `loading` prop (or read an App-provided flag) and render
  edges with `animated: loading` (map `edges` → `{ ...e, animated: loading }`).
- **`Drawer.tsx`**: a **"Last load" card** atop the Metrics tab when `lastLoad` is
  present: config line (`<rate> req/s · <dur>s`) + a grid — requests, throughput
  (`rps`), error% , avg, p95, peak (`latencyMaxMs`) — above the live per-service table.

## Data flow

Run → `running` → pick a preset / set rate+dur → **Generate load** →
`POST /api/load/:runId` recompiles the k6 script + runs k6 in-network at the entry
service → service publishes → Kafka → worker consumes (badges/logs move live via the
metrics WS) + edges animate → k6 exits (~`durationSec`) → `K6Result` returned → "Last
load" card fills, edges stop animating. Repeatable.

## Error handling

- Not-running / unknown / load-in-flight → `4xx` → error banner; button stays
  disabled appropriately.
- Graph with no k6 entry (no service/LB) → `400 "no load entry"` → banner.
- k6 run failure → `500` → banner. The run itself is unaffected (load is separate
  from the stack lifecycle).

## Testing

- **Engine:** `parseSummary` test gains a `max` field → asserts `latencyMaxMs`.
- **Agent:** `POST /api/load` happy path with a **`FakeRunner`** that, on the
  `grafana/k6` docker-run argv, writes a canned `summary.json` into the run dir (so
  the real `K6Runner` parses a `K6Result`); assert the returned + stored
  `rec.lastLoad` (incl. `latencyMaxMs`). Plus `404` unknown run, `409` not-running.
- **SPA:** `api.load` posts to the right URL; `App` Generate-load button is disabled
  until `running`, calls `api.load`, and renders the result (mocked fetch); `Drawer`
  renders the "Last load" card from the `lastLoad` prop (incl. peak); `Canvas` marks
  edges animated when `loading`.
- `tsc --noEmit` clean; `npm --prefix web run build` produces `web/dist`.

## Out of scope (deferred / post-epic)

Per-service "most-stressed" attribution; continuous/indefinite load; load
history/sparklines; concurrent multi-load; choosing the load target node (always the
compiler's entry); cloud hybrid (post-epic).

## Likely task breakdown (for writing-plans)

1. Engine: `K6Result.latencyMaxMs` + `parseSummary` parses `max` + test.
2. Agent: `POST /api/load/:runId` (guards → recompile → write `load.js` → `k6.run` →
   store/return) + `RunRecord.lastLoad`/`loadInFlight` + tests (FakeRunner writes a
   canned `summary.json`).
3. SPA: `api.load` + Drawer "Last load" card (+ `K6Result` type) + tests.
4. SPA: `App` load control (presets + unit inputs) + Generate-load wiring + animated
   edges (`Canvas` `loading`) + tests + build.
