import { describe, it, expect } from 'vitest';
import { kafkaHandler } from './kafka.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

describe('kafkaHandler.validate', () => {
  it('errors when kafka has no publisher', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'k', type: 'kafka', label: 'Bus' }, { id: 'w', type: 'worker', label: 'W' }],
      edges: [{ source: 'k', target: 'w' }],
    };
    const errors = kafkaHandler.validate(g.nodes[0]!, buildIndex(g));
    expect(errors.some((e) => /publisher/i.test(e.message))).toBe(true);
  });
  it('errors when kafka has no subscriber', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 's', type: 'service', label: 'S' }, { id: 'k', type: 'kafka', label: 'Bus' }],
      edges: [{ source: 's', target: 'k' }],
    };
    const errors = kafkaHandler.validate(g.nodes[1]!, buildIndex(g));
    expect(errors.some((e) => /subscriber/i.test(e.message))).toBe(true);
  });
  it('passes with both a publisher and a subscriber', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 's', type: 'service', label: 'S' },
        { id: 'k', type: 'kafka', label: 'Bus' },
        { id: 'w', type: 'worker', label: 'W' },
      ],
      edges: [{ source: 's', target: 'k' }, { source: 'k', target: 'w' }],
    };
    expect(kafkaHandler.validate(g.nodes[1]!, buildIndex(g))).toEqual([]);
  });
});

describe('kafkaHandler.compile', () => {
  it('emits kafka service with a healthcheck', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'k', type: 'kafka', label: 'Event Bus' }], edges: [] };
    const svc = kafkaHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.name).toBe('event-bus');
    expect(svc.image).toBe('bitnami/kafka:latest');
    expect(svc.healthcheck).toBeDefined();
    expect(svc.healthcheck!.retries).toBeGreaterThan(0);
  });
});
