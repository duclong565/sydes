import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from './server.js';
import type { Runner, RunResult } from '../engine/runner.js';
import type { Graph } from '../compiler/types.js';

class FakeRunner implements Runner {
  async run(argv: string[]): Promise<RunResult> {
    if (argv.includes('logs')) return { code: 0, stdout: 'payment-worker | consumed 1\n', stderr: '' };
    if (argv.includes('inspect')) return { code: 0, stdout: '', stderr: '' };
    if (argv.includes('ps')) return { code: 0, stdout: '[]', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }
}

const sagaGraph: Graph = {
  experimentId: 'saga',
  nodes: [
    { id: 'o', type: 'service', label: 'Order Service' },
    { id: 'k', type: 'kafka', label: 'Order Events' },
    { id: 'p', type: 'worker', label: 'Payment Worker' },
  ],
  edges: [{ source: 'o', target: 'k' }, { source: 'p', target: 'k' }],
};

describe('GET /api/logs/:runId', () => {
  it('returns logs lines for a known run', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'sds-logs-'));
    const { app } = buildServer({ runner: new FakeRunner(), runRoot });
    try {
      await app.inject({ method: 'POST', url: '/api/run', payload: { graph: sagaGraph } });
      const res = await app.inject({ method: 'GET', url: '/api/logs/saga' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ runId: 'saga', lines: 'payment-worker | consumed 1\n' });
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it('404s for an unknown run', async () => {
    const { app } = buildServer({ runner: new FakeRunner() });
    const res = await app.inject({ method: 'GET', url: '/api/logs/nope' });
    expect(res.statusCode).toBe(404);
  });
});
