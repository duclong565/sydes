import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';
import { dbUrl } from './db.js';

export const serviceHandler: NodeHandler = {
  validate(node, index) {
    const errors = [];
    const hasEdge = index.inEdges(node.id).length > 0 || index.outEdges(node.id).length > 0;
    if (!hasEdge) errors.push({ nodeId: node.id, message: 'Service must have at least one edge' });
    const ms = node.config?.msPerKb;
    if (ms !== undefined && (typeof ms !== 'number' || ms < 0)) {
      errors.push({ nodeId: node.id, message: 'msPerKb must be ≥ 0' });
    }
    return errors;
  },
  compile(node, index) {
    const env: Record<string, string> = {
      LATENCY_MS: String(node.config?.latencyMs ?? 0),
      ERROR_RATE: String(node.config?.errorRate ?? 0),
      MS_PER_KB: String(node.config?.msPerKb ?? 0),
    };
    const kafkaDeps: string[] = [];
    for (const edge of index.outEdges(node.id)) {
      const target = index.nodeMap.get(edge.target);
      if (!target) continue;
      if (target.type === 'db') env.DB_URL = dbUrl(slugify(target.label));
      if (target.type === 'kafka') {
        env.PUBLISH_TOPIC = slugify(target.label);
        env.KAFKA_BROKER = `${slugify(target.label)}:9092`;
        kafkaDeps.push(slugify(target.label));
      }
      if (target.type === 'service') env.UPSTREAM_HTTP = `http://${slugify(target.label)}:8080`;
    }
    return {
      name: slugify(node.label),
      image: 'sds/microservice',
      environment: env,
      ...(kafkaDeps.length > 0 ? { dependsOn: kafkaDeps } : {}),
    };
  },
};
