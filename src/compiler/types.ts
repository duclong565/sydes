export type NodeType = 'service' | 'kafka' | 'worker' | 'db' | 'lb';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  config?: {
    latencyMs?: number;
    errorRate?: number;
    partitions?: number;
    loadRate?: number;   // present + integer ≥1 = this node is a load source at N rps
    msPerKb?: number;    // service receiver: +ms latency per KB received (float ≥ 0)
  };
}

export interface GraphEdge {
  source: string; // node id
  target: string; // node id
}

export interface Graph {
  experimentId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface LoadTarget { nodeId: string; rate: number }
export interface LoadConfig { durationSec: number; targets: LoadTarget[] }

export interface LoadTargetResolved { slug: string; targetRps: number }

export interface ComposeService {
  name: string;        // container name + DNS hostname
  image: string;
  environment: Record<string, string>;
  ports?: string[];    // e.g. "8080:8080"
  volumes?: string[];  // e.g. "./nginx.conf:/etc/nginx/conf.d/default.conf:ro"
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
  };
  /** service_healthy dependencies: service names that must be healthy before this starts */
  dependsOn?: string[];
}

export interface CompilerError {
  nodeId: string;
  message: string;
}

export type CompilerResult =
  | { ok: true; output: { compose: string; nginx?: string; k6?: string; loadTargets?: LoadTargetResolved[] } }
  | { ok: false; errors: CompilerError[] };

export interface GraphIndex {
  nodeMap: Map<string, GraphNode>;
  inEdges: (nodeId: string) => GraphEdge[];
  outEdges: (nodeId: string) => GraphEdge[];
}

export interface NodeHandler {
  validate(node: GraphNode, index: GraphIndex): CompilerError[];
  compile(node: GraphNode, index: GraphIndex): ComposeService;
}
