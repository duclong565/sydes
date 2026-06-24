import { describe, it, expect } from 'vitest';
import { slugify } from './slug.js';

describe('slugify', () => {
  it('lowercases and dashes spaces', () => {
    expect(slugify('Order Service')).toBe('order-service');
    expect(slugify('Orders DB')).toBe('orders-db');
  });
  it('collapses and trims separators', () => {
    expect(slugify('  Payment   Worker!! ')).toBe('payment-worker');
  });
});
