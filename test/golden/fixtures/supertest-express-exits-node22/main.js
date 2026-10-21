const http = require('http');
const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.get('/users/:id', (req, res) => res.json({ id: req.params.id, q: req.query }));
app.post('/echo', (req, res) => res.status(201).json({ got: req.body }));
app.get('/login', (req, res) => res.cookie('sid', 'abc').send('in'));
app.get('/me', (req, res) => res.send(`cookie: ${req.headers.cookie ?? 'none'}`));
app.get('/fail', (req, res, next) => next(new Error('nope')));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

process.on('exit', (code) => console.log('exit', code));

async function main() {
  const one = await request(app).get('/users/7?x=1').expect(200).expect('Content-Type', /json/);
  console.log('get', one.status, JSON.stringify(one.body));

  const two = await request(app).post('/echo').send({ a: 1 }).expect(201);
  console.log('post', two.status, JSON.stringify(two.body));

  await request(app)
    .get('/users/8')
    .expect(404)
    .then(
      () => console.log('unexpected pass'),
      (err) => console.log('expectation failed:', err.message)
    );

  const fail = await request(app).get('/fail').expect(500);
  console.log('error handler', fail.status, JSON.stringify(fail.body));

  await new Promise((resolve) => {
    request(app)
      .get('/users/9')
      .end((err, res) => {
        console.log('end cb', err, res.status, res.body.id);
        resolve();
      });
  });

  const shared = request(app);
  const both = await Promise.all([shared.get('/users/a'), shared.get('/users/b')]);
  console.log('shared', both.map((r) => r.body.id).join(','));

  const agent = request.agent(app);
  await agent.get('/login').expect(200);
  const me = await agent.get('/me');
  console.log('agent', me.text);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const own = await request(server).get('/users/own');
  console.log('own server', own.body.id, 'still listening', server.listening);
  server.close(() => console.log('own server closed'));
}

main().then(() => console.log('done'));
