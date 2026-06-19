import { describe, it, expect } from 'vitest';
import { generateCompose } from './compose.js';
import type { ComposeService } from '../types.js';

describe('generateCompose', () => {
  it('renders services, env, ports, and network deterministically', () => {
    const services: ComposeService[] = [
      { name: 'order-service', image: 'sds/microservice', environment: { LATENCY_MS: '20' } },
      { name: 'orders-db', image: 'postgres:alpine', environment: { POSTGRES_PASSWORD: 'sds' }, ports: ['5432:5432'] },
    ];
    const yaml = generateCompose(services, 'sds-exp1-net');
    expect(yaml).toContain('services:');
    expect(yaml).toContain('  order-service:');
    expect(yaml).toContain('    image: sds/microservice');
    expect(yaml).toContain('      LATENCY_MS: "20"');
    expect(yaml).toContain('    ports:');
    expect(yaml).toContain('      - "5432:5432"');
    expect(yaml).toContain('networks:');
    expect(yaml).toContain('  sds-exp1-net:');
    expect(yaml).toContain('    driver: bridge');
    // determinism: same input → same output
    expect(generateCompose(services, 'sds-exp1-net')).toBe(yaml);
  });

  it('renders a healthcheck block when present', () => {
    const services: ComposeService[] = [
      {
        name: 'events',
        image: 'bitnami/kafka:latest',
        environment: {},
        healthcheck: { test: ['CMD-SHELL', 'check || exit 1'], interval: '5s', timeout: '5s', retries: 10 },
      },
    ];
    const yaml = generateCompose(services, 'net');
    expect(yaml).toContain('    healthcheck:');
    expect(yaml).toContain('      test: ["CMD-SHELL", "check || exit 1"]');
    expect(yaml).toContain('      retries: 10');
  });
});
