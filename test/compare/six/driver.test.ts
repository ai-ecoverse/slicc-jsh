/**
 * Six (SLICC v6) driver for test/compare. The runner (test/compare/run.mjs)
 * copies this file into a slicc checkout as
 * packages/webapp/tests/__jsh_compare__/driver.test.ts and runs it under the
 * repo's own vitest `webapp` project, so every import, `define` and alias is
 * v6's own.
 *
 * Each case runs the way a v6 user runs a `.jsh`: a real
 * `AlmostBashShellHeadless` over a fresh fake-indexeddb `VirtualFS`, the
 * case's files under /workspace/skills/jshc (a default `$PATH` search root),
 * and the shell command `main <args>`, which the shell discovers as a `.jsh`
 * command and runs through `jsh-executor` → `runInRealm` → `runJsRealm`.
 * No Worker exists under vitest, so the realm is the in-process one
 * (`realm-inprocess.ts`), the same `runJsRealm` the DedicatedWorker runs.
 *
 * Input: $JSH_COMPARE_JOBS (JSON array of jobs). Output: $JSH_COMPARE_OUT.
 */
import 'fake-indexeddb/auto';
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';

interface Job {
  name: string;
  root: string;
  entry: string;
  files: { rel: string; b64: string }[];
  args: string[];
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
}

const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

it('six: run jsh compare cases', async () => {
  const jobs: Job[] = JSON.parse(readFileSync(process.env.JSH_COMPARE_JOBS as string, 'utf8'));
  const { VirtualFS } = await import('../../src/fs/index.js');
  const { AlmostBashShellHeadless } = await import('../../src/shell/almost-bash-shell-headless.js');
  const { bytesToStdin } = await import('../../src/shell/just-bash-compat.js');
  const results: Record<string, unknown> = {};
  let n = 0;
  for (const job of jobs) {
    const started = Date.now();
    const fs = await VirtualFS.create({ dbName: `jsh-compare-${process.pid}-${n++}`, wipe: true });
    await fs.mkdir(job.root, { recursive: true });
    for (const f of job.files) {
      const path = `${job.root}/${f.rel}`;
      await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      await fs.writeFile(path, new Uint8Array(Buffer.from(f.b64, 'base64')));
    }
    const shell = new AlmostBashShellHeadless({ fs, cwd: job.root });
    const envPrefix = Object.entries(job.env)
      .map(([k, v]) => `${k}=${shq(v)} `)
      .join('');
    const cmdName = job.entry.replace(/^.*\//, '').replace(/\.jsh$/, '');
    const command = `${envPrefix}${cmdName}${job.args.map((a) => ` ${shq(a)}`).join('')}`;
    const stdin = bytesToStdin(new Uint8Array(Buffer.from(job.stdin ?? '', 'base64')));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        shell.executeCommand(command, undefined, undefined, stdin),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('six timeout')), job.timeoutMs);
        }),
      ]);
      results[job.name] = {
        status: r.exitCode,
        // v6 hands back text: stdout/stderr are JS strings, latin1 for bytes.
        stdout: Buffer.from(r.stdout, 'utf8').toString('base64'),
        stderr: Buffer.from(r.stderr, 'utf8').toString('base64'),
        ms: Date.now() - started,
        command,
      };
    } catch (err) {
      results[job.name] = {
        status: 'timeout',
        stdout: '',
        stderr: Buffer.from(`${(err as Error).message}\n`).toString('base64'),
        ms: Date.now() - started,
        command,
      };
    } finally {
      clearTimeout(timer);
      shell.dispose();
      await fs.dispose?.();
    }
  }
  writeFileSync(process.env.JSH_COMPARE_OUT as string, JSON.stringify(results));
}, 3_600_000);
