# SysDes — System Design Sandbox

Draw a service architecture. Press Run. Watch real Docker containers spin up under load.

SysDes lets you drag-and-drop system components onto a canvas, wire them together, and run them as real Docker containers — load-tested with k6, with live status and logs. It runs as a **local agent + browser UI**: a small Node process drives Docker on your machine while a React app in the browser is the canvas.

## What it does

- **Visual canvas** — drag Service, Kafka, Worker, DB, and Load Balancer nodes; draw edges to define topology.
- **Graph Compiler** — translates your diagram into a `docker-compose.yml` (+ nginx config + k6 load script).
- **Real Docker runtime** — containers spin up in an isolated bridge network; the Saga chain (service → Kafka → worker → Postgres) runs end-to-end.
- **Run UX** — Preview the compiled compose, Run (with a "Warming up…" state for Kafka cold start), watch per-service status, and tail container logs.
- *Coming next:* live CPU/memory + throughput/latency badges overlaid on the canvas.

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
| Metrics | dockerode `container.stats` (CPU/mem) |

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

🟢 **Working end-to-end.** The engine (Graph Compiler → Docker → k6 → metrics) and both Go images are complete, and the Saga chain runs end-to-end. The UI is built up through **run/teardown UX + logs** (canvas, palette, inspector, run controls, status + Logs drawer); **live metric badges over WebSocket are next**.

## Docs

- Project guidance: [`CLAUDE.md`](CLAUDE.md)
- Graph Compiler PRD: [`docs/prd/2026-06-19-graph-compiler.md`](docs/prd/2026-06-19-graph-compiler.md)
- Per-brick design specs + implementation plans: [`docs/superpowers/specs/`](docs/superpowers/specs/) and [`docs/superpowers/plans/`](docs/superpowers/plans/)
