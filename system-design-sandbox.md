# System Design Sandbox

> Drag and drop services, set the load, and watch how the system really behaves — on your own machine, with real Docker.

**Status:** 🟡 Planning
**Last updated:** 2026-06-19

---

## Core idea

Learning system design usually stops at theory and static diagrams. This tool lets you **assemble an architecture with a drag-and-drop UI**, then press Run — the system actually spins up on your machine using Docker, takes real load, and you immediately see throughput, latency, bottlenecks, and where the SPOFs are.

Example: draw a Saga Pattern (3 services → Kafka → Worker → DB), set 10,000 req/s, press Run → watch what breaks first.

---

## Problems to solve

- Diagrams on paper say nothing about real behavior under load
- There's no easy way to experiment with "if I add Redis, how much does throughput go up?"
- Learning Saga / CQRS / 2PC is usually just reading blog posts, with no way to "see" it run
- Docker Compose is too verbose for quick experimentation

---

## High-level architecture

```
┌─────────────────────────────────────────────────┐
│               ELECTRON APP (UI)                 │
│  Visual Canvas │ Load Config │ Metrics Dashboard │
└──────────────────────┬──────────────────────────┘
                       │ graph JSON
┌──────────────────────▼──────────────────────────┐
│           ORCHESTRATION ENGINE (Node.js)        │
│  Graph Compiler │ Docker Controller │ k6 Runner │
│  Metrics Collector (Prometheus + WebSocket)     │
└──────────────────────┬──────────────────────────┘
                       │ Docker API (dockerode)
┌──────────────────────▼──────────────────────────┐
│              DOCKER RUNTIME                     │
│  [Kafka] [Redis] [Microservice×N] [Postgres]    │
│  [Nginx LB] [k6] [cAdvisor] [Prometheus]        │
│  ← isolated bridge network per experiment →     │
└─────────────────────────────────────────────────┘
```

---

## Main components

### 1. Visual Canvas
- Drag and drop service nodes from a palette
- Drag edges to connect services
- The compiler reads the graph and infers meaning from node type + edge direction:
  - `Service → Kafka` = publish
  - `Worker → Kafka` = subscribe
  - `LB → [Service, Service]` = round-robin upstream
- Built-in pattern templates: Saga, CQRS, LB Scaling, Event Sourcing

### 2. Graph Compiler
The brain of the system. Translates the visual graph → docker-compose config + nginx config + k6 script.

Example output for a Saga Pattern:
```yaml
# auto-generated — no need to write by hand
services:
  order-service:
    image: sds/microservice:latest
    environment:
      KAFKA_BROKER: kafka:9092
      PUBLISH_TOPIC: order.created
      LATENCY_MS: 20
  payment-service:
    image: sds/microservice:latest
    environment:
      KAFKA_BROKER: kafka:9092
      SUBSCRIBE_TOPIC: order.created
      PUBLISH_TOPIC: payment.processed
  kafka:
    image: bitnami/kafka:latest
  # ...
```

### 3. Pre-built Docker images

| UI node | Docker image | Notes |
|---------|-------------|-------|
| Microservice | `sds/microservice` (Go) | Configured via env vars: latency, error rate, upstream |
| Kafka | `bitnami/kafka` | Topics auto-created from edges |
| Redis | `redis:alpine` | Single or cluster |
| Database | `postgres:alpine` + pgBouncer | Connection pooling |
| Load Balancer | `nginx:alpine` | Upstream config auto-generated |
| Object Store | `minio/minio` | S3-compatible |
| API Gateway | `kong:alpine` | Rate limit, auth |
| Worker | `sds/worker` (Go) | Async consumer |

`sds/microservice` is a custom-built image — a Go binary ~5MB, cold start <100ms, taking all of its behavior from env vars.

### 4. Load Generator
- Runs k6 inside a Docker container
- Script auto-generated from the load config UI (req/s, duration, pattern)
- Supports: steady load, ramp-up, spike, soak test

```javascript
// auto-generated k6 script
import http from 'k6/http';
export const options = {
  scenarios: {
    main: {
      executor: 'constant-arrival-rate',
      rate: 10000, // from UI config
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 500,
    },
  },
};
export default function () {
  http.post('http://api-gateway:8080/order', JSON.stringify({ item: 'book' }));
}
```

### 5. Monitoring sidecar
- **cAdvisor**: container-level CPU, memory, network I/O
- **Prometheus**: scrapes all containers
- **WebSocket bridge**: pushes metrics from Prometheus → Electron → UI
- Shows per-node metrics right on the canvas (small badge under each node)

---

## Tech stack

