import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { K6Runner, parseSummary } from './k6-runner.js';
import type { Runner, RunResult } from './runner.js';

const summary = JSON.stringify({
  metrics: {
    http_reqs: { count: 2500, rate: 250 },
    http_req_failed: { value: 0.01 },
    dropped_iterations: { count: 120 },
    'http_reqs{scenario:checkout}': { count: 500, rate: 50 },
    'http_req_duration{scenario:checkout}': { avg: 22.1, 'p(95)': 40, max: 96 },
    'http_req_failed{scenario:checkout}': { value: 0.014 },
    'dropped_iterations{scenario:checkout}': { count: 120 },
    'http_reqs{scenario:gateway}': { count: 2000, rate: 200 },
    'http_req_duration{scenario:gateway}': { avg: 9.4, 'p(95)': 18, max: 61 },
    'http_req_failed{scenario:gateway}': { value: 0.002 },
    // NOTE: no dropped_iterations{scenario:gateway} — zero-drop scenario emits no samples
  },
});

describe('parseSummary per-target', () => {
  it('splits metrics by scenario tag and sums the total', () => {
    const r = parseSummary(summary, [
      { slug: 'gateway', targetRps: 200 },
      { slug: 'checkout', targetRps: 50 },
    ], 10);
    const checkout = r.perTarget.find((t) => t.slug === 'checkout')!;
    expect(checkout).toMatchObject({ targetRps: 50, achievedRps: 50, requests: 500, dropped: 120, droppedRps: 12, latencyP95Ms: 40 });
    const gateway = r.perTarget.find((t) => t.slug === 'gateway')!;
    expect(gateway.dropped).toBe(0); // missing sub-metric defaults to 0
    expect(gateway.droppedRps).toBe(0);
    expect(r.total).toMatchObject({ requests: 2500, achievedRps: 250, targetRps: 250, dropped: 120, droppedRps: 12 });
  });
});

class FakeRunner implements Runner {
  calls: string[][] = [];
  result: RunResult = { code: 0, stdout: '', stderr: '' };
  async run(argv: string[]): Promise<RunResult> {
    this.calls.push(argv);
    return this.result;
  }
}

describe('K6Runner.run', () => {
  it('builds the docker run argv and parses summary.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sds-k6-'));
    writeFileSync(join(dir, 'summary.json'), summary);
    const runner = new FakeRunner();
    const targets = [{ slug: 'gateway', targetRps: 200 }, { slug: 'checkout', targetRps: 50 }];
    const result = await new K6Runner(runner).run('exp1', dir, targets, 10);
    expect(runner.calls[0]).toEqual([
      'docker', 'run', '--rm', '--network', 'sds-exp1_sds-exp1-net',
      '-v', `${dir}:/sds`,
      'grafana/k6:0.49.0', 'run', '--summary-export=/sds/summary.json', '/sds/load.js',
    ]);
    expect(result.perTarget).toHaveLength(2);
    expect(result.total.requests).toBe(2500);
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws with stderr on a non-zero k6 exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sds-k6-'));
    const runner = new FakeRunner();
    runner.result = { code: 99, stdout: '', stderr: 'script error' };
    await expect(new K6Runner(runner).run('exp1', dir, [], 10)).rejects.toThrow(/script error/);
    rmSync(dir, { recursive: true, force: true });
  });
});
