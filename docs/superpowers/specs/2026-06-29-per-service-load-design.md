# Per-Service Load Targeting — Design

Date: 2026-06-29 · Branch: `feat/per-service-load` · Base: `main`

## Context

Today a load run hits exactly **one** target. The compiler auto-picks an entry —
"first `lb` else first `service`" (`src/compiler/index.ts:106-113`) — and
`generateK6` emits a single `constant-arrival-rate` scenario against it. The SPA's
toolbar carries one global `rate` + `durationSec` and a "Generate load" button
(`web/src/App.tsx:146-165`); `/api/load/:runId` recompiles with `{rate,durationSec}`
and runs k6 once against the already-up stack.

For a system-design sandbox that's the wrong shape: the interesting questions are
**asymmetric** — checkout at 50 rps while search runs at 200 rps stresses the shared
Kafka/DB differently than a single firehose. This brick lets the user **mark any
service or lb node as a load source with its own RPS**, fire all of them at once
under one shared duration, and read **per-target results** (including saturation).

**Lifecycle is unchanged.** k6 is *not* a compose service (it never has been); it's a
one-shot `docker run --rm --network <net> grafana/k6 …` against the up stack
(`src/engine/k6-runner.ts:40-52`), re-runnable, guarded by `loadInFlight`. So
"Run load against the up stack, re-runnably" is the existing architecture — this
brick changes only *what* k6 is told to do and *how its results are parsed*, not the
run lifecycle.

## Locked decisions (brainstorm 2026-06-29, mockup v2 `docs/_local/ui-per-service-load-mockup.html`)

- **Multi-source, per-service rate.** Each eligible node carries its own rate; many
  fire simultaneously. (Rejected: single selectable target — doesn't fix the
  complaint; shared-rate — can't show asymmetric load.)
- **Duration is global, rate is per-node.** One run = one wall-clock window. Toolbar
  holds `durationSec`; the Inspector holds each node's `rate`.
- **Eligible sources: `service` + `lb` only** (both are HTTP entrypoints; matches the
  old auto-pick that preferred lb). service → port `8080`, lb → port `80`.
  kafka/worker/db never show the toggle.
- **Per-target results, with saturation made explicit.** One tagged k6 scenario per
  target → one result row: `target /s` (requested) vs `achieved /s` + `dropped` iters
  + err% + avg/p95/peak. A row where achieved < target is highlighted. The **total**
  row sums requests/target/achieved/dropped; latency columns are blank (averaging
  latency across asymmetric targets is noise).
- **Canvas indicator: a `⚡N/s` chip in the node's type-header bar** (in-flow, matches
  how the cpu/mem/writes rows were added; no overlap with the metric badge).
