import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from './server.js';
import { RealRunner } from '../engine/runner.js';
import type { Graph } from '../compiler/types.js';

// Gated: needs RUN_DOCKER=1 and the sds/microservice + sds/worker images built; pulls apache/kafka.
describe.skipIf(!process.env.RUN_DOCKER)('agent e2e smoke (real docker)', () => {
  it('runs an example via the HTTP API: run -> status running -> stop', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'sds-agent-e2e-'));
    const graph = JSON.parse(readFileSync('examples/saga.json', 'utf8')) as Graph;
    const { app, runs } = buildServer({ runner: new RealRunner(), runRoot });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/run', payload: { graph } });
      expect(res.statusCode).toBe(202);
      await runs.get('saga')!.task; // wait for up --wait (kafka cold start)

      const status = await app.inject({ method: 'GET', url: '/api/status/saga' });
      const body = status.json() as { state: string; services: Array<{ name: string }>; error?: string };
      expect(body.state, `run errored: ${body.error ?? ''}`).toBe('running');
      expect(body.services.length).toBeGreaterThan(0);
    } finally {
      await app.inject({ method: 'POST', url: '/api/stop', payload: { runId: 'saga' } });
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
