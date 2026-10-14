import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJshAndSh } from './helpers.mjs';

// What the goldens (process-members-node22, process-execve-node22) can't pin
// against host Node: an execve that can't start (Node's fatal error, SIGABRT,
// whose native stack the host prints), and report files written to disk.
describe('process members (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
  });
  after(() => jsh?.close());

  const sh = (script) => jsh.run(['sh', '-c', script], { cwd: '/os' });

  it("an execve that can't start is Node's fatal error: SIGABRT, no 'exit' event", async () => {
    const r = await jsh.run(
      ['node', '-e', "process.on('exit', () => console.log('exit event')); process.execve('/nope', ['nope'])"],
      { cwd: '/os' }
    );
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /process\.execve failed with error code ENOENT\n/);
    const s = await sh("node -e \"process.execve('/nope')\" 2>/dev/null; echo status=$?");
    assert.equal(s.stdout, 'status=134\n');
  });

  it('process.report.writeReport writes the JSON report and names it as Node does', async () => {
    const r = await jsh.run(
      [
        'node',
        '-e',
        [
          "const fs = require('fs');",
          'const f = process.report.writeReport();',
          'const j = JSON.parse(fs.readFileSync(f, "utf8"));',
          'console.log(/^report\\.\\d{8}\\.\\d{6}\\.\\d+\\.0\\.001\\.json$/.test(f), j.header.event, j.header.trigger, j.header.filename === f);',
          "const g = process.report.writeReport('named.json', new Error('e'));",
          "console.log(g, JSON.parse(fs.readFileSync('named.json', 'utf8')).javascriptStack.message);",
          "process.report.directory = '/tmp'; process.report.compact = true;",
          "const h = process.report.writeReport('c.json');",
          "console.log(h, fs.readFileSync('/tmp/c.json', 'utf8').split('\\n').length);",
        ].join('\n'),
      ],
      { cwd: '/os' }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'true JavaScript API API true\nnamed.json Error: e\nc.json 2\n');
    assert.match(r.stderr, /^\nWriting Node\.js report to file: report\.[^\n]+\nNode\.js report completed\n/);
  });

  it('process.dlopen fails as Linux dlopen(3) does', async () => {
    const r = await jsh.run(
      [
        'node',
        '-e',
        "for (const f of ['/nope.node', '/etc/passwd']) try { process.dlopen({ exports: {} }, f) } catch (e) { console.log(e.code, e.message) }",
      ],
      { cwd: '/os' }
    );
    assert.equal(
      r.stdout,
      'ERR_DLOPEN_FAILED /nope.node: cannot open shared object file: No such file or directory\n' +
        'ERR_DLOPEN_FAILED /etc/passwd: invalid ELF header\n'
    );
  });
});
