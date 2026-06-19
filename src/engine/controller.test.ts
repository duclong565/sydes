import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperimentController } from './controller.js';
import type { Runner, RunResult } from './runner.js';

/** Records argv and returns queued (or default) results. No Docker. */
class FakeRunner implements Runner {
  calls: string[][] = [];
  responses: RunResult[] = [];
  default: RunResult = { code: 0, stdout: '', stderr: '' };
  async run(argv: string[]): Promise<RunResult> {
    this.calls.push(argv);
    return this.responses.shift() ?? this.default;
  }
}

const tmpDirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'sds-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ExperimentController.writeArtifacts', () => {
  it('writes compose.yml always and returns the run dir', () => {
    const root = freshRoot();
    const c = new ExperimentController(new FakeRunner(), { runRoot: root });
    const dir = c.writeArtifacts('exp1', { compose: 'services: {}\n' });
    expect(dir).toBe(join(root, 'exp1'));
    expect(readFileSync(join(dir, 'compose.yml'), 'utf8')).toBe('services: {}\n');
    expect(existsSync(join(dir, 'nginx.conf'))).toBe(false);
    expect(existsSync(join(dir, 'load.js'))).toBe(false);
  });

  it('writes nginx.conf and load.js only when present', () => {
    const root = freshRoot();
    const c = new ExperimentController(new FakeRunner(), { runRoot: root });
    const dir = c.writeArtifacts('exp2', { compose: 'x', nginx: 'upstream {}', k6: 'export default(){}' });
    expect(readFileSync(join(dir, 'nginx.conf'), 'utf8')).toBe('upstream {}');
    expect(readFileSync(join(dir, 'load.js'), 'utf8')).toBe('export default(){}');
  });
});
