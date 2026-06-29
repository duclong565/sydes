export interface K6Target { slug: string; port: number; rate: number }

const SUB_METRICS: Record<string, string> = {
  http_reqs: 'count>=0',
  http_req_duration: 'max>=0',
  http_req_failed: 'rate>=0',
  dropped_iterations: 'count>=0',
};

// VU ceiling per scenario. Without it, `preAllocatedVUs = rate` / `maxVUs = rate*10`
// is unbounded: a rate like 200000 makes k6 preallocate hundreds of thousands of VUs
// at startup and the container is OOM-killed (exit 137). Above the cap a target simply
// saturates (dropped iterations) — the correct sandbox signal — instead of crashing.
// 2000 VUs sustains very high throughput for a fast service (Little's law: 2000 / 10ms
// = 200k rps) and stays well within the k6 container's memory.
const MAX_VUS = 2000;

export function generateK6(targets: K6Target[], durationSec: number): string {
  const scenarios = targets
    .map((t, i) => {
      const maxVUs = Math.min(t.rate * 10, MAX_VUS);
      const preAllocatedVUs = Math.min(t.rate, maxVUs);
      return (
        `    '${t.slug}': { executor: 'constant-arrival-rate', rate: ${t.rate}, timeUnit: '1s', ` +
        `duration: '${durationSec}s', preAllocatedVUs: ${preAllocatedVUs}, maxVUs: ${maxVUs}, exec: 'fn${i}' },`
      );
    })
    .join('\n');

  const thresholds = targets
    .flatMap((t) =>
      Object.entries(SUB_METRICS).map(([metric, agg]) => `    '${metric}{scenario:${t.slug}}': ['${agg}'],`),
    )
    .join('\n');

  const fns = targets
    .map(
      (t, i) =>
        `export function fn${i}() {\n` +
        `  http.post('http://${t.slug}:${t.port}/', JSON.stringify({ ping: true }), { headers: { 'Content-Type': 'application/json' } });\n` +
        `}`,
    )
    .join('\n');

  return `import http from 'k6/http';

export const options = {
  scenarios: {
${scenarios}
  },
  thresholds: {
${thresholds}
  },
};

${fns}
`;
}
