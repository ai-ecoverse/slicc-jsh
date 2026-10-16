const fs = require('fs'); const path = require('path'); const { execFile } = require('child_process'); const { promisify } = require('util'); const ef = promisify(execFile); const h = require('./h.cjs');
const d = h.fresh('w-ld'); const C = (s) => String(s).split(process.cwd()).join('CWD');
const pkg = (dir, name, files) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/package.json`, JSON.stringify({ name, version: '1.0.0', main: 'i.js', ...(files.pj || {}) })); for (const [f, c] of Object.entries(files)) if (f !== 'pj') fs.writeFileSync(`${dir}/${f}`, c); };
const S = `${d}/node_modules/.pnpm`;
pkg(`${S}/dep@1.0.0/node_modules/dep`, 'dep', {
  'i.js': "const C=(s)=>String(s).split(process.cwd()).join('CWD'); exports.file=C(__filename); exports.dir=C(__dirname); exports.peer=(()=>{try{return require('peer').v}catch(e){return e.code}})(); exports.paths=module.paths.slice(0,2).map(C); exports.data=require('./data.json').k; exports.loads=(globalThis.__loads=(globalThis.__loads||0)+1);",
  'data.json': '{"k":"json-ok"}',
  'e.mjs': "import peer from 'peer'; const C=(s)=>String(s).split(process.cwd()).join('CWD'); export const url=C(import.meta.url); export const res=C(import.meta.resolve('peer')); export const p=peer.v; export const fn=C(import.meta.filename);",
  pj: { exports: { '.': './i.js', './e': './e.mjs' } },
});
pkg(`${S}/dep@1.0.0/node_modules/peer`, 'peer', { 'i.js': "exports.v='peer-ok'" });
pkg(`${S}/circ@1.0.0/node_modules/circ`, 'circ', { 'i.js': "exports.a=1; const b=require('./b.js'); exports.fromB=b.sawA; exports.done=true;", 'b.js': "const a=require('./i.js'); exports.sawA=JSON.stringify(a);" });
fs.symlinkSync('.pnpm/dep@1.0.0/node_modules/dep', `${d}/node_modules/dep`);
fs.symlinkSync('.pnpm/circ@1.0.0/node_modules/circ', `${d}/node_modules/circ`);
fs.symlinkSync('node_modules/.pnpm/dep@1.0.0/node_modules/dep/data.json', `${d}/data-link.json`);
fs.mkdirSync(`${d}/node_modules/.bin`); fs.writeFileSync(`${S}/dep@1.0.0/node_modules/dep/cli.js`, "#!/usr/bin/env node\nconst C=(s)=>String(s).split(process.cwd()).join('CWD'); console.log('BIN argv1', C(process.argv[1]), 'file', C(__filename), 'peer', require('peer').v, 'args', process.argv.slice(2).join(','));");
fs.chmodSync(`${S}/dep@1.0.0/node_modules/dep/cli.js`, 0o755); fs.symlinkSync('../.pnpm/dep@1.0.0/node_modules/dep/cli.js', `${d}/node_modules/.bin/depcli`);
fs.writeFileSync(`${d}/main.js`, `
const C=(s)=>String(s).split(process.cwd()).join('CWD');
const m = require('dep'); console.log('main argv1', C(process.argv[1]), 'main file', C(__filename));
console.log('cjs', JSON.stringify(m));
console.log('resolve', C(require.resolve('dep')));
const real = require(require('fs').realpathSync(require.resolve('dep'))); console.log('cache identity', real === m, globalThis.__loads, Object.keys(require.cache).filter((k) => k.includes('dep/i.js')).map(C).join(' '));
console.log('circ', JSON.stringify(require('circ')));
console.log('json via link', require('./data-link.json').k, Object.keys(require.cache).filter((k) => k.endsWith('.json')).map(C).join(' '));
console.log('_nodeModulePaths rel', require('module')._nodeModulePaths('w-x/y').slice(0, 2).map(C).join(' '));
console.log('pathToFileURL @', require('url').pathToFileURL('/a/@scope/b').href);
import('dep/e').then((e) => console.log('esm', JSON.stringify({ ...e })), (e) => console.log('esm err', e.message));
`);
fs.symlinkSync('main.js', `${d}/main-link.js`);
const run = async (args, env = {}) => { try { const r = await ef(process.execPath, args, { encoding: 'utf8', cwd: require('path').resolve(d), env: { ...process.env, ...env } }); return C(r.stdout + (r.stderr ? '[stderr] ' + r.stderr : '')).trim(); } catch (e) { return 'ERR ' + e.code + ' ' + C(e.stderr).split('\n').slice(0, 6).join(' | '); } };
(async () => { for (const [label, args, env] of [['plain', ['main.js']], ['via main-link', ['main-link.js']], ['--preserve-symlinks', ['--preserve-symlinks', 'main.js']], ['NODE_PRESERVE_SYMLINKS=1', ['main.js'], { NODE_PRESERVE_SYMLINKS: '1' }], ['--preserve-symlinks-main via link', ['--preserve-symlinks-main', 'main-link.js']], ['--preserve-symlinks --preserve-symlinks-main via link', ['--preserve-symlinks', '--preserve-symlinks-main', 'main-link.js']], ['bin via .bin link', ['node_modules/.bin/depcli', 'x', 'y']]]) console.log(`### ${label}\n${await run(args, env)}`); })();
