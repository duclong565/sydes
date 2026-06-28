import type { Runner } from '../engine/runner.js';

const WRITES_SQL = 'select coalesce(sum(n_tup_ins),0) from pg_stat_user_tables';

/**
 * Total rows inserted ("writes") in a db container's postgres, read from the stats
 * collector's cumulative insert counter — cheap (no table scan, no observer effect),
 * monotonic except on a stats reset. Returns undefined if the query fails or the
 * output is not a number (db still starting, no tables yet).
 */
export async function dbWrites(runner: Runner, container: string): Promise<number | undefined> {
  const r = await runner.run(['docker', 'exec', container, 'psql', '-U', 'postgres', '-tAc', WRITES_SQL]);
  if (r.code !== 0) return undefined;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : undefined;
}
