import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';

// Gated: runs only with RUN_DOCKER=1 and a built sds/microservice image.
// Requires host port 80 to be free.
describe.skipIf(!process.env.RUN_DOCKER)('lb routing smoke (real docker)', () => {
  it('routes localhost:80 through nginx to the backends', async () => {
    const graph = JSON.parse(readFileSync('examples/lb-scaling.json', 'utf8')) as Graph;
    const result = compile(graph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runRoot = mkdtempSync(join(tmpdir(), 'sds-lb-'));
    const c = new ExperimentController(new RealRunner(), { runRoot });
    c.writeArtifacts(graph.experimentId, result.output);
    try {
      await c.preflight(result.output);
      await c.up(graph.experimentId);

      // Give the backends a moment to bind after the container reports running.
      await new Promise((r) => setTimeout(r, 1500));

      let ok = 0;
      for (let i = 0; i < 6; i++) {
        const res = await fetch('http://localhost:80/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (res.status === 200) ok++;
      }
      // nginx is configured (not the default welcome page) and routes to a healthy backend.
      expect(ok).toBeGreaterThanOrEqual(5);
    } finally {
      await c.down(graph.experimentId);
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