- **Validation:** rate must be an integer ≥ 1 — inline red in the Inspector **and** a
  fail-loud compile error (matches the compiler's default-deny philosophy). ≥ 1 target
  required to run; the toolbar button is disabled with a how-to hint when zero marked.
- **Drop the global rate input + the Light/Normal/Spike/Stress presets** — both assume
  one global rate, which no longer exists. (Follow-up, out of scope: a bulk "apply rate
  to all sources" action.)

## Contract changes (the spine)

**`LoadConfig` (runtime) — `src/compiler/types.ts`:**
```ts
// was: { rate: number; durationSec: number }
export interface LoadTarget { nodeId: string; rate: number }     // rate = req/s, integer ≥ 1
export interface LoadConfig { durationSec: number; targets: LoadTarget[] }
```

**`CompilerResult.output`** gains a resolved target list so result-parsing has a single
source of truth (the compiler already resolves `nodeId → label → slug` and
`type → port`):
```ts
output: { compose: string; nginx?: string; k6?: string;
          loadTargets?: { slug: string; targetRps: number }[] }
```

**`K6Result` (`src/engine/k6-runner.ts`)** becomes per-target + total:
```ts
export interface TargetResult {
  slug: string; targetRps: number; achievedRps: number; requests: number;
  dropped: number; errorRate: number; latencyAvgMs: number; latencyP95Ms: number; latencyMaxMs: number;
}
export interface K6Result {
  perTarget: TargetResult[];
  total: { requests: number; targetRps: number; achievedRps: number; dropped: number; errorRate: number };
}
```

**Data lives on the node** for the UI/persistence: `NodeConfig.loadRate?: number`
(both the SPA `web/src/store.ts` and the compiler `src/compiler/types.ts`). Presence +
value ≥ 1 = "this node is a source at N rps." The compiler does **not** read
`loadRate`; the SPA translates marked nodes → `LoadConfig.targets` at run time so a
load can be re-fired against a different subset without re-Running the stack.

## Components

### 1. `src/compiler/generators/k6.ts` — multi-scenario, tagged

`generateK6(targets: { slug: string; port: number; rate: number }[], durationSec)` emits
**one scenario per target**, scenario **key = slug** (so k6's `scenario` system tag
carries the slug), each with its own `exec` function posting to `http://<slug>:<port>/`:

```js
export const options = {
  scenarios: {
    'checkout': { executor:'constant-arrival-rate', rate:50, timeUnit:'1s',
                  duration:'10s', preAllocatedVUs:50, maxVUs:500, exec:'fn0' },
    'search':   { executor:'constant-arrival-rate', rate:200, timeUnit:'1s',
                  duration:'10s', preAllocatedVUs:200, maxVUs:2000, exec:'fn1' },
  },
  // No-op thresholds FORCE per-scenario sub-metrics into --summary-export.
  // (Without these, summary-export only has aggregate metrics — no per-target breakdown.)
  thresholds: {
    'http_reqs{scenario:checkout}': ['count>=0'],
    'http_req_duration{scenario:checkout}': ['max>=0'],
    'http_req_failed{scenario:checkout}': ['rate>=0'],
    'dropped_iterations{scenario:checkout}': ['count>=0'],
    /* …repeat per slug… */
  },
};
function fn0(){ http.post('http://checkout:8080/', JSON.stringify({ping:true}), {headers:{'Content-Type':'application/json'}}); }
function fn1(){ http.post('http://search:8080/', JSON.stringify({ping:true}), {headers:{'Content-Type':'application/json'}}); }
export { fn0, fn1 };
```

- Scenario **keys are slugs** (hyphens OK — they're string keys); `exec` points to
  generated identifiers `fn0..fnN` (slugs aren't valid JS identifiers).
- **`maxVUs` is the saturation contract, not an implementation detail.**
  `dropped_iterations` fires when the arrival-rate executor can't grab a free VU within
  the VU budget, and k6 (≥0.27) defaults `maxVUs = preAllocatedVUs` (no autoscale). So
  the VU ceiling *defines* what "dropped" means:
  - ceiling too low → drops are VU starvation, not the backend (the drawer's "Docker
    couldn't keep up" becomes a lie);
  - ceiling effectively infinite → k6 spins VUs to hold the rate, latency balloons, and
    saturation hides in p95 with **zero drops**.
  By Little's law, sustaining rate R at response latency L(s) needs ≈ R·L VUs. We set
  **`preAllocatedVUs = rate` (warm pool) and `maxVUs = rate * 10` (ceiling)** → the
  target is declared *dropping/saturated* once it can't be served within ~10× rate
  concurrent VUs (effective latency > ~10s). This is generous enough that drops reflect
  the **backend**, not an artificial VU cap, and bounded enough to not exhaust the k6
  container. **Document in the drawer/help: "dropped = arrival rate not sustainable
  within the VU budget (≈10s effective latency)."** Task 0 tunes the `*10` factor against
  a real saturated backend.
- The no-op thresholds + the `scenario` tag on `dropped_iterations` are the mechanism
  that surfaces per-tag stats — **unproven, verified in Task 0 before the contract is
  written** (see the task breakdown + the top-risk smoke under Testing).

### 2. `src/compiler/index.ts` — resolve targets, drop the auto-pick

Replace the `if (loadConfig)` block (106-113):
- Resolve each `loadConfig.targets[i].nodeId` → node in the graph. Build
  `{ slug: slugify(node.label), port: node.type==='lb' ? 80 : 8080, rate }`.
- `output.k6 = generateK6(resolved, loadConfig.durationSec)`.
- `output.loadTargets = resolved.map(r => ({ slug: r.slug, targetRps: r.rate }))`.
- The compiler no longer auto-picks an entry — it requires explicit `targets`. The old
  "first lb else first service" heuristic isn't deleted from the system, it **relocates
  to the CLI `--load` default** (§4) where a human invocation still needs a sensible
  zero-config target.

Validation (in `compile`, fail-loud — collected with the existing edge-legality pass):
- a `loadConfig` with **zero targets** → error `load requires at least one target`.
- a target `nodeId` that doesn't resolve, or resolves to a non-`service`/`lb` node →
  error `load target <id> must be a service or lb`.
- a target `rate` that is not an integer ≥ 1 → error `load rate must be a whole number ≥ 1`.

### 3. `src/engine/k6-runner.ts` — per-tag parse

- `parseSummary(json, targets: { slug; targetRps }[]) : K6Result`. For each target read
  the tagged sub-metrics by string key:
  `metrics['http_reqs{scenario:'+slug+'}']` → `{requests:count, achievedRps:rate}`,
  `http_req_duration{scenario:slug}` → avg/`p(95)`/max,
  `http_req_failed{scenario:slug}` → errorRate (`value`),
  `dropped_iterations{scenario:slug}` → dropped (`count`; **absent → 0**, since a
  scenario with no drops emits no samples under that tag).
- `total` = the existing top-level aggregate metrics (`http_reqs`, `http_req_duration`,
  `http_req_failed`) + summed `targetRps`/`dropped`.
- `run(experimentId, runDir, targets)` passes `targets` through to `parseSummary`.
- Keep the existing one-shot docker run; only the parse + signature change — **except
  pin the image.** `k6-runner.ts:46` currently runs `grafana/k6` (= `latest`); this
  brick now depends hard on `--summary-export` (soft-deprecated upstream) + tagged
  sub-metric behavior. Pin a specific `grafana/k6:<tag>` (the exact tag is the one Task 0
  verifies the mechanism against), mirroring the repo's `apache/kafka:3.7.2` discipline.
  The smoke asserts against the pinned tag.

### 4. `src/agent/server.ts` — `/api/load` body, run-experiment, CLI

- `POST /api/load/:runId` body → `{ durationSec, targets: {nodeId,rate}[] }`.
  `compile(rec.graph, { durationSec, targets })`. Empty/invalid targets now make
  `compile` return `{ok:false}` (fail-loud validation), so the existing
  `if (!result.ok) → 400 result` path covers it; the legacy `!output.k6` guard stays as
  belt-and-suspenders. Write `load.js`, then
  `rec.lastLoad = await k6.run(runId, rec.runDir, result.output.loadTargets!)`.
- `src/agent/run-experiment.ts` + `src/engine/cli.ts`: both reference the old
  `LoadConfig`. The SPA never sends load on `/api/run`, so `runExperiment`'s `load?`
  just needs to typecheck against the new shape. The **`sim` CLI** `--load` builds
  `targets` from graph nodes that carry `config.loadRate` (the new canonical); if none,
  default the single auto-entry (first lb else first service) at a built-in rate so
  `npm run sim … --load` still does something. (Keeps the 4 examples + smokes working.)

### 5. `web/src/store.ts` — `NodeConfig.loadRate`

- `NodeConfig` gains `loadRate?: number`. No `addNode` seed (sources default OFF;
  toggling on writes it). `toGraph`/`loadExample` already pass `config` through generically.

### 6. `web/src/Inspector.tsx` — load toggle + rate (service & lb)

Render a shared **load section** when `type === 'service' || type === 'lb'` (appended
after the service latency/error fields; for lb it's the only config block):
- A **"⚡ Load source" toggle**. On → `updateNode(id,{config:{...cfg, loadRate: cfg.loadRate ?? 20}})`;
  off → write `config` with `loadRate` removed (set to `undefined`).
- When on, a **rate** number input (`min={1}`, `value={cfg.loadRate}`), editing
  `loadRate`. Inline validation: not-integer or < 1 → red border + **"Rate must be a
  whole number ≥ 1"**. When off, the rate field is hidden (sub-text "off — no traffic
  generated here").
- A sub-line echoes the resolved target, e.g. `k6 hits checkout:8080 at 50 rps`
  (lb → `:80 → nginx round-robins`).

### 7. `web/src/nodes/SdsNode.tsx` — `⚡N/s` header chip

The colored type-header `<div>` (line 19) becomes a flex row: `{type}` on the left and,
when `data.config?.loadRate` is set and `type ∈ {service,lb}`, a right-aligned
`⚡ {loadRate}/s` chip. Pure presentation from node data; no metrics dependency.

### 8. `web/src/App.tsx` — targets assembly, Run-load, drop presets

- Remove the `rate` state and the Light/Normal/Spike/Stress preset row; keep
  `durationSec`.
- A shared **`isLoadSource(n)`** predicate is the single source of truth for both the
  enable-gate and the targets filter — and it must equal the **validity rule**, not just
  "≥ 1":
  ```ts
  const t = n.data.type, r = n.data.config?.loadRate;
  const isLoadSource = (t === 'service' || t === 'lb') && Number.isInteger(r) && r >= 1;
  ```
  (Note the full `(t === 'service' || t === 'lb')` — not `t === 'service' || 'lb'`, which
  is always truthy.) A node with `loadRate: 2.5` is inline-red in the Inspector **and**
  excluded here, so the button can't enable into a guaranteed 400.
- `onRunLoad` (was `onGenerateLoad`): `targets = store.nodes.filter(isLoadSource)
  .map(n => ({ nodeId: n.id, rate: n.data.config!.loadRate! }))`, then
  `api.load(runId, durationSec, targets)`.
- The toolbar load control (still gated on `state==='running'`) shows: `durationSec`
  input, an **aggregate** `⚡ {N} sources · {Σrate} rps` count over `isLoadSource` nodes,
  and a **Run load** button **disabled when zero sources** (count text becomes the how-to
  hint "select a service → toggle ⚡ Load source").
- `lastLoad` is the new `K6Result`; passed to the Drawer unchanged.

### 9. `web/src/api.ts` — load signature + result type

- `load: (runId, durationSec, targets) => POST /api/load/:runId { durationSec, targets }`.
- `K6Result`/`LoadResult` types updated to the per-target shape (shared with the engine).

### 10. `web/src/Drawer.tsx` — per-target results table

Replace the single "Last load" box with a **per-target table**:
`target | target /s | achieved /s | dropped | err % | avg | p95 | peak`, a row per
`lastLoad.perTarget[i]`, **saturated rows** (`achievedRps < targetRps`) tinted + the
`achieved`/`dropped` cells emphasized, then a **total** row (latency cells `—`). The
live container-stats metrics table below it is unchanged.

## Data flow

```
Inspector ⚡ toggle + rate → node.config.loadRate           (canvas / persistence)
Run (up stack)            → /api/run { graph }              (no load; unchanged)
toolbar Run load          → App builds targets from marked nodes
  → POST /api/load/:runId { durationSec, targets:[{nodeId,rate}] }
  → compile(rec.graph, load): resolve nodeId→slug+port, emit one tagged k6 scenario each,
    return output.k6 + output.loadTargets
  → K6Runner.run(id, dir, loadTargets): docker run grafana/k6 vs the up network
  → parseSummary(summary.json, loadTargets): per-scenario sub-metrics → K6Result.perTarget + total
  → Drawer per-target table (+ saturation highlight); ⚡ chips already on canvas
```

## Error handling / edge cases

- **Back-compat:** the 4 bundled examples carry no `loadRate` → no sources → Run works,
  Run-load disabled until the user marks one. Existing compiler/agent tests that passed
  the old `{rate,durationSec}` must migrate to `{durationSec,targets}` (contract change,
  not optional).
- **Empty/invalid targets** → compiler fails loud; agent returns 400; UI button is
  disabled before that can happen (defense in depth).
- **Canvas edited mid-run:** App builds targets from the live store; a `nodeId` not in
  the running `rec.graph` (added/deleted since Run) → fail-loud "unknown target". The
  running stack reflects `rec.graph`; this is the correct, loud behavior.
- **Local Docker saturation:** the sum of target rates can exceed what the host can
  serve; that's the point — surfaced as `achieved < target` + `dropped`. No soft cap is
  imposed (documented, not enforced).
- **Zero-drop scenario:** `dropped_iterations{scenario:slug}` sub-metric is absent →
  parsed as 0.

## Testing

**Compiler (`src/compiler/generators/k6.test.ts`, `src/compiler/index.test.ts`, no Docker):**
- 2 targets → 2 scenarios keyed by slug, each with its `exec` fn hitting the right
  `host:port` (service `:8080`, lb `:80`); threshold keys present for all four metrics
  per slug.
- `compile` returns `output.loadTargets` with resolved `{slug,targetRps}`; `output.k6`
  present only when targets non-empty.
- validate: zero targets / a `kafka` target / `rate:0` / `rate:2.5` → fail-loud errors;
  a valid `service`+`lb` pair at integer rates → ok.

**Engine (`src/engine/k6-runner.test.ts`, no Docker):**
- `parseSummary` on a fixture with `http_reqs{scenario:checkout}` etc. → correct
  `perTarget` rows + summed `total`; a slug with a missing `dropped_iterations` sub-metric
  → `dropped: 0`; achieved < target preserved (no clamping).

**Engine smoke (`*.smoke.test.ts`, `RUN_DOCKER=1`):** the Task-0 spike, hardened into a
kept regression — a real 2-target k6 run against a live stack (one saturated) → assert
the summary contains the per-scenario sub-metrics (incl. `dropped_iterations{scenario:…}`)
and `parseSummary` yields two rows with the saturated one showing drops. Pinned to the
chosen `grafana/k6:<tag>`. **This is the top risk; Task 0 proves the shape before the
contract is built, this smoke keeps it from regressing.**

**Agent (`src/agent/load.test.ts` / `server.test.ts`, FakeRunner):**
- `POST /api/load` with `{durationSec, targets}` → canned summary parsed to the new
  shape; empty `targets` → 400; ineligible target → 400 (compile error surfaced).

**SPA (`web/src/*.test.tsx`):**
- `store`: `loadRate` round-trips `toGraph`/`loadExample`; toggling via `updateNode`
  adds/removes it.
- `Inspector`: service **and** lb show the ⚡ toggle + rate; on adds `loadRate`, off
  removes; `rate:0` → red + "Rate must be a whole number ≥ 1"; kafka shows no toggle.
- `SdsNode`: ⚡ chip renders when `loadRate` set on service/lb, absent otherwise.
- `App`: Run-load assembles `targets` from marked nodes and calls `api.load(runId,
  durationSec, targets)`; button disabled with zero sources; src-count shows aggregate rps.
- `Drawer`: renders a row per `perTarget` + a total; a saturated row gets the highlight.

`npm test` + `npm run typecheck` clean; `npm --prefix web run test` + web `tsc` +
`build` clean.

## Out of scope

- Load **presets** / a bulk "apply rate to all sources" action (dropped with the global
  rate; a clean follow-up).
- Non-constant load profiles (ramping/staged) — only `constant-arrival-rate`.
- Per-node **duration** (decided: global).
- Server-side persistence of load config (canvas + `rec.graph` are the source of truth).
- Per-target live overlay on the canvas during the load run (results land in the Drawer;
  the ⚡ chip is static config, not live throughput).

## Likely task breakdown (for writing-plans)

0. **Spike the k6 mechanism (throwaway, `RUN_DOCKER`, BEFORE the contract).** Hand-write
   a 2-scenario k6 script (scenario keys = slugs, no-op `{scenario:…}` thresholds, the
   `maxVUs` policy) and run it against a live 2-service stack — one healthy, one forced
   slow/saturated. Assert all three load-bearing assumptions: (1) `scenario` system tag
   present, (2) the no-op thresholds surface `metric{scenario:slug}` sub-metrics in
   `--summary-export`, (3) **`dropped_iterations` carries the `scenario` tag** (the shaky
   one). Also confirm a saturated backend actually produces **drops** (not just latency)
   under `maxVUs = rate*10`, and lock the exact `grafana/k6:<tag>`. **If (3) fails**, the
   contract changes here (e.g. `dropped` only at the `total` level, or derive saturation
   from achieved-vs-target alone) — cheaper to learn now than after task 8. Output: a
   confirmed sub-metric key shape + tag + `maxVUs` factor that tasks 1–3 build on.
1. **Contract + compiler** — `LoadConfig`/`LoadTarget`/`NodeConfig.loadRate` in
   `types.ts`; `generateK6` multi-scenario + thresholds; `index.ts` resolve +
   `loadTargets` + validation; `k6.test.ts` + `index.test.ts` (TDD).
2. **Engine parse** — `K6Result` per-target shape + `parseSummary(json,targets)` +
   `run(…,targets)`; `k6-runner.test.ts` (TDD) + a `RUN_DOCKER` smoke for the sub-metric
   mechanism.
3. **Agent + CLI** — `/api/load` body + `compile` + `k6.run(loadTargets)`;
   `run-experiment`/`sim` CLI migrated to the new `LoadConfig`; `load.test.ts` (TDD).
4. **SPA store** — `NodeConfig.loadRate` + `store.test.ts` (TDD).
5. **SPA Inspector** — load toggle + rate for service|lb + inline validation +
   `Inspector.test.tsx` (TDD).
6. **SPA SdsNode** — ⚡ header chip + test.
7. **SPA App** — targets assembly, Run-load, aggregate src-count, drop global
   rate/presets + `App.test.tsx` (TDD); web build.
8. **SPA Drawer** — per-target results table + saturation highlight + `Drawer.test.tsx`.
9. **Docs** — refresh the load/metrics notes in `CLAUDE.md` + `README.md`; optionally
   seed `config.loadRate` in an example graph (e.g. lb-scaling) for a one-click demo.
