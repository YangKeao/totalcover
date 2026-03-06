import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs a shell command and captures output while streaming to the current process.
 * Streaming keeps long running go test jobs observable in real time.
 */
export function execCommand(
  command: string,
  options: {
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            if (!finished) {
              child.kill('SIGKILL');
              reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`));
            }
          }, options.timeoutMs)
        : undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', (err) => {
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(err);
    });

    child.on('close', (code) => {
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}
