import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';
import { dbUrl } from './db.js';

export const workerHandler: NodeHandler = {
  validate(node, index) {
    const errors = [];
    const out = index.outEdges(node.id);
    const subscribesToKafka = out.some((e) => index.nodeMap.get(e.target)?.type === 'kafka');
    if (!subscribesToKafka) {
      errors.push({ nodeId: node.id, message: 'Worker must subscribe to at least one Kafka' });
    }
    // The worker has a single DB_URL slot; >1 db edge would silently keep only the last.
    const dbCount = out.filter((e) => index.nodeMap.get(e.target)?.type === 'db').length;
    if (dbCount > 1) {
      errors.push({ nodeId: node.id, message: 'Worker may persist to at most one DB — remove the extra DB edge' });
    }
    return errors;
  },
  compile(node, index) {
    const topics: string[] = [];
    const env: Record<string, string> = {};
    for (const edge of index.outEdges(node.id)) {
      const target = index.nodeMap.get(edge.target);
      if (!target) continue;
      if (target.type === 'kafka') {
        topics.push(slugify(target.label));
        env.KAFKA_BROKER = `${slugify(target.label)}:9092`;
      }
      if (target.type === 'db') env.DB_URL = dbUrl(slugify(target.label));
    }
    env.SUBSCRIBE_TOPICS = topics.join(',');
    return { name: slugify(node.label), image: 'sds/worker', environment: env };
  },
};
