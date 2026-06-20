# Compiler Kafka Wiring (Saga brick 2a) — Design

> **Status:** Approved design, ready for implementation plan.
> **Date:** 2026-06-20
> **Depends on:** Graph Compiler (handlers for kafka/service/worker), `sds/microservice` Kafka publish (brick 1 — needs `KAFKA_BROKER`).

## Goal

Make a Saga-shaped graph actually bootable and connectable. Today the compiler
emits a Kafka service that **won't start** (missing KRaft listener config) and
service/worker nodes that **can't connect** (no `KAFKA_BROKER`). This brick fixes
the three compiler handlers so a `Service→Kafka→Worker` graph compiles into a
compose stack whose Kafka boots and whose clients address the broker correctly.

This is **brick 2a of the Saga work** — the compiler prerequisite. Brick 2b
(`sds/worker` Go image + Saga example + the real-Kafka end-to-end smoke) follows.

## The gaps being fixed

1. **`kafka` handler** emits only `KAFKA_CFG_NODE_ID=0` + `KAFKA_CFG_PROCESS_ROLES=controller,broker`.
   bitnami/kafka in KRaft mode needs listener + controller-quorum config to start;
   without it the container never becomes healthy and `docker compose up --wait`
   times out.
2. **`service` handler** emits `PUBLISH_TOPIC` for a `Service→Kafka` edge but no
   `KAFKA_BROKER`. With brick 1's microservice, `PUBLISH_TOPIC` without
   `KAFKA_BROKER` is a fail-loud boot error.
3. **`worker` handler** emits `SUBSCRIBE_TOPICS` but no `KAFKA_BROKER` — the worker
   (brick 2b) will have nothing to connect to.

## Scope (locked — brainstorm 2026-06-20)

**In:** the three handler fixes (kafka full KRaft env; service/worker
`KAFKA_BROKER=<kafka>:9092`) + compiler unit tests asserting the emitted compose
env.

**Out (deferred to brick 2b):** the `sds/worker` Go image, the Saga example graph,
and the real-Kafka end-to-end smoke (the actual boot + producer→consumer
round-trip). A kafka node only compiles with a worker subscriber, and `sds/worker`
does not exist yet, so 2a cannot stand up a real broker on its own — it is
compiler-only, unit-tested on the emitted config.

## Changes (all under `src/compiler/handlers/`)

### kafka.ts — full single-node KRaft config

`kafkaHandler.compile(node)` (uses the node's own slug as the broker hostname):
```ts
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
A single combined controller+broker node: PLAINTEXT broker listener on `:9092`,
controller listener on `:9093`, advertised as `<name>:9092` so in-network clients
connect by the Kafka container's DNS name. The healthcheck is unchanged. The
compose generator already double-quotes env values, so the `://`, `,`, `@`
characters emit as valid YAML scalars.

### service.ts — emit `KAFKA_BROKER` on a `Service→Kafka` edge

In the existing outgoing-edge loop, when the target is a kafka node:
```ts
if (target.type === 'kafka') {
  env.PUBLISH_TOPIC = slugify(target.label);
  env.KAFKA_BROKER = `${slugify(target.label)}:9092`;
}
```
This closes the brick-1 gap: a `Service→Kafka` graph now emits both
`PUBLISH_TOPIC` and `KAFKA_BROKER`, so the microservice passes its boot validation
and can connect.

### worker.ts — emit `KAFKA_BROKER` on a `Worker→Kafka` edge

In the existing outgoing-edge loop, when the target is a kafka node:
```ts
if (target.type === 'kafka') {
  topics.push(slugify(target.label));
  env.KAFKA_BROKER = `${slugify(target.label)}:9092`;
}
```

Broker value = `<kafka-slug>:9092`, matching the kafka handler's advertised
PLAINTEXT listener. v1 assumes a single kafka node; with multiple, `KAFKA_BROKER`
takes the last kafka edge — consistent with how `PUBLISH_TOPIC` already resolves.

## Testing

**Compiler unit tests (fast, no Docker):**
- `kafka.test.ts`: `kafkaHandler.compile` emits all eight `KAFKA_CFG_*` keys with
  the right values, including `KAFKA_CFG_CONTROLLER_QUORUM_VOTERS=0@<name>:9093`
  and `KAFKA_CFG_ADVERTISED_LISTENERS=PLAINTEXT://<name>:9092`. The existing
  healthcheck assertion still holds.
- `service.test.ts`: a `Service→Kafka` graph → service env has
  `PUBLISH_TOPIC=<slug>` and `KAFKA_BROKER=<slug>:9092`.
- `worker.test.ts`: a `Worker→Kafka` graph → worker env has `SUBSCRIBE_TOPICS`
  containing the topic and `KAFKA_BROKER=<slug>:9092`.
- `index.test.ts`: a Saga-shaped graph (service→kafka, worker→kafka) → the
  generated `output.compose` contains the KRaft env lines and both
  `KAFKA_BROKER` lines.

**Deferred:** no real-Kafka boot here — proven in brick 2b's Saga smoke once
`sds/worker` exists.

## Backward compatibility

Non-Kafka graphs (LB, single-service, service→db) are unchanged — the new env is
only emitted on edges into a kafka node, which those graphs don't have. The
existing kafka validation (publisher + subscriber required) is untouched.

## Follow-ups

1. **Saga brick 2b** — `sds/worker` (kafka-go consumer, simulate work, optional
   DB), the Saga example graph, and the real-Kafka end-to-end smoke
   (`service → kafka → worker`), which also validates this brick's KRaft config
   and brick 1's producer against a live broker.
