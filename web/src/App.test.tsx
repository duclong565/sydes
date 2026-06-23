import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.js';
import { useGraphStore } from './store.js';

const exampleList = [
  { id: 'saga', label: 'saga', graph: { experimentId: 'saga', nodes: [], edges: [] } },
];

beforeEach(() => {
  vi.restoreAllMocks();
  useGraphStore.setState({ experimentId: 'untitled', nodes: [], edges: [], selectedId: null });
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
