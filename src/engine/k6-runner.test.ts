import { describe, it, expect } from 'vitest';
import { parseSummary } from './k6-runner.js';

// Representative k6 --summary-export shape (flat under metrics).
export const fixture = JSON.stringify({
  metrics: {
    http_reqs: { count: 30000, rate: 498.3 },
    http_req_duration: { avg: 12.4, 'p(95)': 41.0, max: 120 },
    http_req_failed: { value: 0.018, passes: 29460, fails: 540 },
  },
});

describe('parseSummary', () => {
  it('extracts the headline metrics', () => {
    expect(parseSummary(fixture)).toEqual({
      requests: 30000,
      rps: 498.3,
      latencyAvgMs: 12.4,
      latencyP95Ms: 41.0,
      errorRate: 0.018,
    });
  });

  it('defaults missing metrics to 0', () => {
    const r = parseSummary(JSON.stringify({ metrics: { http_reqs: { count: 5 } } }));
    expect(r.requests).toBe(5);
    expect(r.rps).toBe(0);
    expect(r.latencyAvgMs).toBe(0);
    expect(r.latencyP95Ms).toBe(0);
    expect(r.errorRate).toBe(0);
  });

  it('handles an empty object without throwing', () => {
    expect(parseSummary('{}')).toEqual({
      requests: 0, rps: 0, latencyAvgMs: 0, latencyP95Ms: 0, errorRate: 0,
    });
  });
});
