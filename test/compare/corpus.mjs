#!/usr/bin/env node
/**
 * Counts what the real `.jsh` corpus uses, so the gap report can weigh each
 * gap by the scripts it affects. Reads the files straight from git (no
 * checkout is touched):
 *
 *   - every `*.jsh` in ai-ecoverse/skills at <ref>;
 *   - every `*.jsh` under packages/vfs-root/ in ai-ecoverse/slicc at <ref>.
 *
 * Usage: node test/compare/corpus.mjs [--skills <repo>@<ref>] [--slicc <repo>@<ref>]
 * Defaults: ~/Developer/ai-ecoverse/skills@origin/main and
 * ~/Developer/ai-ecoverse/slicc@origin/main. Writes test/compare/corpus.json.
 *
 * A feature is a regular expression over the script's source with comments
 * left in, so a count is "scripts whose text mentions it": an upper bound.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const base = join(homedir(), 'Developer/ai-ecoverse');
const sources = [
  { label: 'ai-ecoverse/skills', spec: opt('--skills', `${base}/skills@origin/main`), filter: (p) => p.endsWith('.jsh') },
  {
    label: 'ai-ecoverse/slicc',
    spec: opt('--slicc', `${base}/slicc@origin/main`),
    filter: (p) => p.endsWith('.jsh') && p.startsWith('packages/vfs-root/'),
  },
];

const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const R = (re) => (src) => re.test(src);
const req = (name) => R(new RegExp(String.raw`require\(\s*['"\`]${name}['"\`]\s*\)|from\s+['"]${name}['"]|import\(\s*['"]${name}['"]\s*\)`));

/** key → [description, test(src)] */
export const FEATURES = {
  // wrapper
  'top-level-await': ['top-level `await` outside any function', (s) => topLevelAwait(s)],
  'top-level-return': ['a `return` at column 0', R(/^return\b/m)],
  'shebang': ['a `#!` first line', R(/^#!/)],
  'static-import': ['a static `import … from`', R(/^\s*import\s+[\w{*][^;]*from\s+['"]/m)],
  'dynamic-import': ['`import(…)`', R(/(?<![\w.])import\(/)],
  'import-url': ['`import(\'https://…\')`', R(/import\(\s*['"]https?:/)],
  'import-in-function-ctor': ['`new Function(…import(…)…)`', R(/new Function\([^)]*import\(/)],
  '__dirname': ['`__dirname` / `__filename`', R(/__dirname|__filename/)],
  'module.exports': ['`module.exports` / `exports.x =`', R(/module\.exports|^exports\.\w+\s*=/m)],
  'require-relative': ['`require(\'./…\')`', R(/require\(\s*['"]\.\.?\//)],
  'require-relative-jsh': ['`require(\'./x.jsh\')`', R(/require\(\s*['"]\.\.?\/[^'"]+\.jsh['"]/)],
  'require-package': ['`require(\'<npm package>\')`', (s) => requiresPackage(s)],
  'require-absolute': ['`require(\'/abs/path\')`', R(/require\(\s*['"]\//)],
  'async-main': ['`async function main` (the usual entry shape)', R(/async function main\b/)],
  // process
  'parseFlags': ['`process.argv.parseFlags()`', R(/parseFlags\(/)],
  'argv.slice(2)': ['`process.argv.slice(2)`', R(/argv\.slice\(2\)/)],
  'argv[0]': ['`process.argv[0]`', R(/argv\[0\]/)],
  'argv[1]': ['`process.argv[1]`', R(/argv\[1\]/)],
  'process.env': ['`process.env`', R(/process\.env\b/)],
  'process.cwd': ['`process.cwd()`', R(/process\.cwd\(/)],
  'process.chdir': ['`process.chdir()`', R(/process\.chdir\(/)],
  'process.exit': ['`process.exit()`', R(/process\.exit\(/)],
  'process.exitCode': ['`process.exitCode`', R(/process\.exitCode/)],
  'process.on': ['`process.on(…)`', R(/process\.(on|once)\(/)],
  'process.platform': ['`process.platform`', R(/process\.platform/)],
  'process.versions': ['`process.version(s)`', R(/process\.versions?\b/)],
  'stdout.write': ['`process.stdout.write`', R(/process\.stdout\.write/)],
  'stderr.write': ['`process.stderr.write`', R(/process\.stderr\.write/)],
  'isTTY': ['`isTTY`', R(/isTTY/)],
  'stdin': ['`process.stdin`', R(/process\.stdin/)],
  'stdin.read': ['`process.stdin.read()` (whole-buffer in v6)', R(/stdin\.read\(\)/)],
  'stdin.on': ['`process.stdin.on(…)`', R(/stdin\.on\(/)],
  'stdin-fd0': ['`readFileSync(0)` / `/dev/stdin`', R(/readFileSync\(\s*(0|['"]\/dev\/stdin['"])/)],
  // console
  'console.log': ['`console.log`', R(/console\.log\(/)],
  'console.error': ['`console.error` / `console.warn`', R(/console\.(error|warn)\(/)],
  'console.error(err)': ['`console.log/error(e|err|error)`: an Error object through console', R(/console\.(log|error|warn)\(\s*(e|err|error)\s*\)/)],
  'console.table': ['`console.table`', R(/console\.table\(/)],
  // exit timing
  'setTimeout': ['`setTimeout`', R(/setTimeout\(/)],
  'setInterval': ['`setInterval`', R(/setInterval\(/)],
  'main().catch': ['`main().catch(…)` in any form (`await`ed, `return`ed or floating)', R(/main\(\)\s*\.(catch|then)\(/)],
  'floating-main': ['a floating `main().catch(…)` at column 0 (neither awaited nor returned)', R(/^\w+\(\)\s*\.(catch|then)\(/m)],
  // fs
  'fs': ['`require(\'fs\')`', req('(node:)?fs')],
  'fs-v6-promise': ['v6 promise `fs` (`await fs.readFile(…)` etc. on `require(\'fs\')`)', (s) => v6Fs(s)],
  'fs.readFile-await': ['`await fs.readFile(`', R(/await\s+fs\.readFile\(/)],
  'fs.writeFile-await': ['`await fs.writeFile(`', R(/await\s+fs\.writeFile\(/)],
  'fs.exists': ['`fs.exists(`', R(/fs\.exists\(/)],
  'fs.readFileBinary': ['`fs.readFileBinary` / `writeFileBinary`', R(/fs\.(read|write)FileBinary\(/)],
  'fs.readDir': ['`fs.readDir`', R(/fs\.readDir\(/)],
  'fs.fetchToFile': ['`fs.fetchToFile`', R(/fetchToFile\(/)],
  'fs.stat-prop': ['`stat(…).isDirectory` read as a property', R(/\.(isDirectory|isFile)(?!\s*\()(?![\w])/)],
  'fs.promises': ['`fs.promises` / `fs/promises`', R(/fs\.promises|['"](node:)?fs\/promises['"]/)],
  'fs.sync': ['any `fs.*Sync(`', R(/fs\.\w+Sync\(/)],
  'fs.callback': ['`fs.x(…, (err, …) =>` callbacks', R(/fs\.\w+\([^)]*,\s*(function\s*)?\(\s*err/)],
  '/workspace': ['a literal `/workspace` path', R(/['"`]\/workspace\b/)],
  '/shared': ['a literal `/shared` path', R(/['"`]\/shared\b/)],
  '/tmp': ['a literal `/tmp` path', R(/['"`]\/tmp\b/)],
  // builtins
  'path': ['`require(\'path\')`', req('(node:)?path')],
  'child_process': ['`require(\'child_process\')`', req('(node:)?child_process')],
  'crypto': ['`require(\'crypto\')`', req('(node:)?crypto')],
  'zlib': ['`require(\'zlib\')`', req('(node:)?zlib')],
  'os': ['`require(\'os\')`', req('(node:)?os')],
  'stream': ['`require(\'stream\')`', req('(node:)?stream')],
  'readline': ['`require(\'readline\')`', req('(node:)?readline')],
  'events': ['`require(\'events\')`', req('(node:)?events')],
  'util': ['`require(\'util\')`', req('(node:)?util')],
  'url': ['`require(\'url\')`', req('(node:)?url')],
  'buffer-module': ['`require(\'buffer\')`', req('(node:)?buffer')],
  'http-module': ['`require(\'http(s)\')` / `net`', req('(node:)?(https?|net)')],
  'tty': ['`require(\'tty\')`', req('(node:)?tty')],
  'playwright': ['`require(\'playwright\')`', req('playwright')],
  // globals
  'fetch': ['`fetch(`', R(/(?<![\w.])fetch\(/)],
  'WebSocket': ['`new WebSocket`', R(/new WebSocket\b/)],
  'Buffer': ['`Buffer.`', R(/\bBuffer\./)],
  'TextEncoder/Decoder': ['`TextEncoder` / `TextDecoder`', R(/Text(En|De)coder/)],
  'atob/btoa': ['`atob` / `btoa`', R(/(?<![\w.])(atob|btoa)\(/)],
  'URL': ['`new URL` / `URLSearchParams`', R(/new URL\(|URLSearchParams/)],
  'crypto.subtle/randomUUID': ['global `crypto.subtle` / `crypto.randomUUID`', R(/(?<![\w.])crypto\.(subtle|randomUUID|getRandomValues)/)],
  'AbortController': ['`AbortController` / `AbortSignal`', R(/Abort(Controller|Signal)/)],
  'FormData/Blob': ['`FormData` / `Blob`', R(/new (FormData|Blob)\b/)],
  'SLICC_VERSION': ['`SLICC_VERSION`', R(/SLICC_VERSION/)],
  // sliccy
  'sliccy:cli': ['`sliccy:cli`', req('sliccy:cli')],
  'sliccy:color': ['`sliccy:color`', req('sliccy:color')],
  'sliccy:fmt': ['`sliccy:fmt`', req('sliccy:fmt')],
  'sliccy:time': ['`sliccy:time`', req('sliccy:time')],
  'sliccy:pool': ['`sliccy:pool`', req('sliccy:pool')],
  'sliccy:exec': ['`sliccy:exec`', req('sliccy:exec')],
  'exec.spawn': ['`exec.spawn(`', R(/exec\.spawn\(/)],
  'exec.start': ['`exec.start(`', R(/exec\.start\(/)],
  'sliccy:http': ['`sliccy:http`', req('sliccy:http')],
  'sliccy:skill': ['`sliccy:skill`', req('sliccy:skill')],
  'skill.token': ['`skill.token(`', R(/skill\.token\(/)],
  'skill.config': ['`skill.config(`', R(/skill\.config\(/)],
  'skill.refs/assets': ['`skill.refs` / `skill.assets` / `skill.root`', R(/skill\.(refs|assets|root)\b/)],
  'exit-in-caught-main': ['`main().catch(…)` around a main that calls `cli.help`/`cli.die`/`process.exit`', (s) => /main\(\)\s*\.catch\(/.test(s) && /cli\.(help|die)\(|process\.exit\(/.test(s)],
  'exit-in-try': ['`process.exit` / `cli.die` / `cli.help` in a file that also has `try … catch`', (s) => /\}\s*catch\s*(\(|\{)/.test(s) && /cli\.(help|die)\(|process\.exit\(/.test(s)],
  'NodeExitError-guard': ['re-throws `NodeExitError` from a catch (works around a catchable `process.exit`)', R(/NodeExitError/)],
  'finally+exit': ['has a `finally` block and calls `process.exit` / `cli.die` / `cli.help`', (s) => /\bfinally\b/.test(s) && /cli\.(help|die)\(|process\.exit\(/.test(s)],
  'subarray': ['`.subarray(`', R(/\.subarray\(/)],
  'rmdirSync': ['`rmdirSync(`', R(/rmdirSync\(/)],
  'events-setMaxListeners': ['`setMaxListeners` / `prependListener`', R(/setMaxListeners|prependListener/)],
  'nextTick': ['`process.nextTick`', R(/process\.nextTick/)],
  'sliccy:browser': ['`sliccy:browser`', req('sliccy:browser')],
  'sliccy:agent': ['`sliccy:agent`', req('sliccy:agent')],
  'sliccy:usb': ['`sliccy:usb`', req('sliccy:usb')],
  'sliccy:serial': ['`sliccy:serial`', req('sliccy:serial')],
  'sliccy:hid': ['`sliccy:hid`', req('sliccy:hid')],
  'sliccy:computer': ['`sliccy:computer`', req('sliccy:computer')],
  'cli.die': ['`cli.die(`', R(/cli\.die\(/)],
  'cli.help': ['`cli.help(`', R(/cli\.help\(/)],
};

const BUILTINS = new Set(
  'assert buffer child_process crypto events fs fs/promises http https net os path process readline stream string_decoder timers tty url util zlib worker_threads module vm querystring perf_hooks dns'.split(' ')
);

function requiresPackage(src) {
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const id = m[1];
    if (id.startsWith('.') || id.startsWith('/') || id.startsWith('sliccy:') || id.startsWith('node:')) continue;
    if (BUILTINS.has(id) || BUILTINS.has(id.split('/')[0])) continue;
    if (id.includes('<') || id.includes('*') || id === 'x') continue;
    return true;
  }
  return false;
}

/** Calls of v6's promise-returning fs on the binding `require('fs')` gave. */
function v6Fs(src) {
  const names = [...src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"](?:node:)?fs['"]\s*\)/g)].map((m) => m[1]);
  for (const n of names) {
    const re = new RegExp(
      String.raw`(await\s+${n}\.(readFile|writeFile|readdir|stat|mkdir|rm|unlink|appendFile|access|rename|copyFile|cp|mkdtemp)\(|${n}\.(exists|readFileBinary|writeFileBinary|readDir|fetchToFile)\(|${n}\.(readFile|readdir|stat|writeFile)\([^)]*\)\s*\.then)`
    );
    if (re.test(src)) return true;
  }
  return false;
}

/** `await` at brace depth 0 outside strings/comments, roughly. */
function topLevelAwait(src) {
  let depth = 0;
  const s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (depth === 0 && s.startsWith('await', i) && !/\w/.test(s[i - 1] ?? '') && !/\w/.test(s[i + 5] ?? '')) return true;
  }
  return false;
}

const files = [];
const refs = {};
for (const src of sources) {
  const at = src.spec.lastIndexOf('@');
  const repo = src.spec.slice(0, at);
  const ref = src.spec.slice(at + 1);
  const sha = git(repo, 'rev-parse', '--short', ref).trim();
  refs[src.label] = `${ref} (${sha})`;
  for (const path of git(repo, 'ls-tree', '-r', '--name-only', sha).split('\n')) {
    if (!path || !src.filter(path) || path.includes('worktrees/')) continue;
    files.push({ path: `${src.label}/${path}`, text: git(repo, 'show', `${sha}:${path}`) });
  }
}

const counts = {};
for (const [key, [description, test]] of Object.entries(FEATURES)) {
  const hits = files.filter((f) => test(f.text)).map((f) => f.path);
  counts[key] = { description, count: hits.length, files: hits };
}

const out = { refs, scripts: files.length, features: counts };
writeFileSync(join(here, 'corpus.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`${files.length} scripts (${Object.entries(refs).map(([k, v]) => `${k} ${v}`).join(', ')})`);
for (const [key, v] of Object.entries(counts)) console.log(`${String(v.count).padStart(3)}  ${key}`);
