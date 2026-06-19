import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { CompilerResult } from '../compiler/types.js';
import type { Runner } from './runner.js';

export type CompilerOutput = Extract<CompilerResult, { ok: true }>['output'];

export interface Publisher {
  url: string;
  published: number;
  target: number;
}

export interface ServiceStatus {
  name: string;
  state: string;
  health?: string;
  publishers: Publisher[];
}

/** Drives one experiment's container lifecycle via the `docker compose` CLI. */
export class ExperimentController {
  private readonly runRoot: string;

  constructor(private readonly runner: Runner, opts: { runRoot?: string } = {}) {
    this.runRoot = opts.runRoot ?? '.sds-runs';
  }

  private dir(id: string): string {
    return resolvePath(this.runRoot, id);
  }

  /** Writes the compiler artifacts to <runRoot>/<id>/ and returns the dir. */
  writeArtifacts(id: string, output: CompilerOutput): string {
    const d = this.dir(id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'compose.yml'), output.compose);
    if (output.nginx) writeFileSync(join(d, 'nginx.conf'), output.nginx);
    if (output.k6) writeFileSync(join(d, 'load.js'), output.k6);
    return d;
  }

  private composePath(id: string): string {
    return join(this.dir(id), 'compose.yml');
  }

  private baseArgs(id: string): string[] {
    return ['docker', 'compose', '-p', `sds-${id}`, '-f', this.composePath(id)];
  }

  /** Brings the stack up and blocks until healthchecked services are healthy. */
  async up(id: string): Promise<void> {
    const r = await this.runner.run([...this.baseArgs(id), 'up', '-d', '--wait']);
    if (r.code !== 0) {
      throw new Error(`docker compose up failed (exit ${r.code}): ${r.stderr.trim()}`);
    }
  }

  /** Tears down the stack and its volumes. Idempotent. */
  async down(id: string): Promise<void> {
    await this.runner.run([...this.baseArgs(id), 'down', '-v', '--remove-orphans']);
  }

  /** Returns current container status. Tolerates array / single-object / NDJSON ps output. */
  async status(id: string): Promise<ServiceStatus[]> {
    const r = await this.runner.run([...this.baseArgs(id), 'ps', '--format', 'json']);
    const out = r.stdout.trim();
    if (!out) return [];
    let rows: Array<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(out);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      rows = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    }
    return rows.map((row) => {
      const pubs = Array.isArray(row.Publishers) ? row.Publishers : [];
      return {
        name: String(row.Name),
        state: String(row.State),
        health: row.Health ? String(row.Health) : undefined,
        publishers: pubs
          .filter((p: Record<string, unknown>) => p.PublishedPort)
          .map((p: Record<string, unknown>) => ({
            url: p.URL ? String(p.URL) : '0.0.0.0',
            published: Number(p.PublishedPort),
            target: Number(p.TargetPort),
          })),
      };
    });
  }
}
