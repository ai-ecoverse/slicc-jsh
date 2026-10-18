const w = new WebSocket('wss://echo.websocket.org/');
w.onopen = () => { console.log('open'); w.send('hello-jsh'); };
w.onmessage = (m) => { if (String(m.data).includes('hello-jsh')) { console.log('echoed hello-jsh'); w.close(1000); } };
w.onerror = () => console.log('error');
w.onclose = (e) => { console.log('close', e.code); process.exit(0); };
