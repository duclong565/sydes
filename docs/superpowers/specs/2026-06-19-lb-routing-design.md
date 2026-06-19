# Compiler LB Routing v1 — Design

> **Status:** Approved design, ready for implementation plan.
> **Date:** 2026-06-19
> **Depends on:** Graph Compiler (done), `sds/microservice` (done), Docker Controller (done — writes artifacts + `docker compose up`).

## Goal

Make Load-Balancer graphs actually route. Today the `lb` handler emits an
`nginx:alpine` container with port `80:80` published but no nginx config mounted,
so an LB stack comes up serving nginx's default welcome page instead of
round-robining to the backends. This brick mounts the compiler's generated nginx
config into the LB container so `curl localhost:80` reaches the `sds/microservice`
backends — making the LB Scaling template work end-to-end and host-`curl`-able.

## Scope (locked — brainstorm 2026-06-19)

**In:** add a `volumes` field to `ComposeService`, emit it from the compose
generator, and have the `lb` handler mount the generated nginx config at
`/etc/nginx/conf.d/default.conf`. Plus a gated real-Docker smoke proving an LB
graph routes.

**Out (deferred):**
- Host ports for `service` nodes (single-service host-`curl`). Every service
  publishing the same host port collides; needs a port-allocation strategy. Not
  needed for the LB entry, which already publishes port 80. `service` containers
  remain reachable in-network (`<name>:8080`), which is what k6 and nginx use.
- Concurrent experiments sharing host port 80 (one-experiment-at-a-time MVP).

## Why nginx routing is currently broken

- `lbHandler.compile` returns `{ name, image: 'nginx:alpine', environment: {}, ports: ['80:80'] }` — no volume, so the generated `nginx.conf` never reaches the container.
- `ComposeService` has no `volumes` field, and `generateCompose` emits no
  `volumes:` block — so even if the handler wanted to mount, the generator
  couldn't express it.
- Result: nginx runs its stock default config (welcome page), ignoring the
  upstream the compiler computed.

## Changes

### 1. `ComposeService.volumes` (src/compiler/types.ts)

Add an optional field using Compose short-syntax strings (mirrors `ports`):

```ts
export interface ComposeService {
  name: string;
  image: string;
  environment: Record<string, string>;
  ports?: string[];
  volumes?: string[];   // NEW — e.g. "./nginx.conf:/etc/nginx/conf.d/default.conf:ro"
  healthcheck?: { test: string[]; interval: string; timeout: string; retries: number };
}
```

### 2. Compose generator emits volumes (src/compiler/generators/compose.ts)

After the existing `ports:` block, before `healthcheck:`:

```ts
if (svc.volumes && svc.volumes.length > 0) {
  lines.push('    volumes:');
  for (const v of svc.volumes) lines.push(`      - "${v}"`);
}
```

Determinism preserved: array order, no key sorting. Services without `volumes`
emit nothing, so all existing compose output is byte-identical.

### 3. LB handler mounts the nginx config (src/compiler/handlers/lb.ts)

```ts
compile(node) {
  return {
    name: slugify(node.label),
    image: 'nginx:alpine',
    environment: {},
    ports: ['80:80'],
    volumes: ['./nginx.conf:/etc/nginx/conf.d/default.conf:ro'],
  };
},
```

**Mount target rationale — `/etc/nginx/conf.d/default.conf`, not `nginx.conf`:**
The generated config (`generateNginx`) is an http-context snippet —
`upstream backend { … } server { listen 80; location / { proxy_pass http://backend; } }`
— with no `events{}`/`http{}` wrapper. Stock `nginx:alpine`'s `/etc/nginx/nginx.conf`
already contains `http { include /etc/nginx/conf.d/*.conf; }`, and ships exactly
one file there (`default.conf`, the welcome page). Mounting our snippet over
`default.conf` places the `upstream`/`server` directives in valid http context
and replaces the welcome page. Mounting at `/etc/nginx/nginx.conf` would fail
(missing `events{}`). Therefore **`generateNginx` is unchanged**.

### 4. No controller change

The Docker Controller already writes `nginx.conf` next to `compose.yml` in
`.sds-runs/<id>/` (its `writeArtifacts` writes `output.nginx` when present, which
the compiler emits whenever an `lb` node exists). The compose volume source
`./nginx.conf` is relative; `docker compose -f .sds-runs/<id>/compose.yml`
resolves relative bind-mount paths against the compose file's directory
(`.sds-runs/<id>/`), where `nginx.conf` was written. The gated smoke confirms
this empirically.

## Data flow (after this change)

```
compile(lbGraph)
  output.compose: nginx svc has volumes: ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
  output.nginx:   upstream backend { server svc-one:8080; server svc-two:8080; } server { listen 80; ... }

controller.writeArtifacts:
  .sds-runs/lbdemo/compose.yml
  .sds-runs/lbdemo/nginx.conf

docker compose up -d --wait
  nginx container mounts .sds-runs/lbdemo/nginx.conf -> /etc/nginx/conf.d/default.conf

curl http://localhost:80/ (POST)
  -> nginx :80 -> round-robin -> svc-one:8080 / svc-two:8080 (in-network)
  -> 200 {"ok":true}
```

## Testing

**Compiler unit tests (fast, no Docker):**
- `generators/compose.test.ts`: a service with `volumes` renders a `volumes:`
  block with `- "<entry>"` lines in array order; a service without `volumes`
  renders none (determinism unchanged).
- `handlers/lb.test.ts`: `lbHandler.compile(...).volumes` includes
  `./nginx.conf:/etc/nginx/conf.d/default.conf:ro`.
- `index.test.ts`: compiling the LB graph → `output.compose` contains the lb
  service's `volumes:` block; `output.nginx` still contains the `upstream`/`server`
  blocks (extend the existing LB test).

**Gated real-Docker smoke (`RUN_DOCKER=1`) — `src/engine/lb-routing.smoke.test.ts`:**
```
compile examples/lb-scaling.json
controller.writeArtifacts + up -d --wait
for N requests: POST http://localhost:80/ via Node fetch -> assert 200 {"ok":true}
finally: down -v   (always)
```
This is the empirical proof the nginx config is mounted and routing works.
Round-robin distribution is NOT strictly asserted: the `sds/microservice`
response carries no per-instance identifier, so "distinct backends served" cannot
be observed from the response body. The smoke asserts all N requests return 200
(nginx up + routing to a healthy backend) and documents this limitation. Gated/
skipped by default like the controller smoke.

## Known limitations

- Single-`service` graphs remain in-network-only (no host port) — deferred.
- Round-robin fan-out is not directly asserted (no per-instance marker in the
  microservice response). A future enhancement: add an `INSTANCE_ID` env / response
  header to `sds/microservice` so distribution can be asserted.
- One experiment at a time (host port 80 is singular).

## Follow-ups (separate plans)

1. `sds/microservice`: optional `INSTANCE_ID` echoed in the response → assert
   round-robin distribution; richer dashboards.
2. Service host ports (port-allocation strategy) for single-service host access.
3. k6 Runner; Metrics Collector (dockerode); `sds/worker` + Saga.
