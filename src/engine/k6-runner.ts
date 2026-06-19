/** Aggregate result of one k6 load run. */
export interface K6Result {
  requests: number;       // total HTTP requests
  rps: number;            // throughput, req/s
  latencyAvgMs: number;
  latencyP95Ms: number;
  errorRate: number;      // 0..1 (http_req_failed)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Parse k6's `--summary-export` JSON (flat shape under `metrics`). Missing fields default to 0. */
export function parseSummary(json: string): K6Result {
  const data = JSON.parse(json) as { metrics?: Record<string, Record<string, unknown>> };
  const m = data.metrics ?? {};
  const reqs = m.http_reqs ?? {};
  const dur = m.http_req_duration ?? {};
  const failed = m.http_req_failed ?? {};
  return {
    requests: num(reqs.count),
    rps: num(reqs.rate),
    latencyAvgMs: num(dur.avg),
    latencyP95Ms: num(dur['p(95)']),
    errorRate: num(failed.value),
  };
}
