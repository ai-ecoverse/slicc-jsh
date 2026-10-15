const util = require('util');
console.log('setTraceSigInt', typeof util.setTraceSigInt, typeof process.setTraceSigInt);
console.log('getCallSites', typeof util.getCallSites, 'getCallSite', typeof util.getCallSite);
process.on('warning', (w) => console.log('warning', w.name, w.code, w.message));
try { const s = util.getCallSite?.(); console.log('getCallSite ret', Array.isArray(s), s && s[0] && typeof s[0].functionName); } catch (e) { console.log('getCallSite threw', e.code); }
try { const s = util.getCallSites(); console.log('getCallSites ret', Array.isArray(s), Object.keys(s[0]).sort().join(',')); } catch (e) { console.log('getCallSites threw', e.code); }
setTimeout(() => {}, 50);
