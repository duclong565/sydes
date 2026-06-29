import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.js';
import { api } from './api.js';
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

function runningFetch() {
  return vi.fn(async (url: string) => {
    if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
    if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
    if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
    return new Response(JSON.stringify({}));
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  useGraphStore.setState({ experimentId: 'untitled', nodes: [], edges: [], selectedId: null });
  useMetricsStore.setState({ byService: {} });
  MockWS.last = null;
  vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
});

describe('App brick 4 (metrics WS)', () => {
  it('opens a metrics WS once running and shows live metrics in the Metrics tab', async () => {
    vi.stubGlobal('fetch', runningFetch());
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
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      if (url === '/api/stop') return new Response(JSON.stringify({ runId: 'saga', state: 'stopped' }));
      if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
      return new Response(JSON.stringify({}));
    }));
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(MockWS.last).not.toBeNull());
    const sock = MockWS.last!;
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(sock.closed).toBe(true));
    expect(useMetricsStore.getState().byService).toEqual({});
  });
});

describe('App brick 3', () => {
  it('shows the "Warming up…" badge immediately after Run', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      return new Response(JSON.stringify({ runId: 'saga', state: 'starting', services: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByText(/warming up/i)).toBeInTheDocument());
  });

  it('shows a dismissible error banner on a compile 400', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/compile') return new Response(JSON.stringify({ ok: false, errors: [{ message: 'Kafka needs a publisher' }] }), { status: 400 });
      return new Response(JSON.stringify({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText(/Kafka needs a publisher/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(/Kafka needs a publisher/)).toBeNull();
  });

  it('Stop shows the Stopped badge', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      if (url === '/api/stop') return new Response(JSON.stringify({ runId: 'saga', state: 'stopped' }));
      return new Response(JSON.stringify({ runId: 'saga', state: 'starting', services: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByText(/Stopped/)).toBeInTheDocument());
  });

  it('lets you Stop an errored run to tear down the half-up stack', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      if (url === '/api/stop') return new Response(JSON.stringify({ runId: 'saga', state: 'stopped' }));
      if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'error', error: 'compose up failed', services: [] }));
      return new Response(JSON.stringify({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    // run goes to error → Stop must be clickable so the user can clean up the partial stack
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/stop', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(screen.getByText(/Stopped/)).toBeInTheDocument());
  });

  it('polls /api/logs when the Logs tab is open', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      if (url.startsWith('/api/logs/')) return new Response(JSON.stringify({ runId: 'saga', lines: 'worker | consumed 1' }));
      return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await userEvent.click(screen.getByRole('button', { name: 'Logs' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/logs/saga', expect.anything()));
  });
});

describe('App brick 5 (run load)', () => {
  it('shows the load control only while running', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
      return new Response(JSON.stringify({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Run load' })).toBeNull(); // hidden before running
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run load' })).toBeInTheDocument());
  });

  it('disables Run load when no node is a load source', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
      return new Response(JSON.stringify({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
    // no nodes in store → sources = []
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run load' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Run load' })).toBeDisabled();
  });

  it('Run load posts targets built from marked nodes', async () => {
    const result = { perTarget: [], total: { requests: 0, targetRps: 0, achievedRps: 0, dropped: 0, errorRate: 0 } };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
      if (url.startsWith('/api/load/')) return new Response(JSON.stringify(result));
      return new Response(JSON.stringify({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
    // seed a service node with loadRate = 50
    useGraphStore.setState({
      experimentId: 'untitled',
      nodes: [{
        id: 'svc-1',
        type: 'serviceNode',
        position: { x: 0, y: 0 },
        data: { label: 'svc-1', type: 'service', config: { loadRate: 50 } },
      }],
      edges: [],
      selectedId: null,
    });
    const spy = vi.spyOn(api, 'load').mockResolvedValue(result);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run load' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run load' })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: 'Run load' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      [{ nodeId: 'svc-1', rate: 50 }],
    ));
    spy.mockRestore();
  });

  it('includes bodyKb in the load targets when set', async () => {
    // the resolved value is never asserted (we check the CALL args), so cast a minimal
    // stub rather than coupling to the current K6Result.total shape:
    const spy = vi.spyOn(api, 'load').mockResolvedValue({ perTarget: [], total: { requests: 0, targetRps: 0, achievedRps: 0, dropped: 0, droppedRps: 0, errorRate: 0 } } as unknown as Awaited<ReturnType<typeof api.load>>);
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
      return new Response(JSON.stringify({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
    // arrange a running experiment with a service node config { loadRate: 50, loadBodyKb: 64 }
    useGraphStore.setState({
      experimentId: 'untitled',
      nodes: [{
        id: 'svc-1',
        type: 'serviceNode',
        position: { x: 0, y: 0 },
        data: { label: 'svc-1', type: 'service', config: { loadRate: 50, loadBodyKb: 64 } },
      }],
      edges: [],
      selectedId: null,
    });
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run load' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run load' })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: 'Run load' }));
    expect(spy).toHaveBeenCalledWith(expect.any(String), expect.any(Number),
      [expect.objectContaining({ rate: 50, bodyKb: 64 })]);
    spy.mockRestore();
  });

  it('does not count a node with fractional loadRate as a source', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      if (url.startsWith('/api/status/')) return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
      return new Response(JSON.stringify({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
    useGraphStore.setState({
      experimentId: 'untitled',
      nodes: [{
        id: 'svc-2',
        type: 'serviceNode',
        position: { x: 0, y: 0 },
        data: { label: 'svc-2', type: 'service', config: { loadRate: 2.5 } },
      }],
      edges: [],
      selectedId: null,
    });
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run load' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Run load' })).toBeDisabled();
  });
});
