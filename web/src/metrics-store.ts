import { create } from 'zustand';

export interface ServiceMetric {
  service: string;
  cpuPercent: number;
  memMB: number;
}

interface MetricsState {
  byService: Record<string, { cpuPercent: number; memMB: number }>;
  setSnapshot(list: ServiceMetric[]): void;
  clear(): void;
}

export const useMetricsStore = create<MetricsState>((set) => ({
  byService: {},
  setSnapshot: (list) =>
    set({ byService: Object.fromEntries(list.map((m) => [m.service, { cpuPercent: m.cpuPercent, memMB: m.memMB }])) }),
  clear: () => set({ byService: {} }),
}));
