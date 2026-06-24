---
name: run-app
description: Launch and drive the sydes app end-to-end (local Fastify agent + browser React SPA + real Docker), or verify the full stack headlessly. Use when asked to run, start, demo, or smoke-test the app, reproduce an experiment run, or confirm the canvas → agent → Docker → live-metrics loop works.
---

# Run the sydes app

sydes = a local **agent** (Fastify, `src/agent/`, port 8787) wrapping the engine + a **browser SPA** (`web/`, Vite). The agent drives real Docker; the SPA is the canvas. To run, you need Docker running and the two Go images built.

## Prerequisites (once)

```bash
# Go is not on PATH in this env — needed only to BUILD the worker image:
export PATH="$PATH:/usr/local/go/bin"
docker build -t sds/microservice ./images/microservice
docker build -t sds/worker ./images/worker
npm install && npm --prefix web install
```

## Interactive (browser)

```bash
export PATH="$PATH:/usr/local/go/bin" && npm run dev   # run in background
# concurrently starts: agent on :8787, Vite on http://localhost:5173
open http://localhost:5173
```
Drive in the browser: **Load example → `saga`** (or drag palette nodes + wire edges) → **Preview** (Compose tab) → **Run**. Kafka cold start makes it sit "⏳ Warming up…" ~15–25s, then "● Running": per-node **CPU/mem badges** appear, the **Logs** and **Metrics** drawer tabs stream, **Status** lists services. **Stop** tears it down.

## Headless verify (no browser — proves the whole stack)

Build the SPA first so the agent serves it, start the agent, then drive its HTTP+WS API exactly as the SPA does:

```bash
npm --prefix web run build                                  # -> web/dist (agent serves it)
export PATH="$PATH:/usr/local/go/bin" && PORT=8787 npx tsx src/agent/main.ts   # background

curl -s http://127.0.0.1:8787/ | grep -o '<title>[^<]*</title>'        # SPA served
curl -s http://127.0.0.1:8787/api/examples | head -c 120               # bundled graphs
curl -s -X POST http://127.0.0.1:8787/api/run -H 'content-type: application/json' \
     -d "{\"graph\": $(cat examples/saga.json)}"                       # -> {"runId":"saga","state":"starting"}
# poll until running (~7 ticks @3s during Kafka warmup):
for i in $(seq 1 40); do s=$(curl -s http://127.0.0.1:8787/api/status/saga); \
  echo "$s" | grep -q '"state":"running"' && { echo "$s"; break; }; sleep 3; done
curl -s http://127.0.0.1:8787/api/logs/saga | head -c 300              # container logs
# live metrics WebSocket (ws is bundled with @fastify/websocket):
node -e 'const W=require("ws");const w=new W("ws://127.0.0.1:8787/api/metrics/saga");let n=0;w.on("message",m=>{console.log(m.toString());if(++n>=2)w.close()});w.on("close",()=>process.exit(0));setTimeout(()=>process.exit(1),8000)'
curl -s -X POST http://127.0.0.1:8787/api/stop -H 'content-type: application/json' -d '{"runId":"saga"}'
```
Expected metrics frame: `[{"service":"order-service","cpuPercent":..,"memMB":..}, {"service":"order-events",..}, {"service":"payment-worker",..}]` — service slugs match node labels via `slugify`.

## Teardown

```bash
pkill -f 'concurrently'; pkill -f 'src/agent/main.ts'; pkill -f 'node_modules/.bin/vite'
# clean any leftover experiment containers:
docker ps -aq --filter 'label=com.docker.compose.project=sds-saga' | xargs -r docker rm -f
```

## Notes

- `/api/stop` already runs `docker compose down -v` for the experiment; the teardown `docker rm` is only a belt-and-suspenders for crashes.
- Compose project = `sds-<experimentId>`; containers are `sds-<id>-<service>-1`; network is doubled `sds-<id>_sds-<id>-net`.
- Other example graphs: `examples/{saga,saga-db,lb-scaling,service-pair}.json`. `saga-db` adds Postgres persistence (`worker → db`).
- CLI alternative (no UI): `npm run sim examples/saga.json --load --metrics`.
