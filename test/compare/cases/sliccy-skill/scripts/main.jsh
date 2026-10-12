const skill = require('sliccy:skill');
console.log('keys', Object.keys(skill).sort().join(','));
console.log('dir', skill.dir);
console.log('refs', skill.refs);
console.log('assets', skill.assets);
console.log('config', JSON.stringify(await skill.config()));
console.log('config write', JSON.stringify(await skill.config({ added: true })));
console.log('config file', require('fs').readFileSync(__dirname + '/.config', 'utf8').replace(/\s+/g, ' '));
try {
  await skill.token('compare-provider');
  console.log('token resolved');
} catch (e) {
  console.log('token error', e.message.split('\n')[0]);
}
