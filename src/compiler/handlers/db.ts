import type { NodeHandler } from '../types.js';
import { slugify } from '../util.js';

export const DB_USER = 'postgres';
export const DB_PASSWORD = 'sds';
export const DB_NAME = 'postgres';

/** Full Postgres DSN a client can connect with. Single source of the DB connection facts. */
export const dbUrl = (slug: string): string =>
  `postgres://${DB_USER}:${DB_PASSWORD}@${slug}:5432/${DB_NAME}?sslmode=disable`;

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
      environment: { POSTGRES_PASSWORD: DB_PASSWORD },
      // No host port publish: clients connect over the docker network via dbUrl(slug).
      // Publishing 5432 to the host collides when a graph has >1 db, or with a local postgres.
      healthcheck: {
        test: ['CMD-SHELL', 'pg_isready -U postgres'],
        interval: '5s',
        timeout: '5s',
        retries: 10,
      },
    };
  },
};
