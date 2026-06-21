import { describe, it, expect } from 'vitest';
import { workerHandler } from './worker.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

describe('workerHandler.validate', () => {
  it('errors when worker has no kafka subscription', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'w', type: 'worker', label: 'W' }, { id: 'd', type: 'db', label: 'DB' }],
      edges: [{ source: 'w', target: 'd' }],
    };
    const errors = workerHandler.validate(g.nodes[0]!, buildIndex(g));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/subscribe/i);
  });
  it('passes when worker subscribes to kafka', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'w', type: 'worker', label: 'W' }, { id: 'k', type: 'kafka', label: 'Bus' }],
      edges: [{ source: 'w', target: 'k' }],
    };
    expect(workerHandler.validate(g.nodes[0]!, buildIndex(g))).toEqual([]);
  });
});

describe('workerHandler.compile', () => {
  it('emits SUBSCRIBE_TOPICS and DB_URL', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'w', type: 'worker', label: 'Payment Worker' },
        { id: 'k', type: 'kafka', label: 'Order Events' },
        { id: 'd', type: 'db', label: 'Pay DB' },
      ],
      edges: [{ source: 'w', target: 'k' }, { source: 'w', target: 'd' }],
    };
    const svc = workerHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.name).toBe('payment-worker');
    expect(svc.image).toBe('sds/worker');
    expect(svc.environment.SUBSCRIBE_TOPICS).toBe('order-events');
    expect(svc.environment.DB_URL).toBe('postgres://postgres:sds@pay-db:5432/postgres?sslmode=disable');
  });
});

describe('workerHandler.compile kafka broker', () => {
  it('emits KAFKA_BROKER on a worker->kafka edge', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'w', type: 'worker', label: 'Payment Worker' },
        { id: 'k', type: 'kafka', label: 'Order Events' },
      ],
      edges: [{ source: 'w', target: 'k' }],
    };
    const env = workerHandler.compile(g.nodes[0]!, buildIndex(g)).environment;
    expect(env.SUBSCRIBE_TOPICS).toBe('order-events');
    expect(env.KAFKA_BROKER).toBe('order-events:9092');
  });
});
