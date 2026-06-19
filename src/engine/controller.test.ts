import { describe, it, expect, afterEach } from 'vitest';
import { resolve as resolvePath } from 'node:path';
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
  async run(argv: string[], _opts?: { cwd?: string }): Promise<RunResult> {
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

describe('ExperimentController.up / down', () => {
  it('up builds the compose up --wait argv', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    await c.up('exp1');
    expect(runner.calls.at(-1)).toEqual([
      'docker', 'compose', '-p', 'sds-exp1',
      '-f', resolvePath(root, 'exp1', 'compose.yml'),
      'up', '-d', '--wait',
    ]);
  });

  it('up throws with stderr on non-zero exit', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    runner.responses = [{ code: 1, stdout: '', stderr: 'kafka unhealthy' }];
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    await expect(c.up('exp1')).rejects.toThrow(/kafka unhealthy/);
  });

  it('down builds the compose down -v argv', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    await c.down('exp1');
    expect(runner.calls.at(-1)).toEqual([
      'docker', 'compose', '-p', 'sds-exp1',
      '-f', resolvePath(root, 'exp1', 'compose.yml'),
      'down', '-v', '--remove-orphans',
    ]);
  });
});

describe('ExperimentController.status', () => {
  it('parses NDJSON ps output into ServiceStatus[]', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    runner.responses = [{
      code: 0,
      stdout:
        '{"Name":"sds-exp1-edge-1","State":"running","Health":"","Publishers":[]}\n' +
        '{"Name":"sds-exp1-db-1","State":"running","Health":"healthy","Publishers":[{"URL":"0.0.0.0","PublishedPort":5432,"TargetPort":5432}]}\n',
      stderr: '',
    }];
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    const st = await c.status('exp1');
    expect(st).toHaveLength(2);
    expect(st[0]).toEqual({ name: 'sds-exp1-edge-1', state: 'running', health: undefined, publishers: [] });
    expect(st[1]!.health).toBe('healthy');
    expect(st[1]!.publishers).toEqual([{ url: '0.0.0.0', published: 5432, target: 5432 }]);
  });

  it('parses a JSON array form of ps output', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    runner.responses = [{
      code: 0,
      stdout: '[{"Name":"a","State":"running","Publishers":null}]',
      stderr: '',
    }];
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    const st = await c.status('exp1');
    expect(st).toEqual([{ name: 'a', state: 'running', health: undefined, publishers: [] }]);
  });

  it('returns [] for empty output', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    runner.responses = [{ code: 0, stdout: '\n', stderr: '' }];
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    expect(await c.status('exp1')).toEqual([]);
  });

  it('parses a single JSON object form of ps output', async () => {
    const root = freshRoot();
    const runner = new FakeRunner();
    runner.responses = [{ code: 0, stdout: '{"Name":"x","State":"exited","Health":"","Publishers":[]}', stderr: '' }];
    const c = new ExperimentController(runner, { runRoot: root });
    c.writeArtifacts('exp1', { compose: 'x' });
    const st = await c.status('exp1');
    expect(st).toEqual([{ name: 'x', state: 'exited', health: undefined, publishers: [] }]);
  });
});

describe('ExperimentController.preflight', () => {
  it('passes when every sds/* image inspects ok', async () => {
    const runner = new FakeRunner(); // default code 0 = image present
    const c = new ExperimentController(runner, { runRoot: freshRoot() });
    await expect(
      c.preflight({ compose: 'services:\n  a:\n    image: sds/microservice\n' }),
    ).resolves.toBeUndefined();
    expect(runner.calls).toContainEqual(['docker', 'image', 'inspect', 'sds/microservice']);
  });

  it('throws a build hint when an sds/* image is missing', async () => {
    const runner = new FakeRunner();
    runner.responses = [{ code: 1, stdout: '', stderr: 'No such image' }];
    const c = new ExperimentController(runner, { runRoot: freshRoot() });
    await expect(
      c.preflight({ compose: 'services:\n  w:\n    image: sds/worker\n' }),
    ).rejects.toThrow(/sds\/worker not found.*docker build -t sds\/worker \.\/images\/worker/);
  });

  it('ignores non-sds images', async () => {
    const runner = new FakeRunner();
    const c = new ExperimentController(runner, { runRoot: freshRoot() });
    await c.preflight({ compose: 'services:\n  k:\n    image: bitnami/kafka:latest\n' });
    expect(runner.calls).toEqual([]); // no inspects issued
  });
});
