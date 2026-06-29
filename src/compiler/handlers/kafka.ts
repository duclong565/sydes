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
    const p = node.config?.partitions;
    if (p !== undefined && (!Number.isInteger(p) || p < 1))
      errors.push({ nodeId: node.id, message: 'Kafka partitions must be a whole number ≥ 1' });
    return errors;
  },
  compile(node, index) {
    const name = slugify(node.label);
    // Collect all worker subscriber topic lists to derive consumer group ids.
    const subscriberGroupIds: string[] = index
      .inEdges(node.id)
      .filter((e) => index.nodeMap.get(e.source)?.type === 'worker')
      .map((e) => {
        // group id = "sds-" + worker's subscribed topics joined by "-"
        const worker = index.nodeMap.get(e.source)!;
        const topics = index.outEdges(worker.id)
          .filter((we) => index.nodeMap.get(we.target)?.type === 'kafka')
          .map((we) => slugify(index.nodeMap.get(we.target)!.label));
        return `sds-${topics.join('-')}`;
      });
    // Build a healthcheck that:
    //   1. verifies kafka is up (--list)
    //   2. creates the topic (--create --if-not-exists)
    //   3. verifies every subscriber consumer group is active (so up --wait blocks until workers are consuming)
    const groupChecks = subscriberGroupIds
      .map((g) => `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list 2>/dev/null | grep -qx '${g}'`)
      .join(' && ');
    const healthCmd = [
      `/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list`,
      `/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --if-not-exists --topic ${name} --partitions ${node.config?.partitions ?? 1} --replication-factor 1`,
      ...(groupChecks ? [groupChecks] : []),
    ].join(' && ') + ' || exit 1';
    return {
      name,
      image: 'apache/kafka:3.7.2',
      environment: {
        KAFKA_NODE_ID: '0',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
        KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://${name}:9092`,
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
        KAFKA_CONTROLLER_QUORUM_VOTERS: `0@${name}:9093`,
        KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
        // Required for kafka-go consumer groups to work:
        KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      },
      healthcheck: {
        test: ['CMD-SHELL', healthCmd],
        interval: '5s',
        timeout: '10s',
        retries: 15,
      },
    };
  },
};
