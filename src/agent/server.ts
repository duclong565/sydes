import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Graph, LoadConfig } from '../compiler/types.js';
import { compile as compileFn } from '../compiler/index.js';
import type { Runner } from '../engine/runner.js';
import { RunStore } from './runs.js';

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

  return { app, runs };
}
