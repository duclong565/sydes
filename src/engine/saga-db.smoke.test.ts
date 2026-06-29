import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';
import { K6Runner } from './k6-runner.js';

// Gated: needs RUN_DOCKER=1, the sds/microservice + sds/worker images built; pulls apache/kafka + postgres.
describe.skipIf(!process.env.RUN_DOCKER)('saga-db smoke (real docker)', () => {
  it('service -> kafka -> worker -> postgres rows land', async () => {
    const graph = JSON.parse(readFileSync('examples/saga-db.json', 'utf8')) as Graph;
    const result = compile(graph, { durationSec: 3, targets: [{ nodeId: 'o', rate: 20 }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runRoot = mkdtempSync(join(tmpdir(), 'sds-sagadb-'));
    const runner = new RealRunner();
    const c = new ExperimentController(runner, { runRoot });
    const runDir = c.writeArtifacts(graph.experimentId, result.output);
    const id = graph.experimentId;
    const compose = ['docker', 'compose', '-p', `sds-${id}`, '-f', join(runDir, 'compose.yml')];
    try {
      await c.preflight(result.output);
      await c.up(id); // blocks until kafka healthy (worker group registered) + postgres healthy
      await new K6Runner(runner).run(id, runDir, result.output.loadTargets!, 3); // fire load at the service -> publishes -> worker consumes -> writes

      // Poll Postgres until the worker's writes land (or time out).
      let count = 0;
      for (let i = 0; i < 15; i++) {
        const r = await runner.run([
          ...compose, 'exec', '-T', 'orders-db',
          'psql', '-U', 'postgres', '-tAc', 'SELECT count(*) FROM events',
        ]);
        if (r.code === 0) {
          count = parseInt(r.stdout.trim(), 10) || 0;
          if (count > 0) break;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      console.log(`saga-db smoke: events row count = ${count}`);
      expect(count).toBeGreaterThan(0);
    } finally {
      await c.down(id);
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
