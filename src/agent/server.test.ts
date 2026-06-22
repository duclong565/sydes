import { describe, it, expect } from 'vitest';
import { buildServer } from './server.js';
import type { Runner } from '../engine/runner.js';
import type { Graph } from '../compiler/types.js';

const stubRunner: Runner = { run: async () => ({ code: 0, stdout: '', stderr: '' }) };

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

describe('GET /api/examples', () => {
  it('lists bundled example graphs from the examples dir', async () => {
    const { app } = buildServer({ runner: stubRunner, examplesDir: 'examples' });
    const res = await app.inject({ method: 'GET', url: '/api/examples' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; label: string; graph: Graph }>;
    expect(body.some((e) => e.label === 'saga')).toBe(true);
    const saga = body.find((e) => e.label === 'saga')!;
    expect(saga.graph.experimentId).toBe('saga');
  });
});

describe('POST /api/compile', () => {
  it('returns compose output for a valid graph', async () => {
    const { app } = buildServer({ runner: stubRunner });
    const res = await app.inject({ method: 'POST', url: '/api/compile', payload: { graph: sagaGraph } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; output: { compose: string } };
    expect(body.ok).toBe(true);
    expect(body.output.compose).toContain('order-service');
  });

  it('returns 400 with errors for an invalid graph', async () => {
    const bad: Graph = { experimentId: 'bad', nodes: [{ id: 'k', type: 'kafka', label: 'Lonely' }], edges: [] };
    const { app } = buildServer({ runner: stubRunner });
    const res = await app.inject({ method: 'POST', url: '/api/compile', payload: { graph: bad } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; errors: unknown[] };
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });
});
