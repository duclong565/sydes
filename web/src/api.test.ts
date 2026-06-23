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
});
