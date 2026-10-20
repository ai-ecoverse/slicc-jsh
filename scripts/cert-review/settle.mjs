const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function settle(what, url, accept, { deadline, quietMs = 60_000, pollMs = 2000 }) {
  const t0 = Date.now();
  let answered = t0;
  let seen = 'no answer yet';
  for (;;) {
    try {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(quietMs) });
      answered = Date.now();
      const r = await accept(res);
      if (r.fail) throw Object.assign(new Error(`${what}: ${r.fail}`), { final: true });
      if (r.done) return r.value;
      seen = r.seen;
    } catch (error) {
      if (error.final) throw error;
      seen = `no answer (${error.message})`;
    }
    const now = Date.now();
    if (now - answered >= quietMs) throw new Error(`${what}: the registry has not answered for ${Math.round((now - answered) / 1000)} s: ${seen} (${url})`);
    if (now >= deadline) throw new Error(`${what}: not there after ${Math.round((now - t0) / 1000)} s: ${seen} (${url})`);
    await sleep(pollMs);
  }
}
