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
});
