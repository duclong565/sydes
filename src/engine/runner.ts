import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(argv: string[], opts?: { cwd?: string }): Promise<RunResult>;
}

/** Runs commands as real child processes. The single side-effecting unit. */
export class RealRunner implements Runner {
  run(argv: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error('Runner.run called with empty argv');
    return new Promise<RunResult>((resolve) => {
      const child = spawn(cmd, args, { cwd: opts.cwd });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }
}
