import { describe, it, expect } from 'vitest';
import { generateK6 } from './k6.js';

describe('generateK6 multi-scenario', () => {
  it('emits one tagged scenario + exec fn per target, with no-op threshold sub-metrics', () => {
    const s = generateK6(
      [ { slug: 'checkout', port: 8080, rate: 50 }, { slug: 'gateway', port: 80, rate: 200 } ],
      10,
    );
    // scenario keyed by slug, with maxVUs = rate*10 and preAllocatedVUs = rate
    expect(s).toContain("'checkout': { executor: 'constant-arrival-rate', rate: 50");
    expect(s).toContain('preAllocatedVUs: 50, maxVUs: 500');
    expect(s).toContain("'gateway': { executor: 'constant-arrival-rate', rate: 200");
    expect(s).toContain('preAllocatedVUs: 200, maxVUs: 2000');
    // exec fns hit the right host:port
    expect(s).toContain("http.post('http://checkout:8080/'");
    expect(s).toContain("http.post('http://gateway:80/'");
    // forced sub-metric thresholds for the dropped metric (the saturation signal)
    expect(s).toContain("'dropped_iterations{scenario:checkout}': ['count>=0']");
    expect(s).toContain("'dropped_iterations{scenario:gateway}': ['count>=0']");
    expect(s).toContain("'http_req_duration{scenario:checkout}': ['max>=0']");
  });
});
