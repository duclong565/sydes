import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';

// Gated: runs only with RUN_DOCKER=1 and a built sds/microservice image.
describe.skipIf(!process.env.RUN_DOCKER)('controller smoke (real docker)', () => {
  it('ups a service-pair graph to running, then tears down', async () => {
    const graph = JSON.parse(readFileSync('examples/service-pair.json', 'utf8')) as Graph;
    const result = compile(graph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runRoot = mkdtempSync(join(tmpdir(), 'sds-smoke-'));
    const c = new ExperimentController(new RealRunner(), { runRoot });
    c.writeArtifacts(graph.experimentId, result.output);
    try {
      await c.preflight(result.output);
      await c.up(graph.experimentId);
      const st = await c.status(graph.experimentId);
      expect(st.length).toBeGreaterThanOrEqual(2);
      expect(st.every((s) => s.state === 'running')).toBe(true);
    } finally {
      await c.down(graph.experimentId);
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