| Layer | Tech | Why |
|-------|------|-----|
| Desktop shell | Electron | Direct access to the Docker socket, cross-platform |
| UI framework | React + React Flow | React Flow is purpose-built for node graphs |
| Styling | Tailwind CSS | Fast |
| Docker integration | dockerode (npm) | Docker API from Node.js |
| Custom service image | Go | Small binary, fast cold start, easy to cross-compile |
| Load generator | k6 | JS scripting, ready-made Docker image, built-in metrics |
| Metrics scraping | Prometheus + cAdvisor | Battle-tested, ready-made Docker images |
| State management | Zustand | Lighter than Redux for this use case |
| Realtime | WebSocket (ws npm) | Push metrics from main process → renderer |

---

## Roadmap

### Phase 1 — MVP (local, core flow)
- [ ] Electron app boilerplate + React Flow canvas
- [ ] Palette: 6 basic node types (Service, Kafka, Redis, DB, LB, Client)
- [ ] Edge drawing + edge type inferred from node type
- [ ] Graph Compiler: graph JSON → docker-compose
- [ ] dockerode integration: spin up / tear down
- [ ] `sds/microservice` Go image v1 (HTTP server, configurable latency/error)
- [ ] k6 container + auto-generated script
- [ ] Basic metrics dashboard (throughput, latency, per-container CPU/mem)
- [ ] Pattern templates: Saga, LB Scaling

### Phase 2 — Richer simulation
- [ ] `sds/worker` image (Kafka consumer)
- [ ] Kong API Gateway image + auto-config
- [ ] 2PC simulation (coordinator service)
- [ ] Chaos controls: kill container, throttle CPU, inject network delay
- [ ] Automatic bottleneck highlighting on the canvas
- [ ] Pattern templates: CQRS, Event Sourcing, Circuit Breaker

### Phase 3 — Share & learn
- [ ] Export architecture → real docker-compose.yml (usable in production)
- [ ] Save/load experiment JSON
- [ ] Share link (encode the architecture in a URL)
- [ ] Annotation layer: add notes on the diagram
- [ ] Bundled scenarios with explanations (e.g., "Why is the DB the bottleneck?")

### Phase 4 — Advanced
- [ ] Multi-node Kafka cluster
- [ ] Read-replica Postgres + replication-lag simulation
- [ ] Service mesh (Istio-lite) visualization
- [ ] Distributed tracing (OpenTelemetry)
- [ ] Web version (WebContainers or remote Docker host)

---

## Technical points to solve

### Graph Compiler — rule engine
The most complex piece. Needs clear definitions for:
- What each edge type means (A→B, where A and B are which types)
- How to resolve conflicts (Service → Kafka AND Service → DB?)
- Naming convention for containers in the Docker network

### `sds/microservice` env var API
Needs careful design to be flexible enough:
```
LATENCY_MS=20           # avg latency
LATENCY_JITTER_MS=5     # jitter
ERROR_RATE=0.01         # 1% error
KAFKA_BROKER=kafka:9092
PUBLISH_TOPIC=order.created
SUBSCRIBE_TOPICS=payment.processed,inventory.reserved
UPSTREAM_HTTP=http://db-service:8080
DB_URL=postgres://...
REDIS_URL=redis://redis:6379
```

### Metrics mapping
Need to map Prometheus metrics → meaning in the UI:
- `container_cpu_usage_seconds_total` → % CPU per node
- k6 output (`http_req_duration`, `http_reqs`) → throughput/latency overlay
- Custom `/metrics` endpoint in `sds/microservice` → business metrics

### Cold start & timing
Kafka needs ~5-10s to be ready. Need:
- A health-check loop before letting k6 fire load
- UI showing a "Warming up..." state
- Clear timeout and error handling

---

## Open questions

- Is a web version feasible? (WebContainers only runs Node, not Kafka/Postgres)
  → More realistic direction: connect to a remote Docker host over SSH
- Should we support Podman? (rootless, popular on Linux)
- Pricing model if productized: free for N nodes, pay for advanced patterns?
- Project name: **ArchLab**? **SysSim**? **DesignBench**?

---

## References

- [React Flow docs](https://reactflow.dev)
- [dockerode](https://github.com/apocas/dockerode)
- [k6 Docker image](https://hub.docker.com/r/grafana/k6)
- [cAdvisor](https://github.com/google/cadvisor)
- [bitnami/kafka](https://hub.docker.com/r/bitnami/kafka)
- Inspiration: [Excalidraw](https://excalidraw.com) (UX), [Diagrams.net](https://draw.io) (patterns), [Chaos Monkey](https://github.com/Netflix/chaosmonkey) (chaos testing)

---

## Log

| Date | Notes |
|------|-------|
| 2026-06-19 | Created the idea, drew the high-level architecture, settled the tech stack |
