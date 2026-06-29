import { ReactFlow, Background, BackgroundVariant, Controls, MarkerType, type NodeTypes, type EdgeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore, type NodeType } from './store.js';
import { SdsNode } from './nodes/SdsNode.js';
import { FlowEdge } from './edges/FlowEdge.js';

const nodeTypes: NodeTypes = { sds: SdsNode };
const edgeTypes: EdgeTypes = { flow: FlowEdge };

// Edge tint = source node type. lb fan-out is the load path → signal orange (mirrors the landing diagram).
const EDGE_COLOR: Record<NodeType, string> = {
  service: '#4c8dff', kafka: '#f5b042', worker: '#f472b6', lb: '#ff6a2b', db: '#34d399',
};

export function Canvas({ loading = false }: { loading?: boolean }) {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnect = useGraphStore((s) => s.onConnect);
  const setSelected = useGraphStore((s) => s.setSelected);

  const typeOf = new Map(nodes.map((n) => [n.id, n.data.type]));
  // Color-coded animated edges: each carries its source-type tint + the load-run flag (faster pulse).
  const shownEdges = edges.map((e) => {
    const color = EDGE_COLOR[typeOf.get(e.source) ?? 'service'] ?? '#3a4862';
    return {
      ...e,
      type: 'flow',
      data: { color, loading },
      markerEnd: { type: MarkerType.ArrowClosed, color },
    };
  });

  return (
    <div className="h-full w-full bg-ground">
      <ReactFlow
        nodes={nodes}
        edges={shownEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => setSelected(n.id)}
        onPaneClick={() => setSelected(null)}
        proOptions={{ hideAttribution: true }}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="#1c2840" />
        <Controls />
      </ReactFlow>
    </div>
  );
}
