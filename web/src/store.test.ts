import { describe, it, expect, beforeEach } from 'vitest';
import { useGraphStore, type Graph } from './store.js';

const saga: Graph = {
  experimentId: 'saga',
  nodes: [
    { id: 'o', type: 'service', label: 'Order Service', config: { latencyMs: 20, errorRate: 0.01 } },
    { id: 'k', type: 'kafka', label: 'Order Events' },
    { id: 'p', type: 'worker', label: 'Payment Worker' },
  ],
  edges: [{ source: 'o', target: 'k' }, { source: 'p', target: 'k' }],
};

beforeEach(() => {
  useGraphStore.setState({ experimentId: 'untitled', nodes: [], edges: [], selectedId: null });
});

describe('graph store', () => {
  it('addNode adds a typed node with default config for service', () => {
    useGraphStore.getState().addNode('service');
    const { nodes } = useGraphStore.getState();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.data.type).toBe('service');
    expect(nodes[0]!.data.label).toMatch(/Service/);
    expect(nodes[0]!.data.config).toEqual({ latencyMs: 0, errorRate: 0 });
    expect(nodes[0]!.type).toBe('sds');
  });

  it('addNode for kafka seeds partitions: 1', () => {
    useGraphStore.getState().addNode('kafka');
    expect(useGraphStore.getState().nodes[0]!.data.config).toEqual({ partitions: 1 });
  });

  it('toGraph round-trips a kafka partitions config', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 'k', type: 'kafka', label: 'Bus', config: { partitions: 4 } }],
      edges: [],
    };
    useGraphStore.getState().loadExample(g);
    expect(useGraphStore.getState().toGraph()).toEqual(g);
  });

  it('updateNode patches label and config independently', () => {
    useGraphStore.getState().addNode('service');
    const id = useGraphStore.getState().nodes[0]!.id;
    useGraphStore.getState().updateNode(id, { label: 'Orders' });
    useGraphStore.getState().updateNode(id, { config: { latencyMs: 50, errorRate: 0.1 } });
    const n = useGraphStore.getState().nodes[0]!;
    expect(n.data.label).toBe('Orders');
    expect(n.data.config).toEqual({ latencyMs: 50, errorRate: 0.1 });
  });

  it('onConnect adds an edge; removeNode drops the node and its edges', () => {
    useGraphStore.getState().loadExample(saga);
    useGraphStore.getState().onConnect({ source: 'o', target: 'p', sourceHandle: null, targetHandle: null });
    expect(useGraphStore.getState().edges.length).toBe(3);
    useGraphStore.getState().removeNode('o');
    const after = useGraphStore.getState();
    expect(after.nodes.find((n) => n.id === 'o')).toBeUndefined();
    expect(after.edges.every((e) => e.source !== 'o' && e.target !== 'o')).toBe(true);
  });

  it('loadExample then toGraph round-trips the graph shape', () => {
    useGraphStore.getState().loadExample(saga);
    expect(useGraphStore.getState().toGraph()).toEqual(saga);
  });
});

describe('onConnect — kafka edge auto-orient', () => {
  const withDb: Graph = {
    experimentId: 'wd',
    nodes: [
      { id: 'o', type: 'service', label: 'Order Service' },
      { id: 'k', type: 'kafka', label: 'Order Events' },
      { id: 'p', type: 'worker', label: 'Payment Worker' },
      { id: 'd', type: 'db', label: 'Orders DB' },
    ],
    edges: [],
  };
  const conn = (source: string, target: string) => ({ source, target, sourceHandle: null, targetHandle: null });
  const onlyEdge = () => useGraphStore.getState().edges[0]!;

  beforeEach(() => useGraphStore.getState().loadExample(withDb));

  it('flips a kafka→worker drag to worker→kafka (subscribe)', () => {
    useGraphStore.getState().onConnect(conn('k', 'p'));
    expect({ source: onlyEdge().source, target: onlyEdge().target }).toEqual({ source: 'p', target: 'k' });
  });

  it('flips a kafka→service drag to service→kafka (publish)', () => {
    useGraphStore.getState().onConnect(conn('k', 'o'));
    expect({ source: onlyEdge().source, target: onlyEdge().target }).toEqual({ source: 'o', target: 'k' });
  });

  it('leaves an already-correct worker→kafka edge as drawn', () => {
    useGraphStore.getState().onConnect(conn('p', 'k'));
    expect({ source: onlyEdge().source, target: onlyEdge().target }).toEqual({ source: 'p', target: 'k' });
  });

  it('does not touch a non-kafka edge (worker→db)', () => {
    useGraphStore.getState().onConnect(conn('p', 'd'));
    expect({ source: onlyEdge().source, target: onlyEdge().target }).toEqual({ source: 'p', target: 'd' });
  });
});

describe('loadRate config', () => {
  it('round-trips config.loadRate through toGraph', () => {
    const s = useGraphStore.getState();
    s.loadExample({ experimentId: 'e', nodes: [{ id: 's', type: 'service', label: 'Checkout', config: { loadRate: 50 } }], edges: [] });
    expect(useGraphStore.getState().toGraph().nodes[0].config).toEqual({ loadRate: 50 });
  });
});
