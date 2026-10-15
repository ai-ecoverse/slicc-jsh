/**
 * The Chromium harness for the browser suite (`npm run test:browser`):
 * slicc-shared-web's harness (as slicc-kernel's and slicc-bios's integration
 * suites use it) serves the kernel's browser build, the base packages and the
 * test page; `registry.npmjs.org` is answered from the harness's disk cache,
 * so pnpm in the page installs from the registry as seven does.
 *
 * The browser is Chrome for Testing at the version package.json pins in
 * `config.chrome`, which `npm run browser` installs with slicc-cdp's
 * `install-browser` (CI adds `--with-deps`); CHROME_PATH overrides it. It is
 * a throwaway either way: a fresh `slicc-harness-*` profile in $TMPDIR, never
 * the user's.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { findBrowser } from '@ai-ecoverse/slicc-cdp';
import { launch as start } from '@ai-ecoverse/slicc-shared-web/harness';

const pinned = () =>
  process.env.npm_package_config_chrome ||
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).config.chrome;

/** The pinned Chrome for Testing (or $CHROME_PATH), never a system Chrome. */
export async function executable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const version = pinned();
  const found = await findBrowser({ version });
  if (found) return found.executable;
  throw new Error(`no Chrome for Testing ${version}: run \`npm run browser\` (or set CHROME_PATH)`);
}

export const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/**
 * Launch the harness Chromium with a DevTools port (the browser the kernel's
 * CDP host relays to). Returns the harness handle plus `browser`, the
 * browser-level `webSocketDebuggerUrl`.
 */
export async function launch({ pack, args = [], ...overrides } = {}) {
  const port = await freePort();
  const chrome = await start({
    roots: [
      ['/kernel/', 'node_modules/@ai-ecoverse/slicc-kernel/dist/'],
      ['/node_modules/@ai-ecoverse/', 'node_modules/@ai-ecoverse/'],
      ...(pack ? [['/pack/', pack]] : []),
      ['/', 'test/browser/page/'],
    ],
    isolated: true,
    intercept: ['https://registry.npmjs.org/'],
    timeout: 300000,
    stallAfter: 120000,
    coverage: [],
    executable: await executable(),
    args: [`--remote-debugging-port=${port}`, ...args],
    ...overrides,
  });
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return Object.assign(chrome, { browser: version.webSocketDebuggerUrl, debugPort: port });
}
