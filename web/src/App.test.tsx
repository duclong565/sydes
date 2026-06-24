import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.js';
import { useGraphStore } from './store.js';
import { useMetricsStore } from './metrics-store.js';

const exampleList = [
  { id: 'saga', label: 'saga', graph: { experimentId: 'saga', nodes: [], edges: [] } },
];

// Minimal controllable WebSocket mock (jsdom has none).
class MockWS {
  static last: MockWS | null = null;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) { this.url = url; MockWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send() {}
  close() { this.closed = true; this.onclose?.(); }
}

beforeEach(() => {
  vi.restoreAllMocks();
  useGraphStore.setState({ experimentId: 'untitled', nodes: [], edges: [], selectedId: null });
  useMetricsStore.setState({ byService: {} });
  MockWS.last = null;
});

function runningFetch() {
  return vi.fn(async (url: string) => {
    if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
    if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
    if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
    return new Response(JSON.stringify({}));
  });
}

describe('App brick 4 (metrics WS)', () => {
  it('opens a metrics WS once running and shows live metrics in the Metrics tab', async () => {
    vi.stubGlobal('fetch', runningFetch());
    vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByText(/Running/)).toBeInTheDocument()); // status flipped to running
    await waitFor(() => expect(MockWS.last).not.toBeNull()); // WS opened
    expect(MockWS.last!.url).toContain('/api/metrics/saga');

    MockWS.last!.onmessage?.({ data: JSON.stringify([{ service: 'order-service', cpuPercent: 12, memMB: 48 }]) });
    await userEvent.click(screen.getByRole('button', { name: 'Metrics' }));
    await waitFor(() => expect(screen.getByText('order-service')).toBeInTheDocument());
  });

  it('closes the WS and clears metrics on Stop', async () => {
    const fetchMock = runningFetch();
    (fetchMock as unknown as { mockImplementation: (f: unknown) => void }); // keep type loose
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      if (url === '/api/stop') return new Response(JSON.stringify({ runId: 'saga', state: 'stopped' }));
      if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
      return new Response(JSON.stringify({}));
    }));
    vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(MockWS.last).not.toBeNull());
    const sock = MockWS.last!;
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(sock.closed).toBe(true));
    expect(useMetricsStore.getState().byService).toEqual({});
  });
});
