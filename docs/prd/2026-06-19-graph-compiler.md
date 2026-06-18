# PRD: Graph Compiler — Phase 1 MVP

**Status:** Ready for implementation  
**Date:** 2026-06-19  
**Label:** `ready-for-agent`

---

## Problem Statement

Engineers who want to stress-test a system architecture before committing to it have no fast feedback loop. Writing Docker Compose files by hand is verbose, error-prone, and disconnected from architectural thinking. There is no tool that lets an engineer draw a service graph and immediately get a runnable, load-tested Docker environment from it.

---

## Solution

A Graph Compiler that takes a visual graph (typed nodes + directed edges) and deterministically produces a runnable `docker-compose.yml`, an `nginx.conf` (when load balancers are present), and a k6 load test script (when a load config is provided). It validates the graph strictly and fails loudly with actionable errors rather than producing broken output.

---

## User Stories

1. As an engineer, I want to draw a Saga Pattern (3 services + Kafka + Worker + DB), click Compile, and get a working docker-compose.yml, so that I can spin it up without writing any YAML manually.
2. As an engineer, I want the compiler to tell me every error in my graph at once, so that I can fix them all in one pass without re-running repeatedly.
3. As an engineer, I want a load balancer node that automatically generates the correct nginx upstream config, so that I don't have to understand nginx syntax to test horizontal scaling.
4. As an engineer, I want Worker nodes to automatically subscribe to their connected Kafka topics, so that the wiring is inferred from the graph structure.
5. As an engineer, I want a k6 load test script auto-generated from my load config, so that I can start shooting traffic without writing k6 scripting.
6. As an engineer, I want the compiler to detect the correct entry point (LB if present, else first Service) for k6, so that load is directed correctly without manual configuration.
7. As an engineer, I want Service nodes to automatically receive DB connection strings based on their edges, so that I can connect services to databases by drawing an arrow.
8. As an engineer, I want container names to be derived from node labels, so that I can identify containers in Docker output by names that match my architecture diagram.
9. As an engineer, I want to receive a clear error when a load balancer has fewer than 2 upstream services, so that I understand why the graph is invalid.
10. As an engineer, I want to receive a clear error when a Worker node has no Kafka subscription edge, so that I am not silently given a broken consumer.
11. As an engineer, I want to receive a clear error when a Kafka node has no publishers or no subscribers, so that I know my message bus is not wired into the graph.
12. As an engineer, I want to receive a clear error when two nodes have the same label, so that container name collisions are caught before runtime.
13. As an engineer, I want isolated Docker bridge networks per experiment, so that concurrent experiments do not interfere with each other.
14. As an engineer, I want the same graph to always produce the same output, so that I can version-control the compiled artifacts.
15. As an engineer, I want the compiler output to be usable immediately with `docker compose up`, with no manual editing required for standard topologies.

---

## Implementation Decisions

### Compiler is a pure function
`compile(graph: Graph): CompilerResult` — no I/O, no side effects. All file writing and Docker interaction is the responsibility of the orchestration layer above. This makes the compiler trivially testable and reusable.

### Two-pass execution
Pass 1 is a full validation sweep that collects **all** errors before returning. Pass 2 (code generation) only runs if errors are empty. This ensures the user sees every problem in one shot.

### Node-owned handler model
Each node type implements a `NodeHandler` interface with two methods: `validate` and `compile`. The compiler iterates nodes and delegates to the correct handler. Adding a new node type requires only a new handler file — no changes to existing handlers or the compiler core.

```typescript
// Decision-encoding shape (from design session):
interface NodeHandler {
  validate(node: GraphNode, inEdges: GraphEdge[], outEdges: GraphEdge[], allNodes: Map<string, GraphNode>): CompilerError[];
  compile(node: GraphNode, inEdges: GraphEdge[], outEdges: GraphEdge[], allNodes: Map<string, GraphNode>): ComposeService;
}

type CompilerResult =
  | { ok: true;  output: { compose: string; nginx?: string; k6?: string } }
  | { ok: false; errors: Array<{ nodeId: string; message: string }> }
```

### Phase 1 node types
Five types: `service`, `kafka`, `worker`, `db`, `lb`. All map to pre-built `sds/*` Docker images. Custom image override is out of scope for Phase 1.

### Edge semantics (inferred, not explicit)
The compiler infers meaning from the combination of source and target node types — edges carry no explicit type label:

| Source | Target | Inferred meaning | Emitted config |
|--------|--------|-----------------|----------------|
| service | kafka | publish | `PUBLISH_TOPIC=<kafka-label>` |
| worker | kafka | subscribe | `SUBSCRIBE_TOPICS=<kafka-label>` |
| service/worker | db | persistence | `DB_URL=postgres://<db-label>:5432` |
| lb | service | upstream | nginx `upstream` block entry |

### Naming convention
`node.label` → lowercase, spaces to hyphens → Docker container name and DNS hostname within the experiment network. Uniqueness is enforced during validation. Network name: `sds-<experimentId>-net`.

### k6 entry point auto-detection
If ≥1 LB node exists, k6 targets the LB's exposed port. Otherwise it targets the first Service node. No user configuration needed for standard topologies.

### Artifact generation is independent per output type
`compose.ts`, `nginx.ts`, and `k6.ts` are separate generators that each receive the compiled service list. They are independently replaceable.

---

## Testing Decisions

**What makes a good test:** test external behavior through the public `compile()` function. Do not test internal handler methods or intermediate data structures directly — those are implementation details. A test should describe a valid or invalid graph and assert on the final `CompilerResult`.

**Modules to test:**

- `compile()` — primary integration seam. Test full valid graphs (Saga, LB scaling) and assert the compose output contains correct service names, environment variables, and network config.
- `compile()` — validation path. Test each invalid graph condition (LB with 1 upstream, orphan service, Kafka with no subscriber, duplicate labels) and assert the correct error is returned.
- `generateCompose()` — unit test the YAML serializer with a known `ComposeService[]` fixture. Assert structure is valid YAML and matches expected shape.
- `generateNginx()` — unit test with a known upstream list, assert correct nginx upstream block format.

**Prior art:** No existing tests in the codebase yet. First tests should establish the pattern for future node types.

---

## Out of Scope

- Custom Docker image per node (Phase 2 — bring-your-own image)
- Redis, API Gateway, Object Store node types (Phase 2)
- Chaos controls (kill container, CPU throttle, network delay)
- Real-time metrics overlay on canvas
- Export to production-ready docker-compose (Phase 3)
- Multiple instances of the same node type with automatic port allocation
- Advanced nginx configuration (timeouts, health checks, sticky sessions)
- Kafka topic naming UI (topics are implicit from node labels in Phase 1)
- Web version / remote Docker host support

---

## Further Notes

- Kafka requires ~5-10s to become ready. The orchestration layer (not the compiler) is responsible for health-check polling before k6 fires load. The compiler should annotate Kafka services with `healthcheck` config in the compose output to make this easy for the orchestration layer.
- The `ComposeService` intermediate type is the key extension point for Phase 2 custom images — the `image` field should be designed to be overridable even in Phase 1.
- Two nodes with the same label is a validation error, not a feature. The duplicate-label check must run before all other validation to avoid confusing downstream errors.
