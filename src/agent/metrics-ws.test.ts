import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { buildServer } from './server.js';
import type { Runner, RunResult } from '../engine/runner.js';
import type { StatsSource, ContainerRef, DockerStats } from '../engine/metrics.js';
import type { Graph } from '../compiler/types.js';

class FakeRunner implements Runner {
  async run(argv: string[]): Promise<RunResult> {
    if (argv.includes('inspect')) return { code: 0, stdout: '', stderr: '' };
    if (argv.includes('ps')) return { code: 0, stdout: '[]', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }
}

// Canned stats that yield a positive cpuPercent.
function stat(): DockerStats {
  return {
    cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 1 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    memory_stats: { usage: 50 * 1024 * 1024 },
  };
}
class FakeStats implements StatsSource {
  async list(): Promise<ContainerRef[]> { return [{ id: 'c1', name: 'sds-saga-order-service-1' }]; }
  async stats(): Promise<DockerStats> { return stat(); }
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

describe('GET /api/metrics/:runId (websocket)', () => {
  it('pushes a per-service metric frame for a running experiment', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'sds-ws-'));
    const { app, runs } = buildServer({ runner: new FakeRunner(), runRoot, statsSource: new FakeStats() });
    try {
      await app.inject({ method: 'POST', url: '/api/run', payload: { graph: sagaGraph } });
      await runs.get('saga')!.task; // background run -> state 'running'
      const addr = await app.listen({ port: 0, host: '127.0.0.1' });
      const ws = new WebSocket(`${addr.replace('http', 'ws')}/api/metrics/saga`);
      const frame = await new Promise<string>((resolve, reject) => {
        ws.on('message', (d) => resolve(d.toString()));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('no frame')), 5000);
      });
      const parsed = JSON.parse(frame) as Array<{ service: string; cpuPercent: number; memMB: number }>;
      expect(parsed[0]!.service).toBe('order-service');
      expect(parsed[0]!.cpuPercent).toBeGreaterThan(0);
      expect(parsed[0]!.memMB).toBeCloseTo(50, 0);
      ws.close();
    } finally {
      await app.close();
      rmSync(runRoot, { recursive: true, force: true });
    }
  }, 15000);

  it('closes the socket for an unknown run', async () => {
    const { app } = buildServer({ runner: new FakeRunner(), statsSource: new FakeStats() });
    try {
      const addr = await app.listen({ port: 0, host: '127.0.0.1' });
      const ws = new WebSocket(`${addr.replace('http', 'ws')}/api/metrics/nope`);
      await new Promise<void>((resolve, reject) => {
        ws.on('close', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket stayed open')), 5000);
      });
    } finally {
      await app.close();
    }
  }, 15000);
});
