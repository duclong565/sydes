import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';

export const dbHandler: NodeHandler = {
  validate(node, index) {
    return index.inEdges(node.id).length > 0
      ? []
      : [{ nodeId: node.id, message: 'Database must have at least one consumer' }];
  },
  compile(node) {
    return {
      name: slugify(node.label),
      image: 'postgres:alpine',
      environment: { POSTGRES_PASSWORD: 'sds' },
      ports: ['5432:5432'],
    };
  },
};
