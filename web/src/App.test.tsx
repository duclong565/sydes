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

describe('App', () => {
  it('loads examples into the Load-example dropdown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(exampleList))));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'saga' })).toBeInTheDocument());
  });

  it('Run posts /api/run with the serialized canvas graph', async () => {
    let runBody: { graph: { experimentId: string } } | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') {
        runBody = JSON.parse(String(init!.body));
        return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      }
      return new Response(JSON.stringify({ runId: 'saga', state: 'running', services: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'saga' })).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText('load example'), 'saga'); // loadExample(saga)
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/run', expect.objectContaining({ method: 'POST' })));
    expect(runBody!.graph.experimentId).toBe('saga');
  });
});
