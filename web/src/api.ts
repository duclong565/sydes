export interface GraphLike {
  experimentId: string;
  nodes: unknown[];
  edges: unknown[];
}

export interface ExampleEntry {
  id: string;
  label: string;
  graph: GraphLike;
}

export interface ServiceRow {
  name: string;
  state: string;
  health?: string;
}

export interface RunStatus {
  runId: string;
  state: 'starting' | 'running' | 'error' | 'stopped';
  services: ServiceRow[];
  error?: string;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return (await res.json()) as T;
}

export const api = {
  examples: () => jsonFetch<ExampleEntry[]>('/api/examples'),
  compile: (graph: GraphLike) =>
    jsonFetch<{ ok: boolean; output?: { compose: string }; errors?: unknown[] }>('/api/compile', {
      method: 'POST',
      body: JSON.stringify({ graph }),
    }),
  run: (graph: GraphLike) =>
    jsonFetch<{ runId: string; state: string }>('/api/run', {
      method: 'POST',
      body: JSON.stringify({ graph }),
    }),
  status: (runId: string) => jsonFetch<RunStatus>(`/api/status/${runId}`),
  stop: (runId: string) =>
    jsonFetch<{ runId: string; state: string }>('/api/stop', {
      method: 'POST',
      body: JSON.stringify({ runId }),
    }),
};
