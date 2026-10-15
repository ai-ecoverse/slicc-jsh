const t0 = Date.now(); const ev = [];
const w = new WebSocket('ws://127.0.0.1:9/');
w.onerror = (e) => ev.push(`error@${Date.now() - t0 < 1000 ? '<1s' : '>1s'}:${e instanceof Event}:${e.type}`);
w.onclose = (e) => ev.push(`close:${e.code}:${e.wasClean}`);
w.onopen = () => ev.push('open');
for (const ms of [500, 3000, 6000]) setTimeout(() => console.log(`after ${ms} ms: ${ev.join(',') || 'no events'} readyState ${w.readyState}`), ms);
