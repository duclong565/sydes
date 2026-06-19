import type { NodeType, NodeHandler } from '../types.js';
import { serviceHandler } from './service.js';
import { kafkaHandler } from './kafka.js';
import { workerHandler } from './worker.js';
import { dbHandler } from './db.js';
import { lbHandler } from './lb.js';

export const handlers: Record<NodeType, NodeHandler> = {
  service: serviceHandler,
  kafka: kafkaHandler,
  worker: workerHandler,
  db: dbHandler,
  lb: lbHandler,
};
