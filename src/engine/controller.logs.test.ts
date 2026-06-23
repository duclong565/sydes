import { describe, it, expect } from 'vitest';
import { ExperimentController } from './controller.js';
import type { Runner, RunResult } from './runner.js';

class RecordingRunner implements Runner {
  calls: string[][] = [];
  async run(argv: string[]): Promise<RunResult> {
    this.calls.push(argv);
    if (argv.includes('logs')) return { code: 0, stdout: 'order-service | hello\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }
}

describe('ExperimentController.logs', () => {
  it('runs docker compose logs --tail and returns stdout', async () => {
    const runner = new RecordingRunner();
    const c = new ExperimentController(runner, { runRoot: '.sds-runs' });
    const out = await c.logs('saga');
    expect(out).toBe('order-service | hello\n');
    const argv = runner.calls.at(-1)!;
    expect(argv.slice(0, 4)).toEqual(['docker', 'compose', '-p', 'sds-saga']);
    expect(argv).toContain('logs');
    expect(argv).toContain('--tail');
  });
});
