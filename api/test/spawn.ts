import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const apiDir = fileURLToPath(new URL('..', import.meta.url));

async function freePort(): Promise<number> {
  const srv = createServer().listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const addr = srv.address();
  srv.close();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

/** Starts the real server entrypoint in a child process and resolves once it logs that it is listening. */
export async function startServer(env: Record<string, string>): Promise<{ child: ChildProcess; url: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: apiDir,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env, PORT: String(port), LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('server did not start within 15s')); }, 15_000);
    lines.on('line', (line) => {
      if (line.includes('"api listening"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

/** Runs the server entrypoint and waits for it to exit on its own (for startup-failure tests). */
export async function runToExit(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: apiDir,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: '0', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill(), 15_000);
  const [code] = (await once(child, 'exit')) as [number | null];
  clearTimeout(timer);
  return { code, stderr };
}
