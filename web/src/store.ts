import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react';

export type NodeType = 'service' | 'kafka' | 'worker' | 'db' | 'lb';
export interface NodeConfig { latencyMs?: number; errorRate?: number; partitions?: number }

// Index signature satisfies @xyflow/react's `Node<T extends Record<string, unknown>>` constraint.
export interface SdsNodeData extends Record<string, unknown> {
  type: NodeType;
  label: string;
  config?: NodeConfig;
}
export type AppNode = Node<SdsNodeData>;

export interface GraphNode { id: string; type: NodeType; label: string; config?: NodeConfig }
export interface GraphEdge { source: string; target: string }
export interface Graph { experimentId: string; nodes: GraphNode[]; edges: GraphEdge[] }

const TYPE_LABEL: Record<NodeType, string> = {
  service: 'Service', kafka: 'Kafka', worker: 'Worker', db: 'DB', lb: 'LB',
};

let idCounter = 0;
const nextId = (): string => `n${(idCounter += 1)}`;

interface GraphState {
  experimentId: string;
  nodes: AppNode[];
  edges: Edge[];
  selectedId: string | null;
  setExperimentId(id: string): void;
  addNode(type: NodeType): void;
  updateNode(id: string, patch: Partial<SdsNodeData>): void;
  removeNode(id: string): void;
  setSelected(id: string | null): void;
  onNodesChange(changes: NodeChange[]): void;
  onEdgesChange(changes: EdgeChange[]): void;
  onConnect(conn: Connection): void;
  loadExample(graph: Graph): void;
  toGraph(): Graph;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  experimentId: 'untitled',
  nodes: [],
  edges: [],
  selectedId: null,

  setExperimentId: (id) => set({ experimentId: id }),

  addNode: (type) =>
    set((s) => {
      const count = s.nodes.filter((n) => n.data.type === type).length + 1;
      const i = s.nodes.length;
      const node: AppNode = {
        id: nextId(),
        type: 'sds',
        position: { x: 80 + (i % 5) * 48, y: 80 + (i % 5) * 48 },
        data: {
          type,
          label: `${TYPE_LABEL[type]} ${count}`,
          ...(type === 'service'
            ? { config: { latencyMs: 0, errorRate: 0 } }
            : type === 'kafka'
            ? { config: { partitions: 1 } }
            : {}),
        },
      };
      return { nodes: [...s.nodes, node] };
    }),

  updateNode: (id, patch) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
    })),

  removeNode: (id) =>
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.source !== id && e.target !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  setSelected: (id) => set({ selectedId: id }),

  onNodesChange: (changes) => set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) as AppNode[] })),
  onEdgesChange: (changes) => set((s) => ({ edges: applyEdgeChanges(changes, s.edges) })),
  onConnect: (conn) =>
    set((s) => {
      // A service/worker ↔ kafka edge always means "declare against the topic" (publish /
      // subscribe) with kafka as the target. The data appears to flow kafka → consumer, so
      // users naturally drag it backwards; auto-orient so kafka is the target either way.
      const typeOf = (id: string | null) => s.nodes.find((n) => n.id === id)?.data.type;
      let c = conn;
      if (typeOf(conn.source) === 'kafka' && (typeOf(conn.target) === 'worker' || typeOf(conn.target) === 'service')) {
        c = { ...conn, source: conn.target, target: conn.source };
      }
      return { edges: addEdge(c, s.edges) };
    }),

  loadExample: (graph) =>
    set(() => ({
      experimentId: graph.experimentId,
      selectedId: null,
      nodes: graph.nodes.map((gn, i) => ({
        id: gn.id,
        type: 'sds',
        position: { x: 60 + i * 200, y: 120 + (i % 2) * 130 },
        data: { type: gn.type, label: gn.label, ...(gn.config ? { config: gn.config } : {}) },
      })),
      edges: graph.edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
    })),

  toGraph: () => {
    const s = get();
    return {
      experimentId: s.experimentId,
      nodes: s.nodes.map((n) => ({
        id: n.id,
        type: n.data.type,
        label: n.data.label,
        ...(n.data.config ? { config: n.data.config } : {}),
      })),
      edges: s.edges.map((e) => ({ source: e.source, target: e.target })),
    };
  },
}));
