import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from './server.js';
import type { Runner, RunResult } from '../engine/runner.js';
import type { Graph } from '../compiler/types.js';

// Writes a canned per-scenario summary.json on the k6 docker-run argv so the real K6Runner parses a K6Result.
class FakeRunner implements Runner {
  async run(argv: string[]): Promise<RunResult> {
    if (argv.includes('grafana/k6:0.49.0')) {
      const v = argv[argv.indexOf('-v') + 1] ?? '';
      const runDir = v.slice(0, v.lastIndexOf(':'));
      writeFileSync(join(runDir, 'summary.json'), JSON.stringify({ metrics: {
        http_reqs: { count: 200, rate: 20 },
        'http_reqs{scenario:order-service}': { count: 200, rate: 20 },
        'http_req_duration{scenario:order-service}': { avg: 8.1, 'p(95)': 18.2, max: 95.5 },
        'http_req_failed{scenario:order-service}': { value: 0 },
        http_req_duration: { avg: 8.1, 'p(95)': 18.2, max: 95.5 },
        http_req_failed: { value: 0 },
      }}));
      return { code: 0, stdout: '', stderr: '' };
    }
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

function server() {
  const runRoot = mkdtempSync(join(tmpdir(), 'sds-load-'));
  return { ...buildServer({ runner: new FakeRunner(), runRoot }), runRoot };
}

describe('POST /api/load/:runId', () => {
  it('runs k6 against a running experiment and returns the K6Result', async () => {
    const { app, runs, runRoot } = server();
    try {
      await app.inject({ method: 'POST', url: '/api/run', payload: { graph: sagaGraph } });
      await runs.get('saga')!.task; // -> running
      const res = await app.inject({
        method: 'POST', url: '/api/load/saga',
        payload: { durationSec: 10, targets: [{ nodeId: 'o', rate: 20 }] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { perTarget: Array<{ slug: string; targetRps: number }>; total: { requests: number } };
      expect(body.total.requests).toBe(200);
      expect(body.perTarget[0]!.slug).toBe('order-service');
      expect(runs.get('saga')!.lastLoad?.total.requests).toBe(200);
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it('400s when targets list is empty', async () => {
    const { app, runs, runRoot } = server();
    try {
      await app.inject({ method: 'POST', url: '/api/run', payload: { graph: sagaGraph } });
      await runs.get('saga')!.task; // -> running
      const res = await app.inject({
        method: 'POST', url: '/api/load/saga',
        payload: { durationSec: 10, targets: [] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it('400s when targets is missing / not an array (malformed body)', async () => {
    const { app, runs, runRoot } = server();
    try {
      await app.inject({ method: 'POST', url: '/api/run', payload: { graph: sagaGraph } });
      await runs.get('saga')!.task; // -> running
      const res = await app.inject({
        method: 'POST', url: '/api/load/saga',
        payload: { durationSec: 10 }, // targets omitted
      });
      expect(res.statusCode).toBe(400);
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it('400s when durationSec is not a positive number', async () => {
    const { app, runs, runRoot } = server();
    try {
      await app.inject({ method: 'POST', url: '/api/run', payload: { graph: sagaGraph } });
      await runs.get('saga')!.task; // -> running
      const res = await app.inject({
        method: 'POST', url: '/api/load/saga',
        payload: { durationSec: 0, targets: [{ nodeId: 'o', rate: 20 }] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it('404s for an unknown run', async () => {
    const { app, runRoot } = server();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/load/nope', payload: { durationSec: 10, targets: [{ nodeId: 'o', rate: 20 }] } });
      expect(res.statusCode).toBe(404);
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it('409s when the run is not running', async () => {
    const { app, runs, runRoot } = server();
    try {
      await app.inject({ method: 'POST', url: '/api/run', payload: { graph: sagaGraph } });
      await runs.get('saga')!.task;
      await app.inject({ method: 'POST', url: '/api/stop', payload: { runId: 'saga' } }); // -> stopped
      const res = await app.inject({ method: 'POST', url: '/api/load/saga', payload: { durationSec: 10, targets: [{ nodeId: 'o', rate: 20 }] } });
      expect(res.statusCode).toBe(409);
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });
});
