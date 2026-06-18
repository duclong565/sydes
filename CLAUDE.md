# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**System Design Sandbox** — Electron desktop app for drag-and-drop system architecture simulation. Users wire services visually, press Run, and real Docker containers spin up under load. See `system-design-sandbox.md` for full planning doc.

Status: 🟡 Planning — no code exists yet.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Desktop shell | Electron |
| UI | React + React Flow (node graph) + Tailwind CSS |
| State | Zustand |
| Docker integration | dockerode (npm) |
| Custom service images | Go (binary ~5MB, cold start <100ms) |
| Load generator | k6 (runs in Docker) |
| Metrics | Prometheus + cAdvisor + WebSocket bridge |

## Architecture

Three layers communicating top-down:

```
Electron Renderer (React canvas + dashboard)
        ↕ IPC
Electron Main / Orchestration Engine (Node.js)
  - Graph Compiler: graph JSON → docker-compose + nginx + k6 script
  - Docker Controller: dockerode spin up/tear down
  - k6 Runner: generate & launch load scripts
  - Metrics Collector: Prometheus scrape → WebSocket → renderer
        ↕ Docker API (dockerode)
Docker Runtime (isolated bridge network per experiment)
  Kafka, Redis, Postgres, Nginx LB, k6, cAdvisor, Prometheus
  + sds/microservice (Go), sds/worker (Go)
```

## Graph Compiler — Core Logic

The compiler is the most complex piece. It reads a graph JSON (nodes + typed edges) and emits:
- `docker-compose.yml` — services, env vars, network
- `nginx.conf` — upstream config for LB nodes
- k6 script — load pattern from UI config

**Edge semantics** (inferred from source+target node types):
- `Service → Kafka` = publish (`PUBLISH_TOPIC`)
- `Worker → Kafka` = subscribe (`SUBSCRIBE_TOPICS`)
- `LB → [Service, Service]` = round-robin upstream
- `Service → DB` = sets `DB_URL`
- `Service → Redis` = sets `REDIS_URL`

## `sds/microservice` Env Var API

The Go microservice image configures all behavior via env:
```
LATENCY_MS, LATENCY_JITTER_MS, ERROR_RATE
KAFKA_BROKER, PUBLISH_TOPIC, SUBSCRIBE_TOPICS
UPSTREAM_HTTP, DB_URL, REDIS_URL
```

Exposes `/metrics` (Prometheus) and handles HTTP POST traffic.

## Key Technical Constraints

- **Kafka cold start**: ~5-10s. Must health-check loop before k6 fires load. UI shows "Warming up..." state.
- **Isolated networks**: each experiment gets its own Docker bridge network — container names are the DNS hostnames.
- **Metrics mapping**: `container_cpu_usage_seconds_total` → per-node CPU badge; k6 `http_req_duration` / `http_reqs` → throughput/latency overlay on canvas.

## Planned Commands (once scaffolded)

```bash
npm run dev          # Electron dev mode (hot reload)
npm run build        # Package Electron app
npm test             # Unit tests
docker build -t sds/microservice ./images/microservice   # Build Go service image
docker build -t sds/worker ./images/worker               # Build Go worker image
```

## Roadmap Phase 1 (MVP)

Electron boilerplate → React Flow canvas → Graph Compiler → dockerode integration → `sds/microservice` Go image → k6 runner → basic metrics dashboard → Saga + LB Scaling templates.
