import http from 'node:http';
import express from 'express';
import * as chai from 'chai';
import chaiHttp, { request } from 'chai-http';

chai.use(chaiHttp);
const { expect } = chai;

const app = express();
app.use(express.json());
app.get('/users/:id', (req, res) => res.json({ id: req.params.id, q: req.query }));
app.post('/echo', (req, res) => res.status(201).json({ got: req.body }));
app.get('/login', (req, res) => res.cookie('sid', 'abc').send('in'));
app.get('/me', (req, res) => res.send(`cookie: ${req.headers.cookie ?? 'none'}`));
app.get('/fail', (req, res, next) => next(new Error('nope')));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

process.on('exit', (code) => console.log('exit', code));

const one = await request.execute(app).get('/users/7?x=1');
expect(one).to.have.status(200);
expect(one).to.be.json;
console.log('get', one.status, JSON.stringify(one.body));

const two = await request.execute(app).post('/echo').send({ a: 1 });
expect(two).to.have.status(201);
console.log('post', two.status, JSON.stringify(two.body));

const missing = await request.execute(app).get('/nowhere');
expect(missing).to.have.status(404);
console.log('missing', missing.status);

const fail = await request.execute(app).get('/fail');
expect(fail).to.have.status(500);
console.log('error handler', fail.status, JSON.stringify(fail.body));

const agent = request.agent(app);
const login = await agent.get('/login');
expect(login).to.have.cookie('sid', 'abc');
const me = await agent.get('/me');
console.log('agent', login.text, me.text);
agent.close();

const own = http.createServer(app);
own.listen(0, '127.0.0.1', async () => {
  const res = await request.execute(own).keepOpen().get('/users/9');
  console.log('own server', res.status, res.body.id, own.listening);
  own.close(() => console.log('own closed'));
});
