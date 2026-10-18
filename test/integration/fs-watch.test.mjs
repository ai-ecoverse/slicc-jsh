/**
 * fs.watch and fs.promises.watch inside a kernel program, over the kernel's
 * file-change events (slicc-kernel 1.125.0, ai-ecoverse/slicc-kernel#1047),
 * with what the goldens can't do: changes made from outside the program
 * (the embedder, another process), an AbortSignal from outside, unref,
 * close, and a promises.watch queue that overflows while the program is
 * busy. On an older kernel fs.watch stays out, as before.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeKernel as createKernel120 } from 'kernel-cert-new/node';
import { devPackageFiles, kernelAtLeast, kernelVersion, packageFiles, withJsh } from './helpers.mjs';

const decoder = new TextDecoder();
const needs = kernelAtLeast('1.125.0') ? {} : { skip: `slicc-kernel ${kernelVersion} has no ctx.sync.fs.watch` };

describe('fs.watch in the kernel', needs, () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  /** The text of a kernel file, or null while it isn't there. */
  const read = async (path) => {
    try {
      return decoder.decode(await jsh.kernel.readFile(path));
    } catch {
      return null;
    }
  };
  /** Run a program; `.ended` is its result once it has exited. */
  const start = (argv) => {
    const run = jsh.run(argv, { cwd: '/tmp' });
    run.then((r) => (run.ended = r));
    return run;
  };
  /** Wait until `path` (the program's log) has `count` lines; fail if the program ends first. */
  const lines = async (run, path, count) => {
    for (;;) {
      const text = await read(path);
      if (text !== null && text.split('\n').filter(Boolean).length >= count) return text;
      if (run.ended) assert.fail(`the program ended (${run.ended.status}): ${run.ended.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const program = (path, body) => jsh.kernel.writeFile(path, body.join('\n'));
  const mkdir = async (path) => {
    const r = await jsh.run(['node', '-e', `require('fs').mkdirSync(${JSON.stringify(path)})`]);
    assert.equal(r.status, 0, r.stderr);
  };

  it('sees the embedder and another process change a directory, then ends when the listener closes it', async () => {
    await mkdir('/tmp/outside');
    await program('/tmp/outside.js', [
      "const fs = require('fs');",
      "const log = (s) => fs.appendFileSync('/tmp/outside.log', s + '\\n');",
      "const w = fs.watch('/tmp/outside', (type, name) => {",
      '  log(`${type} ${name}`);',
      "  if (name === 'done') w.close();",
      '});',
      "w.on('close', () => log('close'));",
      "log('watching');",
    ]);
    const run = start(['node', '/tmp/outside.js']);
    await lines(run, '/tmp/outside.log', 1);
    await jsh.kernel.writeFile('/tmp/outside/a.txt', 'from the embedder');
    await lines(run, '/tmp/outside.log', 3);
    const other = await jsh.run(['node', '-e', "const fs = require('fs'); fs.renameSync('/tmp/outside/a.txt', '/tmp/outside/b.txt')"]);
    assert.equal(other.status, 0, other.stderr);
    await lines(run, '/tmp/outside.log', 5);
    await jsh.kernel.writeFile('/tmp/outside/done', '');
    const r = await run;
    assert.equal(r.status, 0, r.stderr);
    const log = (await read('/tmp/outside.log')).split('\n').filter(Boolean);
    assert.deepEqual(log.slice(0, 5), ['watching', 'rename a.txt', 'change a.txt', 'rename a.txt', 'rename b.txt']);
    assert.equal(log.at(-2).endsWith(' done'), true, log.join('|'));
    assert.equal(log.at(-1), 'close');
  });

  it('a file watch sees another process remove the file, as inotify reports it, and keeps the program alive', async () => {
    await jsh.kernel.writeFile('/tmp/gone.txt', 'x');
    await program('/tmp/gone.js', [
      "const fs = require('fs');",
      "const log = (s) => fs.appendFileSync('/tmp/gone.log', s + '\\n');",
      "const w = fs.watch('/tmp/gone.txt', (type, name) => log(`${type} ${name}`));",
      "fs.watch('/tmp', (type, name) => { if (name === 'stop') w.close(); }).unref();",
      "w.on('close', () => log('close'));",
      "log('watching');",
    ]);
    const run = start(['node', '/tmp/gone.js']);
    await lines(run, '/tmp/gone.log', 1);
    const rm = await jsh.run(['node', '-e', "require('fs').unlinkSync('/tmp/gone.txt')"]);
    assert.equal(rm.status, 0, rm.stderr);
    await lines(run, '/tmp/gone.log', 4);
    // Still running: Node's watcher stays open after its file goes.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(run.ended, undefined);
    await jsh.kernel.writeFile('/tmp/stop', '');
    const r = await run;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await read('/tmp/gone.log'), 'watching\nchange gone.txt\nrename gone.txt\nrename gone.txt\nclose\n');
  });

  it('an AbortSignal aborted on an outside change closes the watcher; nothing comes after close()', async () => {
    await mkdir('/tmp/abort');
    await program('/tmp/abort.js', [
      "const fs = require('fs');",
      "const log = (s) => fs.appendFileSync('/tmp/abort.log', s + '\\n');",
      'const ac = new AbortController();',
      "const w = fs.watch('/tmp/abort', { signal: ac.signal }, (type, name) => {",
      '  log(`${type} ${name}`);',
      '  ac.abort();',
      '});',
      "w.on('close', () => log('close ' + process.getActiveResourcesInfo().includes('FSEventWrap')));",
      "log('watching');",
    ]);
    const run = start(['node', '/tmp/abort.js']);
    await lines(run, '/tmp/abort.log', 1);
    // Two changes before the program sees either: the listener closes it at the first.
    await jsh.kernel.writeFile('/tmp/abort/one', '');
    const r = await run;
    assert.equal(r.status, 0, r.stderr);
    await jsh.kernel.writeFile('/tmp/abort/two', '');
    assert.equal(await read('/tmp/abort.log'), 'watching\nrename one\nclose false\n');
  });

  it("an unref'd or non-persistent watcher doesn't keep the program alive; ref() does again", async () => {
    await mkdir('/tmp/unref');
    await program('/tmp/unref.js', [
      "const fs = require('fs');",
      "fs.watch('/tmp/unref', { persistent: false }, () => console.log('not seen'));",
      "const w = fs.watch('/tmp/unref', () => console.log('not seen either')).unref();",
      "console.log(process.getActiveResourcesInfo().filter((r) => r === 'FSEventWrap').length);",
      "process.on('exit', () => console.log('exit'));",
    ]);
    const r = await jsh.run(['node', '/tmp/unref.js'], { cwd: '/tmp' });
    assert.deepEqual(r, { status: 0, stdout: '0\nexit\n', stderr: '' });

    await program('/tmp/reref.js', [
      "const fs = require('fs');",
      "const log = (s) => fs.appendFileSync('/tmp/reref.log', s + '\\n');",
      "const w = fs.watch('/tmp/unref', (type, name) => { log(name); w.close(); });",
      'w.unref().ref();',
      "log('watching');",
    ]);
    const run = start(['node', '/tmp/reref.js']);
    await lines(run, '/tmp/reref.log', 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(run.ended, undefined);
    await jsh.kernel.writeFile('/tmp/unref/wake', '');
    assert.equal((await run).status, 0);
    assert.equal(await read('/tmp/reref.log'), 'watching\nwake\n');
  });

  it('a listener that throws reaches uncaughtException, and the watcher goes on', async () => {
    await mkdir('/tmp/throws');
    await program('/tmp/throws.js', [
      "const fs = require('fs');",
      "const log = (s) => fs.appendFileSync('/tmp/throws.log', s + '\\n');",
      "process.on('uncaughtException', (e) => log('caught ' + e.message));",
      "const w = fs.watch('/tmp/throws', (type, name) => {",
      "  if (name === 'last') return w.close();",
      "  if (type === 'rename') throw new Error('at ' + name);",
      '});',
      "log('watching');",
    ]);
    const run = start(['node', '/tmp/throws.js']);
    await lines(run, '/tmp/throws.log', 1);
    await jsh.kernel.writeFile('/tmp/throws/first', '');
    await lines(run, '/tmp/throws.log', 2);
    await jsh.kernel.writeFile('/tmp/throws/last', '');
    const r = await run;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await read('/tmp/throws.log'), 'watching\ncaught at first\n');
  });

  it("promises.watch: more outside changes than maxQueue while the program is busy: 'error' throws, 'ignore' keeps maxQueue and warns", async () => {
    await program('/tmp/flood.mjs', [
      "import fs from 'node:fs';",
      "import { watch } from 'node:fs/promises';",
      "const overflow = process.argv[2];",
      "const ready = (s) => fs.writeFileSync(`/os/flood-${overflow}.ready`, s);",
      "const warnings = [];",
      "process.on('warning', (w) => warnings.push(w.message));",
      'const ac = new AbortController();',
      "const it = watch(`/tmp/flood-${overflow}`, { maxQueue: 2, overflow, signal: ac.signal });",
      // The first next() starts the watch.
      'const first = it.next();',
      "ready('yes');",
      // Busy until the test has made its changes: they queue meanwhile.
      "while (!fs.existsSync(`/os/flood-${overflow}.go`)) { const t = Date.now(); while (Date.now() - t < 5); }",
      'const out = [];',
      'try {',
      "  for (const { value } of [await first, await it.next()]) out.push(`${value.eventType} ${value.filename}`);",
      '  setTimeout(() => ac.abort(), 100);',
      '  await it.next();',
      '} catch (e) {',
      '  out.push(e.code);',
      '}',
      "console.log(out.join(' '), warnings.length, warnings[0]);",
    ]);
    for (const [overflow, expected] of [
      ['error', 'ERR_FS_WATCH_QUEUE_OVERFLOW 0 undefined'],
      // The other eight events are dropped, with a warning each.
      ['ignore', 'rename f1 change f1 ABORT_ERR 8 fs.watch maxQueue exceeded'],
    ]) {
      await mkdir(`/tmp/flood-${overflow}`);
      const run = jsh.run(['node', '--no-warnings', '/tmp/flood.mjs', overflow], { cwd: '/tmp' });
      while ((await read(`/os/flood-${overflow}.ready`)) === null) await new Promise((resolve) => setTimeout(resolve, 10));
      // Five new files: a 'rename' and a 'change' each.
      for (let i = 1; i <= 5; i++) await jsh.kernel.writeFile(`/tmp/flood-${overflow}/f${i}`, '');
      // Not next to the watched directory: an embedder's write there ends the
      // watch on slicc-kernel 1.125.0 (reported to the kernel lane).
      await jsh.kernel.writeFile(`/os/flood-${overflow}.go`, '');
      const r = await run;
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `${expected}\n`, overflow);
    }
  });
});

describe('chokidar 5 in the kernel (usePolling: false)', needs, () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const pkg of ['chokidar', 'readdirp']) {
      for (const [path, data] of devPackageFiles(pkg)) await jsh.kernel.writeFile(`/os${path}`, data);
    }
  });
  after(() => jsh?.close());

  const read = async (path) => {
    try {
      return decoder.decode(await jsh.kernel.readFile(path));
    } catch {
      return null;
    }
  };
  const until = async (run, path, line) => {
    for (;;) {
      const text = (await read(path)) ?? '';
      if (text.split('\n').includes(line)) return text;
      if (run.ended) assert.fail(`the program ended (${run.ended.status}): ${run.ended.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('watches with fs.watch, not polling, and reports add, change, addDir and unlink from outside', async () => {
    await jsh.kernel.writeFile('/os/project/src/index.js', 'one');
    await jsh.kernel.writeFile(
      '/os/watch.mjs',
      [
        "import fs from 'node:fs';",
        "import chokidar from 'chokidar';",
        "const log = (s) => fs.appendFileSync('/os/chokidar.log', s + '\\n');",
        "const watcher = chokidar.watch('/os/project', { usePolling: false, ignoreInitial: true });",
        "watcher.on('all', (event, path) => {",
        '  log(`${event} ${path}`);',
        // Later: chokidar keeps the new file's closer only after it emits 'add'.
        "  if (path.endsWith('stop')) setTimeout(() => watcher.close().then(() => log('closed')), 50);",
        '});',
        "watcher.on('ready', () => {",
        '  const kinds = process.getActiveResourcesInfo();',
        "  log(`ready ${kinds.filter((k) => k === 'FSEventWrap').length > 0} ${kinds.includes('StatWatcher')}`);",
        '});',
      ].join('\n')
    );
    const run = jsh.run(['node', '/os/watch.mjs'], { cwd: '/os' });
    run.then((r) => (run.ended = r));
    await until(run, '/os/chokidar.log', 'ready true false');
    await jsh.kernel.writeFile('/os/project/src/index.js', 'two');
    await until(run, '/os/chokidar.log', 'change /os/project/src/index.js');
    await jsh.kernel.writeFile('/os/project/src/new.js', 'new');
    await until(run, '/os/chokidar.log', 'add /os/project/src/new.js');
    const other = await jsh.run(['node', '-e', "const fs = require('fs'); fs.mkdirSync('/os/project/lib'); fs.unlinkSync('/os/project/src/new.js')"]);
    assert.equal(other.status, 0, other.stderr);
    await until(run, '/os/chokidar.log', 'addDir /os/project/lib');
    await until(run, '/os/chokidar.log', 'unlink /os/project/src/new.js');
    // From a process: the embedder's write would end the watch on lib, on
    // slicc-kernel 1.125.0 (reported to the kernel lane).
    const stop = await jsh.run(['node', '-e', "require('fs').writeFileSync('/os/project/lib/stop', '')"]);
    assert.equal(stop.status, 0, stop.stderr);
    const r = await run;
    assert.equal(r.status, 0, r.stderr);
    const log = (await read('/os/chokidar.log')).split('\n').filter(Boolean);
    assert.equal(log.at(-1), 'closed');
    assert.deepEqual(log.slice(0, -1).sort(), [
      'add /os/project/lib/stop',
      'add /os/project/src/new.js',
      'addDir /os/project/lib',
      'change /os/project/src/index.js',
      'ready true false',
      'unlink /os/project/src/new.js',
    ]);
  });
});

describe('fs.watch on an older kernel (1.120.2): not there, as documented', () => {
  let kernel;
  before(async () => {
    kernel = await createKernel120();
    for (const [rel, data] of packageFiles()) await kernel.writeFile(`/node_modules/@ai-ecoverse/slicc-jsh/${rel}`, data);
  });
  after(() => kernel?.terminate());

  it('fs.watch and fs.promises.watch are absent, and calling fs.watch throws', async () => {
    await kernel.writeFile(
      '/tmp/old.js',
      [
        "const fs = require('fs');",
        "console.log(typeof fs.watch, typeof fs.promises.watch, typeof require('fs/promises').watch, typeof fs.watchFile);",
        "try { fs.watch('/tmp', () => {}); } catch (e) { console.log(e.name, e.message); }",
      ].join('\n')
    );
    const r = await kernel.run(['node', '/tmp/old.js'], { cwd: '/tmp' });
    assert.deepEqual(r, {
      status: 0,
      stdout: 'undefined undefined undefined function\nTypeError fs.watch is not a function\n',
      stderr: '',
    });
  });
});
