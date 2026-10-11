/**
 * Raw abi:js program — ctx.net only, no jsh net.mjs.
 * argv[1]: "writer-close" | "conn-close"
 *
 * Installed and run by scripts/run-raw-ctx-net-fin.mjs
 */
export default async function main(ctx) {
  const mode = ctx.argv[1] || 'writer-close';
  const enc = new TextEncoder();
  const payload = enc.encode('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhello');
  const DEADLINE_MS = 2000;

  const listener = await ctx.net.listen({ port: 0, host: '127.0.0.1' });
  const { port } = listener;

  const clientTask = (async () => {
    const conn = await ctx.net.connect({ host: '127.0.0.1', port });
    const reader = conn.readable.getReader();
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    }, DEADLINE_MS);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          clearTimeout(timer);
          await ctx.write(1, `DONE mode=${mode} bytes=${bytes}\n`);
          return 'done';
        }
        bytes += value.byteLength;
      }
    } catch {
      clearTimeout(timer);
      if (timedOut) {
        await ctx.write(1, `TIMEOUT mode=${mode} bytes=${bytes}\n`);
        return 'timeout';
      }
      await ctx.write(1, `ERROR mode=${mode} bytes=${bytes}\n`);
      return 'error';
    } finally {
      try {
        await conn.close();
      } catch {
        /* ignore */
      }
    }
  })();

  const serverConn = await listener.accept();
  const writer = serverConn.writable.getWriter();
  await writer.write(payload);

  if (mode === 'writer-close') {
    // (a) half-close send side only — peer should see reader done.
    await writer.close();
  } else if (mode === 'conn-close') {
    // (b) full connection close (release writer lock first).
    try {
      writer.releaseLock();
    } catch {
      /* ignore */
    }
    await serverConn.close();
  } else {
    await ctx.write(2, `unknown mode ${mode}\n`);
    return 64;
  }

  const result = await clientTask;
  try {
    await listener.close();
  } catch {
    /* ignore */
  }
  // Leave serverConn open after writer-close so we don't conflate with conn.close.
  if (mode === 'conn-close') {
    /* already closed */
  }
  return result === 'done' ? 0 : 2;
}
