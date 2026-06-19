import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';
import { MetricsCollector, DockerodeStatsSource } from './metrics.js';

// Gated: runs only with RUN_DOCKER=1. Needs the sds/microservice image.
describe.skipIf(!process.env.RUN_DOCKER)('metrics smoke (real docker)', () => {
  it('samples per-service cpu/mem for a running service-pair', async () => {
    const graph = JSON.parse(readFileSync('examples/service-pair.json', 'utf8')) as Graph;
    const result = compile(graph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runRoot = mkdtempSync(join(tmpdir(), 'sds-metrics-'));
    const c = new ExperimentController(new RealRunner(), { runRoot });
    c.writeArtifacts(graph.experimentId, result.output);
    try {
      await c.preflight(result.output);
      await c.up(graph.experimentId);
      const snaps = await new MetricsCollector(new DockerodeStatsSource()).sample(graph.experimentId);
      expect(snaps.length).toBeGreaterThanOrEqual(2);
      for (const s of snaps) {
        expect(Number.isFinite(s.cpuPercent)).toBe(true);
        expect(s.cpuPercent).toBeGreaterThanOrEqual(0);
        expect(s.memMB).toBeGreaterThan(0);
      }
    } finally {
      await c.down(graph.experimentId);
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
