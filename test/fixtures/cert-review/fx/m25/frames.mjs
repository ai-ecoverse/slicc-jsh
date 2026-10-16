import { thrower, Klass, whoThis } from './lib/frames-lib.mjs';
const norm = (s) => s.replace(/file:\/\/\/[^ )]*\/m25\//g, 'file:///M/').replace(/\/[^ )]*\/m25\//g, '/M/');
try { thrower(); } catch (e) { console.log(norm(e.stack.split('\n').slice(0, 3).join(' | '))); }
try { new Klass().method(); } catch (e) { console.log(norm(e.stack.split('\n').slice(0, 3).join(' | '))); }
console.log('this in imported fn', whoThis());
const orig = Error.prepareStackTrace; Error.prepareStackTrace = (e, cs) => cs.map((c) => [norm(String(c.getFileName())), c.getLineNumber(), c.getColumnNumber(), c.getFunctionName(), c.getTypeName()]);
const st = (() => new Error('x').stack)(); Error.prepareStackTrace = orig; console.log('callsites', JSON.stringify(st.slice(0, 2)));
