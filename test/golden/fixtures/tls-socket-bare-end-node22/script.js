const net = require('net');
const tls = require('tls');
const events = [];
const peer = net.createServer((s) => {
  let got = '';
  s.on('data', (d) => (got += d));
  s.on('end', () => {
    events.push(`peer end ${JSON.stringify(got)}`);
    s.end();
  });
});
peer.listen(0, '127.0.0.1', () => {
  const t = new tls.TLSSocket(net.connect(peer.address().port, '127.0.0.1'));
  for (const e of ['connect', 'secureConnect', 'secure', 'end', 'finish']) t.on(e, () => events.push(e));
  t.on('error', (e) => events.push(`error ${e.code}`));
  t.on('close', () => {
    events.push('close');
    setImmediate(() => {
      console.log(events.join(', '));
      peer.close(() => console.log('peer closed'));
    });
  });
  t.end((e) => events.push(`end cb ${e ? e.code : 'null'}`));
  events.push(`connecting ${t.connecting}`);
});
