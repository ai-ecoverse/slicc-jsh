const cp = require('child_process');
const pick = (e) => JSON.stringify({ name: e.name, status: e.status, signal: e.signal, stdout: e.stdout && String(e.stdout), stderr: e.stderr && String(e.stderr), code: e.code, msgStart: String(e.message).split('\n')[0], output: e.output && e.output.map((x) => (x == null ? x : String(x))) });
console.log('ok', JSON.stringify(cp.execSync('echo hello').toString()));
console.log('encoding', JSON.stringify(cp.execSync('echo hello', { encoding: 'utf8' })));
try { cp.execSync('echo partial; echo bad >&2; exit 5', { stdio: 'pipe' }); } catch (e) { console.log('throws', pick(e)); }
try { cp.execFileSync('sh', ['-c', 'exit 2']); } catch (e) { console.log('execFileSync throws', pick(e)); }
try { cp.execFileSync('no-such-cmd-xyz'); } catch (e) { console.log('execFileSync ENOENT', e.code, e.errno, e.syscall, e.path, e.status, e.message); }
console.log('execFileSync quoting', JSON.stringify(cp.execFileSync('printf', ['[%s]\\n', 'a b', "it's", '$HOME', '"q"', '*', '']).toString()));
console.log('execFileSync encoding', JSON.stringify(cp.execFileSync('echo', ['x'], { encoding: 'latin1' })));
console.log('execSync input', JSON.stringify(cp.execSync('cat; echo', { input: 'in' }).toString()));
console.log('shell custom', JSON.stringify(cp.execSync('echo $0', { shell: '/bin/bash' }).toString().trim().endsWith('bash')));
console.log('shell true spawnSync', JSON.stringify(String(cp.spawnSync('echo a b | wc -w', { shell: true }).stdout).trim()));
console.log('windowsHide', JSON.stringify(cp.execSync('echo ok', { windowsHide: true }).toString()));
