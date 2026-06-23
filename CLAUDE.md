# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**System Design Sandbox (sydes)** — drag-and-drop system-architecture simulation. Users wire services visually, press Run, and real Docker containers spin up under k6 load with live per-service status/logs.

Status: 🟢 **Engine complete; UI in progress.** The orchestration engine + two Go images are done and merged. The UI is being built as an **agent + browser SPA** (not Electron — see Architecture): bricks 1–3 (agent HTTP API, React Flow canvas, run/teardown UX + logs) are merged; brick 4 (live metric badges over WebSocket) is next.

## Architecture

**Agent-first, local-only, hybrid-ready** (this replaced the original Electron plan). The engine needs the local Docker socket + subprocesses + filesystem, which a browser can't touch — so a local Node **agent** wraps the engine and exposes it over HTTP+JSON to a browser SPA.

```
web/  — browser SPA (React + React Flow canvas + Tailwind + Zustand)
   │  HTTP + JSON   (dev: Vite :5173 proxies /api → agent :8787)
src/agent/  — Fastify "sds-agent" wrapping the engine
   │  in-process calls
src/engine/ + src/compiler/  — the orchestration engine:
   - Graph Compiler (src/compiler): graph JSON → docker-compose (+ nginx + k6)
   - Docker Controller (src/engine/controller.ts): docker compose up/down/ps/logs via a Runner seam
   - k6 Runner (src/engine/k6-runner.ts): one-shot grafana/k6 load run
   - Metrics Collector (src/engine/metrics.ts): dockerode container.stats → CPU%/mem
   - sim CLI (src/engine/cli.ts): run an experiment from the terminal
   │  dockerode + `docker compose` CLI
Docker runtime (isolated bridge network per experiment)
   apache/kafka (KRaft), postgres, nginx LB, grafana/k6
   + sds/microservice (Go), sds/worker (Go)
```

**Hybrid future (NOT built):** the SPA could be cloud-hosted and reach a local `npx sds-agent` through a WebSocket relay + token pairing. The transport boundary (HTTP+JSON, injectable `buildServer(deps)`) is kept clean for this; nothing cloud exists yet.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Browser SPA | React + React Flow (`@xyflow/react`) + Tailwind v4 + Zustand (in `web/`, its own package) |
| Local agent | Fastify (`src/agent/`), runs via `tsx` |
| Engine | TypeScript (ESM, Node) — compiler + controller + k6 runner + metrics |
| Docker integration | dockerode + `docker compose` CLI (spawned via a `Runner` seam) |
| Custom service images | Go (scratch, `CGO_ENABLED=0`) — `sds/microservice`, `sds/worker` |
| Load generator | k6 (one-shot `grafana/k6` container) |
| Metrics | dockerode `container.stats` (CPU%/mem). **No Prometheus/cAdvisor.** WebSocket streaming to the canvas is brick 4 (not yet built). |
| Tests | vitest (root engine/agent + `web/`), gated real-Docker smokes |

## Repo Layout

- `src/compiler/` — Graph Compiler (`compile(graph, load?)` → `{compose, nginx?, k6?}`), node handlers + generators.
- `src/engine/` — `ExperimentController`, `K6Runner`, `MetricsCollector`, `Runner` seam, `sim` CLI.
- `src/agent/` — Fastify `buildServer(deps)` + run lifecycle (in-memory `RunStore`).
- `web/` — Vite/React SPA (separate `package.json`).
- `images/microservice`, `images/worker` — Go images.
- `examples/` — bundled graph JSON (saga, saga-db, lb-scaling, service-pair).
- `docs/superpowers/{specs,plans}/`, `docs/prd/` — design specs + implementation plans (per brick).

## Graph Compiler — Core Logic

Reads a graph JSON (nodes + typed edges) and emits:
- `docker-compose.yml` — services, env vars, healthchecks, network.
- `nginx.conf` — upstream config for LB nodes.
- k6 script — load pattern (only when a load config is supplied).

Node types: `service | kafka | worker | db | lb` (no Redis node).

**Edge semantics** (inferred from source+target node types):
- `Service → Kafka` = publish (`PUBLISH_TOPIC` + `KAFKA_BROKER`)
- `Worker → Kafka` = subscribe (`SUBSCRIBE_TOPICS` + `KAFKA_BROKER`)
- `LB → [Service, Service]` = round-robin nginx upstream
- `Service → DB` / `Worker → DB` = sets `DB_URL` (a full DSN: `postgres://postgres:sds@<slug>:5432/postgres?sslmode=disable`). The **worker** persists to it (pgx); the microservice does not read it.

