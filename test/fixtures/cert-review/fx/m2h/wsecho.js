const t0 = Date.now();
const w = new WebSocket('wss://echo.websocket.org/');
let n = 0;
w.onopen = () => { console.log('open'); w.send('hello-jsh'); };
w.onmessage = (m) => { n++; if (String(m.data).includes('hello-jsh')) { console.log('echoed hello-jsh'); w.close(1000); } };
w.onerror = () => console.log('error');
w.onclose = (e) => { console.log('close', e.code); process.exit(0); };
setTimeout(() => { console.log('timeout, readyState', w.readyState); process.exit(1); }, 8000);
