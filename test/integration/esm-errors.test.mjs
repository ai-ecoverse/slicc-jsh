import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// Uncaught errors in ES modules, as Node 22.22.0 reports them (checked by
// hand against host Node; its own node:internal frames — ModuleJob.run, … —
// are the only lines jsh doesn't print, so these aren't goldens).
describe('ES module uncaught errors (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  const runFile = async (name, source) => {
    await jsh.kernel.writeFile(`/os/${name}`, source);
    return jsh.run(['node', name], { cwd: '/os' });
  };

  it('an Error thrown at the top level: file: URL, the line, V8 column', async () => {
    const r = await runFile('t1.mjs', "import 'node:fs';\nconst x = 1;\nthrow new Error('boom ' + x);\n");
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      "file:///os/t1.mjs:3\nthrow new Error('boom ' + x);\n      ^\n\nError: boom 1\n    at file:///os/t1.mjs:3:7\n\nNode.js v22.22.0\n"
    );
  });

  it('a TypeError in a function', async () => {
    const r = await runFile('t2.mjs', "import 'node:fs';\nfunction f() {\n  null.x;\n}\nf();\n");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^file:\/\/\/os\/t2\.mjs:3\n {2}null\.x;\n {7}\^\n\nTypeError: Cannot read properties of null \(reading 'x'\)\n {4}at f \(file:\/\/\/os\/t2\.mjs:3:8\)\n {4}at file:\/\/\/os\/t2\.mjs:5:1\n/);
  });

  it('a primitive thrown by the module (sync or after await): run_main', async () => {
    for (const src of ["import 'node:fs';\nthrow 7;\n", 'await 1;\nthrow 7;\n']) {
      const r = await runFile('t3.mjs', src);
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr,
        '\nnode:internal/modules/run_main:123\n    triggerUncaughtException(\n    ^\n7\n(Use `node --trace-uncaught ...` to show where the exception was thrown)\n\nNode.js v22.22.0\n'
      );
    }
  });

  it('-e ES module input is <cwd>/[eval1]', async () => {
    const r = await jsh.run(['node', '--input-type=module', '-e', "throw new Error('x')"], { cwd: '/os' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^file:\/\/\/os\/\[eval1\]:1\nthrow new Error\('x'\)\n {6}\^\n\nError: x\n {4}at file:\/\/\/os\/\[eval1\]:1:7\n/);
  });

  it("a static import of a missing file: Node's resolver report (no frame of the module's own)", async () => {
    const r = await runFile('t5.mjs', "import x from './missing.mjs';\nconsole.log(x);\n");
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      "node:internal/modules/esm/resolve:274\n    throw new ERR_MODULE_NOT_FOUND(\n          ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '/os/missing.mjs' imported from /os/t5.mjs {\n  code: 'ERR_MODULE_NOT_FOUND',\n  url: 'file:///os/missing.mjs'\n}\n\nNode.js v22.22.0\n"
    );
  });

  it('a module that imports itself under top-level await never settles: exit 13', async () => {
    const r = await runFile('self.mjs', "await import('./self.mjs');\nconsole.log(true);\n");
    assert.equal(r.status, 13);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Warning: Detected unsettled top-level await at file:\/\/\/os\/self\.mjs/);
  });

  it("plain node: import('sliccy:x') is Node's ERR_UNSUPPORTED_ESM_URL_SCHEME", async () => {
    const r = await jsh.run(['node', '-e', "import('sliccy:exec').catch((e) => console.log(e.code))"]);
    assert.equal(r.stdout, 'ERR_UNSUPPORTED_ESM_URL_SCHEME\n');
  });
});
