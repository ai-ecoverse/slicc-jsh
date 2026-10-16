const w = new WebSocket('ws://127.0.0.1:9/');
setTimeout(() => console.log('alive after ws error, readyState', w.readyState), 300);
