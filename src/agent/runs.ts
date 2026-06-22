import type { RunRecord } from './types.js';

/** In-memory store of experiment runs, keyed by runId. */
export class RunStore {
  private readonly runs = new Map<string, RunRecord>();
  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }
  set(rec: RunRecord): void {
    this.runs.set(rec.id, rec);
  }
  has(id: string): boolean {
    return this.runs.has(id);
  }
}
