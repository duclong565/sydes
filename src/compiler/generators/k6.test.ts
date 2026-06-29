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

  it('caps VUs at the ceiling so a huge rate saturates instead of OOM-killing k6', () => {
    const s = generateK6([{ slug: 'svc', port: 8080, rate: 200000 }], 20);
    // both preAllocatedVUs and maxVUs are clamped to MAX_VUS (2000) — not 200000 / 2000000
    expect(s).toContain('preAllocatedVUs: 2000, maxVUs: 2000');
    expect(s).not.toContain('200000, maxVUs');
    expect(s).not.toContain('maxVUs: 2000000');
  });

  it('keeps rate*10 headroom for small rates below the cap', () => {
    const s = generateK6([{ slug: 'svc', port: 8080, rate: 100 }], 10);
    expect(s).toContain('preAllocatedVUs: 100, maxVUs: 1000');
  });
});

describe('generateK6 sized body', () => {
  it('posts an N-KB constant body when bodyKb is set; ping otherwise', () => {
    const s = generateK6([
      { slug: 'checkout', port: 8080, rate: 50, bodyKb: 64 },
      { slug: 'search', port: 8080, rate: 50 },
    ], 10);
    // 64 KB = 65536 - 10-byte wrapper = 65526 filler chars
    expect(s).toContain("const body0 = '{\"pad\":\"' + 'x'.repeat(65526) + '\"}';");
    expect(s).toContain('http.post(\'http://checkout:8080/\', body0,');
    // no bodyKb → ping
    expect(s).toContain('const body1 = JSON.stringify({ ping: true });');
    expect(s).toContain('http.post(\'http://search:8080/\', body1,');
  });
});
