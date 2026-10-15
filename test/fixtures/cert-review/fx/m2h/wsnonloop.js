const ev = {};
for (const u of ['ws://nonexistent.invalid/', 'wss://nonexistent.invalid/', 'ws://localhost:9/']) {
  ev[u] = [];
  try {
    const w = new WebSocket(u);
    w.onerror = () => ev[u].push('error'); w.onclose = (e) => ev[u].push('close:' + e.code); w.onopen = () => ev[u].push('open');
    ev[u].w = w;
  } catch (e) { ev[u].push('threw ' + e.name); }
}
setTimeout(() => { for (const [u, e] of Object.entries(ev)) console.log(u, '→', e.join(',') || 'no events', 'readyState', e.w?.readyState); process.exit(0); }, 4000);
