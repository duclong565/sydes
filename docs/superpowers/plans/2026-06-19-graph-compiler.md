# Graph Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure-function Graph Compiler that turns a typed service graph into a runnable `docker-compose.yml`, `nginx.conf`, and k6 load script — validating strictly and failing loudly.

**Architecture:** Node-owned handlers (each node type owns its `validate` + `compile`), driven by a two-pass orchestrator: validation pass collects ALL errors, then generation pass emits artifacts. The compiler is a pure function — zero I/O, zero Docker calls.

**Tech Stack:** TypeScript (ESM), Vitest. No Electron/React in this phase — the compiler is standalone and testable on its own.

## Global Constraints

- Language: TypeScript, ESM modules (`"type": "module"` in package.json).
- Node types (Phase 1): `service`, `kafka`, `worker`, `db`, `lb` — exact lowercase strings.
- Images: `sds/microservice` (service), `sds/worker` (worker), `bitnami/kafka:latest` (kafka), `postgres:alpine` (db), `nginx:alpine` (lb).
- Compiler is pure: `compile(graph, loadConfig?)` — no file writes, no side effects.
- Validation collects ALL errors before returning; never short-circuit.
- Container name = hostname = `slugify(node.label)` (lowercase, spaces→hyphens).
- Network name: `sds-<experimentId>-net`.
- Determinism: same input → byte-identical output. Iterate nodes/edges in array order; never rely on object key order.

---

### Task 1: Project scaffold + Vitest

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Test: `src/compiler/__tests__/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: working `npm test` command running Vitest in ESM mode.

- [ ] **Step 1: Write the failing test**

`src/compiler/__tests__/smoke.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `npm` errors with "Missing script: test" / no package.json.

- [ ] **Step 3: Write minimal implementation**

`package.json`:
```json
{
  "name": "sydes",
  "version": "0.0.1",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
```

`.gitignore`:
```
node_modules/
dist/
*.log
```

Then run: `npm install`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 1 test passing.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/compiler/__tests__/smoke.test.ts package-lock.json
git commit -m "chore: scaffold TypeScript + Vitest toolchain"
```

---

### Task 2: Core types + slugify util

**Files:**
- Create: `src/compiler/types.ts`
- Create: `src/compiler/util.ts`
- Test: `src/compiler/util.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `slugify(label: string): string`
  - Types: `NodeType`, `GraphNode`, `GraphEdge`, `Graph`, `LoadConfig`, `ComposeService`, `CompilerError`, `CompilerResult`, `NodeHandler`, `GraphIndex`.

- [ ] **Step 1: Write the failing test**

`src/compiler/util.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { slugify } from './util.js';

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Order Service')).toBe('order-service');
  });
  it('collapses repeated spaces', () => {
    expect(slugify('Payment   Worker')).toBe('payment-worker');
  });
  it('trims surrounding whitespace', () => {
    expect(slugify('  DB  ')).toBe('db');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/util.test.ts`
Expected: FAIL — cannot find module `./util.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/util.ts`:
```typescript
export function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '-');
}
```

`src/compiler/types.ts`:
```typescript
export type NodeType = 'service' | 'kafka' | 'worker' | 'db' | 'lb';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  config?: {
    latencyMs?: number;
    errorRate?: number;
  };
}

export interface GraphEdge {
  source: string; // node id
  target: string; // node id
}

export interface Graph {
  experimentId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface LoadConfig {
  rate: number;        // requests per second
  durationSec: number;
}

export interface ComposeService {
  name: string;        // container name + DNS hostname
  image: string;
  environment: Record<string, string>;
  ports?: string[];    // e.g. "8080:8080"
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
  };
}

export interface CompilerError {
  nodeId: string;
  message: string;
}

export type CompilerResult =
  | { ok: true; output: { compose: string; nginx?: string; k6?: string } }
  | { ok: false; errors: CompilerError[] };

export interface GraphIndex {
  nodeMap: Map<string, GraphNode>;
  inEdges: (nodeId: string) => GraphEdge[];
  outEdges: (nodeId: string) => GraphEdge[];
}

export interface NodeHandler {
  validate(node: GraphNode, index: GraphIndex): CompilerError[];
  compile(node: GraphNode, index: GraphIndex): ComposeService;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/compiler/util.test.ts`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/types.ts src/compiler/util.ts src/compiler/util.test.ts
git commit -m "feat: add compiler core types and slugify util"
```

---

### Task 3: Graph index

**Files:**
- Create: `src/compiler/graph-index.ts`
- Test: `src/compiler/graph-index.test.ts`

**Interfaces:**
- Consumes: `Graph`, `GraphIndex`, `GraphEdge` from `types.ts`.
- Produces: `buildIndex(graph: Graph): GraphIndex`.

- [ ] **Step 1: Write the failing test**

`src/compiler/graph-index.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildIndex } from './graph-index.js';
import type { Graph } from './types.js';

