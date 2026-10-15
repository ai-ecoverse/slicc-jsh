/**
 * The browser suite's page: boots slicc-kernel in this tab on OPFS, the way
 * seven (slicc-bios's os.js) does — `createKernel({ root, network: {
 * transport }, cdp })` — with the page's `fetchTransport` and a CDP host.
 *
 * The CDP host is the kernel's `cdp` hook. In seven, bios's `browserHook`
 * opens the connection through slicc-extension (`sliccExtension.cdp`) or the
 * local proxy's `/cdp` WebSocket; here it is relayed, one connection per
 * kernel client, to the harness Chromium's own browser endpoint (the test's
 * `cdpOut` binding and `cdpIn`), as slicc-kernel's cdp.test.mjs does, and
 * the relay refuses what seven's CDP guard refuses (kernel.mjs). The
 * kernel then serves it to its processes on 127.0.0.1:9222 and sets
 * SLICC_CDP_URL, exactly as in seven.
 */
import { createKernel, fetchTransport } from '/kernel/index.js';

async function walk(path, create = false) {
  let dir = await navigator.storage.getDirectory();
  for (const part of path.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetching ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The base packages, as bios's installer step puts them: files from the
 * server into OPFS under node_modules/, before the kernel boots.
 */
window.installTree = async (dir, names) => {
  let next = 0;
  const copy = async () => {
    while (next < names.length) {
      const name = names[next++];
      const bytes = await fetchBytes(`/${dir}${name}`);
      const parts = (dir + name).split('/');
      const base = parts.pop();
      const handle = await (await walk(parts.join('/'), true)).getFileHandle(base, {
        create: true,
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    }
  };
  await Promise.all(Array.from({ length: 8 }, copy));
  return names.length;
};

const cdpLinks = new Map();
let cdpNext = 0;

window.cdpIn = (id, message, closed) => {
  const conn = cdpLinks.get(id);
  if (!conn) return false;
  if (closed === undefined) conn.onmessage?.(message);
  else {
    cdpLinks.delete(id);
    conn.onclose?.(closed || undefined);
  }
  return true;
};

window.cdpOpened = 0;

const cdpHook = async (request) => {
  const id = ++cdpNext;
  window.cdpOpened++;
  const out = (message) => window.cdpOut(JSON.stringify({ id, ...message }));
  const conn = {
    onmessage: null,
    onclose: null,
    send: (m) => out({ m }),
    close: () => {
      if (cdpLinks.delete(id)) out({ close: true });
    },
  };
  cdpLinks.set(id, conn);
  out({ open: request });
  return conn;
};

window.cdpOpen = () => cdpLinks.size;

window.boot = async ({ cdp = true, webSocket = false } = {}) => {
  window.kernel = await createKernel({
    root: await navigator.storage.getDirectory(),
    network: { transport: fetchTransport(webSocket ? { webSocket: true } : {}) },
    ...(cdp ? { cdp: cdpHook } : {}),
  });
  return true;
};

window.run = (argv, options) => window.kernel.run(argv, options);
