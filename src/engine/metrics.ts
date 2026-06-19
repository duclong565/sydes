import Docker from 'dockerode';

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

export interface ContainerRef {
  id: string;
  name: string;
}

export interface StatsSource {
  list(experimentId: string): Promise<ContainerRef[]>;
  stats(containerId: string): Promise<DockerStats>;
}

/** Collects per-service CPU/mem snapshots from a StatsSource. */
export class MetricsCollector {
  constructor(private readonly source: StatsSource) {}

  async sample(experimentId: string): Promise<MetricsSnapshot[]> {
    const containers = await this.source.list(experimentId);
    return Promise.all(
      containers.map(async (c) => {
        const s = await this.source.stats(c.id);
        return { name: c.name, cpuPercent: cpuPercent(s), memMB: memMB(s) };
      }),
    );
  }
}

/** Real StatsSource: reads container stats from the Docker API via dockerode. */
export class DockerodeStatsSource implements StatsSource {
  private readonly docker = new Docker();

  async list(experimentId: string): Promise<ContainerRef[]> {
    const cs = await this.docker.listContainers({
      filters: { label: [`com.docker.compose.project=sds-${experimentId}`] },
    });
    return cs.map((c) => ({ id: c.Id, name: c.Names[0]?.replace(/^\//, '') ?? c.Id }));
  }

  async stats(id: string): Promise<DockerStats> {
    return this.docker.getContainer(id).stats({ stream: false }) as unknown as Promise<DockerStats>;
  }
}
