import type { Graph } from '../compiler/types.js';
import type { ServiceStatus } from '../engine/controller.js';
import type { K6Result } from '../engine/k6-runner.js';

export type RunState = 'starting' | 'running' | 'error' | 'stopped';

export interface RunRecord {
  id: string;
  graph: Graph;
  runDir: string;
  state: RunState;
  error?: string;
  services: ServiceStatus[];
  task?: Promise<void>; // background run promise (await in tests)
  lastLoad?: K6Result;
  loadInFlight?: boolean;
}
