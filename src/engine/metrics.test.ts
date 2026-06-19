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
