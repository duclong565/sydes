import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';

export const kafkaHandler: NodeHandler = {
  validate(node, index) {
    const errors = [];
    if (index.inEdges(node.id).length === 0)
      errors.push({ nodeId: node.id, message: 'Kafka must have at least one publisher' });
    const hasSubscriber =
      index.outEdges(node.id).length > 0 ||
      index.inEdges(node.id).some((e) => index.nodeMap.get(e.source)?.type === 'worker');
    if (!hasSubscriber)
      errors.push({ nodeId: node.id, message: 'Kafka must have at least one subscriber' });
    return errors;
  },
  compile(node) {
    return {
      name: slugify(node.label),
      image: 'bitnami/kafka:latest',
      environment: { KAFKA_CFG_NODE_ID: '0', KAFKA_CFG_PROCESS_ROLES: 'controller,broker' },
      healthcheck: {
        test: ['CMD-SHELL', 'kafka-topics.sh --bootstrap-server localhost:9092 --list || exit 1'],
        interval: '5s',
        timeout: '5s',
        retries: 10,
      },
    };
  },
};
