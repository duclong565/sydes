import { describe, it, expect } from 'vitest';
import { generateK6 } from './k6.js';

describe('generateK6', () => {
  it('renders a constant-arrival-rate script targeting the host', () => {
    const script = generateK6('gateway-lb', 80, { rate: 10000, durationSec: 60 });
    expect(script).toContain("import http from 'k6/http';");
    expect(script).toContain("executor: 'constant-arrival-rate'");
    expect(script).toContain('rate: 10000');
    expect(script).toContain("duration: '60s'");
    expect(script).toContain("http.post('http://gateway-lb:80/'");
    expect(generateK6('gateway-lb', 80, { rate: 10000, durationSec: 60 })).toBe(script);
  });
});
