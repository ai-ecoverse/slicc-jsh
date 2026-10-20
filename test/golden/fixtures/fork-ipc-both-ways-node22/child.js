const N = Number(process.argv[2]);
const PAD = 'x'.repeat(240);
let next = 0;
let wrong = 0;
let sent = 0;
const done = () => {
  if (next === N && sent === N) {
    console.log('child got', next, 'out of order', wrong, 'callbacks', sent);
    process.disconnect();
  }
};
process.on('message', (m) => {
  if (m.i !== next || m.pad !== PAD) wrong++;
  next++;
  done();
});
for (let i = 0; i < N; i++)
  process.send({ i, pad: PAD }, (err) => {
    if (!err) sent++;
    done();
  });
