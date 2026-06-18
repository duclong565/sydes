import { describe, it, expect } from 'vitest';
import { buildIndex } from './graph-index.js';
import type { Graph } from './types.js';

const graph: Graph = {
  experimentId: 'exp1',
  nodes: [
    { id: 'a', type: 'service', label: 'A' },
    { id: 'k', type: 'kafka', label: 'Bus' },
    { id: 'w', type: 'worker', label: 'W' },
  ],
  edges: [
    { source: 'a', target: 'k' },
    { source: 'w', target: 'k' },
  ],
};

describe('buildIndex', () => {
  it('maps node ids to nodes', () => {
    const idx = buildIndex(graph);
    expect(idx.nodeMap.get('a')?.label).toBe('A');
  });
  it('returns outgoing edges for a node', () => {
    const idx = buildIndex(graph);
    expect(idx.outEdges('a')).toEqual([{ source: 'a', target: 'k' }]);
  });
  it('returns incoming edges for a node', () => {
    const idx = buildIndex(graph);
    expect(idx.inEdges('k')).toEqual([
      { source: 'a', target: 'k' },
      { source: 'w', target: 'k' },
    ]);
  });
  it('returns empty array for node with no edges', () => {
    const idx = buildIndex(graph);
    expect(idx.outEdges('k')).toEqual([]);
  });
});
