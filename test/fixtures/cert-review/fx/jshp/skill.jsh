const skill = require('sliccy:skill');
console.log('skill dir', typeof skill.dir, skill.dir && skill.dir.split('/').pop());
try { const t = await skill.token('github'); console.log('token', typeof t); } catch (e) { console.log('token error', e.message.split('\n')[0].slice(0, 100)); }
for (const m of ['agent', 'browser', 'nope']) { try { require('sliccy:' + m); console.log(m, 'loaded'); } catch (e) { console.log(m, '→', e.message.split('\n')[0].slice(0, 110)); } }
