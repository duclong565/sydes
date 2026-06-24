import { describe, it, expect } from 'vitest';
import { serviceName } from './metrics-stream.js';

describe('serviceName', () => {
  it('strips the sds-<runId>- prefix and -<n> replica suffix', () => {
    expect(serviceName('sds-saga-order-service-1', 'saga')).toBe('order-service');
    expect(serviceName('sds-saga-orders-db-1', 'saga')).toBe('orders-db');
    expect(serviceName('sds-saga-order-events-2', 'saga')).toBe('order-events');
  });
  it('tolerates names without the expected shape', () => {
    expect(serviceName('weird', 'saga')).toBe('weird');
  });
});
