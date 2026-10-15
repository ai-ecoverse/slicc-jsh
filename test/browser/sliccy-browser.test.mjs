/**
 * `sliccy:browser` in the kernel jsh, end to end (ai-ecoverse/slicc-jsh#73):
 * a kernel in a Chromium tab, slicc-jsh installed from this repo's dist and
 * `@ai-ecoverse/sliccy-browser` from the registry, both with `pnpm add -g`
 * inside the kernel, as seven's catalog installs packages; CDP to kernel
 * processes as seven has it: SLICC_CDP_URL, the kernel's 127.0.0.1:9222,
 * behind the kernel's `cdp` hook, with what seven's CDP guard refuses
 * refused. Every script also runs on the host jsh against the same browser,
 * and both must print the same.
 *
 * SLICCY_BROWSER overrides the package (a registry spec, or a tarball's path).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { hostJshWith } from './host.mjs';
import { booted, installJshAndBrowser, packJsh, SEVEN_REFUSED, SLICCY_BROWSER } from './kernel.mjs';
import { startSite } from './site.mjs';

const pack = mkdtempSync(join(tmpdir(), 'jsh-browser-pack-'));
const scripts = mkdtempSync(join(tmpdir(), 'jsh-browser-host-'));
let chrome;
let kernelSite;
let hostSite;
let host;
let tgz;

before(async () => {
  tgz = packJsh(pack);
  chrome = await launch({ pack: `${pack}/` });
  kernelSite = await startSite();
  hostSite = await startSite();
  host = hostJshWith(SLICCY_BROWSER);
});

after(async () => {
  await chrome?.close();
  await kernelSite?.close();
  await hostSite?.close();
  host?.close();
  rmSync(pack, { recursive: true, force: true });
  rmSync(scripts, { recursive: true, force: true });
});

/** The host jsh on `script`, against the harness browser. */
function runHost(name, script, env = {}) {
  writeFileSync(join(scripts, name), script);
  return host.run([name], { cwd: scripts, env: { SLICC_CDP_URL: chrome.browser, ...env } });
}

/** Ports, target ids and the host's paths, as both sides print them. */
function normal(text, site) {
  return text
    .replaceAll(site.origin, '$SITE')
    .replace(/"[0-9A-F]{32}"/g, '"$TARGET"')
    .replaceAll(scripts, '$DIR')
    .replaceAll('/home/t', '$DIR');
}

const RESOLVE = `const browser = require('sliccy:browser');
const ns = await import('sliccy:browser');
console.log(Object.keys(browser).sort().join(','));
console.log('import', ns.default === browser, ns.ensureTab === browser.ensureTab);
`;

/** A CDP method seven's guard refuses: its error, at once, not a hang. */
const REFUSE = `const ws = new WebSocket(process.env.SLICC_CDP_URL);
await new Promise((resolve) => (ws.onopen = resolve));
const started = Date.now();
const reply = await new Promise((resolve) => {
  ws.onmessage = ({ data }) => resolve(JSON.parse(data));
  ws.send(JSON.stringify({ id: 7, method: 'Runtime.addBinding', params: { name: 'probe' } }));
});
console.log(reply.id, reply.error?.message, Date.now() - started < 5000);
ws.close();
`;

/** The #73 checklist, one line each; the script ends on its own (no process.exit). */
const PROBE = `const browser = require('sliccy:browser');
const fs = require('fs');
const site = process.env.SITE;
const step = async (label, fn) => {
  try {
    const v = await fn();
    console.log(label, typeof v === 'string' ? v : JSON.stringify(v));
    return v;
  } catch (e) {
    console.log(label, 'THROW', e.message.split('\\n')[0]);
  }
};
const tab = await step('ensureTab', () => browser.ensureTab(site + '/app'));
await step('ensureTab same origin', async () => (await browser.ensureTab(site + '/other')).targetId === tab.targetId);
await step('eval', () => browser.eval(tab, 'window.marker'));
await step('eval function', () => browser.eval(tab, () => ({ title: document.title, path: location.pathname })));
await step('eval throws', () => browser.eval(tab, 'missing.thing'));
await step('evalAsync', () => browser.evalAsync(tab, 'new Promise((r) => setTimeout(() => r(document.title), 10))'));
// Both sites are on localhost (other ports), so the first localhost tab may be either's.
await step('findTab domain', () => browser.findTab({ domain: 'localhost' }).then((t) => t && new URL(t.url).hostname));
await step('findTab urlMatch', async () => (await browser.findTab({ urlMatch: new RegExp(site.split(':').pop() + '/app$') })).targetId === tab.targetId);
await step('findTab none', () => browser.findTab({ domain: 'example.invalid' }));
await step('cookie', () => browser.cookie(tab, 'jsh_sid'));
await step('cookie missing', () => browser.cookie(tab, 'nope'));
await step('localStorage', () => browser.localStorage(tab, 'jsh-token'));
await step('localStorage missing', () => browser.localStorage(tab, 'nope'));
await step('fetch', async () => {
  const r = await browser.fetch(tab, '/api/echo', { method: 'POST', body: 'hi', headers: { 'x-test': '1' } });
  return [r.ok, r.status, r.headers['x-jsh'], r.body];
});
await step('fetch text', async () => {
  const r = await browser.fetch(tab, '/api/text');
  return [r.status, r.statusText, r.body];
});
const handles = [];
await step('websocket log', async () => {
  const h = await browser.websocket.on(tab, { urlMatch: '/feed' }).forward({ sink: 'log' });
  handles.push(h);
  return [h.forward.sink, h.urlMatch];
});
await step('websocket vfs', async () => {
  const h = await browser.websocket
    .on(tab, { urlMatch: '/feed' })
    .filter({ where: { type: 'odd' }, project: ['seq'] })
    .forward({ sink: 'vfs', path: process.env.FEED });
  handles.push(h);
  return [h.forward.sink, h.filter];
});
await step('websocket list', async () => (await browser.websocket.list()).map((s) => s.forward.sink));
await step('feed', () => browser.eval(tab, 'openFeed(4)'));
const read = () => (fs.existsSync(process.env.FEED) ? fs.readFileSync(process.env.FEED, 'utf8') : '');
for (let i = 0; i < 200 && !read().includes('"seq":3'); i++) await new Promise((r) => setTimeout(r, 50));
await new Promise((r) => setTimeout(r, 500));
await step('vfs file', read);
await step('websocket close', async () => Promise.all(handles.map((h) => h.close())));
await step('websocket list after', async () => (await browser.websocket.list()).length);
`;

