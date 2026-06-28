import { describe, it, expect } from 'vitest';
import { dbHandler, dbUrl } from './db.js';
import { buildIndex } from '../graph-index.js';
import type { Graph } from '../types.js';

describe('dbHandler.validate', () => {
  it('errors when db has no consumer', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'd', type: 'db', label: 'DB' }], edges: [] };
    const errors = dbHandler.validate(g.nodes[0]!, buildIndex(g));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/consumer/i);
  });
  it('passes when db has a consumer', () => {
    const g: Graph = {
      experimentId: 'e',
      nodes: [{ id: 's', type: 'service', label: 'S' }, { id: 'd', type: 'db', label: 'DB' }],
      edges: [{ source: 's', target: 'd' }],
    };
    expect(dbHandler.validate(g.nodes[1]!, buildIndex(g))).toEqual([]);
  });
});

describe('dbHandler.compile', () => {
  it('emits postgres service with pg_isready healthcheck and no host port publish', () => {
    const g: Graph = { experimentId: 'e', nodes: [{ id: 'd', type: 'db', label: 'Orders DB' }], edges: [] };
    const svc = dbHandler.compile(g.nodes[0]!, buildIndex(g));
    expect(svc.name).toBe('orders-db');
    expect(svc.image).toBe('postgres:alpine');
    // No host port: clients reach postgres over the docker network by container name (see dbUrl).
    // Publishing 5432 collides when a graph has >1 db node, or with a local postgres.
    expect(svc.ports).toBeUndefined();
    expect(svc.environment.POSTGRES_PASSWORD).toBe('sds');
    expect(svc.healthcheck?.test).toEqual(['CMD-SHELL', 'pg_isready -U postgres']);
  });
});

describe('dbUrl', () => {
  it('builds a full postgres DSN with creds, db, and sslmode', () => {
    expect(dbUrl('orders-db')).toBe('postgres://postgres:sds@orders-db:5432/postgres?sslmode=disable');
  });
});
