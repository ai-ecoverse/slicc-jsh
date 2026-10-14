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

  it('process.report writes on its signal (the program goes on) and on an uncaught exception (between the error and its Node.js line)', async () => {
    const r = await jsh.run(
      [
        'node',
        '-e',
        [
          "const fs = require('fs');",
          "fs.mkdirSync('/tmp/rep', { recursive: true });",
          "process.report.directory = '/tmp/rep';",
          'process.report.reportOnSignal = true;',
          "process.kill(process.pid, 'SIGUSR2');",
          'setTimeout(() => {',
          "  const files = fs.readdirSync('/tmp/rep');",
          "  const j = JSON.parse(fs.readFileSync('/tmp/rep/' + files[0], 'utf8'));",
          "  console.log('alive', files.length, j.header.event, j.header.trigger, JSON.stringify(j.javascriptStack), j.header.glibcVersionRuntime);",
          '  process.report.reportOnSignal = false;',
          '  process.report.reportOnUncaughtException = true;',
          "  throw new Error('boom');",
          '}, 300);',
        ].join('\n'),
      ],
      { cwd: '/os' }
    );
    assert.equal(r.status, 1);
    assert.equal(r.stdout, 'alive 1 SIGUSR2 Signal {"message":"","errorProperties":{}} 2.28\n');
    assert.match(r.stderr, /\nError: boom\n[^]*\n\nWriting Node\.js report to file: report\.[^\n]+\.002\.json\nNode\.js report completed\n\nNode\.js v22\.22\.0\n$/);
    const j = await jsh.run(
      ['node', '-e', "const fs = require('fs'); const f = fs.readdirSync('/tmp/rep').sort()[1]; const j = JSON.parse(fs.readFileSync('/tmp/rep/' + f, 'utf8')); console.log(j.header.event, j.header.trigger, j.javascriptStack.message, j.javascriptStack.stack.includes('Error: boom'))"],
      { cwd: '/os' }
    );
    assert.equal(j.stdout, 'Exception Exception [eval]:12 true\n');
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
