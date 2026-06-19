import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';

export const lbHandler: NodeHandler = {
  validate(node, index) {
    const serviceUpstreams = index
      .outEdges(node.id)
      .filter((e) => index.nodeMap.get(e.target)?.type === 'service');
    return serviceUpstreams.length >= 2
      ? []
      : [{ nodeId: node.id, message: 'Load balancer requires at least 2 service upstreams' }];
  },
  compile(node) {
    return { name: slugify(node.label), image: 'nginx:alpine', environment: {}, ports: ['80:80'] };
  },
};
