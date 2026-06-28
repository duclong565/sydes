import { describe, it, expect } from 'vitest';
import { dbWrites } from './db-rows.js';
import type { Runner, RunResult } from '../engine/runner.js';

const runnerReturning = (res: RunResult): Runner => ({ async run() { return res; } });

describe('dbWrites', () => {
  it('parses the count from psql stdout', async () => {
    const n = await dbWrites(runnerReturning({ code: 0, stdout: '208803\n', stderr: '' }), 'sds-saga-orders-db-1');
    expect(n).toBe(208803);
  });

  it('runs psql with sum(n_tup_ins) inside the container', async () => {
    let argv: string[] = [];
    const runner: Runner = { async run(a) { argv = a; return { code: 0, stdout: '0\n', stderr: '' }; } };
    await dbWrites(runner, 'sds-x-db-1');
    expect(argv).toEqual([
      'docker', 'exec', 'sds-x-db-1', 'psql', '-U', 'postgres', '-tAc',
      'select coalesce(sum(n_tup_ins),0) from pg_stat_user_tables',
    ]);
  });

  it('returns undefined on non-zero exit', async () => {
    expect(await dbWrites(runnerReturning({ code: 1, stdout: '', stderr: 'err' }), 'c')).toBeUndefined();
  });

  it('returns undefined on non-numeric output', async () => {
    expect(await dbWrites(runnerReturning({ code: 0, stdout: 'ERROR: relation\n', stderr: '' }), 'c')).toBeUndefined();
  });
});
