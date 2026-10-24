const dir = require('fs').realpathSync(__dirname);
const show = (...a) => console.log(a.join(' ').split(dir).join('DIR').split(__dirname).join('DIR'));
delete Error.prepareStackTrace;
show(Object.hasOwn(Error, 'prepareStackTrace'));
show(new Error('x').stack.split('\n').slice(0, 2).join('\n'));
show(eval('new Error("e").stack').split('\n')[1]);
try {
  null.p;
} catch (e) {
  show(e.stack.split('\n').slice(0, 2).join('\n'));
}
Error.prepareStackTrace = (e, sites) => `custom ${sites[0].getFileName() === __filename} ${sites[0].getLineNumber()}`;
show(new Error('y').stack);
delete Error.prepareStackTrace;
show(new Error('z').stack.split('\n').slice(0, 2).join('\n'));
Error.prepareStackTrace = undefined;
show(new Error('u').stack.split('\n').slice(0, 2).join('\n'));
delete Error.prepareStackTrace;
RangeError.prepareStackTrace = () => 'range';
show(Object.hasOwn(RangeError, 'prepareStackTrace'), new RangeError('r').stack.split('\n')[0]);