const graph: Graph = {
  experimentId: 'exp1',
  nodes: [
    { id: 'a', type: 'service', label: 'A' },
    { id: 'k', type: 'kafka', label: 'Bus' },
    { id: 'w', type: 'worker', label: 'W' },
  ],
  edges: [
    { source: 'a', target: 'k' },
    { source: 'w', target: 'k' },
  ],
};

describe('buildIndex', () => {
  it('maps node ids to nodes', () => {
    const idx = buildIndex(graph);
    expect(idx.nodeMap.get('a')?.label).toBe('A');
  });
  it('returns outgoing edges for a node', () => {
    const idx = buildIndex(graph);
    expect(idx.outEdges('a')).toEqual([{ source: 'a', target: 'k' }]);
  });
  it('returns incoming edges for a node', () => {
    const idx = buildIndex(graph);
    expect(idx.inEdges('k')).toEqual([
      { source: 'a', target: 'k' },
      { source: 'w', target: 'k' },
    ]);
  });
  it('returns empty array for node with no edges', () => {
    const idx = buildIndex(graph);
    expect(idx.outEdges('k')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/graph-index.test.ts`
Expected: FAIL — cannot find module `./graph-index.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/graph-index.ts`:
```typescript
import type { Graph, GraphIndex } from './types.js';

export function buildIndex(graph: Graph): GraphIndex {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  return {
    nodeMap,
    inEdges: (id) => graph.edges.filter((e) => e.target === id),
    outEdges: (id) => graph.edges.filter((e) => e.source === id),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/compiler/graph-index.test.ts`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/graph-index.ts src/compiler/graph-index.test.ts
git commit -m "feat: add graph index helper"
```

---

### Task 4: Service handler

**Files:**
- Create: `src/compiler/handlers/service.ts`
- Test: `src/compiler/handlers/service.test.ts`

**Interfaces:**
- Consumes: `NodeHandler`, `GraphNode`, `GraphIndex` from `types.ts`; `slugify` from `util.ts`.
- Produces: `serviceHandler: NodeHandler`. Emits image `sds/microservice`, env `LATENCY_MS`, `ERROR_RATE`, plus `DB_URL` when an outgoing edge targets a `db`, `PUBLISH_TOPIC` when an outgoing edge targets a `kafka`. Validation error if node has zero edges (in or out).

- [ ] **Step 1: Write the failing test**

`src/compiler/handlers/service.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { serviceHandler } from './service.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

function idxFor(graph: Graph) {
  return buildIndex(graph);
}

describe('serviceHandler.validate', () => {
  it('errors when service has no edges', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 's', type: 'service', label: 'Orphan' }], edges: [] };
    const errors = serviceHandler.validate(g.nodes[0]!, idxFor(g));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/at least one edge/i);
  });
  it('passes when service has an edge', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 's', type: 'service', label: 'Order' }, { id: 'd', type: 'db', label: 'OrdersDB' }],
      edges: [{ source: 's', target: 'd' }],
    };
    expect(serviceHandler.validate(g.nodes[0]!, idxFor(g))).toEqual([]);
  });
});

describe('serviceHandler.compile', () => {
  it('emits DB_URL and PUBLISH_TOPIC from outgoing edges', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 's', type: 'service', label: 'Order Service', config: { latencyMs: 20, errorRate: 0.01 } },
        { id: 'd', type: 'db', label: 'Orders DB' },
        { id: 'k', type: 'kafka', label: 'Events' },
      ],
      edges: [{ source: 's', target: 'd' }, { source: 's', target: 'k' }],
    };
    const svc = serviceHandler.compile(g.nodes[0]!, idxFor(g));
    expect(svc.name).toBe('order-service');
    expect(svc.image).toBe('sds/microservice');
    expect(svc.environment.LATENCY_MS).toBe('20');
    expect(svc.environment.ERROR_RATE).toBe('0.01');
    expect(svc.environment.DB_URL).toBe('postgres://orders-db:5432');
    expect(svc.environment.PUBLISH_TOPIC).toBe('events');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/handlers/service.test.ts`
Expected: FAIL — cannot find module `./service.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/handlers/service.ts`:
```typescript
import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';

export const serviceHandler: NodeHandler = {
  validate(node, index) {
    const hasEdge = index.inEdges(node.id).length > 0 || index.outEdges(node.id).length > 0;
    return hasEdge ? [] : [{ nodeId: node.id, message: 'Service must have at least one edge' }];
  },
  compile(node, index) {
    const env: Record<string, string> = {
      LATENCY_MS: String(node.config?.latencyMs ?? 0),
      ERROR_RATE: String(node.config?.errorRate ?? 0),
    };
    for (const edge of index.outEdges(node.id)) {
      const target = index.nodeMap.get(edge.target);
      if (!target) continue;
      if (target.type === 'db') env.DB_URL = `postgres://${slugify(target.label)}:5432`;
      if (target.type === 'kafka') env.PUBLISH_TOPIC = slugify(target.label);
    }
    return { name: slugify(node.label), image: 'sds/microservice', environment: env };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/compiler/handlers/service.test.ts`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/handlers/service.ts src/compiler/handlers/service.test.ts
git commit -m "feat: add service node handler"
```

---

### Task 5: DB handler

**Files:**
- Create: `src/compiler/handlers/db.ts`
- Test: `src/compiler/handlers/db.test.ts`

**Interfaces:**
- Consumes: `NodeHandler` from `types.ts`; `slugify` from `util.ts`.
- Produces: `dbHandler: NodeHandler`. Image `postgres:alpine`, port `5432:5432`, env `POSTGRES_PASSWORD=sds`. Validation error if no incoming edge (no consumer).

- [ ] **Step 1: Write the failing test**

`src/compiler/handlers/db.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { dbHandler } from './db.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

describe('dbHandler.validate', () => {
  it('errors when db has no consumer', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'd', type: 'db', label: 'DB' }], edges: [] };
    const errors = dbHandler.validate(g.nodes[0]!, buildIndex(g));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/consumer/i);
  });
  it('passes when db has a consumer', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 's', type: 'service', label: 'S' }, { id: 'd', type: 'db', label: 'DB' }],
      edges: [{ source: 's', target: 'd' }],
    };
    expect(dbHandler.validate(g.nodes[1]!, buildIndex(g))).toEqual([]);
  });
});

describe('dbHandler.compile', () => {
  it('emits postgres service with port', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'd', type: 'db', label: 'Orders DB' }], edges: [] };
    const svc = dbHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.name).toBe('orders-db');
    expect(svc.image).toBe('postgres:alpine');
    expect(svc.ports).toEqual(['5432:5432']);
    expect(svc.environment.POSTGRES_PASSWORD).toBe('sds');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/handlers/db.test.ts`
Expected: FAIL — cannot find module `./db.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/handlers/db.ts`:
```typescript
import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';

export const dbHandler: NodeHandler = {
  validate(node, index) {
    return index.inEdges(node.id).length > 0
      ? []
      : [{ nodeId: node.id, message: 'Database must have at least one consumer' }];
  },
  compile(node) {
    return {
      name: slugify(node.label),
      image: 'postgres:alpine',
      environment: { POSTGRES_PASSWORD: 'sds' },
      ports: ['5432:5432'],
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/compiler/handlers/db.test.ts`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/handlers/db.ts src/compiler/handlers/db.test.ts
git commit -m "feat: add db node handler"
```

---

### Task 6: Kafka handler

**Files:**
- Create: `src/compiler/handlers/kafka.ts`
- Test: `src/compiler/handlers/kafka.test.ts`

**Interfaces:**
- Consumes: `NodeHandler` from `types.ts`; `slugify` from `util.ts`.
- Produces: `kafkaHandler: NodeHandler`. Image `bitnami/kafka:latest`, healthcheck included. Validation error if no publisher (no incoming edge) OR no subscriber (no outgoing edge). A publisher is any node with an edge INTO kafka; a subscriber is any `worker` node with an edge INTO kafka.

- [ ] **Step 1: Write the failing test**

`src/compiler/handlers/kafka.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { kafkaHandler } from './kafka.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

describe('kafkaHandler.validate', () => {
  it('errors when kafka has no publisher', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'k', type: 'kafka', label: 'Bus' }, { id: 'w', type: 'worker', label: 'W' }],
      edges: [{ source: 'k', target: 'w' }],
    };
    const errors = kafkaHandler.validate(g.nodes[0]!, buildIndex(g));
    expect(errors.some((e) => /publisher/i.test(e.message))).toBe(true);
  });
  it('errors when kafka has no subscriber', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 's', type: 'service', label: 'S' }, { id: 'k', type: 'kafka', label: 'Bus' }],
      edges: [{ source: 's', target: 'k' }],
    };
    const errors = kafkaHandler.validate(g.nodes[1]!, buildIndex(g));
    expect(errors.some((e) => /subscriber/i.test(e.message))).toBe(true);
  });
  it('passes with both a publisher and a subscriber', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 's', type: 'service', label: 'S' },
        { id: 'k', type: 'kafka', label: 'Bus' },
        { id: 'w', type: 'worker', label: 'W' },
      ],
      edges: [{ source: 's', target: 'k' }, { source: 'k', target: 'w' }],
    };
    expect(kafkaHandler.validate(g.nodes[1]!, buildIndex(g))).toEqual([]);
  });
});

