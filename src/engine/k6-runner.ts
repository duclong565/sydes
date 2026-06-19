import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner } from './runner.js';

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

/** Runs grafana/k6 as a one-shot container against an experiment's network. */
export class K6Runner {
  constructor(private readonly runner: Runner) {}

  async run(experimentId: string, runDir: string): Promise<K6Result> {
    // Docker Compose names the network <project>_<key>: project `sds-<id>` + YAML key `sds-<id>-net`.
    const net = `sds-${experimentId}_sds-${experimentId}-net`;
    const r = await this.runner.run([
      'docker', 'run', '--rm', '--network', net,
      '-v', `${runDir}:/sds`,
      'grafana/k6', 'run', '--summary-export=/sds/summary.json', '/sds/load.js',
    ]);
    if (r.code !== 0) {
      throw new Error(`k6 run failed (exit ${r.code}): ${r.stderr.trim()}`);
    }
    return parseSummary(readFileSync(join(runDir, 'summary.json'), 'utf8'));
  }
}
