import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { K6Runner, parseSummary } from './k6-runner.js';
import type { Runner, RunResult } from './runner.js';

// Representative k6 --summary-export shape (flat under metrics).
export const fixture = JSON.stringify({
  metrics: {
    http_reqs: { count: 30000, rate: 498.3 },
    http_req_duration: { avg: 12.4, 'p(95)': 41.0, max: 120 },
    http_req_failed: { value: 0.018, passes: 29460, fails: 540 },
  },
});

class FakeRunner implements Runner {
  calls: string[][] = [];
  result: RunResult = { code: 0, stdout: '', stderr: '' };
  async run(argv: string[]): Promise<RunResult> {
    this.calls.push(argv);
    return this.result;
  }
}

describe('parseSummary', () => {
  it('extracts the headline metrics', () => {
    expect(parseSummary(fixture)).toEqual({
      requests: 30000,
      rps: 498.3,
      latencyAvgMs: 12.4,
      latencyP95Ms: 41.0,
      latencyMaxMs: 120,
      errorRate: 0.018,
    });
  });

  it('defaults missing metrics to 0', () => {
    const r = parseSummary(JSON.stringify({ metrics: { http_reqs: { count: 5 } } }));
    expect(r.requests).toBe(5);
    expect(r.rps).toBe(0);
    expect(r.latencyAvgMs).toBe(0);
    expect(r.latencyP95Ms).toBe(0);
    expect(r.latencyMaxMs).toBe(0);
    expect(r.errorRate).toBe(0);
  });

  it('parses peak latency (http_req_duration.max) into latencyMaxMs', () => {
    const json = JSON.stringify({ metrics: {
      http_reqs: { count: 100, rate: 10 },
      http_req_duration: { avg: 8, 'p(95)': 18, max: 95.5 },
      http_req_failed: { value: 0 },
    }});
    expect(parseSummary(json).latencyMaxMs).toBe(95.5);
  });

  it('handles an empty object without throwing', () => {
    expect(parseSummary('{}')).toEqual({
      requests: 0, rps: 0, latencyAvgMs: 0, latencyP95Ms: 0, latencyMaxMs: 0, errorRate: 0,
    });
  });
});

describe('K6Runner.run', () => {
  it('builds the docker run argv and parses summary.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sds-k6-'));
    writeFileSync(join(dir, 'summary.json'), fixture);
    const runner = new FakeRunner();
    const result = await new K6Runner(runner).run('exp1', dir);
    expect(runner.calls[0]).toEqual([
      'docker', 'run', '--rm', '--network', 'sds-exp1_sds-exp1-net',
      '-v', `${dir}:/sds`,
      'grafana/k6', 'run', '--summary-export=/sds/summary.json', '/sds/load.js',
    ]);
    expect(result.requests).toBe(30000);
    expect(result.rps).toBe(498.3);
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws with stderr on a non-zero k6 exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sds-k6-'));
    const runner = new FakeRunner();
    runner.result = { code: 99, stdout: '', stderr: 'script error' };
    await expect(new K6Runner(runner).run('exp1', dir)).rejects.toThrow(/script error/);
    rmSync(dir, { recursive: true, force: true });
  });
});
