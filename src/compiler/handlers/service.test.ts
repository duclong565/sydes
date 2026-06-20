import { describe, it, expect } from 'vitest';
import { serviceHandler } from './service.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

function idxFor(graph: Graph) {
  return buildIndex(graph);
}

describe('serviceHandler.validate', () => {
  it('errors when service has no edges', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 's', type: 'service', label: 'Orphan' }], edges: [] };
    const errors = serviceHandler.validate(g.nodes[0]!, idxFor(g));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/at least one edge/i);
  });
  it('passes when service has an edge', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 's', type: 'service', label: 'Order' }, { id: 'd', type: 'db', label: 'OrdersDB' }],
      edges: [{ source: 's', target: 'd' }],
    };
    expect(serviceHandler.validate(g.nodes[0]!, idxFor(g))).toEqual([]);
  });
});

describe('serviceHandler.compile', () => {
  it('emits DB_URL and PUBLISH_TOPIC from outgoing edges', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 's', type: 'service', label: 'Order Service', config: { latencyMs: 20, errorRate: 0.01 } },
        { id: 'd', type: 'db', label: 'Orders DB' },
        { id: 'k', type: 'kafka', label: 'Events' },
      ],
      edges: [{ source: 's', target: 'd' }, { source: 's', target: 'k' }],
    };
    const svc = serviceHandler.compile(g.nodes[0]!, idxFor(g));
    expect(svc.name).toBe('order-service');
    expect(svc.image).toBe('sds/microservice');
    expect(svc.environment.LATENCY_MS).toBe('20');
    expect(svc.environment.ERROR_RATE).toBe('0.01');
    expect(svc.environment.DB_URL).toBe('postgres://orders-db:5432');
    expect(svc.environment.PUBLISH_TOPIC).toBe('events');
  });
});

describe('serviceHandler.compile kafka broker', () => {
  it('emits KAFKA_BROKER on a service->kafka edge', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 's', type: 'service', label: 'Order' },
        { id: 'k', type: 'kafka', label: 'Events' },
      ],
      edges: [{ source: 's', target: 'k' }],
    };
    const env = serviceHandler.compile(g.nodes[0]!, buildIndex(g)).environment;
    expect(env.PUBLISH_TOPIC).toBe('events');
    expect(env.KAFKA_BROKER).toBe('events:9092');
  });
});
