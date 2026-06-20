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
    const name = slugify(node.label);
    return {
      name,
      image: 'bitnami/kafka:latest',
      environment: {
        KAFKA_CFG_NODE_ID: '0',
        KAFKA_CFG_PROCESS_ROLES: 'controller,broker',
        KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: `0@${name}:9093`,
        KAFKA_CFG_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
        KAFKA_CFG_ADVERTISED_LISTENERS: `PLAINTEXT://${name}:9092`,
        KAFKA_CFG_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
        KAFKA_CFG_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      },
      healthcheck: {
        test: ['CMD-SHELL', 'kafka-topics.sh --bootstrap-server localhost:9092 --list || exit 1'],
        interval: '5s',
        timeout: '5s',
        retries: 10,
      },
    };
  },
};
