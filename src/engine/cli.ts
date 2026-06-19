import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compile } from '../compiler/index.js';
import type { Graph, LoadConfig } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';
import { K6Runner } from './k6-runner.js';

export interface Logger {
  log(s: string): void;
  error(s: string): void;
}

export interface SimOptions {
  loadConfig?: LoadConfig;
  k6Runner?: Pick<K6Runner, 'run'>;
}

/** Compile a graph file, bring its stack up, optionally run a load test, print status. Returns the experimentId. */
export async function runSim(
  graphPath: string,
  controller: ExperimentController,
  out: Logger,
  opts: SimOptions = {},
): Promise<string> {
  const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as Graph;
  const result = compile(graph, opts.loadConfig);
  if (!result.ok) {
    for (const e of result.errors) out.error(`✗ ${e.nodeId}: ${e.message}`);
    throw new Error('compile failed');
  }
  await controller.preflight(result.output);
  const runDir = controller.writeArtifacts(graph.experimentId, result.output);
  out.log(`⏳ warming up ${graph.experimentId} (kafka cold start ~5-10s if present)…`);
  try {
    await controller.up(graph.experimentId);
    for (const s of await controller.status(graph.experimentId)) {
      const ports = s.publishers.map((p) => `${p.published}->${p.target}`).join(', ') || '-';
      out.log(`  ${s.name}  ${s.state}${s.health ? '/' + s.health : ''}  ports:${ports}`);
    }
    if (opts.loadConfig && opts.k6Runner) {
      out.log(`🔥 running load: ${opts.loadConfig.rate} rps for ${opts.loadConfig.durationSec}s…`);
      const k = await opts.k6Runner.run(graph.experimentId, runDir);
      out.log(
        `load: requests=${k.requests}  rps=${k.rps.toFixed(1)}  ` +
          `avg=${k.latencyAvgMs.toFixed(1)}ms  p95=${k.latencyP95Ms.toFixed(1)}ms  ` +
          `errors=${(k.errorRate * 100).toFixed(1)}%`,
      );
    }
  } catch (e) {
    await controller.down(graph.experimentId);
    throw e;
  }
  out.log(`network: sds-${graph.experimentId}-net   |   Ctrl-C to tear down`);
  return graph.experimentId;
}

export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const keep = args.includes('--keep');
  const load = args.includes('--load');
  const runRootIdx = args.indexOf('--run-root');
  const runRoot = runRootIdx >= 0 ? args[runRootIdx + 1] : undefined;

  const numFlag = (name: string, def: number): number => {
    const i = args.indexOf(name);
    if (i < 0) return def;
    const v = Number(args[i + 1]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  const rate = numFlag('--rate', 50);
  const durationSec = numFlag('--duration', 10);

  // Positional graph path: a non-flag token that is not a value consumed by a value-flag.
  const consumed = new Set<number>();
  for (const f of ['--run-root', '--rate', '--duration']) {
    const i = args.indexOf(f);
    if (i >= 0) consumed.add(i + 1);
  }
  const graphPath = args.find((a, i) => !a.startsWith('--') && !consumed.has(i));
  if (!graphPath) {
    console.error('usage: npm run sim <graph.json> [--load [--rate N] [--duration N]] [--keep] [--run-root <dir>]');
    process.exit(1);
    return;
  }

  const controller = new ExperimentController(new RealRunner(), { runRoot });
  const out: Logger = { log: (s) => console.log(s), error: (s) => console.error(s) };
  const opts: SimOptions = load
    ? { loadConfig: { rate, durationSec }, k6Runner: new K6Runner(new RealRunner()) }
    : {};

  let id: string;
  try {
    id = await runSim(graphPath, controller, out, opts);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
    return;
  }

  if (keep) {
    console.log('--keep: leaving stack up. Tear down with: docker compose -p sds-' + id + ' down -v');
    return;
  }
  if (load) {
    // One-shot load run: tear down after results.
    console.log('tearing down…');
    await controller.down(id);
    return;
  }
  const teardown = async () => {
    console.log('\ntearing down…');
    await controller.down(id);
    process.exit(0);
  };
  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);
}

// Auto-run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv);
}
