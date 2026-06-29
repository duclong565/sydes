# Payload Sensitivity — Design

Date: 2026-06-30 · Branch: `feat/payload-sensitivity` · Base: `main` (after PR #29 lands)

## Context

Today the request body is inert: the microservice drains and discards it
(`images/microservice/server.go:63` — `io.Copy(io.Discard, r.Body)`, "Body
intentionally dropped — traffic simulator, not a proxy"), then sleeps a fixed
`LATENCY_MS (+ jitter)`. So the body the load brick sends (`{"ping":true}`) never
moves any number.

This brick makes payload size **matter**, with two knobs that mirror real life:

- a **load source** sends an N-KB filler body (`config.loadBodyKb`);
- a receiving **service** adds latency proportional to bytes received
  (`config.msPerKb`): `extraMs = bytesReceived / 1024 × msPerKb`.

A fat body at a sensitive service raises that target's avg/p95/peak in the
per-target results the load brick already shows, and at high rate tips it into
`dropped` (saturation). The demo: *watch a fat payload saturate a service the
small one couldn't.* The byte count is free — `io.Copy` already returns it; today
we throw it away.

## Locked decisions (brainstorm 2026-06-30, mockup v2 `docs/_local/ui-load-body-mockup.html`)

- **Latency-only (v1).** `bytes/1024 × msPerKb` added to the sleep — deterministic
  and legible. No CPU work (hashing would jitter the CPU% badge and muddy the
  lesson); CPU work is a possible later toggle.
- **Sized body only.** One constant ~N-KB string, built once at k6 module scope and
  reused every iteration. No static-paste / template / per-request randomness —
  per-request generation was the thing that would pollute the saturation metric, so
  it's out.
- **Two knobs, two roles:** `loadBodyKb` on the load **source** (the ⚡ node);
  `msPerKb` on the receiving **service**. `msPerKb` lives only on `service` nodes
  (HTTP receivers — workers consume Kafka, an LB only forwards). `loadBodyKb` lives
  only on load sources (service/lb), and travels in the load request (like `rate`).
- **Back-compat:** `MS_PER_KB=0` (default) → byte-identical sleep to today;
  `loadBodyKb` unset → k6 still posts `{"ping":true}`.
- **Body size cap 1024 KB**, `msPerKb ≥ 0` — inline red in the Inspector **and**
  fail-loud compile errors (the VU-cap lesson, applied to bodies).
- **nginx body limit (must-fix):** the generated nginx.conf must raise
  `client_max_body_size` above the cap, or the lb fan-out path 413s near the cap.

## Contract change

`LoadTarget` (`src/compiler/types.ts`) gains an optional body size; everything else
is unchanged:
```ts
export interface LoadTarget { nodeId: string; rate: number; bodyKb?: number }
// LoadConfig stays { durationSec, targets: LoadTarget[] }
```
`bodyKb` rides in the load request (fresh per load, like `rate`); `msPerKb` is a
service-node config baked into the compose env at Run (like `latencyMs`).

Node config fields:
```ts
msPerKb?: number;     // service receiver: +ms latency per KB received (float ≥ 0)
loadBodyKb?: number;  // load source: send an N-KB filler body (int 1..1024)
```
`msPerKb` goes on **both** the compiler `GraphNode.config` (the service handler reads
it → `MS_PER_KB` env) and the web `NodeConfig` (Inspector edits it). `loadBodyKb` is
**web-only** on `NodeConfig` — the compiler never reads it from the node; it arrives
via `LoadTarget.bodyKb` in the load request (the SPA copies it from the node when
building targets).

## Components

### 1. `images/microservice` — react to body size

- `config.go`: add `MsPerKb float64` to `Config`; read `MS_PER_KB` via a new
  `nonNegFloat(key)` helper (mirrors `nonNegInt`; empty → 0, parse error or `< 0`
  → fail loud). Default 0.
- `server.go` `handleRoot`: capture the byte count `io.Copy` already returns and fold
  it into the sleep as float-ms (the current `delay` is an int; switch the per-KB
  term to float accumulation):
  ```go
  n, _ := io.Copy(io.Discard, r.Body)
  delayMs := float64(s.cfg.LatencyMS)
  if s.cfg.JitterMS > 0 {
      delayMs += float64(s.rand.Intn(s.cfg.JitterMS + 1))
  }
  delayMs += float64(n) / 1024.0 * s.cfg.MsPerKb
  time.Sleep(time.Duration(delayMs * float64(time.Millisecond)))
  ```
  The extra latency lands before error-injection / upstream / publish — it is the
  service's own processing time.
- Test (`server_test.go`): with `MsPerKb > 0`, a large request body produces a
  measurably larger `handleRoot` latency than an empty body; with `MsPerKb = 0`,
  body size has no effect (back-compat).

### 2. `src/compiler/handlers/service.ts` — emit `MS_PER_KB`

- In `compile`, add to `env` when set: `MS_PER_KB: String(node.config?.msPerKb ?? 0)`.
  (Emit always as `"0"` by default — harmless, and keeps the env surface uniform with
  `LATENCY_MS`/`ERROR_RATE`.)
- In `validate`, append: if `node.config?.msPerKb` is defined and
  `(typeof it !== 'number' || it < 0)` → `{ nodeId, message: 'msPerKb must be ≥ 0' }`.
  Add `msPerKb?: number` to `GraphNode.config` in `src/compiler/types.ts`.

### 3. `src/compiler/generators/k6.ts` — sized body per target

- `K6Target` gains `bodyKb?: number`. For each target, emit a module-scope constant
  body and post it (keep the generated file small — use `'x'.repeat(bytes)`, not a
  literal megabyte):
  ```js
  // WRAPPER = '{"pad":"' (8 bytes) + '"}' (2 bytes) = 10 bytes
  // fill = bodyKb*1024 - 10, clamped ≥ 0; bodyKb=64 → 65536-10 = 65526
  const body0 = '{"pad":"' + 'x'.repeat(65526) + '"}';   // = 64 KB total
  export function fn0() { http.post('http://checkout:8080/', body0, { headers: { 'Content-Type': 'application/json' } }); }
  // bodyKb unset → unchanged: posts JSON.stringify({ ping: true })
  ```
  Filler bytes = `bodyKb*1024 - 10` (the 10-byte JSON wrapper), clamped ≥ 0, so the
  total body is exactly `bodyKb` KB. (Compute it; don't hardcode per size.)

### 4. `src/compiler/index.ts` — resolve `bodyKb` + validate the cap

- In the k6 resolve block, pass each target's `bodyKb` (from `loadConfig.targets[i].bodyKb`)
  into the `K6Target`.
- In the load-targeting validation pass, when a target's `bodyKb` is defined:
  `(!Number.isInteger(bodyKb) || bodyKb < 1 || bodyKb > 1024)` →
  `{ nodeId, message: 'Body size must be a whole number 1–1024 KB' }` (fail loud).

### 5. `src/compiler/generators/nginx.ts` — raise the body limit (the 413 fix)

- `generateNginx` adds `client_max_body_size 2m;` inside the `server { … }` block
  (comfortably above the 1024 KB cap; nginx default is 1 MB = the cap exactly, which
  would 413 lb-path bodies near the cap before they reach a backend).
- Test (`nginx.test.ts`): the generated config contains `client_max_body_size 2m;`.

### 6. `web/src/store.ts` — `NodeConfig` fields

- `NodeConfig` gains `msPerKb?: number` and `loadBodyKb?: number`. `toGraph`/`loadExample`
  already pass `config` through. No `addNode` seed (both default off).

### 7. `web/src/Inspector.tsx` — two fields

- **service** block: a `payload sensitivity (ms/KB)` number input (`step=0.1`, `min=0`),
  editing `config.msPerKb`; inline red "Must be ≥ 0" when negative/non-numeric.
- **load section** (service/lb, shown when ⚡ on): a `body size (KB)` number input
  (`min=1`), editing `config.loadBodyKb`; inline red "Max body size is 1024 KB" when
  `> 1024` or not an integer ≥ 1. Empty → unset (default `{ping:true}`).
- A one-line hint under the body field: *"only bites a service with ms/KB > 0"* (the
  silent-no-op note).

### 8. `web/src/App.tsx` — carry `bodyKb` in the load request

- The `isLoadSource`/targets builder includes `bodyKb: n.data.config?.loadBodyKb` when
  set: `targets = sources.map(n => ({ nodeId, rate, ...(loadBodyKb ? { bodyKb: loadBodyKb } : {}) }))`.
- `api.load` already sends `{ durationSec, targets }`; the `targets` type gains optional
  `bodyKb`. No new endpoint.

### Results

No new column. The effect lands in the existing per-target `avg / p95 / peak` and
`dropped/s`. (No Drawer change.)

## Data flow

```
Inspector: service.msPerKb  → compose env MS_PER_KB (baked at Run, part of the stack)
Inspector: source.loadBodyKb → travels in /api/load targets[{nodeId,rate,bodyKb}]
  → compile(rec.graph, {durationSec,targets}) resolves bodyKb → K6Target
  → generateK6 posts an ≈N-KB constant body to the target
  → service receives n bytes → sleeps base + jitter + n/1024×msPerKb
  → higher avg/p95/peak for that target; at high rate → dropped/s (saturation)
LB source: nginx (client_max_body_size 2m) forwards the body to the round-robin'd
  backend → that backend reacts via its own msPerKb
```

## Error handling / edge cases

- **nginx 413 (fixed):** without `client_max_body_size 2m`, lb-path bodies near the
  1024 KB cap are rejected by nginx (default 1 MB) before reaching a backend — the
  fan-out demo would show errors, not latency. Component 5 fixes it.
- **Transport ≠ the knob (documented):** at large sizes (~1 MB × high rate) the added
  latency is dominated by docker-bridge transfer + nginx request-buffering, not
  `msPerKb`. The knob is legible at **16–128 KB**; keep demo sizes modest. Documented,
  not enforced.
- **Silent no-op (documented + hinted):** a source sending a big body to a receiver
  with `msPerKb = 0` does nothing visible. The Inspector hint and docs call this out;
  the source can't see its target's config statically, so no hard validation.
- **Cascade carries no body (documented limitation):** the `service → service`
  upstream cascade posts `http.NoBody` (`server.go:78` — "Body intentionally dropped").
  So `msPerKb` fires on **direct load** and on **LB-forwarded** traffic (nginx forwards
  the real body), but is **inert behind a `service → service` edge** — a
  `Checkout → Inventory` graph with `msPerKb` on Inventory shows nothing on the
  cascaded hop. Two paths reach a backend; only direct + LB carry payload. v1 documents
  this (CLAUDE.md + the Inspector hint's cousin). Forwarding a sized cascade body is a
  bigger, separate change (a new "cascade body size" knob) — out of scope.
- **Back-compat:** `MS_PER_KB` defaults to `"0"` (byte-identical sleep); `loadBodyKb`
  unset → `{"ping":true}`. The four bundled examples and existing smokes are unchanged.
- **Cap:** `bodyKb` 1–1024 and `msPerKb ≥ 0` are fail-loud at compile and inline in the
  Inspector. A constant body string ≤ 1 MB is a single allocation (no per-VU
  duplication), so it can't reproduce the VU-OOM.

## Testing

**Microservice (Go, `images/microservice/*_test.go`):**
- `config.go`: `MS_PER_KB` parses to `MsPerKb`; empty → 0; negative / non-numeric →
  error.
- `server.go`: `handleRoot` with `MsPerKb=1.0` and a ~10 KB body sleeps measurably
  longer than with an empty body; `MsPerKb=0` → body size makes no difference.

**Compiler (vitest, no Docker):**
- `service.test.ts`: `MS_PER_KB` emitted from `config.msPerKb`; default `"0"`;
  `validate` rejects `msPerKb < 0`.
- `k6.test.ts`: a target with `bodyKb: 64` → generated script builds an ≈64 KB constant
  and posts it; no `bodyKb` → posts `{ping:true}` (unchanged).
- `index.test.ts`: `bodyKb` of `0` / `2.5` / `2048` → fail-loud "1–1024 KB"; `64` → ok;
  resolved `K6Target.bodyKb` threads through.
- `nginx.test.ts`: generated config contains `client_max_body_size 2m;`.

**SPA (`web/src/*.test.tsx`):**
- `store`: `msPerKb` + `loadBodyKb` round-trip `toGraph`/`loadExample`.
- `Inspector`: service shows `ms/KB` (negative → red); source shows `body size (KB)`
  (`>1024` → red); kafka/worker/db show neither.
- `App`: a marked source with `loadBodyKb` set → `api.load` targets include `bodyKb`.

`npm test` + `npm run typecheck` clean; `npm --prefix web run test` + web `tsc` +
`build` clean; Go: `go test ./...` in `images/microservice`.

## Out of scope

- CPU work proportional to body (hashing/compute) — possible later toggle; v1 is
  latency-only.
- Static-paste and template/randomized bodies — dropped (sized-only keeps the metric
  clean).
- Forwarding a (sized) body on the `service → service` cascade — the cascade stays
  body-less in v1 (documented limitation above); a cascade-body knob is a separate brick.
- Content-type configuration — sized body is `application/json`.
- Response body sizing / download simulation; per-endpoint or per-method bodies.
- Surfacing transport cost separately from the per-KB sleep.

## Sequencing

Stacks on the per-service-load brick (needs `loadRate` + the load-request `targets`
path, both in `main`) and on **PR #29** (the VU cap + dropped/s + `generateK6` changes)
— land #29 first so this brick extends the post-#29 `generateK6` rather than colliding
with it.

## Likely task breakdown (for writing-plans)

1. **Microservice** — `MS_PER_KB` config + `nonNegFloat`; `server.go` byte-count →
   float-ms sleep; Go tests (TDD).
2. **Compiler service env + validate** — `MS_PER_KB` from `config.msPerKb`, `msPerKb ≥ 0`;
   `service.test.ts` (TDD); add `msPerKb`/`loadBodyKb` to compiler `NodeConfig`.
3. **Compiler k6 sized body + cap** — `K6Target.bodyKb`, sized-body generation,
   `LoadTarget.bodyKb`, `index.ts` resolve + 1–1024 validation; `k6.test.ts` +
   `index.test.ts` (TDD).
4. **nginx body limit** — `client_max_body_size 2m;` + `nginx.test.ts` (TDD).
5. **SPA store** — `msPerKb`/`loadBodyKb` on `NodeConfig` + `store.test.ts` (TDD).
6. **SPA Inspector** — `ms/KB` (service) + `body size (KB)` (source) fields + validation
   + no-op hint + `Inspector.test.tsx` (TDD).
7. **SPA App** — thread `bodyKb` into the `/api/load` targets + `App.test.tsx` (TDD);
   web build.
8. **Docs** — CLAUDE.md (image env-var APIs: `MS_PER_KB`; load body), README; note the
   transport-vs-knob caveat, the 16–128 KB sweet spot, and the **cascade-carries-no-body**
   limitation (`msPerKb` fires on direct + LB-forwarded traffic, not `service → service`).
