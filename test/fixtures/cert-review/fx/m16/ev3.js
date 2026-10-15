// #93: the lazy EventEmitterAsyncResource export, and spreading/copying the events module
const E = require('events');
try { console.log('typeof EventEmitterAsyncResource', typeof E.EventEmitterAsyncResource); } catch (e) { console.log('EventEmitterAsyncResource threw', e.code, e.message); }
try { const copy = { ...E }; console.log('spread keys', Object.keys(copy).length); } catch (e) { console.log('spread threw', e.code); }
try { const { on, once } = require('node:events'); console.log('partial destructure ok', typeof on, typeof once); } catch (e) { console.log('partial threw', e.code); }
console.log('desc', JSON.stringify(Object.getOwnPropertyDescriptor(E, 'EventEmitterAsyncResource') && Object.keys(Object.getOwnPropertyDescriptor(E, 'EventEmitterAsyncResource'))));
