import { describe, it, expect } from 'vitest';
import { generateNginx } from './nginx.js';

describe('generateNginx', () => {
  it('renders an upstream block with one server line per upstream', () => {
    const conf = generateNginx(['order-a', 'order-b']);
    expect(conf).toContain('upstream backend {');
    expect(conf).toContain('    server order-a:8080;');
    expect(conf).toContain('    server order-b:8080;');
    expect(conf).toContain('listen 80;');
    expect(conf).toContain('proxy_pass http://backend;');
    expect(generateNginx(['order-a', 'order-b'])).toBe(conf);
  });
});
