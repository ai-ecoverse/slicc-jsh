// A method frame's receiver against Node 22: V8 names a call on an object
// `Type.fn` (`Type.fn [as method]` when the property's name differs), and
// a CallSite's getTypeName() and getMethodName() say so. jest's assertion
// frame (`at Object.toEqual`) is one: a matcher called on a plain object.
const top = (err) => err.stack.split('\n')[1].trim().replace(/\(.*\)$/, '(…)');
const site = (fn) => {
  const prev = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, sites) => sites;
  try {
    let sites;
    try {
      fn();
    } catch (e) {
      sites = e.stack;
    }
    const s = sites[0];
    return [s.getTypeName(), s.getMethodName(), s.getFunctionName()].map(String).join(' ');
  } finally {
    Error.prepareStackTrace = prev;
  }
};
const cases = [];
const o = {
  method() {
    throw new Error('x');
  },
};
cases.push(['a method on a plain object', () => o.method()]);
o.toEqual = function throwingMatcher() {
  throw new Error('x');
};
cases.push(['a named function as a property of another name', () => o.toEqual()]);
o.anon = function () {
  throw new Error('x');
};
cases.push(['an anonymous function as a property', () => o.anon()]);
const make = () => function () {
  throw new Error('x');
};
const expectation = {};
for (const name of ['toBe', 'toEqual']) expectation[name] = make();
cases.push(['a function made elsewhere, as a property (jest)', () => expectation.toEqual()]);
o.arrow = () => {
  throw new Error('x');
};
cases.push(['an arrow as a property', () => o.arrow()]);
class Matchers {
  toThrow() {
    throw new Error('x');
  }
}
cases.push(['a class method', () => new Matchers().toThrow()]);
const nullProto = Object.create(null);
nullProto.m = function m() {
  throw new Error('x');
};
cases.push(['a method on a null-prototype object', () => nullProto.m()]);
for (const [label, fn] of cases) {
  let frame;
  try {
    fn();
  } catch (e) {
    frame = top(e);
  }
  console.log(label + ':', frame, '|', site(fn));
}
