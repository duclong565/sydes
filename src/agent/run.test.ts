import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from './server.js';
import type { Runner, RunResult } from '../engine/runner.js';
import type { Graph } from '../compiler/types.js';

// Canned runner: image inspect (preflight) ok, ps returns one running service, everything else ok.
class FakeRunner implements Runner {
  async run(argv: string[]): Promise<RunResult> {
    if (argv.includes('inspect')) return { code: 0, stdout: '', stderr: '' };
    if (argv.includes('ps')) {
      return {
        code: 0,
        stdout: JSON.stringify([{ Name: 'sds-saga-order-service-1', State: 'running', Health: 'healthy' }]),
        stderr: '',
      };
    }
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
  edges: [
    { source: 'o', target: 'k' },
    { source: 'p', target: 'k' },
  ],
};

function newServer() {
  const runRoot = mkdtempSync(join(tmpdir(), 'sds-agent-'));
  const server = buildServer({ runner: new FakeRunner(), runRoot });
  return { ...server, runRoot };
}

describe('POST /api/run + status + stop', () => {
  it('starts a run, transitions to running, and reports services', async () => {
    const { app, runs, runRoot } = newServer();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/run', payload: { graph: sagaGraph } });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ runId: 'saga', state: 'starting' });

      await runs.get('saga')!.task; // wait for the background run

      const status = await app.inject({ method: 'GET', url: '/api/status/saga' });
      expect(status.statusCode).toBe(200);
      const body = status.json() as { state: string; services: Array<{ name: string }> };
      expect(body.state).toBe('running');
      expect(body.services.length).toBeGreaterThan(0);
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it('returns 404 for an unknown runId', async () => {
    const { app, runRoot } = newServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/status/nope' });
      expect(res.statusCode).toBe(404);
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it('rejects an invalid graph with 400 before starting a run', async () => {
    const { app, runRoot } = newServer();
    try {
      const bad: Graph = { experimentId: 'bad', nodes: [{ id: 'k', type: 'kafka', label: 'Lonely' }], edges: [] };
      const res = await app.inject({ method: 'POST', url: '/api/run', payload: { graph: bad } });
      expect(res.statusCode).toBe(400);
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it('stops a run and marks it stopped', async () => {
    const { app, runs, runRoot } = newServer();
    try {
      await app.inject({ method: 'POST', url: '/api/run', payload: { graph: sagaGraph } });
      await runs.get('saga')!.task;
      const res = await app.inject({ method: 'POST', url: '/api/stop', payload: { runId: 'saga' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ runId: 'saga', state: 'stopped' });
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });
});
