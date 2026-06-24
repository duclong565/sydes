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

export interface K6Result {
  requests: number;
  rps: number;
  latencyAvgMs: number;
  latencyP95Ms: number;
  latencyMaxMs: number;
  errorRate: number;
}
export type LoadResult = K6Result | { error?: string; ok?: false; errors?: unknown[] };

export type CompileResult = { ok: true; output: { compose: string } } | { ok: false; errors: unknown[] };
export type RunResult = { runId: string; state: string } | { ok: false; errors: unknown[] };

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error(`request failed: ${url}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    // non-JSON body (e.g. a proxy 502) — surface it instead of silently parsing
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
  }
}

export const api = {
  examples: () => jsonFetch<ExampleEntry[]>('/api/examples'),
  compile: (graph: GraphLike) =>
    jsonFetch<CompileResult>('/api/compile', { method: 'POST', body: JSON.stringify({ graph }) }),
  run: (graph: GraphLike) =>
    jsonFetch<RunResult>('/api/run', { method: 'POST', body: JSON.stringify({ graph }) }),
  status: (runId: string) => jsonFetch<RunStatus>(`/api/status/${runId}`),
  stop: (runId: string) =>
    jsonFetch<{ runId: string; state: string }>('/api/stop', { method: 'POST', body: JSON.stringify({ runId }) }),
  logs: (runId: string) => jsonFetch<{ runId: string; lines: string }>(`/api/logs/${runId}`),
  load: (runId: string, rate: number, durationSec: number) =>
    jsonFetch<LoadResult>(`/api/load/${runId}`, { method: 'POST', body: JSON.stringify({ rate, durationSec }) }),
};
