import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';

export const serviceHandler: NodeHandler = {
  validate(node, index) {
    const hasEdge = index.inEdges(node.id).length > 0 || index.outEdges(node.id).length > 0;
    return hasEdge ? [] : [{ nodeId: node.id, message: 'Service must have at least one edge' }];
  },
  compile(node, index) {
    const env: Record<string, string> = {
      LATENCY_MS: String(node.config?.latencyMs ?? 0),
      ERROR_RATE: String(node.config?.errorRate ?? 0),
    };
    for (const edge of index.outEdges(node.id)) {
      const target = index.nodeMap.get(edge.target);
      if (!target) continue;
      if (target.type === 'db') env.DB_URL = `postgres://${slugify(target.label)}:5432`;
      if (target.type === 'kafka') {
        env.PUBLISH_TOPIC = slugify(target.label);
        env.KAFKA_BROKER = `${slugify(target.label)}:9092`;
      }
    }
    return { name: slugify(node.label), image: 'sds/microservice', environment: env };
  },
};
