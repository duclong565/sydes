import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSim } from './cli.js';
import { ExperimentController } from './controller.js';
import type { Runner, RunResult } from './runner.js';
import type { K6Result } from './k6-runner.js';
import type { MetricsSnapshot } from './metrics.js';

/** Returns canned ps output for `ps`, success for everything else. */
class StubRunner implements Runner {
  async run(argv: string[]): Promise<RunResult> {
    if (argv.includes('ps')) {
      return { code: 0, stdout: '{"Name":"sds-pair-edge-a-1","State":"running","Publishers":[]}', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
}

class CapturingLogger {
  lines: string[] = [];
  errors: string[] = [];
  log(s: string) { this.lines.push(s); }
  error(s: string) { this.errors.push(s); }
}

const tmpDirs: string[] = [];
function tmpGraph(obj: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'sds-cli-'));
  tmpDirs.push(d);
  const p = join(d, 'graph.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const pairGraph = {
  experimentId: 'pair',
  nodes: [
    { id: 'a', type: 'service', label: 'Edge A' },
    { id: 'b', type: 'service', label: 'Edge B' },
  ],
  edges: [{ source: 'a', target: 'b' }],
};

describe('runSim', () => {
  it('compiles, ups, and prints status; returns experimentId', async () => {
    const out = new CapturingLogger();
    const c = new ExperimentController(new StubRunner(), { runRoot: mkdtempSync(join(tmpdir(), 'sds-run-')) });
    const id = await runSim(tmpGraph(pairGraph), c, out);
    expect(id).toBe('pair');
    expect(out.lines.some((l) => l.includes('sds-pair-edge-a-1'))).toBe(true);
    expect(out.lines.some((l) => l.includes('sds-pair_sds-pair-net'))).toBe(true);
  });

  it('throws and reports compile errors for an invalid graph', async () => {
    const out = new CapturingLogger();
    const c = new ExperimentController(new StubRunner(), { runRoot: mkdtempSync(join(tmpdir(), 'sds-run-')) });
    const orphan = { experimentId: 'bad', nodes: [{ id: 's', type: 'service', label: 'Orphan' }], edges: [] };
    await expect(runSim(tmpGraph(orphan), c, out)).rejects.toThrow(/compile failed/);
    expect(out.errors.some((e) => /Orphan|edge/i.test(e))).toBe(true);
  });

  it('tears down the partial stack when up fails', async () => {
    const calls: string[][] = [];
    const failUpRunner: Runner = {
      async run(argv: string[]) {
        calls.push(argv);
        if (argv.includes('up')) return { code: 1, stdout: '', stderr: 'kafka never healthy' };
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const out = new CapturingLogger();
    const c = new ExperimentController(failUpRunner, { runRoot: mkdtempSync(join(tmpdir(), 'sds-run-')) });
    await expect(runSim(tmpGraph(pairGraph), c, out)).rejects.toThrow(/kafka never healthy/);
    expect(calls.some((a) => a.includes('down'))).toBe(true);
  });
});

class StubK6 {
  ran = false;
  async run(_experimentId: string, _runDir: string, _targets: { slug: string; targetRps: number }[], _durationSec: number): Promise<K6Result> {
    this.ran = true;
    return {
      perTarget: [{ slug: 'edge-a', targetRps: 20, achievedRps: 10, requests: 100, dropped: 0, errorRate: 0, latencyAvgMs: 5, latencyP95Ms: 9, latencyMaxMs: 20 }],
      total: { requests: 100, targetRps: 20, achievedRps: 10, dropped: 0, errorRate: 0 },
    };
  }
}

describe('runSim with load', () => {
  it('runs k6 and prints the load result when loadConfig + k6Runner are given', async () => {
    const out = new CapturingLogger();
    const c = new ExperimentController(new StubRunner(), { runRoot: mkdtempSync(join(tmpdir(), 'sds-run-')) });
    const k6 = new StubK6();
    await runSim(tmpGraph(pairGraph), c, out, {
      loadConfig: { durationSec: 3, targets: [{ nodeId: 'a', rate: 20 }] },
      k6Runner: k6,
    });
    expect(k6.ran).toBe(true);
    expect(out.lines.some((l) => l.includes('load total: requests=100'))).toBe(true);
  });

  it('does not run k6 when no loadConfig is given', async () => {
    const out = new CapturingLogger();
    const c = new ExperimentController(new StubRunner(), { runRoot: mkdtempSync(join(tmpdir(), 'sds-run-')) });
    const k6 = new StubK6();
    await runSim(tmpGraph(pairGraph), c, out, { k6Runner: k6 });
    expect(k6.ran).toBe(false);
  });
});

class StubCollector {
  calls = 0;
  async sample(_experimentId: string): Promise<MetricsSnapshot[]> {
    this.calls++;
    return [{ name: 'edge-a', cpuPercent: 12.5, memMB: 8 }];
  }
}

describe('runSim with metrics', () => {
  it('prints a baseline metrics sample when metrics is set (no load)', async () => {
    const out = new CapturingLogger();
    const c = new ExperimentController(new StubRunner(), { runRoot: mkdtempSync(join(tmpdir(), 'sds-run-')) });
    const col = new StubCollector();
    await runSim(tmpGraph(pairGraph), c, out, { metrics: { collector: col, intervalMs: 10 } });
    expect(col.calls).toBeGreaterThanOrEqual(1);
    expect(out.lines.some((l) => l.includes('cpu 12.5%'))).toBe(true);
  });

  it('samples metrics during a load run', async () => {
    const out = new CapturingLogger();
    const c = new ExperimentController(new StubRunner(), { runRoot: mkdtempSync(join(tmpdir(), 'sds-run-')) });
    const col = new StubCollector();
    const k6 = new StubK6();
    await runSim(tmpGraph(pairGraph), c, out, {
      loadConfig: { durationSec: 3, targets: [{ nodeId: 'a', rate: 20 }] },
      k6Runner: k6,
      metrics: { collector: col, intervalMs: 10 },
    });
    expect(k6.ran).toBe(true);
    expect(col.calls).toBeGreaterThanOrEqual(1);
  });
});
