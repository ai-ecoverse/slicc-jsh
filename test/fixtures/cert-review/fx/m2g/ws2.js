const w = new WebSocket('ws://127.0.0.1:9/');
w.onerror = (e) => console.log('error event', e.type, e instanceof Event);
w.onclose = (e) => console.log('close event', e.code, e.wasClean);
