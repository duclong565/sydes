# Edge-Legality Check — Design

Date: 2026-06-28 · Branch: `feat/edge-legality` · Base: `main`

## Context

The Graph Compiler infers each edge's meaning from its `source`/`target` node
types, per-node. There is **no global check that an edge is meaningful** — an
unrecognized source→target combination is silently dropped, producing a node
that wires nothing.

Concrete bug (observed live): a `DB 1 → Service 2` edge compiled and ran. `Service 2`
booted as an isolated, idle microservice (no inbound traffic, cpu 0%), the
`db → service` edge wired nothing, and the user got no warning. This violates the
compiler's documented contract — *fail loud, refuse to generate, never best-effort*.

This brick adds a **default-deny edge-legality pass**: only an explicit allowlist of
source→target type combos compiles; anything else is a clear compile-time error.
It also closes the one legitimate fan-out the allowlist needs — `service → service`
(upstream cascade) — by wiring the microservice's existing `UPSTREAM_HTTP` env, so
`service-pair.json` (and its k6 smoke) becomes a real A→B cascade instead of a no-op.

## Locked decisions (brainstorm 2026-06-28)

- **Detection model: allowlist (default-deny).** Enumerate the known-good combos in
  one table; reject any edge not in it. New node/edge types must opt in explicitly —
  the strongest guarantee that no silent no-op edge slips through.
- **`service → service`: allowed AND wired** (not a no-op). The microservice already
  reads `UPSTREAM_HTTP`; the compiler now sets it. Resolves the conflict that
  `service-pair.json` + the k6 smoke depend on `service → service`.
- **Message: templated + node labels**, `nodeId = edge.source` (canvas highlights the
  offending node).

## Allowlist (6 combos)

Keyed `${srcType}>${tgtType}`:

| Edge | Wires |
|------|-------|
| `service > kafka`   | publish (`PUBLISH_TOPIC`, `KAFKA_BROKER`) |
| `service > db`      | `DB_URL` |
| `service > service` | **NEW** upstream cascade (`UPSTREAM_HTTP`) |
| `worker > kafka`    | subscribe (`SUBSCRIBE_TOPICS`, `KAFKA_BROKER`) |
| `worker > db`       | persist (`DB_URL`) |
| `lb > service`      | nginx round-robin upstream |

Everything else (`db > *`, `kafka > *`, `* > lb`, `worker > service`,
`service > worker`, …) is rejected.

## Components

### 1. Edge-legality pass — `src/compiler/index.ts`

Runs in the validation phase, **after** `buildIndex` and the per-node `validate`
loop, appending to the same `errors` array (so node-errors and edge-errors surface
together; the existing `if (errors.length > 0) return { ok: false, errors }` gate
covers it). The duplicate-label check still short-circuits earlier (it runs before
`buildIndex`), unchanged.

```ts
const ALLOWED_EDGES = new Set([
  'service>kafka', 'service>db', 'service>service',
  'worker>kafka', 'worker>db',
  'lb>service',
]);
```

For each `edge` in `graph.edges`:
- `src = index.nodeMap.get(edge.source)`, `tgt = index.nodeMap.get(edge.target)`.
- **Dangling:** if `!src` or `!tgt` → push `Edge references unknown node "<missing-id>"`,
  `nodeId = edge.source` (uniform with the other cases). Continue.
- **Self-loop:** if `edge.source === edge.target` → push
  `A node cannot connect to itself ("<label>")`, `nodeId = edge.source`. Continue.
- **Illegal combo:** if `` `${src.type}>${tgt.type}` `` ∉ `ALLOWED_EDGES` → push the
  templated message, `nodeId = edge.source`. Continue.

Collect **all** offending edges (do not stop at the first).

**Message template:**
```
Invalid connection: a ${src.type} ("${src.label}") cannot connect to a ${tgt.type} ("${tgt.label}")
```

### 2. Cascade wiring — `src/compiler/handlers/service.ts`

In `service.compile`, inside the existing `for (const edge of index.outEdges(node.id))`
loop, add a branch:

```ts
if (target.type === 'service') env.UPSTREAM_HTTP = `http://${slugify(target.label)}:8080`;
```

`UPSTREAM_HTTP` must be a full URL — the microservice does
`client.Post(cfg.UpstreamHTTP, ...)` and validates `url.ParseRequestURI` (scheme +
host required). `http://<slug>:8080` matches the in-network DNS name + the
microservice's listen port. No `depends_on`: the upstream call is request-time and
tolerates a cold/erroring upstream (returns 502), matching the current looseness.

## Data flow

```
compile(graph)
  duplicate-label check (early return)            [unchanged]
  buildIndex
  per-node validate  → errors[]                   [unchanged]
  edge-legality pass → errors[] (append)          [NEW]
  if errors → { ok:false, errors }                [unchanged gate]
  generation pass (service.compile now also emits UPSTREAM_HTTP on service→service)
  host-port collision check                        [unchanged]
  compose / nginx / k6
```

## Error handling

- Illegal / dangling / self-loop edges → fail loud with a clear, node-attributed
  message; **all** offenders reported in one pass.
- A graph that was previously a silent no-op (e.g. `db → service`) now fails Preview
  with an actionable message instead of booting dead-weight containers.
- Valid graphs (the 4 bundled examples) are unaffected.

## Testing

**Unit (no Docker):**
- `src/compiler/index.test.ts`:
  - `db → service` rejected — message matches `/cannot connect to a service/i`,
    `nodeId` = the db node id (the live-observed bug).
  - `lb → db` rejected.
  - self-loop (`service → same service`) rejected.
  - dangling edge (target id not a node) rejected.
  - a valid saga graph still compiles `ok`.
  - `service → service` graph compiles `ok` **and** the service service emits
    `UPSTREAM_HTTP=http://<target-slug>:8080`.
- `src/compiler/handlers/service.test.ts`:
  - `service → service` out-edge sets `UPSTREAM_HTTP=http://edge-b:8080`;
  - a service with no service out-edge has no `UPSTREAM_HTTP`.

**Regression:** all four `examples/*.json` (`saga`, `saga-db`, `lb-scaling`,
`service-pair`) compile `ok` after the change — `service-pair` now additionally
carries `UPSTREAM_HTTP` on `Edge A`. `npm test` + `npm run typecheck` clean.

**Gated smoke:** the existing `k6.smoke.test.ts` (service-pair) still passes under
`RUN_DOCKER=1` — k6 hits `edge-a:8080`, which now cascades to `edge-b:8080`.

## Out of scope

- Duplicate-edge dedup.
- Cascade `depends_on` / ordering, multi-hop depth limits, cycle detection beyond the
  single-node self-loop guard.
- Wiring any *other* currently-unwired combo (this brick only adds `service→service`).

## Likely task breakdown (for writing-plans)

1. `service.ts` cascade wiring (`UPSTREAM_HTTP`) + `service.test.ts` (TDD).
2. `index.ts` edge-legality pass (allowlist + dangling + self-loop + templated
   message) + `index.test.ts` cases (TDD).
3. Regression sweep: all examples compile; `npm test` + `npm run typecheck` green.
