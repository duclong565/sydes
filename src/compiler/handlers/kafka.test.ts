import { describe, it, expect } from 'vitest';
import { kafkaHandler } from './kafka.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

describe('kafkaHandler.validate', () => {
  it('errors when kafka has no publisher (only a worker subscribes)', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'k', type: 'kafka', label: 'Bus' }, { id: 'w', type: 'worker', label: 'W' }],
      edges: [{ source: 'w', target: 'k' }],
    };
    const errors = kafkaHandler.validate(g.nodes[0]!, buildIndex(g));
    expect(errors.some((e) => /publisher/i.test(e.message))).toBe(true);
    expect(errors.some((e) => /subscriber/i.test(e.message))).toBe(false);
  });
  it('errors when kafka has no subscriber (only a service publishes)', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 's', type: 'service', label: 'S' }, { id: 'k', type: 'kafka', label: 'Bus' }],
      edges: [{ source: 's', target: 'k' }],
    };
    const errors = kafkaHandler.validate(g.nodes[1]!, buildIndex(g));
    expect(errors.some((e) => /subscriber/i.test(e.message))).toBe(true);
    expect(errors.some((e) => /publisher/i.test(e.message))).toBe(false);
  });
  it('errors with both messages when kafka has no edges at all', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'k', type: 'kafka', label: 'Bus' }], edges: [] };
    const errors = kafkaHandler.validate(g.nodes[0]!, buildIndex(g));
    expect(errors).toHaveLength(2);
  });
  it('passes with a service publisher and a worker subscriber', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 's', type: 'service', label: 'S' },
        { id: 'k', type: 'kafka', label: 'Bus' },
        { id: 'w', type: 'worker', label: 'W' },
      ],
      edges: [{ source: 's', target: 'k' }, { source: 'w', target: 'k' }],
    };
    expect(kafkaHandler.validate(g.nodes[1]!, buildIndex(g))).toEqual([]);
  });
});

describe('kafkaHandler.compile', () => {
  it('emits kafka service with a healthcheck', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'k', type: 'kafka', label: 'Event Bus' }], edges: [] };
    const svc = kafkaHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.name).toBe('event-bus');
    expect(svc.image).toBe('apache/kafka:latest');
    expect(svc.healthcheck).toBeDefined();
    expect(svc.healthcheck!.retries).toBeGreaterThan(0);
  });
});

describe('kafkaHandler.compile KRaft config', () => {
  it('emits a single-node KRaft listener config', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'k', type: 'kafka', label: 'Event Bus' }], edges: [] };
    const env = kafkaHandler.compile(g.nodes[0]!, buildIndex(g)).environment;
    expect(env.KAFKA_NODE_ID).toBe('0');
    expect(env.KAFKA_PROCESS_ROLES).toBe('broker,controller');
    expect(env.KAFKA_CONTROLLER_QUORUM_VOTERS).toBe('0@event-bus:9093');
    expect(env.KAFKA_LISTENERS).toBe('PLAINTEXT://:9092,CONTROLLER://:9093');
    expect(env.KAFKA_ADVERTISED_LISTENERS).toBe('PLAINTEXT://event-bus:9092');
    expect(env.KAFKA_CONTROLLER_LISTENER_NAMES).toBe('CONTROLLER');
    expect(env.KAFKA_LISTENER_SECURITY_PROTOCOL_MAP).toBe('CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT');
    expect(env.KAFKA_INTER_BROKER_LISTENER_NAME).toBe('PLAINTEXT');
  });
});
