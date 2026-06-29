export interface K6Target { slug: string; port: number; rate: number }

const SUB_METRICS: Record<string, string> = {
  http_reqs: 'count>=0',
  http_req_duration: 'max>=0',
  http_req_failed: 'rate>=0',
  dropped_iterations: 'count>=0',
};

export function generateK6(targets: K6Target[], durationSec: number): string {
  const scenarios = targets
    .map(
      (t, i) =>
        `    '${t.slug}': { executor: 'constant-arrival-rate', rate: ${t.rate}, timeUnit: '1s', ` +
        `duration: '${durationSec}s', preAllocatedVUs: ${t.rate}, maxVUs: ${t.rate * 10}, exec: 'fn${i}' },`,
    )
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
