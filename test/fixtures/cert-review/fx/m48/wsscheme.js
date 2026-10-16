for (const u of ['ftp://x/', 'http://127.0.0.1:1/', 'ws://127.0.0.1:1/#frag', 'not a url']) { try { const w = new WebSocket(u); console.log(u, 'constructed', w.url, w.readyState); w.onerror = () => {}; w.close(); } catch (e) { console.log(u, e.name, e.message); } }
setTimeout(() => process.exit(0), 500);
