import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Graph, LoadConfig } from '../compiler/types.js';
import { compile as compileFn } from '../compiler/index.js';
import type { Runner } from '../engine/runner.js';
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
  const app = Fastify({ logger: false });

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

  return { app, runs };
}
