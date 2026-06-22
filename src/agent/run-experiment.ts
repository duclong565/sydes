import type { ExperimentController, CompilerOutput } from '../engine/controller.js';
import type { K6Runner } from '../engine/k6-runner.js';
import type { LoadConfig } from '../compiler/types.js';
import type { RunRecord } from './types.js';

/** Background task: bring the stack up (and optionally fire k6), updating the record's state. */
export async function runExperiment(
  deps: { controller: ExperimentController; k6: K6Runner },
  rec: RunRecord,
  output: CompilerOutput,
  load?: LoadConfig,
): Promise<void> {
  try {
    await deps.controller.preflight(output);
    await deps.controller.up(rec.id);
    rec.services = await deps.controller.status(rec.id);
    rec.state = 'running';
    if (load) {
      await deps.k6.run(rec.id, rec.runDir);
    }
  } catch (err) {
    rec.state = 'error';
    rec.error = err instanceof Error ? err.message : String(err);
  }
}
