import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner } from './runner.js';
import type { LoadTargetResolved } from '../compiler/types.js';

const K6_IMAGE = 'grafana/k6:0.49.0'; // pinned (Task 0); --summary-export + tagged sub-metrics depend on it

export interface TargetResult {
  slug: string;
  targetRps: number;
  achievedRps: number;
  requests: number;
  dropped: number;
  errorRate: number;
  latencyAvgMs: number;
  latencyP95Ms: number;
  latencyMaxMs: number;
}

export interface K6Result {
  perTarget: TargetResult[];
  total: { requests: number; targetRps: number; achievedRps: number; dropped: number; errorRate: number };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function parseSummary(json: string, targets: LoadTargetResolved[], durationSec: number): K6Result {
  const data = JSON.parse(json) as { metrics?: Record<string, Record<string, unknown>> };
  const m = data.metrics ?? {};
  const sub = (metric: string, slug: string) => m[`${metric}{scenario:${slug}}`] ?? {};
  const top = (metric: string) => m[metric] ?? {};

  const perTarget: TargetResult[] = targets.map((t) => {
    const reqs = sub('http_reqs', t.slug);
    const dur = sub('http_req_duration', t.slug);
    const failed = sub('http_req_failed', t.slug);
    const dropped = sub('dropped_iterations', t.slug);
    const requests = num(reqs.count);
    return {
      slug: t.slug,
      targetRps: t.targetRps,
      achievedRps: requests / durationSec,
      requests,
      dropped: num(dropped.count),
      errorRate: num(failed.value),
      latencyAvgMs: num(dur.avg),
      latencyP95Ms: num(dur['p(95)']),
      latencyMaxMs: num(dur.max),
    };
  });

  const totalRequests = num(top('http_reqs').count);
  return {
    perTarget,
    total: {
      requests: totalRequests,
      targetRps: targets.reduce((s, t) => s + t.targetRps, 0),
      achievedRps: totalRequests / durationSec,
      dropped: num(top('dropped_iterations').count),
      errorRate: num(top('http_req_failed').value),
    },
  };
}

/** Runs grafana/k6 as a one-shot container against an experiment's network. */
export class K6Runner {
  constructor(private readonly runner: Runner) {}

  async run(
    experimentId: string,
    runDir: string,
    targets: LoadTargetResolved[],
    durationSec: number,
  ): Promise<K6Result> {
    const net = `sds-${experimentId}_sds-${experimentId}-net`;
    const r = await this.runner.run([
      'docker', 'run', '--rm', '--network', net,
      '-v', `${runDir}:/sds`,
      K6_IMAGE, 'run', '--summary-export=/sds/summary.json', '/sds/load.js',
    ]);
    if (r.code !== 0) {
      throw new Error(`k6 run failed (exit ${r.code}): ${r.stderr.trim()}`);
    }
    return parseSummary(readFileSync(join(runDir, 'summary.json'), 'utf8'), targets, durationSec);
  }
}
