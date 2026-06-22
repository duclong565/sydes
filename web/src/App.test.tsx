import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.js';

const exampleList = [
  { id: 'saga', label: 'saga', graph: { experimentId: 'saga', nodes: [], edges: [] } },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('App', () => {
  it('loads examples into the dropdown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(exampleList))));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'saga' })).toBeInTheDocument());
  });

  it('POSTs to /api/run when Run is clicked', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/examples') return new Response(JSON.stringify(exampleList));
      if (url === '/api/run') return new Response(JSON.stringify({ runId: 'saga', state: 'starting' }));
      return new Response(JSON.stringify({ runId: 'saga', state: 'starting', services: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'saga' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/run', expect.objectContaining({ method: 'POST' })),
    );
  });
});
