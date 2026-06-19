import type { NodeHandler, CompilerError } from '../types.js';
import { slugify } from '../util.js';

export const kafkaHandler: NodeHandler = {
  validate(node, index) {
    const errors: CompilerError[] = [];
    const inEdges = index.inEdges(node.id);
    const hasPublisher = inEdges.some((e) => index.nodeMap.get(e.source)?.type === 'service');
    const hasSubscriber = inEdges.some((e) => index.nodeMap.get(e.source)?.type === 'worker');
    if (!hasPublisher)
      errors.push({ nodeId: node.id, message: 'Kafka must have at least one publisher' });
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
