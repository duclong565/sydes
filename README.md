# SysDes — System Design Sandbox

Draw a service architecture. Press Run. Watch it break under real load.

SysDes is an Electron desktop app that lets engineers drag-and-drop system components onto a canvas, wire them together, and spin up real Docker containers — load-tested with k6, monitored with Prometheus.

## What it does

- **Visual canvas** — drag Service, Kafka, Worker, DB, and Load Balancer nodes; draw edges to define topology
- **Graph Compiler** — translates your diagram into a `docker-compose.yml` + nginx config + k6 load script
- **Real Docker runtime** — containers spin up in an isolated bridge network; no manual YAML required
- **Live metrics** — CPU, memory, throughput, and latency overlaid on the canvas as load runs

## Stack

| Layer | Tech |
|-------|------|
| Desktop | Electron |
| UI | React + React Flow + Tailwind CSS |
| State | Zustand |
| Docker integration | dockerode |
| Service images | Go (`sds/microservice`, `sds/worker`) |
| Load generation | k6 |
| Metrics | Prometheus + cAdvisor |

## Status

🟡 **Planning** — architecture designed, implementation starting.

See [`docs/prd/2026-06-19-graph-compiler.md`](docs/prd/2026-06-19-graph-compiler.md) for the Graph Compiler spec.
