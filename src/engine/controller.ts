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
}
