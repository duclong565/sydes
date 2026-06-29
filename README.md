# SysDes — System Design Sandbox

Draw a service architecture. Press Run. Watch real Docker containers spin up under load.

SysDes lets you drag-and-drop system components onto a canvas, wire them together, and run them as real Docker containers — load-tested with k6, with live status and logs. It runs as a **local agent + browser UI**: a small Node process drives Docker on your machine while a React app in the browser is the canvas.

## What it does

- **Visual canvas** — drag Service, Kafka, Worker, DB, and Load Balancer nodes; draw edges to define topology.
- **Graph Compiler** — translates your diagram into a `docker-compose.yml` (+ nginx config + k6 load script).
- **Real Docker runtime** — containers spin up in an isolated bridge network; the Saga chain (service → Kafka → worker → Postgres) runs end-to-end.
- **Run UX** — Preview the compiled compose, Run (with a "Warming up…" state for Kafka cold start), watch per-service status, and tail container logs.
- **Live metrics** — per-node CPU/memory badges stream onto the canvas over a WebSocket while the run is live, plus per-DB write counts and a Metrics drawer table. Toggle **⚡ Load source** on any service/LB node in the Inspector to give it a rate (a ⚡N/s chip appears on the node); set a global duration and press **Run load** to fire k6 at every marked source at once — the Metrics drawer shows per-target achieved vs target RPS and dropped iterations, with saturated targets highlighted.

## Architecture

Browser SPA ⇄ HTTP/JSON ⇄ local Node **agent** (Fastify) ⇄ Docker. The agent wraps the engine (compiler + controller + k6 runner + metrics) because driving Docker needs local socket/subprocess/filesystem access a browser can't have. (Originally planned as Electron; switched to agent + SPA — lower friction and hybrid-ready.)

## Stack

| Layer | Tech |
|-------|------|
| Browser SPA | React + React Flow + Tailwind + Zustand (`web/`) |
| Local agent | Fastify (`src/agent/`) |
| Engine | TypeScript — Graph Compiler, Docker Controller, k6 Runner, Metrics Collector |
| Docker integration | dockerode + `docker compose` CLI |
| Service images | Go (`sds/microservice`, `sds/worker`) |
| Load generation | k6 |
| Metrics | dockerode `container.stats` (CPU/mem) + per-DB writes, streamed over a `@fastify/websocket` channel |

## Quick start

```bash
# 1. Build the Go service images (once)
docker build -t sds/microservice ./images/microservice
docker build -t sds/worker ./images/worker

# 2. Install deps (root engine/agent + the web SPA package)
npm install
npm --prefix web install

# 3. Run the agent + SPA together (Vite proxies /api → the agent on :8787)
npm run dev
# open the printed Vite URL, build a graph (or Load an example), press Run

# Or drive an experiment from the CLI:
npm run sim examples/saga.json --load --metrics
```

## Status

🟢 **Working end-to-end.** The engine (Graph Compiler → Docker → k6 → metrics) and both Go images are complete, and the Saga chain runs end-to-end. The full UI epic is in: canvas, palette, inspector, run/teardown UX + Logs drawer, and **live per-node metric badges over WebSocket** (Metrics drawer). Recent additions: edge-legality validation, service→service cascades, DB write-visibility, a Kafka partitions field, and **per-service load targeting** (mark any service/LB node with a rate, run k6, get per-target results). Next up is post-epic packaging — cloud SPA hosting + WebSocket relay + `npx sds-agent`.

## Docs

- Project guidance: [`CLAUDE.md`](CLAUDE.md)
- Graph Compiler PRD: [`docs/prd/2026-06-19-graph-compiler.md`](docs/prd/2026-06-19-graph-compiler.md)
- Per-brick design specs + implementation plans: [`docs/superpowers/specs/`](docs/superpowers/specs/) and [`docs/superpowers/plans/`](docs/superpowers/plans/)
