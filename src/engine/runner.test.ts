import { describe, it, expect } from 'vitest';
import { RealRunner } from './runner.js';

describe('RealRunner', () => {
  it('runs an argv and captures stdout + zero exit code', async () => {
    const r = await new RealRunner().run(['node', '-e', 'process.stdout.write("hi")']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi');
  });

  it('captures a non-zero exit code', async () => {
    const r = await new RealRunner().run(['node', '-e', 'process.exit(3)']);
    expect(r.code).toBe(3);
  });

  it('captures stderr', async () => {
    const r = await new RealRunner().run(['node', '-e', 'process.stderr.write("boom")']);
    expect(r.stderr).toBe('boom');
  });
});
