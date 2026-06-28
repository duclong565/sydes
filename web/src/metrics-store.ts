import { create } from 'zustand';

export interface ServiceMetric {
  service: string;
  cpuPercent: number;
  memMB: number;
  writes?: number;        // raw cumulative insert count (db services only)
  writesPerSec?: number;  // derived; absent on the wire
}

interface MetricEntry {
  cpuPercent: number;
  memMB: number;
  writes?: number;
  writesPerSec?: number;
}

interface MetricsState {
  byService: Record<string, MetricEntry>;
  lastT?: number; // wall-clock of the previous snapshot, for Δ/s
  setSnapshot(list: ServiceMetric[]): void;
  clear(): void;
}

export const useMetricsStore = create<MetricsState>((set, get) => ({
  byService: {},
  lastT: undefined,
  setSnapshot: (list) => {
    const now = Date.now();
    const prev = get().byService;
    const prevT = get().lastT;
    const byService: Record<string, MetricEntry> = {};
    for (const m of list) {
      const entry: MetricEntry = { cpuPercent: m.cpuPercent, memMB: m.memMB };
      if (m.writes !== undefined) {
        entry.writes = m.writes;
        const p = prev[m.service];
        if (p?.writes === undefined || prevT === undefined) {
          // first tick for this service — no delta yet
        } else if (m.writes < p.writes) {
          entry.writesPerSec = 0; // stats reset / crash recovery — re-baseline, never negative
        } else {
          const dt = (now - prevT) / 1000;
          entry.writesPerSec = dt > 0 ? (m.writes - p.writes) / dt : 0;
        }
      }
      byService[m.service] = entry;
    }
    set({ byService, lastT: now });
  },
  clear: () => set({ byService: {}, lastT: undefined }),
}));
