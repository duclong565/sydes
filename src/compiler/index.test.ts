import { describe, it, expect } from 'vitest';
import { compile } from './index.js';
import type { Graph } from './types.js';

const sagaGraph: Graph = {
  experimentId: 'exp1',
  nodes: [
    { id: 'o', type: 'service', label: 'Order Service' },
    { id: 'k', type: 'kafka', label: 'Order Events' },
    { id: 'p', type: 'worker', label: 'Payment Worker' },
    { id: 'd', type: 'db', label: 'Orders DB' },
  ],
  edges: [
    { source: 'o', target: 'k' },
    { source: 'o', target: 'd' },
    { source: 'p', target: 'k' },
  ],
};

describe('compile — valid graph', () => {
  it('produces compose output for a Saga topology', () => {
    const result = compile(sagaGraph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.compose).toContain('order-service:');
    expect(result.output.compose).toContain('PUBLISH_TOPIC: "order-events"');
    expect(result.output.compose).toContain('SUBSCRIBE_TOPICS: "order-events"');
    expect(result.output.compose).toContain('sds-exp1-net:');
  });

  it('generates a k6 script when loadConfig is given', () => {
    const result = compile(sagaGraph, { rate: 5000, durationSec: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.k6).toContain('rate: 5000');
    expect(result.output.k6).toContain('http://order-service:8080/');
  });
});

describe('compile — duplicate labels', () => {
  it('fails on duplicate labels before per-node validation runs', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'a', type: 'service', label: 'API' },
        { id: 'b', type: 'service', label: 'api' },
      ],
      edges: [], // both orphan services — would each error if per-node validation ran
    };
    const result = compile(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors.every((e) => /duplicate/i.test(e.message))).toBe(true);
  });
});

describe('compile — invalid graph', () => {
  it('collects all validation errors', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'lb', type: 'lb', label: 'LB' },
        { id: 's', type: 'service', label: 'Only One' },
      ],
      edges: [{ source: 'lb', target: 's' }],
    };
    const result = compile(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // LB has <2 upstreams
    expect(result.errors.some((e) => e.nodeId === 'lb')).toBe(true);
  });
});

describe('compile — load balancer', () => {
  it('generates nginx config and targets lb for k6', () => {
    const g: Graph = {
      experimentId: 'exp2',
      nodes: [
        { id: 'lb', type: 'lb', label: 'Gateway' },
        { id: 's1', type: 'service', label: 'Svc One' },
        { id: 's2', type: 'service', label: 'Svc Two' },
        { id: 'd', type: 'db', label: 'Shared DB' },
      ],
      edges: [
        { source: 'lb', target: 's1' },
        { source: 'lb', target: 's2' },
        { source: 's1', target: 'd' },
        { source: 's2', target: 'd' },
      ],
    };
    const result = compile(g, { rate: 100, durationSec: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.nginx).toContain('server svc-one:8080;');
    expect(result.output.nginx).toContain('server svc-two:8080;');
    expect(result.output.k6).toContain('http://gateway:80/');
  });
});

describe('compile — saga kafka wiring', () => {
  it('wires KRaft config + KAFKA_BROKER for a service->kafka<-worker graph', () => {
    const g: Graph = {
      experimentId: 'saga',
      nodes: [
        { id: 'o', type: 'service', label: 'Order Service' },
        { id: 'k', type: 'kafka', label: 'Order Events' },
        { id: 'p', type: 'worker', label: 'Payment Worker' },
      ],
      edges: [
        { source: 'o', target: 'k' },
        { source: 'p', target: 'k' },
      ],
    };
    const result = compile(g);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.compose).toContain('KAFKA_CFG_ADVERTISED_LISTENERS: "PLAINTEXT://order-events:9092"');
    expect(result.output.compose).toContain('KAFKA_BROKER: "order-events:9092"');
  });
});

describe('compile — load balancer volumes', () => {
  it('emits the nginx config mount on the lb service', () => {
    const g: Graph = {
      experimentId: 'lbv',
      nodes: [
        { id: 'lb', type: 'lb', label: 'Gateway' },
        { id: 's1', type: 'service', label: 'Svc One' },
        { id: 's2', type: 'service', label: 'Svc Two' },
      ],
      edges: [
        { source: 'lb', target: 's1' },
        { source: 'lb', target: 's2' },
      ],
    };
    const result = compile(g);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.compose).toContain('./nginx.conf:/etc/nginx/conf.d/default.conf:ro');
  });
});