test('sliccy:browser in the kernel jsh, against the harness browser, as on the host jsh', async (t) => {
  const k = await booted(chrome, t);

  await t.test('pnpm add -g installs slicc-jsh from dist and sliccy-browser from the registry', async () => {
    const { browser } = await installJshAndBrowser(k, chrome, tgz);
    // engines.node >=24 against jsh's Node 22: neither an error nor a warning.
    assert.doesNotMatch(browser.stdout + browser.stderr, /engine|ERR_PNPM|WARN/i);
    assert.match(browser.stdout, /\+ @ai-ecoverse\/sliccy-browser \d/);
  });

  await t.test('SLICC_CDP_URL names the kernel facade on 127.0.0.1:9222', async () => {
    const r = await k.bash('echo "$SLICC_CDP_URL"');
    assert.match(r.stdout, /^ws:\/\/127\.0\.0\.1:9222\/devtools\/browser\/[0-9a-f-]{36}\n$/);
  });

  await t.test("require('sliccy:browser') and import() resolve to the global install", async () => {
    await k.write('/home/t/resolve.jsh', RESOLVE);
    const kernel = await k.run(['jsh', '/home/t/resolve.jsh']);
    const onHost = await runHost('resolve.jsh', RESOLVE);
    const expected = '__esModule,cookie,default,ensureTab,eval,evalAsync,fetch,findTab,localStorage,websocket\nimport true true\n';
    assert.deepEqual(kernel, { status: 0, stdout: expected, stderr: '' });
    assert.deepEqual(onHost, { status: 0, stdout: expected, stderr: '' });
  });

  await t.test("a method seven's CDP guard refuses fails at once with the guard's error", async () => {
    await k.write('/home/t/refuse.jsh', REFUSE);
    const kernel = await k.run(['timeout', '30', 'jsh', '/home/t/refuse.jsh']);
    assert.deepEqual(kernel, { status: 0, stdout: `7 ${SEVEN_REFUSED} true\n`, stderr: '' });
  });

  await t.test('the #73 checklist: same answers as the host jsh, and the script ends on its own', async () => {
    await k.write('/home/t/probe.jsh', PROBE);
    // coreutils timeout: a script that never ends is status 124, not a hung suite.
    const kernel = await k.run(['timeout', '60', 'jsh', '/home/t/probe.jsh'], {
      env: { SITE: kernelSite.origin, FEED: '/home/t/feed.log' },
    });
    const onHost = await runHost('probe.jsh', PROBE, { SITE: hostSite.origin, FEED: join(scripts, 'feed.log') });
    const seen = { status: kernel.status, stdout: normal(kernel.stdout, kernelSite), stderr: kernel.stderr };
    const hostSeen = { status: onHost.status, stdout: normal(onHost.stdout, hostSite), stderr: onHost.stderr };
    assert.deepEqual(seen, { status: 0, stdout: EXPECTED, stderr: '' });
    assert.deepEqual(hostSeen, seen, 'the host jsh, on the same browser');
    assert.equal(k.sockets.size, 0, 'every CDP connection the kernel opened is closed');
    assert.ok((await k.page.evaluate(() => window.cdpOpened)) >= 1);
  });

  assert.deepEqual(k.page.errors, []);
});

const EXPECTED = `ensureTab {"targetId":"$TARGET","url":"$SITE/app","title":"jsh browser site /app"}
ensureTab same origin true
eval 42
eval function {"title":"jsh browser site /app","path":"/app"}
eval throws THROW ReferenceError: missing is not defined
evalAsync jsh browser site /app
findTab domain localhost
findTab urlMatch true
findTab none null
cookie jsh-session-42
cookie missing null
localStorage stored-token-42
localStorage missing null
fetch [true,200,"yes",{"method":"POST","cookie":"jsh_sid=jsh-session-42","header":"1","body":"hi"}]
fetch text [201,"Created","plain text 42"]
websocket log ["log","/feed"]
websocket vfs ["vfs",{"where":{"type":"odd"},"project":["seq"]}]
websocket list ["log","vfs"]
feed opened
{"type":"odd","seq":1}
{"type":"even","seq":2}
{"type":"odd","seq":3}
{"type":"even","seq":4}
vfs file {"seq":1}
{"seq":3}

websocket close [true,true]
websocket list after 0
`;
