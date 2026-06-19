import { describe, it, expect } from 'vitest';
import { lbHandler } from './lb.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

describe('lbHandler.validate', () => {
  it('errors when lb has fewer than 2 service upstreams', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'lb', type: 'lb', label: 'LB' }, { id: 's', type: 'service', label: 'S' }],
      edges: [{ source: 'lb', target: 's' }],
    };
    const errors = lbHandler.validate(g.nodes[0]!, buildIndex(g));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/2/);
  });
  it('passes with 2 service upstreams', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [
        { id: 'lb', type: 'lb', label: 'LB' },
        { id: 's1', type: 'service', label: 'S1' },
        { id: 's2', type: 'service', label: 'S2' },
      ],
      edges: [{ source: 'lb', target: 's1' }, { source: 'lb', target: 's2' }],
    };
    expect(lbHandler.validate(g.nodes[0]!, buildIndex(g))).toEqual([]);
  });
});

describe('lbHandler.compile', () => {
  it('emits nginx service with port 80', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'lb', type: 'lb', label: 'Gateway LB' }], edges: [] };
    const svc = lbHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.name).toBe('gateway-lb');
    expect(svc.image).toBe('nginx:alpine');
    expect(svc.ports).toEqual(['80:80']);
  });
});

describe('lbHandler.compile volumes', () => {
  it('mounts the generated nginx config into the container', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'lb', type: 'lb', label: 'Gateway LB' }], edges: [] };
    const svc = lbHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.volumes).toEqual(['./nginx.conf:/etc/nginx/conf.d/default.conf:ro']);
  });
});