The compiler fails loud — it refuses to generate and reports clear errors rather than emitting best-effort output.

## Image Env-Var APIs

`sds/microservice` (Go HTTP sim) — reads: `PORT, LATENCY_MS, LATENCY_JITTER_MS, ERROR_RATE, UPSTREAM_HTTP, KAFKA_BROKER, PUBLISH_TOPIC`. Exposes `/metrics` (Prometheus text) + `/health`; handles HTTP, optional upstream cascade, optional Kafka publish.

`sds/worker` (Go consumer) — reads: `PORT, LATENCY_MS, LATENCY_JITTER_MS, ERROR_RATE, KAFKA_BROKER, SUBSCRIBE_TOPICS, DB_URL`. Consumes a Kafka consumer group, simulates work, persists to postgres via pgx (on the ok path); `/health` + `/metrics`.

## Agent HTTP API (`src/agent/`)

`GET /api/examples` · `POST /api/compile` (preview) · `POST /api/run` (async → `runId`, runs in background) · `GET /api/status/:runId` (poll) · `POST /api/stop` · `GET /api/logs/:runId`. Built via `buildServer(deps)` with the engine `Runner` injected (a `FakeRunner` is used in tests, so the whole agent is testable without Docker).

## Key Technical Constraints

- **Kafka cold start ~10–30s**: the kafka healthcheck blocks `docker compose up --wait` until the subscriber consumer group registers. The SPA shows a "Warming up…" run-state while the agent run is `starting`.
- **apache/kafka:3.7.2** (NOT `latest`/4.x — 4.x breaks kafka-go v0.4.51 consumer groups); KRaft single-node env.
- **Isolated networks**: each experiment gets its own Docker bridge network; container names are the DNS hostnames. Compose network name is doubled: `sds-<id>_sds-<id>-net`.
- **Go not on PATH** in this env: prefix Go commands with `export PATH="$PATH:/usr/local/go/bin"`. Worker module is `go 1.25` (pgx); microservice `go 1.23`.
- **Metrics mapping (brick 4)**: `container.stats` CPU%/mem → per-node badges; k6 `http_req_duration`/`http_reqs` → throughput/latency overlay.

## Commands

```bash
npm test                 # engine + agent unit tests (vitest; gated Docker smokes skip)
npm run typecheck        # tsc --noEmit (root)
npm run sim <graph.json> [--load --metrics --keep]   # run an experiment from the CLI
npm run dev              # agent (tsx watch) + Vite SPA together (Vite proxies /api → :8787)
npm run agent:dev        # just the agent on :8787
npm --prefix web run test    # SPA component tests (RTL)
npm --prefix web run build   # build the SPA → web/dist (agent serves it when present)
docker build -t sds/microservice ./images/microservice
docker build -t sds/worker ./images/worker
RUN_DOCKER=1 npx vitest run <file>.smoke.test.ts     # gated real-Docker smokes
```

## Workflow & Conventions

- Per-brick flow: `superpowers:brainstorming` → spec (`docs/superpowers/specs/`) → `superpowers:writing-plans` → plan (`docs/superpowers/plans/`) → `superpowers:subagent-driven-development` → `superpowers:finishing-a-development-branch`. Branch per brick off `main`, one PR.
- **NEVER add a `Co-Authored-By` trailer to commits** (user preference). PR bodies end with the Claude Code footer; commit messages do not.
- Seam/DI everywhere: `Runner` (subprocess), `Publisher`/`Consumer`/`Sink`/`StatsSource`/`RandSource` are injected interfaces with a real impl + a fake for tests. Go images are scratch-static, pure-Go.
- Gated Docker smokes: `describe.skipIf(!process.env.RUN_DOCKER)`; default `npm test` skips them.

## Roadmap

- ✅ Engine: Graph Compiler, Docker Controller, LB routing, k6 Runner, Metrics Collector, Go images, Saga (kafka→worker→postgres) chain, robustness cleanup.
- ✅ UI epic bricks 1–3: agent HTTP API + SPA shell; React Flow canvas → graph JSON; run/teardown UX + warmup + Logs tab.
- ⬜ UI brick 4: live per-node metric badges over WebSocket (Metrics drawer tab) — consumes the engine's `container.stats`; adds the project's first WebSocket.
- ⬜ Post-epic: cloud SPA hosting + WebSocket relay + token pairing + `npx sds-agent` packaging.
