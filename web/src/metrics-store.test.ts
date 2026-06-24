import { describe, it, expect, beforeEach } from 'vitest';
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
