for (const u of ['ftp://x/', 'ws://x/#frag', 'ws://x/#', 'not a url', 'http://127.0.0.1:1/', 'https://127.0.0.1:1/p?q', 'ws://127.0.0.1:1', new URL('ws://127.0.0.1:1/u')]) {
  try {
    const w = new WebSocket(u);
    w.onerror = () => {};
    console.log(JSON.stringify(String(u)), 'url', w.url);
    w.close();
  } catch (e) {
    console.log(JSON.stringify(String(u)), e.name, e.constructor.name, e.code, e.message);
  }
}
for (const p of [['a', 'a'], ['a b'], [''], 'x y', ['chat', 'superchat'], 'v1.proto']) {
  try {
    const w = new WebSocket('ws://127.0.0.1:1/', p);
    w.onerror = () => {};
    w.close();
    console.log(JSON.stringify(p), 'ok');
  } catch (e) {
    console.log(JSON.stringify(p), e.name, e.message);
  }
}
