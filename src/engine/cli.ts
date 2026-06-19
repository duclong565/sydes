import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compile } from '../compiler/index.js';
import type { Graph } from '../compiler/types.js';
import { ExperimentController } from './controller.js';
import { RealRunner } from './runner.js';

export interface Logger {
  log(s: string): void;
  error(s: string): void;
}

/** Compile a graph file, bring its stack up, print status. Returns the experimentId. Throws on failure. */
export async function runSim(graphPath: string, controller: ExperimentController, out: Logger): Promise<string> {
  const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as Graph;
  const result = compile(graph);
  if (!result.ok) {
    for (const e of result.errors) out.error(`✗ ${e.nodeId}: ${e.message}`);
    throw new Error('compile failed');
  }
  await controller.preflight(result.output);
  controller.writeArtifacts(graph.experimentId, result.output);
  out.log(`⏳ warming up ${graph.experimentId} (kafka cold start ~5-10s if present)…`);
  try {
    await controller.up(graph.experimentId);
    for (const s of await controller.status(graph.experimentId)) {
      const ports = s.publishers.map((p) => `${p.published}->${p.target}`).join(', ') || '-';
      out.log(`  ${s.name}  ${s.state}${s.health ? '/' + s.health : ''}  ports:${ports}`);
    }
  } catch (e) {
    // Always tear down a partial stack so a failed warmup doesn't leak containers.
    await controller.down(graph.experimentId);
    throw e;
  }
  out.log(`network: sds-${graph.experimentId}-net   |   Ctrl-C to tear down`);
  return graph.experimentId;
}

export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const keep = args.includes('--keep');
  const runRootIdx = args.indexOf('--run-root');
  const runRoot = runRootIdx >= 0 ? args[runRootIdx + 1] : undefined;
  const graphPath = args.find((a) => !a.startsWith('--') && a !== runRoot);
  if (!graphPath) {
    console.error('usage: npm run sim <graph.json> [--keep] [--run-root <dir>]');
    process.exit(1);
    return;
  }
  const controller = new ExperimentController(new RealRunner(), { runRoot });
  const out: Logger = { log: (s) => console.log(s), error: (s) => console.error(s) };
  let id: string;
  try {
    id = await runSim(graphPath, controller, out);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
    return;
  }
  if (keep) {
    console.log('--keep: leaving stack up. Tear down with: docker compose -p sds-' + id + ' down -v');
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
