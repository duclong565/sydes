import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';
import { K6Runner } from './k6-runner.js';

// Gated: needs RUN_DOCKER=1, the sds/microservice + sds/worker images built; pulls apache/kafka.
describe.skipIf(!process.env.RUN_DOCKER)('saga chain smoke (real docker)', () => {
  it('service publishes -> kafka -> worker consumes', async () => {
    const graph = JSON.parse(readFileSync('examples/saga.json', 'utf8')) as Graph;
    const result = compile(graph, { rate: 20, durationSec: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runRoot = mkdtempSync(join(tmpdir(), 'sds-saga-'));
    const runner = new RealRunner();
    const c = new ExperimentController(runner, { runRoot });
    const runDir = c.writeArtifacts(graph.experimentId, result.output);
    const id = graph.experimentId;
    try {
      await c.preflight(result.output);
      await c.up(id); // kafka cold start; --wait blocks until healthy
      await new K6Runner(runner).run(id, runDir); // fire load at the service -> it publishes
      // Poll the worker logs until it has consumed (instead of a fixed drain sleep).
      let workerLogs = '';
      for (let i = 0; i < 15; i++) {
        workerLogs = (await runner.run([
          'docker', 'compose', '-p', `sds-${id}`, '-f', join(runDir, 'compose.yml'),
          'logs', 'payment-worker',
        ])).stdout;
        if (/consumed/.test(workerLogs)) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      expect(workerLogs).toMatch(/consumed/);
    } finally {
      await c.down(id);
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
