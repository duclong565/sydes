# Compiler Kafka Wiring (Saga brick 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Saga-shaped graph bootable + connectable — emit a complete single-node KRaft config on the kafka service (so bitnami/kafka starts) and `KAFKA_BROKER=<kafka>:9092` on service/worker nodes (so they connect).

**Architecture:** Three compiler handler edits, unit-tested on the emitted compose env. Compiler-only (TS) — no Go, no Docker. The real Kafka boot + producer→consumer round-trip is validated in brick 2b (a kafka node only compiles with a worker subscriber, and `sds/worker` does not exist yet).

**Tech Stack:** TypeScript (ESM), Vitest.

## Global Constraints

- kafka handler emits the full single-node KRaft env (8 `KAFKA_CFG_*` keys, exact values below); the existing healthcheck is unchanged.
- The broker address everywhere is `<kafka-slug>:9092` (matching the kafka handler's advertised PLAINTEXT listener `PLAINTEXT://<name>:9092`).
- `KAFKA_BROKER` is emitted ONLY on an edge into a kafka node (service→kafka / worker→kafka). Non-kafka graphs (LB, single-service, service→db) emit no new env and stay byte-identical.
- Compiler determinism preserved: emit in the existing iteration/key order; no sorting.
- Compiler-only; no images, no Docker, no Go. `.js` import specifiers. **No `Co-Authored-By` trailer in commits.**
- Run tests with the project script: `npm test -- <file>` (vitest).

---

### Task 1: kafka handler — full KRaft config

**Files:**
- Modify: `src/compiler/handlers/kafka.ts`
- Test: `src/compiler/handlers/kafka.test.ts`

**Interfaces:**
- Consumes: `slugify` from `../util.js`; `NodeHandler` from `../types.js`.
- Produces: `kafkaHandler.compile` emits all eight `KAFKA_CFG_*` env keys (listeners, advertised listeners, controller quorum, etc.) using the node's slug as the broker hostname.

- [ ] **Step 1: Write the failing test**

Append to `src/compiler/handlers/kafka.test.ts`:
```typescript
describe('kafkaHandler.compile KRaft config', () => {
  it('emits a single-node KRaft listener config', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'k', type: 'kafka', label: 'Event Bus' }], edges: [] };
    const env = kafkaHandler.compile(g.nodes[0]!, buildIndex(g)).environment;
    expect(env.KAFKA_CFG_NODE_ID).toBe('0');
    expect(env.KAFKA_CFG_PROCESS_ROLES).toBe('controller,broker');
    expect(env.KAFKA_CFG_CONTROLLER_QUORUM_VOTERS).toBe('0@event-bus:9093');
    expect(env.KAFKA_CFG_LISTENERS).toBe('PLAINTEXT://:9092,CONTROLLER://:9093');
    expect(env.KAFKA_CFG_ADVERTISED_LISTENERS).toBe('PLAINTEXT://event-bus:9092');
    expect(env.KAFKA_CFG_CONTROLLER_LISTENER_NAMES).toBe('CONTROLLER');
    expect(env.KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP).toBe('CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT');
    expect(env.KAFKA_CFG_INTER_BROKER_LISTENER_NAME).toBe('PLAINTEXT');
  });
});
```

> Note: `kafka.test.ts` already imports `describe`/`it`/`expect`, `kafkaHandler`, `buildIndex`, and the `Graph` type. Reuse the existing imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/compiler/handlers/kafka.test.ts`
Expected: FAIL — `KAFKA_CFG_CONTROLLER_QUORUM_VOTERS` (and the other new keys) are `undefined`.

- [ ] **Step 3: Write minimal implementation**

Replace the `compile` method in `src/compiler/handlers/kafka.ts` with:
```typescript
  compile(node) {
    const name = slugify(node.label);
    return {
      name,
      image: 'bitnami/kafka:latest',
      environment: {
        KAFKA_CFG_NODE_ID: '0',
        KAFKA_CFG_PROCESS_ROLES: 'controller,broker',
        KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: `0@${name}:9093`,
        KAFKA_CFG_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
        KAFKA_CFG_ADVERTISED_LISTENERS: `PLAINTEXT://${name}:9092`,
        KAFKA_CFG_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
        KAFKA_CFG_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      },
      healthcheck: {
        test: ['CMD-SHELL', 'kafka-topics.sh --bootstrap-server localhost:9092 --list || exit 1'],
        interval: '5s',
        timeout: '5s',
        retries: 10,
      },
    };
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/compiler/handlers/kafka.test.ts`
Expected: PASS — KRaft env test green; the existing kafka handler tests (name/image/healthcheck) still green.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/handlers/kafka.ts src/compiler/handlers/kafka.test.ts
git commit -m "feat: emit single-node KRaft config for kafka service"
```

---

### Task 2: service + worker handlers — `KAFKA_BROKER`

**Files:**
- Modify: `src/compiler/handlers/service.ts`
- Modify: `src/compiler/handlers/worker.ts`
- Test: `src/compiler/handlers/service.test.ts`
- Test: `src/compiler/handlers/worker.test.ts`
- Test: `src/compiler/index.test.ts`

**Interfaces:**
- Consumes: `slugify`; `kafkaHandler` KRaft env (Task 1); `compile` from `../index.js`.
- Produces: `serviceHandler.compile` emits `KAFKA_BROKER=<slug>:9092` alongside `PUBLISH_TOPIC` on a service→kafka edge; `workerHandler.compile` emits `KAFKA_BROKER=<slug>:9092` alongside `SUBSCRIBE_TOPICS` on a worker→kafka edge.

- [ ] **Step 1: Write the failing tests**

Append to `src/compiler/handlers/service.test.ts`:
```typescript
describe('serviceHandler.compile kafka broker', () => {
  it('emits KAFKA_BROKER on a service->kafka edge', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 's', type: 'service', label: 'Order' },
        { id: 'k', type: 'kafka', label: 'Events' },
      ],
      edges: [{ source: 's', target: 'k' }],
    };
    const env = serviceHandler.compile(g.nodes[0]!, buildIndex(g)).environment;
    expect(env.PUBLISH_TOPIC).toBe('events');
    expect(env.KAFKA_BROKER).toBe('events:9092');
  });
});
```

Append to `src/compiler/handlers/worker.test.ts`:
```typescript
describe('workerHandler.compile kafka broker', () => {
  it('emits KAFKA_BROKER on a worker->kafka edge', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'w', type: 'worker', label: 'Payment Worker' },
        { id: 'k', type: 'kafka', label: 'Order Events' },
      ],
      edges: [{ source: 'w', target: 'k' }],
    };
    const env = workerHandler.compile(g.nodes[0]!, buildIndex(g)).environment;
    expect(env.SUBSCRIBE_TOPICS).toBe('order-events');
    expect(env.KAFKA_BROKER).toBe('order-events:9092');
  });
});
```

Append to `src/compiler/index.test.ts`:
```typescript
describe('compile — saga kafka wiring', () => {
  it('wires KRaft config + KAFKA_BROKER for a service->kafka<-worker graph', () => {
    const g: Graph = {
      experimentId: 'saga',
      nodes: [
        { id: 'o', type: 'service', label: 'Order Service' },
        { id: 'k', type: 'kafka', label: 'Order Events' },
        { id: 'p', type: 'worker', label: 'Payment Worker' },
      ],
      edges: [
        { source: 'o', target: 'k' },
        { source: 'p', target: 'k' },
      ],
    };
    const result = compile(g);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.compose).toContain('KAFKA_CFG_ADVERTISED_LISTENERS: "PLAINTEXT://order-events:9092"');
    expect(result.output.compose).toContain('KAFKA_BROKER: "order-events:9092"');
  });
});
```

> Note: `service.test.ts`, `worker.test.ts`, and `index.test.ts` already import `describe`/`it`/`expect`, the relevant handler / `compile`, `buildIndex`, and the `Graph` type. Reuse the existing imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/compiler/handlers/service.test.ts src/compiler/handlers/worker.test.ts src/compiler/index.test.ts`
Expected: FAIL — `KAFKA_BROKER` is `undefined`; the Saga compose lacks the `KAFKA_BROKER` line.

- [ ] **Step 3: Write minimal implementation**

In `src/compiler/handlers/service.ts`, update the kafka branch of the outgoing-edge loop:
```typescript
      if (target.type === 'kafka') {
        env.PUBLISH_TOPIC = slugify(target.label);
        env.KAFKA_BROKER = `${slugify(target.label)}:9092`;
      }
```

In `src/compiler/handlers/worker.ts`, update the kafka branch of the outgoing-edge loop:
```typescript
      if (target.type === 'kafka') {
        topics.push(slugify(target.label));
        env.KAFKA_BROKER = `${slugify(target.label)}:9092`;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/compiler/handlers/service.test.ts src/compiler/handlers/worker.test.ts src/compiler/index.test.ts`
Expected: PASS — new KAFKA_BROKER + Saga-wiring tests green; all prior service/worker/index tests still green.

- [ ] **Step 5: Run the full suite + commit**

Run: `npm test`
Expected: PASS — full compiler + engine suite green (the Docker smokes stay skipped).

```bash
git add src/compiler/handlers/service.ts src/compiler/handlers/worker.ts \
        src/compiler/handlers/service.test.ts src/compiler/handlers/worker.test.ts \
        src/compiler/index.test.ts
git commit -m "feat: emit KAFKA_BROKER for service and worker kafka edges"
```

---

## Self-Review

**Spec coverage** (design → task):
- kafka full KRaft env (8 keys, advertised `<name>:9092`, quorum `0@<name>:9093`) → Task 1.
- service `KAFKA_BROKER` on service→kafka → Task 2.
- worker `KAFKA_BROKER` on worker→kafka → Task 2.
- Saga-shaped integration (compose has KRaft env + KAFKA_BROKER) → Task 2 (`index.test.ts`).
- Broker = `<kafka-slug>:9092` matching the advertised listener → Tasks 1 + 2 (identical `<name>:9092`).
- Backward compatibility (non-kafka graphs unchanged; KAFKA_BROKER only on kafka edges) → Task 2 (new env inside the `target.type === 'kafka'` branch only).
- Healthcheck unchanged → Task 1 (carried verbatim).

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** broker string `<slug>:9092` is byte-identical in `kafka.ts` advertised listener, `service.ts`, `worker.ts`, and every test assertion (`event-bus:9092` / `events:9092` / `order-events:9092`). The KRaft env keys in Task 1's implementation match Task 1's test and the `index.test.ts` assertion in Task 2. `kafkaHandler.compile`, `serviceHandler.compile`, `workerHandler.compile`, and `compile` signatures are used as they already exist.

**Not in this plan (intentional, = Saga brick 2b):** the `sds/worker` Go image, the Saga example graph file, and the real-Kafka end-to-end smoke that boots the broker.
