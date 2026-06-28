import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useMetricsStore } from './metrics-store.js';

beforeEach(() => useMetricsStore.setState({ byService: {} }));

describe('metrics-store', () => {
  it('setSnapshot keys metrics by service', () => {
    useMetricsStore.getState().setSnapshot([
      { service: 'order-service', cpuPercent: 12, memMB: 48 },
      { service: 'payment-worker', cpuPercent: 5, memMB: 30 },
    ]);
    const { byService } = useMetricsStore.getState();
    expect(byService['order-service']).toEqual({ cpuPercent: 12, memMB: 48 });
    expect(byService['payment-worker']!.memMB).toBe(30);
  });
  it('clear empties the store', () => {
    useMetricsStore.getState().setSnapshot([{ service: 'x', cpuPercent: 1, memMB: 1 }]);
    useMetricsStore.getState().clear();
    expect(useMetricsStore.getState().byService).toEqual({});
  });
});

describe('metrics-store writes Δ/s', () => {
  beforeEach(() => useMetricsStore.setState({ byService: {}, lastT: undefined }));

  it('keeps the writes count but no delta on the first snapshot', () => {
    useMetricsStore.getState().setSnapshot([{ service: 'db-1', cpuPercent: 1, memMB: 1, writes: 100 }]);
    const e = useMetricsStore.getState().byService['db-1']!;
    expect(e.writes).toBe(100);
    expect(e.writesPerSec).toBeUndefined();
  });

  it('computes a positive rate on the next snapshot', () => {
    const t0 = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    useMetricsStore.getState().setSnapshot([{ service: 'db-1', cpuPercent: 1, memMB: 1, writes: 100 }]);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 2000); // +2s
    useMetricsStore.getState().setSnapshot([{ service: 'db-1', cpuPercent: 1, memMB: 1, writes: 900 }]);
    expect(useMetricsStore.getState().byService['db-1']!.writesPerSec).toBeCloseTo(400, 0); // (900-100)/2
    vi.restoreAllMocks();
  });

  it('clamps the rate to 0 on a decrease (stats reset)', () => {
    const t0 = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    useMetricsStore.getState().setSnapshot([{ service: 'db-1', cpuPercent: 1, memMB: 1, writes: 900 }]);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 1500);
    useMetricsStore.getState().setSnapshot([{ service: 'db-1', cpuPercent: 1, memMB: 1, writes: 5 }]);
    expect(useMetricsStore.getState().byService['db-1']!.writesPerSec).toBe(0);
    vi.restoreAllMocks();
  });
});
