import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from './api.js';

afterEach(() => vi.restoreAllMocks());

describe('api', () => {
  it('logs() fetches /api/logs and returns lines', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runId: 'saga', lines: 'a\nb' }))));
    const r = await api.logs('saga');
    expect(r.lines).toBe('a\nb');
  });

  it('returns a JSON 400 body instead of throwing (compile errors path)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, errors: [{ message: 'x' }] }), { status: 400 })));
    const r = await api.compile({ experimentId: 'e', nodes: [], edges: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toBeTruthy();
  });

  it('throws when the response body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })));
    await expect(api.status('saga')).rejects.toThrow();
  });

  it('load() posts durationSec/targets and returns a K6Result', async () => {
    const result = { perTarget: [{ slug: 'svc', targetRps: 50, achievedRps: 50, requests: 500, dropped: 0, errorRate: 0, latencyAvgMs: 8, latencyP95Ms: 18, latencyMaxMs: 95 }], total: { requests: 500, targetRps: 50, achievedRps: 50, dropped: 0, errorRate: 0 } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetchMock);
    const r = await api.load('saga', 10, [{ nodeId: 'svc-1', rate: 50 }]);
    expect(r).toMatchObject({ perTarget: [{ slug: 'svc', requests: 500 }] });
    expect(fetchMock).toHaveBeenCalledWith('/api/load/saga', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ durationSec: 10, targets: [{ nodeId: 'svc-1', rate: 50 }] });
  });
});
