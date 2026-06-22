import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';
import { dbUrl } from './db.js';

export const workerHandler: NodeHandler = {
  validate(node, index) {
    const subscribesToKafka = index
      .outEdges(node.id)
      .some((e) => index.nodeMap.get(e.target)?.type === 'kafka');
    return subscribesToKafka
      ? []
      : [{ nodeId: node.id, message: 'Worker must subscribe to at least one Kafka' }];
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
