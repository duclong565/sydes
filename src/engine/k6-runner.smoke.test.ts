import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSummary } from './k6-runner.js';
import { generateK6 } from '../compiler/generators/k6.js';

describe.skipIf(!process.env.RUN_DOCKER)('k6 per-tag mechanism (real run)', () => {
  it('produces per-scenario sub-metrics incl. dropped on a saturated target', () => {
    const net = 'sds-spike_smoke-net';
    execFileSync('docker', ['network', 'create', net]);
    try {
      execFileSync('docker', ['run', '-d', '--name', 'fast', '--network', net, '-e', 'PORT=8080', '-e', 'LATENCY_MS=5', 'sds/microservice']);
      execFileSync('docker', ['run', '-d', '--name', 'slow', '--network', net, '-e', 'PORT=8080', '-e', 'LATENCY_MS=200', 'sds/microservice']);
      const dir = mkdtempSync(join(tmpdir(), 'k6smoke-'));
      // scenario keys must be the hostnames the script targets:
      writeFileSync(join(dir, 'load.js'), generateK6(
        [ { slug: 'fast', port: 8080, rate: 50 }, { slug: 'slow', port: 8080, rate: 300 } ], 8));
      execFileSync('docker', ['run', '--rm', '--network', net, '-v', `${dir}:/sds`,
        'grafana/k6:0.49.0', 'run', '--summary-export=/sds/summary.json', '/sds/load.js'], { stdio: 'inherit' });
      const r = parseSummary(readFileSync(join(dir, 'summary.json'), 'utf8'),
        [ { slug: 'fast', targetRps: 50 }, { slug: 'slow', targetRps: 300 } ], 8);
      expect(r.perTarget).toHaveLength(2);
      const slow = r.perTarget.find((t) => t.slug === 'slow')!;
      expect(slow.dropped).toBeGreaterThan(0); // the saturation signal — assumption (3)
    } finally {
      execFileSync('docker', ['rm', '-f', 'fast', 'slow'], { stdio: 'ignore' });
      execFileSync('docker', ['network', 'rm', net], { stdio: 'ignore' });
    }
  }, 60_000);
});
