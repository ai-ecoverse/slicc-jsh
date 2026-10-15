/**
 * Boot a kernel in a harness tab, with the base packages seven's BIOS
 * installs (bash, coreutils, pnpm) and the CDP relay to the harness browser.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
export const BASE = ['wasm-bash', 'wasm-coreutils', 'wasi-pnpm'];

/** One WebSocket to the harness browser per kernel CDP client. */
function relay(page, browser) {
  const sockets = new Map();
  const deliver = (...args) =>
    page.evaluate((id, m, closed) => window.cdpIn(id, m, closed), ...args).catch(() => false);
  page.expose('cdpOut', ({ id, open, m, close }) => {
    if (open) {
      const ws = new WebSocket(browser);
      const queued = [];
      ws.onopen = () => {
        for (const text of queued.splice(0)) ws.send(text);
      };
      ws.onmessage = ({ data }) => void deliver(id, data);
      ws.onclose = () => {
        if (sockets.delete(id)) void deliver(id, null, 'the browser closed');
      };
      sockets.set(id, { ws, queued });
    } else if (m !== undefined) {
      const entry = sockets.get(id);
      if (!entry) return;
      if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(m);
      else entry.queued.push(m);
    } else if (close) {
      const entry = sockets.get(id);
      sockets.delete(id);
      entry?.ws.close();
    }
  });
  return sockets;
}

async function installBase(page, name) {
  const base = new URL(`${name}/`, modules);
  const files = await readdir(base, { recursive: true, withFileTypes: true });
  const names = files
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath}/${entry.name}`.slice(base.pathname.length));
  return page.evaluate(
    (d, n) => window.installTree(d, n),
    `node_modules/@ai-ecoverse/${name}/`,
    names
  );
}

export async function booted(chrome, t, { cdp = true, webSocket = false } = {}) {
  const page = await chrome.page(t);
  const sockets = cdp ? relay(page, chrome.browser) : new Map();
  await page.goto('/');
  await page.until(() => typeof window.boot === 'function');
  for (const name of BASE) await installBase(page, name);
  await page.evaluate((o) => window.boot(o), { cdp, webSocket });
  const run = (argv, options = {}) =>
    page.evaluate((a, o) => window.run(a, o), argv, { cwd: '/home', ...options });
  return {
    page,
    sockets,
    run,
    /** A fresh kernel on the same OPFS (the tab reloaded, as seven restarts). */
    reboot: async () => {
      await page.reload();
      await page.until(() => typeof window.boot === 'function');
      await page.evaluate((o) => window.boot(o), { cdp, webSocket });
    },
    bash: (script, options) => run(['bash', '-c', script], options),
    write: async (path, text) => {
      const r = await run(['bash', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', path], {
        stdin: text,
      });
      if (r.status !== 0) throw new Error(`writing ${path}: ${r.stderr}`);
    },
  };
}

/**
 * The `@ai-ecoverse/sliccy-browser` the suite installs: a registry spec, or
 * (SLICCY_BROWSER=/path/to.tgz) a local tarball, served to the kernel from
 * /pack/ and installed on the host from its path.
 */
export const SLICCY_BROWSER = process.env.SLICCY_BROWSER ?? '@ai-ecoverse/sliccy-browser@0.1.1';

/**
 * npm pack this repo (and copy a local SLICCY_BROWSER) into `dir`; the jsh
 * tarball's name. JSH_TARBALL=/path/to.tgz (a released one, say) is used
 * instead of packing.
 */
export function packJsh(dir) {
  if (process.env.JSH_TARBALL) copyFileSync(process.env.JSH_TARBALL, join(dir, basename(process.env.JSH_TARBALL)));
  else execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], { cwd: root, stdio: 'pipe' });
  if (SLICCY_BROWSER.startsWith('/')) copyFileSync(SLICCY_BROWSER, join(dir, basename(SLICCY_BROWSER)));
  return readdirSync(dir).find((n) => n.startsWith('ai-ecoverse-slicc-jsh-'));
}

/**
 * As seven's catalog installs packages: `pnpm add -g` inside the kernel,
 * slicc-jsh from the packed dist, sliccy-browser from the registry. Then a
 * fresh kernel on the same OPFS (pnpm's wasm leaves the tab large; seven
 * runs scripts long after an install).
 */
export async function installJshAndBrowser(k, chrome, tgz) {
  // The kernel's 127.0.0.1 is its own loopback (slicc-kernel 1.91.0, #510):
  // the harness server on the real machine is host.slicc.internal there,
  // which the kernel hands to the page's transport as 127.0.0.1.
  const packUrl = `${chrome.url.replace('//127.0.0.1:', '//host.slicc.internal:')}pack/`;
  const jsh = await k.run(['pnpm', 'add', '-g', `${packUrl}${tgz}`]);
  if (jsh.status !== 0) throw new Error(`pnpm add -g slicc-jsh: ${jsh.stderr || jsh.stdout}`);
  const spec = SLICCY_BROWSER.startsWith('/') ? `${packUrl}${basename(SLICCY_BROWSER)}` : SLICCY_BROWSER;
  const browser = await k.run(['pnpm', 'add', '-g', spec]);
  if (browser.status !== 0) throw new Error(`pnpm add -g ${spec}: ${browser.stderr || browser.stdout}`);
  await k.reboot();
  return { jsh, browser };
}
