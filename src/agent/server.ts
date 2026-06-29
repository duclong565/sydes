import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Graph, LoadConfig } from '../compiler/types.js';
import { compile as compileFn } from '../compiler/index.js';
import type { Runner } from '../engine/runner.js';
import { MetricsCollector, DockerodeStatsSource, type StatsSource } from '../engine/metrics.js';
import { serviceName } from './metrics-stream.js';
import { slugify } from '../compiler/util.js';
import { dbWrites } from './db-rows.js';
import { RunStore } from './runs.js';
import { ExperimentController } from '../engine/controller.js';
import { K6Runner } from '../engine/k6-runner.js';
import { runExperiment } from './run-experiment.js';
import type { RunRecord } from './types.js';

export interface AgentDeps {
  runner: Runner;
  compile?: typeof compileFn;
  runRoot?: string;
  examplesDir?: string;
  statsSource?: StatsSource;
}

export interface AgentServer {
  app: FastifyInstance;
  runs: RunStore;
}

export function buildServer(deps: AgentDeps): AgentServer {
  const compile = deps.compile ?? compileFn;
  const examplesDir = deps.examplesDir ?? 'examples';
  const runs = new RunStore();
  const controller = new ExperimentController(deps.runner, { runRoot: deps.runRoot });
  const k6 = new K6Runner(deps.runner);
  const collector = new MetricsCollector(deps.statsSource ?? new DockerodeStatsSource());
  const app = Fastify({ logger: false });
  app.register(fastifyWebsocket);

  app.get('/api/examples', async () => {
    return readdirSync(examplesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const graph = JSON.parse(readFileSync(join(examplesDir, f), 'utf8')) as Graph;
        return { id: graph.experimentId, label: f.replace(/\.json$/, ''), graph };
      });
  });

  app.post('/api/compile', async (req, reply) => {
    const { graph, load } = req.body as { graph: Graph; load?: LoadConfig };
    const result = compile(graph, load);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  app.post('/api/run', async (req, reply) => {
    const { graph, load } = req.body as { graph: Graph; load?: LoadConfig };
    const result = compile(graph, load);
    if (!result.ok) return reply.code(400).send(result);
    const id = graph.experimentId;
    if (runs.has(id)) await controller.down(id);
    const runDir = controller.writeArtifacts(id, result.output);
    const rec: RunRecord = { id, graph, runDir, state: 'starting', services: [] };
    runs.set(rec);
    rec.task = runExperiment({ controller, k6 }, rec, result.output, load);
    return reply.code(202).send({ runId: id, state: rec.state });
  });

  app.get('/api/status/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const rec = runs.get(runId);
    if (!rec) return reply.code(404).send({ error: 'unknown runId' });
    if (rec.state === 'running') rec.services = await controller.status(runId);
    return { runId, state: rec.state, services: rec.services, error: rec.error };
  });

  app.post('/api/stop', async (req, reply) => {
    const { runId } = req.body as { runId: string };
    const rec = runs.get(runId);
    if (!rec) return reply.code(404).send({ error: 'unknown runId' });
    await controller.down(runId);
    rec.state = 'stopped';
    return { runId, state: rec.state };
  });

  app.get('/api/logs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    if (!runs.has(runId)) return reply.code(404).send({ error: 'unknown runId' });
    const lines = await controller.logs(runId);
    return { runId, lines };
  });

  app.post('/api/load/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const { durationSec, targets } = req.body as { durationSec: number; targets: { nodeId: string; rate: number }[] };
    const rec = runs.get(runId);
    if (!rec) return reply.code(404).send({ error: 'unknown runId' });
    if (rec.state !== 'running') return reply.code(409).send({ error: 'run is not running' });
    if (rec.loadInFlight) return reply.code(409).send({ error: 'a load is already running' });
    // Shape-guard the body so a malformed payload fails loud as 400, not a generic 500
    // from a throw deep in compile. (The compiler still validates target contents.)
    if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
      return reply.code(400).send({ error: 'durationSec must be a positive number' });
    }
    if (!Array.isArray(targets)) {
      return reply.code(400).send({ error: 'targets must be an array' });
    }
    const result = compile(rec.graph, { durationSec, targets });
    if (!result.ok) return reply.code(400).send(result);
    // k6 + loadTargets are emitted together by the compiler; guard on the script and
    // pass loadTargets (defaulting to []) so neither needs a non-null assertion.
    const { k6: loadScript, loadTargets } = result.output;
    if (!loadScript) return reply.code(400).send({ error: 'no load entry (needs a service or lb target)' });
    writeFileSync(join(rec.runDir, 'load.js'), loadScript);
    rec.loadInFlight = true;
    try {
      rec.lastLoad = await k6.run(runId, rec.runDir, loadTargets ?? [], durationSec);
      return rec.lastLoad;
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      rec.loadInFlight = false;
    }
  });

  app.register(async (fastify) => {
    fastify.get('/api/metrics/:runId', { websocket: true }, (socket, req) => {
      const { runId } = (req.params as { runId: string });
      const rec = runs.get(runId);
      if (!rec || rec.state !== 'running') {
        socket.close();
        return;
      }
      const dbSlugs = new Set(rec.graph.nodes.filter((n) => n.type === 'db').map((n) => slugify(n.label)));
      const push = async () => {
        try {
          const snaps = await collector.sample(runId);
          const frame = await Promise.all(
            snaps.map(async (s) => {
              const service = serviceName(s.name, runId);
              const entry: { service: string; cpuPercent: number; memMB: number; writes?: number } = {
                service, cpuPercent: s.cpuPercent, memMB: s.memMB,
              };
              if (dbSlugs.has(service)) {
                const w = await dbWrites(deps.runner, s.name);
                if (w !== undefined) entry.writes = w;
              }
              return entry;
            }),
          );
          socket.send(JSON.stringify(frame));
        } catch {
          /* transient stats / exec error: skip this tick */
        }
      };
      void push(); // immediate first frame
      const timer = setInterval(() => {
        if (rec.state !== 'running') {
          clearInterval(timer);
          socket.close();
          return;
        }
        void push();
      }, 1500);
      socket.on('close', () => clearInterval(timer));
    });
  });

  const distDir = resolve('web', 'dist');
  if (existsSync(distDir)) {
    app.register(fastifyStatic, { root: distDir });
  }

  return { app, runs };
}
