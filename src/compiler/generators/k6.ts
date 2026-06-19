import type { LoadConfig } from '../types.js';

export function generateK6(targetHost: string, port: number, load: LoadConfig): string {
  return `import http from 'k6/http';

export const options = {
  scenarios: {
    main: {
      executor: 'constant-arrival-rate',
      rate: ${load.rate},
      timeUnit: '1s',
      duration: '${load.durationSec}s',
      preAllocatedVUs: 500,
    },
  },
};

export default function () {
  http.post('http://${targetHost}:${port}/', JSON.stringify({ ping: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
`;
}
