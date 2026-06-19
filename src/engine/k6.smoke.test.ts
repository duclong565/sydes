import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';
import { K6Runner } from './k6-runner.js';

// Gated: runs only with RUN_DOCKER=1. Needs the sds/microservice image; pulls grafana/k6 on first run.
describe.skipIf(!process.env.RUN_DOCKER)('k6 smoke (real docker)', () => {
  it('runs a small load against a service-pair and reports metrics', async () => {
    const graph = JSON.parse(readFileSync('examples/service-pair.json', 'utf8')) as Graph;
    const result = compile(graph, { rate: 20, durationSec: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runRoot = mkdtempSync(join(tmpdir(), 'sds-k6-smoke-'));
    const c = new ExperimentController(new RealRunner(), { runRoot });
    const runDir = c.writeArtifacts(graph.experimentId, result.output);
    try {
      await c.preflight(result.output);
      await c.up(graph.experimentId);
      const res = await new K6Runner(new RealRunner()).run(graph.experimentId, runDir);
      expect(res.requests).toBeGreaterThan(0);
      expect(res.rps).toBeGreaterThan(0);
    } finally {
      await c.down(graph.experimentId);
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
