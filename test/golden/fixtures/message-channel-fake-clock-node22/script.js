let n = 0;
Date.now = () => n++;
const L = [];
const { port1, port2 } = new MessageChannel();
port2.onmessage = (e) => L.push('mc ' + e.data);
setImmediate(() => L.push('imm'));
port1.postMessage('x');
port1.postMessage('y');
setTimeout(() => { L.push('timer'); console.log(L.join(' | ')); port1.close(); }, 20);
