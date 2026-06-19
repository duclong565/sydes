export interface MetricsSnapshot {
  name: string;        // service/container name
  cpuPercent: number;  // 0..N*100
  memMB: number;
}

// Minimal shape of dockerode's container.stats() output we read.
export interface DockerStats {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number };
  memory_stats: { usage?: number };
}

export function cpuPercent(s: DockerStats): number {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
  const cpus = s.cpu_stats.online_cpus ?? 1;
  return sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
}

export function memMB(s: DockerStats): number {
  return (s.memory_stats.usage ?? 0) / (1024 * 1024);
}
