import { describe, it, expect } from 'vitest';
import { handlers } from './index.js';

describe('handler registry', () => {
  it('has a handler for every node type', () => {
    for (const type of ['service', 'kafka', 'worker', 'db', 'lb'] as const) {
      expect(handlers[type]).toBeDefined();
      expect(typeof handlers[type].validate).toBe('function');
      expect(typeof handlers[type].compile).toBe('function');
    }
  });
});