describe('kafkaHandler.compile', () => {
  it('emits kafka service with a healthcheck', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'k', type: 'kafka', label: 'Event Bus' }], edges: [] };
    const svc = kafkaHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.name).toBe('event-bus');
    expect(svc.image).toBe('bitnami/kafka:latest');
    expect(svc.healthcheck).toBeDefined();
    expect(svc.healthcheck!.retries).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/handlers/kafka.test.ts`
Expected: FAIL — cannot find module `./kafka.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/handlers/kafka.ts`:
```typescript
import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';

export const kafkaHandler: NodeHandler = {
  validate(node, index) {
    const errors = [];
    if (index.inEdges(node.id).length === 0)
      errors.push({ nodeId: node.id, message: 'Kafka must have at least one publisher' });
    if (index.outEdges(node.id).length === 0)
      errors.push({ nodeId: node.id, message: 'Kafka must have at least one subscriber' });
    return errors;
  },
  compile(node) {
    return {
      name: slugify(node.label),
      image: 'bitnami/kafka:latest',
      environment: { KAFKA_CFG_NODE_ID: '0', KAFKA_CFG_PROCESS_ROLES: 'controller,broker' },
      healthcheck: {
        test: ['CMD-SHELL', 'kafka-topics.sh --bootstrap-server localhost:9092 --list || exit 1'],
        interval: '5s',
        timeout: '5s',
        retries: 10,
      },
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/compiler/handlers/kafka.test.ts`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/handlers/kafka.ts src/compiler/handlers/kafka.test.ts
git commit -m "feat: add kafka node handler"
```

---

### Task 7: Worker handler

**Files:**
- Create: `src/compiler/handlers/worker.ts`
- Test: `src/compiler/handlers/worker.test.ts`

**Interfaces:**
- Consumes: `NodeHandler` from `types.ts`; `slugify` from `util.ts`.
- Produces: `workerHandler: NodeHandler`. Image `sds/worker`, env `SUBSCRIBE_TOPICS` (comma-joined slugified labels of kafka nodes this worker has an edge INTO), plus `DB_URL` when an outgoing edge targets a `db`. Validation error if the worker has no outgoing edge to a `kafka` node (no subscription).

- [ ] **Step 1: Write the failing test**

`src/compiler/handlers/worker.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { workerHandler } from './worker.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

describe('workerHandler.validate', () => {
  it('errors when worker has no kafka subscription', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'w', type: 'worker', label: 'W' }, { id: 'd', type: 'db', label: 'DB' }],
      edges: [{ source: 'w', target: 'd' }],
    };
    const errors = workerHandler.validate(g.nodes[0]!, buildIndex(g));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/subscribe/i);
  });
  it('passes when worker subscribes to kafka', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'w', type: 'worker', label: 'W' }, { id: 'k', type: 'kafka', label: 'Bus' }],
      edges: [{ source: 'w', target: 'k' }],
    };
    expect(workerHandler.validate(g.nodes[0]!, buildIndex(g))).toEqual([]);
  });
});

describe('workerHandler.compile', () => {
  it('emits SUBSCRIBE_TOPICS and DB_URL', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'w', type: 'worker', label: 'Payment Worker' },
        { id: 'k', type: 'kafka', label: 'Order Events' },
        { id: 'd', type: 'db', label: 'Pay DB' },
      ],
      edges: [{ source: 'w', target: 'k' }, { source: 'w', target: 'd' }],
    };
    const svc = workerHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.name).toBe('payment-worker');
    expect(svc.image).toBe('sds/worker');
    expect(svc.environment.SUBSCRIBE_TOPICS).toBe('order-events');
    expect(svc.environment.DB_URL).toBe('postgres://pay-db:5432');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/handlers/worker.test.ts`
Expected: FAIL — cannot find module `./worker.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/handlers/worker.ts`:
```typescript
import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';

export const workerHandler: NodeHandler = {
  validate(node, index) {
    const subscribesToKafka = index
      .outEdges(node.id)
      .some((e) => index.nodeMap.get(e.target)?.type === 'kafka');
    return subscribesToKafka
      ? []
      : [{ nodeId: node.id, message: 'Worker must subscribe to at least one Kafka' }];
  },
  compile(node, index) {
    const topics: string[] = [];
    const env: Record<string, string> = {};
    for (const edge of index.outEdges(node.id)) {
      const target = index.nodeMap.get(edge.target);
      if (!target) continue;
      if (target.type === 'kafka') topics.push(slugify(target.label));
      if (target.type === 'db') env.DB_URL = `postgres://${slugify(target.label)}:5432`;
    }
    env.SUBSCRIBE_TOPICS = topics.join(',');
    return { name: slugify(node.label), image: 'sds/worker', environment: env };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/compiler/handlers/worker.test.ts`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/handlers/worker.ts src/compiler/handlers/worker.test.ts
git commit -m "feat: add worker node handler"
```

---

### Task 8: LB handler

**Files:**
- Create: `src/compiler/handlers/lb.ts`
- Test: `src/compiler/handlers/lb.test.ts`

**Interfaces:**
- Consumes: `NodeHandler` from `types.ts`; `slugify` from `util.ts`.
- Produces: `lbHandler: NodeHandler`. Image `nginx:alpine`, port `80:80`. Validation error if fewer than 2 outgoing edges to `service` nodes. (Nginx upstream config is generated separately by the orchestrator in Task 11 — the handler only emits the container.)

- [ ] **Step 1: Write the failing test**

`src/compiler/handlers/lb.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { lbHandler } from './lb.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

describe('lbHandler.validate', () => {
  it('errors when lb has fewer than 2 service upstreams', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'lb', type: 'lb', label: 'LB' }, { id: 's', type: 'service', label: 'S' }],
      edges: [{ source: 'lb', target: 's' }],
    };
    const errors = lbHandler.validate(g.nodes[0]!, buildIndex(g));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/2/);
  });
  it('passes with 2 service upstreams', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'lb', type: 'lb', label: 'LB' },
        { id: 's1', type: 'service', label: 'S1' },
        { id: 's2', type: 'service', label: 'S2' },
      ],
      edges: [{ source: 'lb', target: 's1' }, { source: 'lb', target: 's2' }],
    };
    expect(lbHandler.validate(g.nodes[0]!, buildIndex(g))).toEqual([]);
  });
});

describe('lbHandler.compile', () => {
  it('emits nginx service with port 80', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'lb', type: 'lb', label: 'Gateway LB' }], edges: [] };
    const svc = lbHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.name).toBe('gateway-lb');
    expect(svc.image).toBe('nginx:alpine');
    expect(svc.ports).toEqual(['80:80']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/handlers/lb.test.ts`
Expected: FAIL — cannot find module `./lb.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/handlers/lb.ts`:
```typescript
import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';

export const lbHandler: NodeHandler = {
  validate(node, index) {
    const serviceUpstreams = index
      .outEdges(node.id)
      .filter((e) => index.nodeMap.get(e.target)?.type === 'service');
    return serviceUpstreams.length >= 2
      ? []
      : [{ nodeId: node.id, message: 'Load balancer requires at least 2 service upstreams' }];
  },
  compile(node) {
    return { name: slugify(node.label), image: 'nginx:alpine', environment: {}, ports: ['80:80'] };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/compiler/handlers/lb.test.ts`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/handlers/lb.ts src/compiler/handlers/lb.test.ts
git commit -m "feat: add load balancer node handler"
```

---

### Task 9: Handler registry

**Files:**
- Create: `src/compiler/handlers/index.ts`
- Test: `src/compiler/handlers/index.test.ts`

**Interfaces:**
- Consumes: all five handlers; `NodeType`, `NodeHandler` from `types.ts`.
- Produces: `handlers: Record<NodeType, NodeHandler>`.

- [ ] **Step 1: Write the failing test**

`src/compiler/handlers/index.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { handlers } from './index.js';

describe('handler registry', () => {
  it('has a handler for every node type', () => {
    for (const type of ['service', 'kafka', 'worker', 'db', 'lb'] as const) {
      expect(handlers[type]).toBeDefined();
      expect(typeof handlers[type].validate).toBe('function');
      expect(typeof handlers[type].compile).toBe('function');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/handlers/index.test.ts`
Expected: FAIL — cannot find module `./index.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/handlers/index.ts`:
```typescript
import type { NodeType, NodeHandler } from '../types.js';
import { serviceHandler } from './service.js';
import { kafkaHandler } from './kafka.js';
import { workerHandler } from './worker.js';
import { dbHandler } from './db.js';
import { lbHandler } from './lb.js';

export const handlers: Record<NodeType, NodeHandler> = {
  service: serviceHandler,
  kafka: kafkaHandler,
  worker: workerHandler,
  db: dbHandler,
  lb: lbHandler,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/compiler/handlers/index.test.ts`
Expected: PASS — 1 test passing.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/handlers/index.ts src/compiler/handlers/index.test.ts
git commit -m "feat: add node handler registry"
```

---

### Task 10: Compose generator

**Files:**
- Create: `src/compiler/generators/compose.ts`
- Test: `src/compiler/generators/compose.test.ts`

**Interfaces:**
- Consumes: `ComposeService` from `types.ts`.
- Produces: `generateCompose(services: ComposeService[], networkName: string): string`. Emits a deterministic YAML string by hand (no YAML library) — services in array order, env keys in insertion order. Every service attaches to `networkName`.

- [ ] **Step 1: Write the failing test**

`src/compiler/generators/compose.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { generateCompose } from './compose.js';
import type { ComposeService } from '../types.js';

describe('generateCompose', () => {
  it('renders services, env, ports, and network deterministically', () => {
    const services: ComposeService[] = [
      { name: 'order-service', image: 'sds/microservice', environment: { LATENCY_MS: '20' } },
      { name: 'orders-db', image: 'postgres:alpine', environment: { POSTGRES_PASSWORD: 'sds' }, ports: ['5432:5432'] },
    ];
    const yaml = generateCompose(services, 'sds-exp1-net');
    expect(yaml).toContain('services:');
    expect(yaml).toContain('  order-service:');
    expect(yaml).toContain('    image: sds/microservice');
    expect(yaml).toContain('      LATENCY_MS: "20"');
    expect(yaml).toContain('    ports:');
    expect(yaml).toContain('      - "5432:5432"');
    expect(yaml).toContain('networks:');
    expect(yaml).toContain('  sds-exp1-net:');
    expect(yaml).toContain('    driver: bridge');
    // determinism: same input → same output
    expect(generateCompose(services, 'sds-exp1-net')).toBe(yaml);
  });

  it('renders a healthcheck block when present', () => {
    const services: ComposeService[] = [
      {
        name: 'events',
        image: 'bitnami/kafka:latest',
        environment: {},
        healthcheck: { test: ['CMD-SHELL', 'check || exit 1'], interval: '5s', timeout: '5s', retries: 10 },
      },
    ];
    const yaml = generateCompose(services, 'net');
    expect(yaml).toContain('    healthcheck:');
    expect(yaml).toContain('      test: ["CMD-SHELL", "check || exit 1"]');
    expect(yaml).toContain('      retries: 10');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/generators/compose.test.ts`
Expected: FAIL — cannot find module `./compose.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/generators/compose.ts`:
```typescript
import type { ComposeService } from '../types.js';

export function generateCompose(services: ComposeService[], networkName: string): string {
  const lines: string[] = ['services:'];
  for (const svc of services) {
    lines.push(`  ${svc.name}:`);
    lines.push(`    image: ${svc.image}`);
    const envKeys = Object.keys(svc.environment);
    if (envKeys.length > 0) {
      lines.push('    environment:');
      for (const key of envKeys) lines.push(`      ${key}: "${svc.environment[key]}"`);
    }
    if (svc.ports && svc.ports.length > 0) {
      lines.push('    ports:');
      for (const port of svc.ports) lines.push(`      - "${port}"`);
    }
    if (svc.healthcheck) {
      const test = svc.healthcheck.test.map((t) => `"${t}"`).join(', ');
      lines.push('    healthcheck:');
      lines.push(`      test: [${test}]`);
      lines.push(`      interval: ${svc.healthcheck.interval}`);
      lines.push(`      timeout: ${svc.healthcheck.timeout}`);
      lines.push(`      retries: ${svc.healthcheck.retries}`);
    }
    lines.push('    networks:');
    lines.push(`      - ${networkName}`);
  }
  lines.push('networks:');
  lines.push(`  ${networkName}:`);
  lines.push('    driver: bridge');
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/compiler/generators/compose.test.ts`
Expected: PASS — 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/generators/compose.ts src/compiler/generators/compose.test.ts
git commit -m "feat: add docker-compose generator"
```

---

### Task 11: Nginx generator

**Files:**
- Create: `src/compiler/generators/nginx.ts`
- Test: `src/compiler/generators/nginx.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (plain strings).
- Produces: `generateNginx(upstreams: string[]): string`. Builds an `upstream backend { ... }` block (each entry `server <name>:8080;` in array order) plus a `server` block on port 80 proxying to it.

- [ ] **Step 1: Write the failing test**

`src/compiler/generators/nginx.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { generateNginx } from './nginx.js';

describe('generateNginx', () => {
  it('renders an upstream block with one server line per upstream', () => {
    const conf = generateNginx(['order-a', 'order-b']);
    expect(conf).toContain('upstream backend {');
    expect(conf).toContain('    server order-a:8080;');
    expect(conf).toContain('    server order-b:8080;');
    expect(conf).toContain('listen 80;');
    expect(conf).toContain('proxy_pass http://backend;');
    expect(generateNginx(['order-a', 'order-b'])).toBe(conf);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/generators/nginx.test.ts`
Expected: FAIL — cannot find module `./nginx.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/generators/nginx.ts`:
```typescript
export function generateNginx(upstreams: string[]): string {
  const servers = upstreams.map((u) => `    server ${u}:8080;`).join('\n');
  return [
    'upstream backend {',
    servers,
    '}',
    '',
    'server {',
    '    listen 80;',
    '    location / {',
    '        proxy_pass http://backend;',
    '    }',
    '}',
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/compiler/generators/nginx.test.ts`
Expected: PASS — 1 test passing.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/generators/nginx.ts src/compiler/generators/nginx.test.ts
git commit -m "feat: add nginx upstream config generator"
```

---

### Task 12: K6 generator

**Files:**
- Create: `src/compiler/generators/k6.ts`
- Test: `src/compiler/generators/k6.test.ts`

**Interfaces:**
- Consumes: `LoadConfig` from `types.ts`.
- Produces: `generateK6(targetHost: string, port: number, load: LoadConfig): string`. Emits a k6 constant-arrival-rate script posting to `http://<targetHost>:<port>/`.

- [ ] **Step 1: Write the failing test**

`src/compiler/generators/k6.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { generateK6 } from './k6.js';

describe('generateK6', () => {
  it('renders a constant-arrival-rate script targeting the host', () => {
    const script = generateK6('gateway-lb', 80, { rate: 10000, durationSec: 60 });
    expect(script).toContain("import http from 'k6/http';");
    expect(script).toContain("executor: 'constant-arrival-rate'");
    expect(script).toContain('rate: 10000');
    expect(script).toContain("duration: '60s'");
    expect(script).toContain("http.post('http://gateway-lb:80/'");
    expect(generateK6('gateway-lb', 80, { rate: 10000, durationSec: 60 })).toBe(script);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/generators/k6.test.ts`
Expected: FAIL — cannot find module `./k6.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/generators/k6.ts`:
```typescript
import type { LoadConfig } from '../types.js';

export function generateK6(targetHost: string, port: number, load: LoadConfig): string {
  return `import http from 'k6/http';

export const options = {
  scenarios: {
    main: {
      executor: 'constant-arrival-rate',
      rate: ${load.rate},
      timeUnit: '1s',
      duration: '${load.durationSec}s',
      preAllocatedVUs: 500,
    },
  },
};

export default function () {
  http.post('http://${targetHost}:${port}/', JSON.stringify({ ping: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/compiler/generators/k6.test.ts`
Expected: PASS — 1 test passing.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/generators/k6.ts src/compiler/generators/k6.test.ts
git commit -m "feat: add k6 load script generator"
```

---

### Task 13: compile() orchestrator

**Files:**
- Create: `src/compiler/index.ts`
- Test: `src/compiler/index.test.ts`

**Interfaces:**
- Consumes: `buildIndex` (Task 3), `handlers` (Task 9), `generateCompose` (Task 10), `generateNginx` (Task 11), `generateK6` (Task 12), `slugify` (Task 2); types from `types.ts`.
- Produces: `compile(graph: Graph, loadConfig?: LoadConfig): CompilerResult`.

**Orchestration order:**
1. Duplicate-label check FIRST — if two nodes share `slugify(label)`, return errors immediately (skip per-node validation to avoid cascading errors).
2. Validation pass — run `handlers[node.type].validate` for every node, collect ALL errors. If any, return `{ ok: false, errors }`.
3. Generation pass — run `handlers[node.type].compile` for every node → `ComposeService[]`.
4. `compose = generateCompose(services, 'sds-<experimentId>-net')`.
5. If any `lb` node exists: `nginx = generateNginx(<slugified service labels its outEdges target>)`.
6. If `loadConfig` provided: pick entry point — first `lb` node if any, else first `service` node — and `k6 = generateK6(slugify(entry.label), entryPort, loadConfig)` where `entryPort` is 80 for lb, 8080 for service.

- [ ] **Step 1: Write the failing test**

`src/compiler/index.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { compile } from './index.js';
import type { Graph } from './types.js';

const sagaGraph: Graph = {
  experimentId: 'exp1',
  nodes: [
    { id: 'o', type: 'service', label: 'Order Service' },
    { id: 'k', type: 'kafka', label: 'Order Events' },
    { id: 'p', type: 'worker', label: 'Payment Worker' },
    { id: 'd', type: 'db', label: 'Orders DB' },
  ],
  edges: [
    { source: 'o', target: 'k' },
    { source: 'o', target: 'd' },
    { source: 'p', target: 'k' },
  ],
};

describe('compile — valid graph', () => {
  it('produces compose output for a Saga topology', () => {
    const result = compile(sagaGraph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.compose).toContain('order-service:');
    expect(result.output.compose).toContain('PUBLISH_TOPIC: "order-events"');
    expect(result.output.compose).toContain('SUBSCRIBE_TOPICS: "order-events"');
    expect(result.output.compose).toContain('sds-exp1-net:');
  });

  it('generates a k6 script when loadConfig is given', () => {
    const result = compile(sagaGraph, { rate: 5000, durationSec: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.k6).toContain('rate: 5000');
    expect(result.output.k6).toContain('http://order-service:8080/');
  });
});

describe('compile — duplicate labels', () => {
  it('fails before per-node validation when two labels collide', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'a', type: 'service', label: 'API' },
        { id: 'b', type: 'service', label: 'api' },
      ],
      edges: [{ source: 'a', target: 'b' }],
    };
    const result = compile(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => /duplicate/i.test(e.message))).toBe(true);
  });
});

describe('compile — invalid graph', () => {
  it('collects all validation errors', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'lb', type: 'lb', label: 'LB' },
        { id: 's', type: 'service', label: 'Only One' },
      ],
      edges: [{ source: 'lb', target: 's' }],
    };
    const result = compile(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // LB has <2 upstreams
    expect(result.errors.some((e) => e.nodeId === 'lb')).toBe(true);
  });
});

describe('compile — load balancer', () => {
  it('generates nginx config and targets lb for k6', () => {
    const g: Graph = {
      experimentId: 'exp2',
      nodes: [
        { id: 'lb', type: 'lb', label: 'Gateway' },
        { id: 's1', type: 'service', label: 'Svc One' },
        { id: 's2', type: 'service', label: 'Svc Two' },
        { id: 'd', type: 'db', label: 'Shared DB' },
      ],
      edges: [
        { source: 'lb', target: 's1' },
        { source: 'lb', target: 's2' },
        { source: 's1', target: 'd' },
        { source: 's2', target: 'd' },
      ],
    };
    const result = compile(g, { rate: 100, durationSec: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.nginx).toContain('server svc-one:8080;');
    expect(result.output.nginx).toContain('server svc-two:8080;');
    expect(result.output.k6).toContain('http://gateway:80/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/compiler/index.test.ts`
Expected: FAIL — cannot find module `./index.js`.

- [ ] **Step 3: Write minimal implementation**

`src/compiler/index.ts`:
```typescript
import type { Graph, LoadConfig, CompilerResult, CompilerError, ComposeService } from './types.js';
import { buildIndex } from './graph-index.js';
import { handlers } from './handlers/index.js';
import { generateCompose } from './generators/compose.js';
import { generateNginx } from './generators/nginx.js';
import { generateK6 } from './generators/k6.js';
import { slugify } from './util.js';

export function compile(graph: Graph, loadConfig?: LoadConfig): CompilerResult {
  // 1. Duplicate-label check first.
  const seen = new Map<string, string>();
  const dupErrors: CompilerError[] = [];
  for (const node of graph.nodes) {
    const slug = slugify(node.label);
    const prior = seen.get(slug);
    if (prior) {
      dupErrors.push({ nodeId: node.id, message: `Duplicate label "${node.label}" collides with node ${prior}` });
    } else {
      seen.set(slug, node.id);
    }
  }
  if (dupErrors.length > 0) return { ok: false, errors: dupErrors };

  const index = buildIndex(graph);

  // 2. Validation pass — collect ALL errors.
  const errors: CompilerError[] = [];
  for (const node of graph.nodes) {
    errors.push(...handlers[node.type].validate(node, index));
  }
  if (errors.length > 0) return { ok: false, errors };

  // 3. Generation pass.
  const services: ComposeService[] = graph.nodes.map((node) =>
    handlers[node.type].compile(node, index),
  );

  // 4. Compose.
  const networkName = `sds-${graph.experimentId}-net`;
  const compose = generateCompose(services, networkName);
  const output: { compose: string; nginx?: string; k6?: string } = { compose };

  // 5. Nginx (first LB node, if any).
  const lbNode = graph.nodes.find((n) => n.type === 'lb');
  if (lbNode) {
    const upstreams = index
      .outEdges(lbNode.id)
      .map((e) => index.nodeMap.get(e.target))
      .filter((n) => n?.type === 'service')
      .map((n) => slugify(n!.label));
    output.nginx = generateNginx(upstreams);
  }

  // 6. k6 (entry = first LB else first service).
  if (loadConfig) {
    const entry = lbNode ?? graph.nodes.find((n) => n.type === 'service');
    if (entry) {
      const port = entry.type === 'lb' ? 80 : 8080;
      output.k6 = generateK6(slugify(entry.label), port, loadConfig);
    }
  }

  return { ok: true, output };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all suites green (full run).

- [ ] **Step 5: Commit**

```bash
git add src/compiler/index.ts src/compiler/index.test.ts
git commit -m "feat: add two-pass compile orchestrator"
```

---

## Self-Review

**Spec coverage** (PRD → task):
- User stories 1, 14, 15 (Saga compose, determinism, runnable) → Task 13 integration + Task 10 determinism assertion.
- Stories 3, 9 (LB nginx + ≥2 upstream error) → Task 8 + Task 11 + Task 13.
- Story 4 (Worker auto-subscribe) → Task 7.
- Stories 5, 6 (k6 + entry detection) → Task 12 + Task 13.
- Story 7 (DB_URL from edges) → Task 4 / Task 7.
- Story 8 (container names from labels) → Task 2 slugify, used everywhere.
- Stories 2, 10, 11, 12 (collect-all errors, worker/kafka/duplicate validation) → Tasks 6, 7, 13.
- Story 13 (isolated network) → Task 10 networkName + Task 13.
- Kafka healthcheck note → Task 6.
- `ComposeService.image` overridable → present as a plain field (Task 2), satisfied.

**Placeholder scan:** none — all steps contain real code + commands.

**Type consistency:** `NodeHandler.{validate,compile}(node, index)` signature is identical across Tasks 4–9 and called consistently in Task 13. `slugify`, `buildIndex`, `generateCompose/Nginx/K6` signatures match their producers. `CompilerResult` discriminated union (`ok` field) used consistently.

**Not yet wired:** the `sds/microservice` and `sds/worker` Docker images are referenced as image names but not built — that is intentionally out of this plan (compiler only emits references). Building those Go images is a separate plan.
