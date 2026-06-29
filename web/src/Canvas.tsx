import { ReactFlow, Background, BackgroundVariant, Controls, MarkerType, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from './store.js';
import { SdsNode } from './nodes/SdsNode.js';

const nodeTypes: NodeTypes = { sds: SdsNode };

export function Canvas({ loading = false }: { loading?: boolean }) {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnect = useGraphStore((s) => s.onConnect);
  const setSelected = useGraphStore((s) => s.setSelected);
  // Directional arrowhead on every edge so publish/subscribe/persist direction is legible.
  const shownEdges = edges.map((e) => ({ ...e, animated: loading, markerEnd: { type: MarkerType.ArrowClosed } }));

  return (
    <div className="h-full w-full bg-ground">
      <ReactFlow
        nodes={nodes}
        edges={shownEdges}
        nodeTypes={nodeTypes}
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
