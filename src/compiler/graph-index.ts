import type { Graph, GraphIndex } from './types.js';

export function buildIndex(graph: Graph): GraphIndex {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  return {
    nodeMap,
    inEdges: (id) => graph.edges.filter((e) => e.target === id),
    outEdges: (id) => graph.edges.filter((e) => e.source === id),
  };
}
