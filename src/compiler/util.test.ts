import { describe, it, expect } from 'vitest';
import { slugify } from './util.js';

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Order Service')).toBe('order-service');
  });
  it('collapses repeated spaces', () => {
    expect(slugify('Payment   Worker')).toBe('payment-worker');
  });
  it('trims surrounding whitespace', () => {
    expect(slugify('  DB  ')).toBe('db');
  });
  it('strips non-alphanumeric characters', () => {
    expect(slugify('Order #1 Service!')).toBe('order-1-service');
  });
  it('trims leading and trailing hyphens', () => {
    expect(slugify('  --Payment--  ')).toBe('payment');
  });
});
