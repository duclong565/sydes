import { describe, it, expect } from 'vitest';
import { cpuPercent, memMB } from './metrics.js';
import type { DockerStats } from './metrics.js';

// cpuDelta = 2e6-1e6 = 1e6 ; sysDelta = 1e8-9e7 = 1e7 ; cpus=4 -> (1e6/1e7)*4*100 = 40
export const sample: DockerStats = {
  cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 100_000_000, online_cpus: 4 },
  precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 90_000_000 },
  memory_stats: { usage: 18 * 1024 * 1024 },
};

describe('cpuPercent', () => {
  it('computes percent from the cpu/system deltas and core count', () => {
    expect(cpuPercent(sample)).toBe(40);
  });
  it('returns 0 when there is no cpu delta (idle)', () => {
    const idle: DockerStats = {
      cpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 100_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 90_000_000 },
      memory_stats: { usage: 1024 },
    };
    expect(cpuPercent(idle)).toBe(0);
  });
  it('returns 0 (not NaN) when sysDelta is non-positive', () => {
    const flat: DockerStats = {
      cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 90_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 90_000_000 },
      memory_stats: {},
    };
    expect(cpuPercent(flat)).toBe(0);
  });
});

describe('memMB', () => {
  it('converts bytes to MB', () => {
    expect(memMB(sample)).toBe(18);
  });
  it('defaults missing usage to 0', () => {
    expect(memMB({ ...sample, memory_stats: {} })).toBe(0);
  });
});

import { MetricsCollector } from './metrics.js';
import type { StatsSource, ContainerRef } from './metrics.js';

class FakeStatsSource implements StatsSource {
  constructor(
    private containers: ContainerRef[],
    private statsById: Record<string, DockerStats>,
  ) {}
  async list(): Promise<ContainerRef[]> {
    return this.containers;
  }
  async stats(id: string): Promise<DockerStats> {
    return this.statsById[id]!;
  }
}

describe('MetricsCollector.sample', () => {
  it('returns one snapshot per container with computed cpu/mem', async () => {
    // c2: cpuDelta=5e5 / sysDelta=1e7 *4*100 = 20 ; mem 9MB
    const c2: DockerStats = {
      cpu_stats: { cpu_usage: { total_usage: 1_500_000 }, system_cpu_usage: 100_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 90_000_000 },
      memory_stats: { usage: 9 * 1024 * 1024 },
    };
    const src = new FakeStatsSource(
      [{ id: 'c1', name: 'edge-a' }, { id: 'c2', name: 'edge-b' }],
      { c1: sample, c2 },
    );
    const snaps = await new MetricsCollector(src).sample('pair');
    expect(snaps).toHaveLength(2);
    expect(snaps[0]).toEqual({ name: 'edge-a', cpuPercent: 40, memMB: 18 });
    expect(snaps[1]).toEqual({ name: 'edge-b', cpuPercent: 20, memMB: 9 });
  });
});
