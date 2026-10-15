const w = new WebSocket('ws://127.0.0.1:9/');
const ev = [];
w.onerror = (e) => ev.push('error:' + (e instanceof Event));
w.onclose = (e) => ev.push('close:' + e.code);
setTimeout(() => console.log('after 1.5 s:', ev.join(',') || 'no events', 'readyState', w.readyState), 1500);
